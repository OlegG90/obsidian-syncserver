/**
 * The delete and resync half of M1, driven through a fake wire.
 *
 * What is being proven is not that the engine can delete — it is that it deletes the RIGHT
 * way: a remote delete is applied only when the epoch says the absence is real, a local
 * delete is pushed by node id, and a restore turns the same absence into a rescue, not a
 * wipe. The fake therefore controls exactly two things: the tree the walk returns, and the
 * answer the cursor probe gets.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CursorRejected, Envelope, CursorUnverifiable } from '../src/api/client.js';
import type { Change, Delta } from '@syncserver/shared';
import type { VaultWire } from '../src/engine/wire.js';
import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { toHex, utf8, randomBytes } from '../src/crypto/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encryptName, nameHmac, wrapContentKey, unwrapContentKey, dedupTag, decryptName } from '../src/crypto/scope.js';
import { SyncEngine } from '../src/engine/engine.js';
import type { StateStore, VaultState } from '../src/engine/state.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const scopeId = 'scope-vault';
const seed = randomBytes(32);
const kv = vaultKey(seed, vaultId);

class Store implements StateStore {
  constructor(public state: VaultState) {}
  async load(): Promise<VaultState> {
    return structuredClone(this.state);
  }
  async save(state: VaultState): Promise<void> {
    this.state = structuredClone(state);
  }
}

interface FileSpec {
  path: string;
  text: string;
  nodeId: string;
  rev: number;
  /** A folder node: no content, and it must not be sealed or listed as a file. */
  folder?: boolean;
}

/** A folder node in the walk. */
const folderSpec = (path: string, nodeId: string, rev: number): FileSpec => ({ path, text: '', nodeId, rev, folder: true });

/**
 * Builds the node list the walk will return. Every file is sealed ONCE and the sealed form
 * is shared across the walk, the dedup answer and the blob reads — `KC` is random, so a fake
 * that re-seals per call invents a new address each time and nothing would ever match.
 */
const nodeListFor = (files: FileSpec[]): { nodes: Change[]; sealed: Map<string, { sha256: string; bytes: Uint8Array; contentKey: Uint8Array }> } => {
  const sealed = new Map<string, { sha256: string; bytes: Uint8Array; contentKey: Uint8Array }>();
  const nodes: Change[] = [
    {
      node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null,
      op: 'put', rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null,
    },
  ];
  for (const f of files) {
    if (f.folder) {
      nodes.push({
        node_id: f.nodeId,
        parent_id: rootNodeId,
        name_enc: encryptName(kv, f.path),
        name_hmac: nameHmac(kv, f.path),
        name_key_id: scopeId,
        op: 'put',
        rev: f.rev,
        sha256: null,
        size: null,
        mtime: new Date(0).toISOString(),
        share_id: null,
        author_id: null,
      });
      continue;
    }
    const s = sealBlob(utf8(f.text));
    sealed.set(f.path, s);
    nodes.push({
      node_id: f.nodeId,
      parent_id: rootNodeId,
      name_enc: encryptName(kv, f.path),
      name_hmac: nameHmac(kv, f.path),
      name_key_id: scopeId,
      op: 'put',
      rev: f.rev,
      sha256: s.sha256,
      size: s.bytes.length,
      mtime: new Date(0).toISOString(),
      share_id: null,
      author_id: null,
    });
  }
  return { nodes, sealed };
};

class FakeWire implements VaultWire {
  deleted: { nodeId: string; ifMatchRev: number }[] = [];
  created: string[] = [];
  putContentCalls: { nodeId: string; baseSha256: string | null }[] = [];
  moved: { nodeId: string; ifMatchRev: number; nameEnc: string }[] = [];

  constructor(
    private readonly files: FileSpec[],
    private readonly sealed: Map<string, { sha256: string; bytes: Uint8Array; contentKey: Uint8Array }>,
    /** What the cursor probe answers. */
    public deltaAnswer: Delta | CursorRejected | CursorUnverifiable,
  ) {}

