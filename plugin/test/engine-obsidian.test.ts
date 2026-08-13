/**
 * The `.obsidian/` switch and its per-device exceptions (#7, docs/01).
 *
 * Three gates share one filter: what the engine scans locally, what it pulls from the
 * server, and what it treats as vanished. The switch is off by default; turning it off
 * freezes `.obsidian/` in place rather than deleting it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CursorRejected, Envelope } from '../src/api/client.js';
import type { Change, Delta } from '@syncserver/shared';
import type { VaultWire } from '../src/engine/wire.js';
import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { toHex, utf8, randomBytes } from '../src/crypto/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encryptName, nameHmac, wrapContentKey, dedupTag } from '../src/crypto/scope.js';
import { isSyncable } from '../src/engine/vault.js';
import { SyncEngine } from '../src/engine/engine.js';
import type { StateStore, VaultState } from '../src/engine/state.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const scopeId = 'scope-vault';
const kv = vaultKey(randomBytes(32), vaultId);

class Store implements StateStore {
  constructor(public state: VaultState) {}
  async load(): Promise<VaultState> {
    return structuredClone(this.state);
  }
  async save(state: VaultState): Promise<void> {
    this.state = structuredClone(state);
  }
}

describe('isSyncable and the .obsidian/ switch', () => {
  it('excludes .obsidian/ entirely when the switch is off (the default)', () => {
    assert.equal(isSyncable('.obsidian/appearance.json', false), false);
    assert.equal(isSyncable('.obsidian/plugins/foo/data.json', false), false);
    assert.equal(isSyncable('Notes/a.md', false), true);
    assert.equal(isSyncable('.trash/gone.md', false), false);
  });

  it('includes .obsidian/ config when the switch is on', () => {
    assert.equal(isSyncable('.obsidian/appearance.json', true), true);
    assert.equal(isSyncable('.obsidian/hotkeys.json', true), true);
    assert.equal(isSyncable('.obsidian/plugins/foo/data.json', true), true);
  });

  it('keeps the per-device exceptions out even when the switch is on', () => {
    assert.equal(isSyncable('.obsidian/workspace.json', true), false, 'window layout');
    assert.equal(isSyncable('.obsidian/workspace-mobile.json', true), false, 'mobile twin');
    assert.equal(isSyncable('.obsidian/graph.json', true), false, 'graph view');
    assert.equal(isSyncable('.obsidian/cache', true), false, 'plugin cache');
    assert.equal(isSyncable('.obsidian/cache/some-file', true), false, 'cache contents');
    // A file under a device-local folder that is itself not device-local still syncs.
    assert.equal(isSyncable('.obsidian/plugins/cache-manager/data.json', true), true);
  });
});

/** A minimal wire: serves the given server files (sealed once) and records pushes. */
class OneFileWire implements VaultWire {
  created = 0;
  deleted: string[] = [];
  private readonly sealed = new Map<string, { sha256: string; bytes: Uint8Array; contentKey: Uint8Array }>();
  constructor(
    private readonly server: { path: string; text: string; nodeId: string; rev: number }[],
    private readonly deltaAnswer: Delta | CursorRejected,
  ) {
    for (const f of server) this.sealed.set(f.path, sealBlob(utf8(f.text)));
  }

