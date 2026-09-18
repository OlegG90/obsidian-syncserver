/**
 * Deduplication inside a shared folder (#376).
 *
 * A content tag is `HMAC(scope key, plaintext hash)`, and a file inside a share is written under `KS` —
 * its envelope, its name and its tag. The engine used to ask the server with a tag taken under `KV` for
 * every file, which nothing inside a share had ever stored, so every such file missed and was sealed and
 * uploaded again. What is pinned here is the question the engine asks, because that is where it went
 * wrong: the tag it sends for a file under a share is the one the share wrote.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Change, Delta, OpenedVault } from '@syncserver/shared';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, utf8 } from '../src/crypto/bytes.js';
import { dedupTag, encryptName, wrapContentKey } from '../src/crypto/scope.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { SyncEngine } from '../src/engine/engine.js';
import { MemoryStateStore } from '../src/engine/state.js';
import type { VaultWire } from '../src/engine/wire.js';
import type { CursorRejected, CursorUnverifiable, Envelope, PutConflict } from '../src/api/client.js';
import { VaultScopes } from '../src/share-keys.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const vaultScopeId = 'scope-vault';
const shareScopeId = 'scope-share';
const shareId = '33333333-3333-4333-8333-333333333333';
const CONTENT = 'the same bytes on both sides';

const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 1,
  scopes: [{ scope: 'vault', key_id: vaultScopeId }],
};

/** The vault's scopes with the share key delivered, built the way the plugin builds them. */
const scopesWith = (vaultKey: Uint8Array, shareKey: Uint8Array): VaultScopes =>
  VaultScopes.open(
    {
      ...opened,
      scopes: [
        ...opened.scopes,
        { scope: 'share', key_id: shareScopeId, share_id: shareId, wrapped_key: wrapShareKey(vaultKey, shareKey), wrapping: 'vault' },
      ],
    },
    { vaultKey, openIdentity: () => randomBytes(32), userId: 'user' },
  );

/** A server holding one shared folder with one note in it, recording every tag it is asked about. */
class ShareWire implements VaultWire {
  readonly asked: string[] = [];
  private readonly sealed = sealBlob(utf8(CONTENT));

  constructor(
    private readonly vaultKey: Uint8Array,
    private readonly shareKey: Uint8Array,
  ) {}

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const at = new Date(1).toISOString();
    return {
      snapshot: 'cursor',
      nodes: [
        { node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null, op: 'put', rev: 1, sha256: null, size: null, mtime: at, share_id: null, author_id: null },
        // The share root keeps its label under `KV` (SH-01); its interior is named under `KS`.
        {
          node_id: 'folder', parent_id: rootNodeId, name_enc: encryptName(this.vaultKey, 'shared'), name_hmac: '',
          name_key_id: vaultScopeId, op: 'put', rev: 2, sha256: null, size: null, mtime: at, share_id: shareId, author_id: null,
        },
        {
          node_id: 'note', parent_id: 'folder', name_enc: encryptName(this.shareKey, 'note.md'), name_hmac: '',
          name_key_id: shareScopeId, op: 'put', rev: 3, sha256: this.sealed.sha256, size: this.sealed.bytes.length,
          mtime: at, share_id: shareId, author_id: null,
        },
      ],
    };
  }

  async dedupLookup(_vaultId: string, tags: string[]): Promise<Map<string, string>> {
    this.asked.push(...tags);
    return new Map();
  }

  async getBlob(): Promise<Uint8Array | undefined> {
    return this.sealed.bytes;
  }

  async blobKeys(): Promise<Map<string, Envelope[]>> {
    const wrappedKey = wrapContentKey(this.shareKey, this.sealed.contentKey);
    return new Map([[this.sealed.sha256, [{ sha256: this.sealed.sha256, scopeId: shareScopeId, wrappedKey }]]]);
  }

  async putBlob(): Promise<{ sha256: string; size: number }> {
    throw new Error('unexpected');
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

describe('deduplication inside a shared folder', () => {
  it('asks the server with the tag the share writes, not one under the vault key', async () => {
    const vaultKey = randomBytes(32);
    const shareKey = randomBytes(32);
    const wire = new ShareWire(vaultKey, shareKey);
    const vault = new FakeVault();
    // The same note on this device, not yet known to it: exactly what adopting a shared folder meets.
    vault.seed('shared/note.md', CONTENT);

    const engine = new SyncEngine(wire, vaultId, scopesWith(vaultKey, shareKey), vault, new MemoryStateStore());
    await engine.sync();

    assert.ok(wire.asked.includes(dedupTag(shareKey, utf8(CONTENT))), 'the tag under the share key was asked');
    assert.ok(
      !wire.asked.includes(dedupTag(vaultKey, utf8(CONTENT))),
      'and not the one under the vault key, which nothing inside the share ever stored',
    );
  });
});
