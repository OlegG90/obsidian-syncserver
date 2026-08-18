/**
 * The engine's scope resolution: a node names the key scope it lives under, and the engine
 * must use that scope's key, not a fixed vault key.
 *
 * Today the real server names every node under the vault's scope, so this behaviour cannot
 * be exercised end to end — it is exactly the seam M3's sharing will rely on (SH-28). The
 * fake wire simulates a node named under a share scope, and the tests pin the rule: the
 * injected share key opens it, and a node whose scope this device cannot open is left out of
 * the tree rather than taken down with the pass.
 *
 * That last one used to assert the opposite — `assert.rejects` on the whole sync. It was the
 * defect written down as a contract: the tree read is the one place a missing key must not be
 * fatal, and `engine-unopenable-share.test.ts` is where the whole of that rule now lives.
 */
import assert from 'node:assert/strict';
import type { OpenedVault } from '@syncserver/shared';
import { describe, it } from 'node:test';
import type { Change, Delta } from '@syncserver/shared';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, utf8 } from '../src/crypto/bytes.js';
import { encryptName, wrapContentKey } from '../src/crypto/scope.js';
import { SyncEngine } from '../src/engine/engine.js';
import { VaultScopes } from '../src/share-keys.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { MemoryStateStore } from '../src/engine/state.js';
import type { VaultWire } from '../src/engine/wire.js';
import type { CursorRejected, Envelope, PutConflict, CursorUnverifiable } from '../src/api/client.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const vaultScopeId = 'scope-vault';
const shareScopeId = 'scope-share';
const shareId = '33333333-3333-4333-8333-333333333333';

/**
 * The vault as the engine is now given it, rather than as it used to ask for it.
 *
 * The seam lost `openVault` when the caller took over opening: one value per
 * operation, passed to everything that operation needs (docs/06).
 */
const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 1,
  scopes: [{ scope: 'vault', key_id: vaultScopeId }],
};

/**
 * The vault's scopes, holding the share key or not.
 *
 * The share scope is reported either with its key genuinely wrapped under `KV` — the
 * initiator's own form — or with no wrapped key at all, which is what an envelope that never
 * arrived looks like from here. Built through `VaultScopes.open` rather than by reaching into
 * it: the engine is the subject, but a fixture that bypasses the unwrapping would also pass
 * if the unwrapping stopped working.
 */
const scopesWith = (vaultKey: Uint8Array, shareKey?: Uint8Array): VaultScopes =>
  VaultScopes.open(
    {
      ...opened,
      scopes: [
        ...opened.scopes,
        {
          scope: 'share', key_id: shareScopeId, share_id: shareId,
          ...(shareKey ? { wrapped_key: wrapShareKey(vaultKey, shareKey), wrapping: 'vault' as const } : {}),
        },
      ],
    },
    { vaultKey, openIdentity: () => randomBytes(32), userId: 'user' },
  );

/** A wire holding one file, named and enveloped under a caller-chosen scope. */
class FakeWire implements VaultWire {
  private readonly sealed: { sha256: string; bytes: Uint8Array; contentKey: Uint8Array };
  private readonly wrapped: string;
  private readonly envelopeScopeId: string;

  constructor(
    private readonly scopeKey: Uint8Array,
    private readonly nameKeyId: string | null,
    content: string,
  ) {
    this.sealed = sealBlob(utf8(content));
    this.wrapped = wrapContentKey(scopeKey, this.sealed.contentKey);
    this.envelopeScopeId = nameKeyId ?? vaultScopeId;
  }

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    return {
      snapshot: 'cursor',
      nodes: [
        { node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null, op: 'put', rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null },
        {
          node_id: 'note', parent_id: rootNodeId, name_enc: encryptName(this.scopeKey, 'shared.md'),
          name_hmac: '', name_key_id: this.nameKeyId, op: 'put', rev: 2,
          sha256: this.sealed.sha256, size: this.sealed.bytes.length,
          mtime: new Date(1).toISOString(), share_id: null, author_id: null,
        },
      ],
    };
  }

  async dedupLookup(): Promise<Map<string, string>> {
    return new Map();
  }

  async putBlob(): Promise<{ sha256: string; size: number }> {
    throw new Error('unexpected');
  }

  async getBlob(): Promise<Uint8Array | undefined> {
    return this.sealed.bytes;
  }

  async blobKeys(): Promise<Map<string, Envelope[]>> {
    return new Map([[this.sealed.sha256, [{ sha256: this.sealed.sha256, scopeId: this.envelopeScopeId, wrappedKey: this.wrapped }]]]);
  }

  async createNode(): Promise<{ node_id: string; rev: number }> {
    throw new Error('unexpected');
  }

  async putContent(): Promise<{ rev: number } | PutConflict> {
    throw new Error('unexpected');
  }

  async moveNode(): Promise<{ rev: number }> {
    throw new Error('unexpected');
  }

  async deleteNode(): Promise<{ rev: number }> {
    throw new Error('unexpected');
  }

  async delta(): Promise<Delta | CursorRejected | CursorUnverifiable> {
    throw new Error('unexpected');
  }
}

describe('the engine opens a node under the scope it is named in', () => {
  it('uses the injected share key to read a node named under a share scope', async () => {
    const vaultKey = randomBytes(32);
    const shareKey = randomBytes(32);
    const engine = new SyncEngine(
      new FakeWire(shareKey, shareScopeId, 'the shared note'),
      vaultId,
      scopesWith(vaultKey, shareKey),
      new FakeVault(),
      new MemoryStateStore(),
    );

    const report = await engine.sync();
    assert.deepEqual(report.errors, [], 'the shared note read cleanly');
    assert.ok(report.pulled.some((p) => p.path === 'shared.md'), 'the shared note was pulled under its own scope');
  });

  it('leaves out a node named under a scope it holds no key for', async () => {
    const vaultKey = randomBytes(32);
    // The node is named and enveloped under the share scope, and no share key is injected.
    const engine = new SyncEngine(
      new FakeWire(randomBytes(32), shareScopeId, 'the shared note'),
      vaultId,
      scopesWith(vaultKey),
      new FakeVault(),
      new MemoryStateStore(),
    );

    const report = await engine.sync();
    assert.deepEqual(report.errors, [], 'unreachable is not broken');
    assert.deepEqual(report.pulled, [], 'and nothing was read with the wrong key');
  });

  it('falls back to the vault scope when a node carries none', async () => {
    const vaultKey = randomBytes(32);
    // `name_key_id: null` — a node with no scope binding is the vault's own.
    const engine = new SyncEngine(
      new FakeWire(vaultKey, null, 'an ordinary note'),
      vaultId,
      scopesWith(vaultKey),
      new FakeVault(),
      new MemoryStateStore(),
    );

    const report = await engine.sync();
    assert.ok(report.pulled.some((p) => p.path === 'shared.md'), 'the ordinary note pulled under the vault scope');
  });
});