  async openVault(): Promise<{ root_node_id: string; head_rev: number; scopes: { scope: string; key_id: string }[] }> {
    return { root_node_id: rootNodeId, head_rev: 9, scopes: [{ scope: 'vault', key_id: scopeId }] };
  }

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const nodes: Change[] = [
      {
        node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null,
        op: 'put', rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null,
      },
    ];
    for (const f of this.files) {
      if (f.folder) {
        nodes.push({
          node_id: f.nodeId, parent_id: rootNodeId,
          name_enc: encryptName(kv, f.path), name_hmac: nameHmac(kv, f.path), name_key_id: scopeId,
          op: 'put', rev: f.rev, sha256: null, size: null,
          mtime: new Date(0).toISOString(), share_id: null, author_id: null,
        });
        continue;
      }
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

  async delta(): Promise<Delta | CursorRejected | CursorUnverifiable> {
    return this.deltaAnswer;
  }

  async dedupLookup(_v: string, tags: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const f of this.files) {
      if (f.folder) continue;
      const s = this.sealed.get(f.path)!;
      out.set(dedupTag(kv, utf8(f.text)), s.sha256);
    }
    return out;
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

  async createNode(_v: string, body: { name_enc: string; sha256?: string }): Promise<{ node_id: string; rev: number }> {
    this.created.push(body.name_enc);
    return { node_id: `new-${this.created.length}`, rev: 20 + this.created.length };
  }

  async putContent(_v: string, nodeId: string, body: { sha256: string; base_sha256: string | null }): Promise<{ rev: number }> {
    this.putContentCalls.push({ nodeId, baseSha256: body.base_sha256 });
    return { rev: 30 };
  }

  async moveNode(_v: string, nodeId: string, ifMatchRev: number, body: { name_enc: string }): Promise<{ rev: number }> {
    this.moved.push({ nodeId, ifMatchRev, nameEnc: body.name_enc });
    return { rev: 40 };
  }

  async deleteNode(_v: string, nodeId: string, ifMatchRev: number): Promise<{ rev: number }> {
    this.deleted.push({ nodeId, ifMatchRev });
    return { rev: 40 };
  }
}

const continuous: Delta = { changes: [], events: [], next_cursor: 'cursor-new', has_more: false };
const restore: CursorRejected = { rejected: true, reason: 'restore' };
const ttl: CursorRejected = { rejected: true, reason: 'journal_ttl' };
/**
 * The 400, not a 410: a cursor this server cannot verify at all (#100).
 *
 * It was the one epoch with no test, and the reason is worth recording — it used to reach
 * the engine as a thrown `ApiError` caught by status, so simulating it meant a fake that
 * threw rather than one that answered. Now `delta` declares it, and it costs a literal.
 */
const unverifiable: CursorUnverifiable = { unverifiable: true, fault: 'cursor_unverifiable' };

const knownState = (spec: FileSpec, plainText: string, address: string): VaultState => ({
  cursor: 'cursor-old',
  nodes: {
    [spec.path]: {
      nodeId: spec.nodeId,
      rev: spec.rev,
      plainHash: toHex(sha256(utf8(plainText))),
      address,
    },
  },
});

describe('delete propagation', () => {
  it('a file gone from disk is deleted on the server, by node id', async () => {
    const spec: FileSpec = { path: 'gone.md', text: 'was here', nodeId: 'node-1', rev: 5 };
    const { sealed } = nodeListFor([spec]);
    const wire = new FakeWire([spec], sealed, continuous);
    const vault = new FakeVault(); // the file is NOT on disk — the user deleted it
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'was here', sealed.get('gone.md')!.sha256)));

    const report = await engine.sync();

    assert.deepEqual(wire.deleted, [{ nodeId: 'node-1', ifMatchRev: 5 }], 'the delete is pushed by node id, at the revision the walk saw');
    assert.deepEqual(report.deleted, [{ path: 'gone.md' }]);
    assert.deepEqual(report.errors, []);
  });

  it('a file deleted on the server is removed locally — the tree said so under a continuous epoch', async () => {
    const spec: FileSpec = { path: 'there.md', text: 'server copy', nodeId: 'node-2', rev: 3 };
    // The walk returns an EMPTY tree: the node is gone on the server.
    const wire = new FakeWire([], new Map(), continuous);
    const vault = new FakeVault();
    vault.seed('there.md', 'server copy');
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'server copy', 'addr-was-here')));

    const report = await engine.sync();

    assert.equal(vault.contents('there.md'), undefined, 'the local copy is gone');
    assert.deepEqual(report.removed, [{ path: 'there.md' }]);
    assert.equal(wire.created.length, 0, 'nothing is resurrected');
  });

  it('under a restore the same absence is a rescue, not a deletion', async () => {
    const spec: FileSpec = { path: 'keep.md', text: 'only copy', nodeId: 'node-3', rev: 7 };
    // The restored server no longer has the node — but absence after a restore proves nothing.
    const wire = new FakeWire([], new Map(), restore);
    const vault = new FakeVault();
    vault.seed('keep.md', 'only copy');
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'only copy', 'addr-was-here')));

    const report = await engine.sync();

    assert.equal(vault.contents('keep.md'), 'only copy', 'the file survives');
    assert.equal(wire.deleted.length, 0, 'no delete is pushed');
    assert.equal(wire.created.length, 1, 'it is re-uploaded as new — the server lost it');
    assert.deepEqual(report.removed, []);
  });

  it('an unverifiable cursor deletes nothing, exactly as a restore does not', async () => {
    // The server cannot say whether it went backwards, so absence proves nothing and the
    // only safe reading is the cautious one. This is the difference between a signature it
    // cannot check and a cursor it knows to be stale — the second is answered by a 410 and
    // trusted; this one is not answered at all.
    const spec: FileSpec = { path: 'unverified.md', text: 'the only copy', nodeId: 'node-9', rev: 4 };
    const wire = new FakeWire([], new Map(), unverifiable);
    const vault = new FakeVault();
    vault.seed('unverified.md', 'the only copy');
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'the only copy', 'addr-gone')));

    const report = await engine.sync();

    assert.equal(vault.contents('unverified.md'), 'the only copy', 'nothing local is removed');
    assert.equal(wire.deleted.length, 0, 'and nothing is deleted on the server');
    assert.deepEqual(report.removed, []);
    assert.equal(wire.created.length, 1, 'the file is re-uploaded, because the tree does not hold it');
  });

  it('a 410 journal_ttl still reads absence as deletion — the server moved forwards', async () => {
    const spec: FileSpec = { path: 'old.md', text: 'gone remotely', nodeId: 'node-4', rev: 2 };
    const wire = new FakeWire([], new Map(), ttl);
    const vault = new FakeVault();
    vault.seed('old.md', 'gone remotely');
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'gone remotely', 'addr-was-here')));

    const report = await engine.sync();

    assert.equal(vault.contents('old.md'), undefined, 'the local copy follows the deletion');
    assert.deepEqual(report.removed, [{ path: 'old.md' }]);
  });

  it('a remote delete does NOT remove a file the user edited locally in the meantime', async () => {
    const spec: FileSpec = { path: 'edited.md', text: 'synced version', nodeId: 'node-5', rev: 4 };
    const wire = new FakeWire([], new Map(), continuous);
    const vault = new FakeVault();
    vault.seed('edited.md', 'my newer edit'); // localChanged: plainHash differs from state
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(knownState(spec, 'synced version', 'addr-was-here')));

    const report = await engine.sync();

    assert.equal(vault.contents('edited.md'), 'my newer edit', 'local work is not erased');
    assert.equal(wire.created.length, 1, 'the edit goes back up as new rather than being lost');
    assert.deepEqual(report.removed, []);
  });
});