  async openVault(): Promise<{ root_node_id: string; head_rev: number; scopes: { scope: string; key_id: string }[] }> {
    return { root_node_id: rootNodeId, head_rev: 5, scopes: [{ scope: 'vault', key_id: scopeId }] };
  }

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const nodes: Change[] = [
      {
        node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null,
        op: 'put', rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null,
      },
    ];
    for (const f of this.server) {
      const s = this.sealed.get(f.path)!;
      nodes.push({
        node_id: f.nodeId, parent_id: rootNodeId,
        name_enc: encryptName(kv, f.path), name_hmac: nameHmac(kv, f.path), name_key_id: scopeId,
        op: 'put', rev: f.rev, sha256: s.sha256, size: s.bytes.length,
        mtime: new Date(0).toISOString(), share_id: null, author_id: null,
      });
    }
    return { nodes, snapshot: 'cursor-new' };
  }

  async delta(): Promise<Delta | CursorRejected> {
    return this.deltaAnswer;
  }

  async dedupLookup(): Promise<Map<string, string>> {
    return new Map();
  }

  async putBlob(sealed: { sha256: string; bytes: Uint8Array; keyId: string }): Promise<{ sha256: string; size: number }> {
    return { sha256: sealed.sha256, size: sealed.bytes.length };
  }

  async getBlob(address: string): Promise<Uint8Array | undefined> {
    for (const s of this.sealed.values()) {
      if (s.sha256 === address) return s.bytes;
    }
    return undefined;
  }

  async blobKeys(_v: string, addresses: string[]): Promise<Map<string, Envelope[]>> {
    const out = new Map<string, Envelope[]>();
    for (const s of this.sealed.values()) {
      if (addresses.includes(s.sha256)) {
        out.set(s.sha256, [{ scopeId, wrappedKey: wrapContentKey(kv, s.contentKey) }]);
      }
    }
    return out;
  }

  async createNode(): Promise<{ node_id: string; rev: number }> {
    this.created++;
    return { node_id: `new-${this.created}`, rev: 10 + this.created };
  }

  async putContent(): Promise<{ rev: number }> {
    return { rev: 20 };
  }

  async moveNode(): Promise<{ rev: number }> {
    return { rev: 30 };
  }

  async deleteNode(_v: string, nodeId: string): Promise<{ rev: number }> {
    this.deleted.push(nodeId);
    return { rev: 40 };
  }
}

const continuous: Delta = { changes: [], events: [], next_cursor: 'cursor-new', has_more: false };

describe('the engine applies the scope to scan, pull and delete', () => {
  it('does not pull .obsidian/ files from the server when the switch is off', async () => {
    // The server has a note AND an .obsidian file (uploaded by a device with the switch on).
    const wire = new OneFileWire(
      [
        { path: 'Notes/a.md', text: 'a note', nodeId: 'node-1', rev: 2 },
        { path: '.obsidian/appearance.json', text: '{}', nodeId: 'node-2', rev: 3 },
      ],
      continuous,
    );
    const vault = new FakeVault();
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store({ nodes: {} }));

    const report = await engine.sync();

    assert.equal(vault.contents('Notes/a.md'), 'a note', 'the ordinary file is pulled');
    assert.equal(vault.contents('.obsidian/appearance.json'), undefined, '.obsidian is not pulled');
    assert.ok(report.pulled.some((p) => p.path === 'Notes/a.md'));
    assert.ok(!report.pulled.some((p) => p.path.startsWith('.obsidian/')));
  });

  it('does not push .obsidian/ files when the switch is off', async () => {
    const wire = new OneFileWire([], continuous);
    const vault = new FakeVault();
    vault.seed('Notes/a.md', 'a note');
    vault.seed('.obsidian/appearance.json', '{}');
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store({ nodes: {} }));

    const report = await engine.sync();

    assert.ok(report.pushed.some((p) => p.path === 'Notes/a.md'));
    assert.ok(!report.pushed.some((p) => p.path.startsWith('.obsidian/')), 'nothing from .obsidian is pushed');
  });

  it('turning the switch off freezes .obsidian/ instead of deleting it', async () => {
    // The device synced .obsidian while the switch was on; it is now off. The file is still
    // in state but no longer on disk (the scan excludes it). It must NOT be pushed as a delete.
    const appearance = sealBlob(utf8('{}'));
    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: {
        '.obsidian/appearance.json': {
          nodeId: 'node-9',
          rev: 4,
          plainHash: toHex(sha256(utf8('{}'))),
          address: appearance.sha256,
        },
      },
    };
    // The server still holds it.
    const wire = new OneFileWire(
      [{ path: '.obsidian/appearance.json', text: '{}', nodeId: 'node-9', rev: 4 }],
      continuous,
    );
    const vault = new FakeVault();
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(state));

    const report = await engine.sync();

    assert.equal(report.deleted.length, 0, 'no delete is pushed for .obsidian');
    assert.equal(report.removed.length, 0, 'and it is not removed locally');
    assert.equal(vault.contents('.obsidian/appearance.json'), undefined, 'the local copy stays gone — the switch froze it');
    // State kept the entry, so flipping the switch back on resumes it rather than re-uploading.
  });
});
