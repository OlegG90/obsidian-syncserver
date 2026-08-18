/**
 * A shared folder this device cannot open must not stop the vault from syncing.
 *
 * The client deliberately drops share scopes whose key it cannot unwrap — one bad envelope
 * must not cost a vault its sync — and says so out loud. The engine then met those names in
 * the listing and threw, from the one place with no `try` around it and before a report
 * existed, so the promise that dropping them was safe was not kept: one undeliverable share
 * key stopped everything.
 *
 * Two things have to hold, and the second is the one that bites. The pass must finish, and
 * the unreadable folder must be **inert in both directions**: its nodes are not in the tree,
 * and the local files under it are not seen as files the server has never heard of. Without
 * the second, the contents of a share this device cannot read are re-uploaded as ordinary
 * notes under `KV` — the folder's own data, silently converted into something else.
 *
 * A share's root is named under `KV` (SH-01), which is what makes the exclusion possible at
 * all: the folder's path is readable even when nothing inside it is.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { priority, summary } from '../src/engine/report.js';
import type { Change, Delta, OpenedVault } from '@syncserver/shared';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, utf8 } from '../src/crypto/bytes.js';
import { encryptName, wrapContentKey } from '../src/crypto/scope.js';
import { SyncEngine } from '../src/engine/engine.js';
import { MemoryStateStore } from '../src/engine/state.js';
import type { VaultWire } from '../src/engine/wire.js';
import type { CursorRejected, Envelope, PutConflict, CursorUnverifiable } from '../src/api/client.js';
import { VaultScopes } from '../src/share-keys.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const vaultScopeId = 'scope-vault';
const shareScopeId = 'scope-share';
const shareId = '22222222-2222-4222-8222-222222222222';

const vaultKey = randomBytes(32);
/** The key this device never receives — the share is real, its envelope did not arrive. */
const shareKey = randomBytes(32);

/**
 * The vault as the server reports it: a share whose scope carries no wrapped key.
 *
 * That is what an undeliverable envelope looks like from here — the scope exists, and
 * `shareKeysFrom` has nothing to open.
 */
const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 3,
  scopes: [
    { scope: 'vault', key_id: vaultScopeId },
    { scope: 'share', key_id: shareScopeId, share_id: shareId },
  ],
};

const scopesOf = (): VaultScopes =>
  VaultScopes.open(opened, { vaultKey, openIdentity: () => randomBytes(32), userId: 'user' });

/**
 * A tree of three: an ordinary note, a shared folder, and a note inside it.
 *
 * The folder's name is under `KV` because a share root always is; the note inside it is
 * under `KS`, which this device holds no key for. Parents come before children, as the
 * server orders them.
 */
const ordinary = sealBlob(utf8('an ordinary note'));

class FakeWire implements VaultWire {
  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const change = (over: Partial<Change> & Pick<Change, 'node_id'>): Change => ({
      parent_id: rootNodeId, name_enc: null, name_hmac: null, name_key_id: null,
      op: 'put', rev: 1, sha256: null, size: null,
      mtime: new Date(0).toISOString(), share_id: null, author_id: null,
      ...over,
    });

    return {
      snapshot: 'cursor',
      nodes: [
        change({ node_id: rootNodeId, parent_id: null }),
        change({
          node_id: 'ordinary', name_enc: encryptName(vaultKey, 'ordinary.md'), rev: 2,
          sha256: ordinary.sha256, size: ordinary.bytes.length,
        }),
        // The share root: its own label is under KV, so this device can read it.
        change({ node_id: 'folder', name_enc: encryptName(vaultKey, 'Shared'), share_id: shareId, rev: 3 }),
        // Its interior: under KS, which never arrived.
        change({
          node_id: 'inside', parent_id: 'folder', name_key_id: shareScopeId,
          name_enc: encryptName(shareKey, 'inside.md'), share_id: shareId, rev: 4,
        }),
      ],
    };
  }

  async dedupLookup(): Promise<Map<string, string>> {
    return new Map();
  }

  async blobKeys(): Promise<Map<string, Envelope[]>> {
    return new Map([
      [ordinary.sha256, [{ sha256: ordinary.sha256, scopeId: vaultScopeId, wrappedKey: wrapContentKey(vaultKey, ordinary.contentKey) }]],
    ]);
  }

  async getBlob(): Promise<Uint8Array | undefined> {
    return ordinary.bytes;
  }

  // Anything below would mean the pass tried to change the server, which no assertion here wants.
  async putBlob(): Promise<{ sha256: string; size: number }> {
    throw new Error('the pass uploaded something');
  }

  async createNode(): Promise<{ node_id: string; rev: number }> {
    throw new Error('the pass created a node');
  }

  async putContent(): Promise<{ rev: number } | PutConflict> {
    throw new Error('the pass wrote content');
  }

  async moveNode(): Promise<{ rev: number }> {
    throw new Error('the pass moved a node');
  }

  async deleteNode(): Promise<{ rev: number }> {
    throw new Error('the pass deleted a node');
  }

  async delta(): Promise<Delta | CursorRejected | CursorUnverifiable> {
    throw new Error('unexpected');
  }
}

const engineOver = (vault: FakeVault): SyncEngine =>
  new SyncEngine(new FakeWire(), vaultId, scopesOf(), vault, new MemoryStateStore(), 'device', false);

describe('a shared folder this device cannot open', () => {
  it('does not stop the rest of the vault from syncing', async () => {
    const vault = new FakeVault();

    const report = await engineOver(vault).sync();

    assert.deepEqual(report.errors, [], 'nothing failed — the folder is unreachable, not broken');
    assert.deepEqual(report.pulled, [{ path: 'ordinary.md' }], 'the rest of the vault came down as usual');
    assert.equal(vault.contents('ordinary.md'), 'an ordinary note');
  });

  it('leaves the unreadable folder out of the tree, and its children with it', async () => {
    const tree = await engineOver(new FakeVault()).readTree();

    assert.ok(tree.has('Shared'), 'the share root is named under KV and stays readable');
    assert.equal(tree.has('inside.md'), false, 'a child of a skipped node must not land at the vault root');
    assert.equal([...tree.keys()].some((p) => p.endsWith('inside.md')), false, 'nor anywhere else');
  });

  it('names the folder once, and does not call the pass a failure', async () => {
    // Once per SHARE, not per file: one undelivered key makes every name inside unreadable
    // together, so counting nodes would report the same fact as many times as the folder has
    // files. And it is not a failure — everything that could sync did, and the key arrives by
    // a route no pass controls, so letting it dominate the mood would make "up to date" an
    // answer this vault could never reach again.
    const report = await engineOver(new FakeVault()).sync();

    assert.deepEqual(report.unreadable, [{ path: 'Shared', scopeId: shareScopeId }]);
    assert.notEqual(priority(report), 'failed', 'unreachable is not broken');
    assert.ok(summary(report).includes('1 folder unreadable'), 'and it is still said out loud');
  });

  it('does not push the local files inside it as new notes', async () => {
    // The trap this test exists for: the subtree is missing from the server tree, so an
    // unguarded pass sees local files the server has never heard of and uploads them — under
    // the VAULT key, turning the contents of a share into ordinary notes. Every write verb on
    // the wire throws, so a push of any kind fails this loudly.
    const vault = new FakeVault();
    vault.seed('Shared/inside.md', 'a note inside the folder this device cannot read');

    const report = await engineOver(vault).sync();

    assert.deepEqual(report.errors, [], 'and it is not an error either — it is simply not this pass’s business');
    assert.deepEqual(report.pushed, [], 'nothing inside the unreadable folder went up');
  });
});