describe('remote rename', () => {
  it('a node that moved on the server moves the local file, and our edits follow it', async () => {
    // The node we know as old.md now lives at new.md on the server, same id, same content.
    const moved: FileSpec = { path: 'new.md', text: 'the body', nodeId: 'node-6', rev: 8 };
    const { sealed } = nodeListFor([moved]);
    const wire = new FakeWire([moved], sealed, continuous);
    const vault = new FakeVault();
    vault.seed('old.md', 'the body EDITED'); // we edited after the server's move
    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: { 'old.md': { nodeId: 'node-6', rev: 6, plainHash: toHex(sha256(utf8('the body'))), address: sealed.get('new.md')!.sha256 } },
    };
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(state));

    const report = await engine.sync();

    assert.equal(vault.contents('old.md'), undefined, 'the old path is gone');
    assert.ok(vault.contents('new.md') !== undefined, 'the file moved to the new path');
    assert.deepEqual(report.renamed, [{ from: 'old.md', to: 'new.md' }]);
    // The edit went up against the SAME node id — not a new file, not a conflict.
    assert.deepEqual(wire.putContentCalls.map((c) => c.nodeId), ['node-6'], 'the edit lands on the moved node');
    assert.deepEqual(report.conflicts, []);
  });

  it('a folder renamed is one move of the folder node, not a move per child', async () => {
    // The server has a folder `Old/` with two files. The user renamed it to `New/` locally:
    // the files vanished from their old paths and reappeared, identical, under `New/`.
    const folder: FileSpec = folderSpec('Old', 'folder-1', 1);
    const one: FileSpec = { path: 'Old/one.md', text: 'content one', nodeId: 'node-a', rev: 2 };
    const two: FileSpec = { path: 'Old/two.md', text: 'content two', nodeId: 'node-b', rev: 3 };
    const { sealed } = nodeListFor([folder, one, two]);
    const wire = new FakeWire([folder, one, two], sealed, continuous);

    const vault = new FakeVault();
    vault.seed('New/one.md', 'content one');
    vault.seed('New/two.md', 'content two');

    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: {
        'Old/one.md': { nodeId: 'node-a', rev: 2, plainHash: toHex(sha256(utf8('content one'))), address: sealed.get('Old/one.md')!.sha256 },
        'Old/two.md': { nodeId: 'node-b', rev: 3, plainHash: toHex(sha256(utf8('content two'))), address: sealed.get('Old/two.md')!.sha256 },
      },
    };
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(state));

    const report = await engine.sync();

    // Exactly ONE move: the folder node, not the children.
    assert.equal(wire.moved.length, 1, 'one moveNode for the folder, not two for the files');
    assert.equal(wire.moved[0]!.nodeId, 'folder-1');
    assert.equal(decryptName(kv, wire.moved[0]!.nameEnc), 'New');
    assert.equal(wire.created.length, 0, 'nothing is created');
    assert.equal(report.renamed.length, 1);
    assert.deepEqual(report.renamed, [{ from: 'Old', to: 'New' }]);
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  });
});

describe('resync after a reset', () => {
  it('quarantines local work the winning tree does not hold, and never erases it', async () => {
    // The winning tree has a shared.md we match, and nothing else. Our local-only note must
    // be quarantined, not deleted and not re-uploaded.
    const shared: FileSpec = { path: 'shared.md', text: 'shared body', nodeId: 'node-7', rev: 2 };
    const { sealed } = nodeListFor([shared]);
    const wire = new FakeWire([shared], sealed, { rejected: true, reason: 'reset' });

    const vault = new FakeVault();
    vault.seed('shared.md', 'shared body');
    vault.seed('mine.md', 'my private note');
    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: {
        'shared.md': { nodeId: 'node-7', rev: 1, plainHash: toHex(sha256(utf8('shared body'))), address: sealed.get('shared.md')!.sha256 },
        'mine.md': { nodeId: 'node-8', rev: 1, plainHash: toHex(sha256(utf8('my private note'))), address: 'some-old-address' },
      },
    };
    const engine = new SyncEngine(wire, vaultId, kv, vault, new Store(state));

    const report = await engine.sync();

    assert.equal(vault.contents('shared.md'), 'shared body', 'the matching file stays in place');
    assert.equal(vault.contents('mine.md'), undefined, 'the local-only file leaves its path');
    const q = report.quarantined.find((x) => x.from === 'mine.md');
    assert.ok(q, 'it was quarantined, not erased');
    assert.match(q!.to, /^_Reset \d{4}-\d{2}-\d{2}\/mine\.md$/);
    assert.equal(vault.contents(q!.to), 'my private note', 'the content survives in quarantine');
    assert.equal(wire.created.length, 0, 'a reset uploads nothing from the losing device');
  });

  it('the quarantine folder is outside synchronisation — it is never pushed back up', async () => {
    // After a reset the winning tree holds a file we match, and our local-only work was
    // quarantined to `_Reset …/`. A follow-up sync must not re-upload the quarantine.
    const shared: FileSpec = { path: 'shared.md', text: 'shared body', nodeId: 'node-7', rev: 2 };
    const { sealed } = nodeListFor([shared]);
    const wire = new FakeWire([shared], sealed, { rejected: true, reason: 'reset' });

    const vault = new FakeVault();
    vault.seed('shared.md', 'shared body');
    vault.seed('mine.md', 'my private note');
    const state: VaultState = {
      cursor: 'cursor-old',
      nodes: {
        'shared.md': { nodeId: 'node-7', rev: 1, plainHash: toHex(sha256(utf8('shared body'))), address: sealed.get('shared.md')!.sha256 },
        'mine.md': { nodeId: 'node-8', rev: 1, plainHash: toHex(sha256(utf8('my private note'))), address: 'some-old-address' },
      },
    };
    const store = new Store(state);
    const engine = new SyncEngine(wire, vaultId, kv, vault, store);

    const first = await engine.sync();
    const quarantinePath = first.quarantined.find((x) => x.from === 'mine.md')!.to;
    assert.equal(wire.created.length, 0, 'the reset pass uploaded nothing');

    // Same vault, one more sync. The quarantine folder is still there — it must not be pushed.
    await engine.sync();
    const pushedPaths = wire.created.map((nameEnc) => decryptName(kv, nameEnc));
    assert.ok(!pushedPaths.includes('mine.md'), 'the quarantined file is not re-uploaded');
    assert.ok(!pushedPaths.some((p) => p.startsWith('_Reset ')), 'no file under _Reset is uploaded');
    assert.equal(vault.contents(quarantinePath), 'my private note', 'and the quarantine itself is untouched');
  });
});
