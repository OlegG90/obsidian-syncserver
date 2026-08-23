/**
 * A flat listing turned into paths (`tree.ts`).
 *
 * The server holds `name_enc` and no key, so every path in a vault is something this device works out.
 * These are the rules that were reachable only by running a pass against a live server: what happens
 * below a folder whose key never arrived, how many times one missing key is reported, and which nodes
 * count as files.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Change } from '@syncserver/shared';
import { encryptName } from '../src/crypto/scope.js';
import { treeFrom, type NameKeys } from '../src/engine/tree.js';

const VAULT_KEY = new Uint8Array(32).fill(1);
const SHARE_KEY = new Uint8Array(32).fill(2);
const ROOT = 'root-id';

/** Only the fields this transformation reads; the rest of a `Change` is another pass's business. */
const node = (id: string, parent: string | null, name: string, key: Uint8Array, opts: Partial<Change> = {}): Change =>
  ({
    node_id: id,
    parent_id: parent,
    name_enc: encryptName(key, name),
    name_key_id: key === VAULT_KEY ? 'vault-scope' : 'share-scope',
    rev: 1,
    sha256: null,
    share_id: null,
    ...opts,
  }) as Change;

/** A device that holds the vault key and, unless told otherwise, no share keys. */
const keys = (openable: Record<string, Uint8Array> = {}): NameKeys => ({
  vaultKey: VAULT_KEY,
  keyIfOpenable: (id) => (id === 'vault-scope' ? VAULT_KEY : openable[id ?? '']),
});

describe('working the paths out', () => {
  it('hangs each name off its parent, with the root children unprefixed', () => {
    const out = treeFrom(
      [node('a', ROOT, 'notes', VAULT_KEY), node('b', 'a', 'one.md', VAULT_KEY, { sha256: 'addr' })],
      ROOT,
      keys(),
    );
    assert.deepEqual([...out.tree.keys()].sort(), ['notes', 'notes/one.md']);
  });

  it('calls a node with an address a file and one without a folder', () => {
    // The server does not label them, and asking it to would be asking it to know something about
    // content it cannot see.
    const out = treeFrom(
      [node('a', ROOT, 'notes', VAULT_KEY), node('b', 'a', 'one.md', VAULT_KEY, { sha256: 'addr' })],
      ROOT,
      keys(),
    );
    assert.equal(out.tree.get('notes')!.isFile, false);
    assert.equal(out.tree.get('notes/one.md')!.isFile, true);
  });

  it('skips the root itself rather than giving it a path', () => {
    const out = treeFrom([node(ROOT, null, 'ignored', VAULT_KEY)], ROOT, keys());
    assert.equal(out.tree.size, 0);
  });
});

describe('a folder whose key has not arrived', () => {
  const shared = (): Change[] => [
    node('s', ROOT, 'Shared', VAULT_KEY),
    node('x', 's', 'inner', SHARE_KEY),
    node('y', 'x', 'deep.md', SHARE_KEY, { sha256: 'addr' }),
  ];

  it('reports the folder once, and its scope rather than its nodes', () => {
    // One missing key is one thing to fix. A list per node would be the same fact repeated as many
    // times as the folder has files.
    const out = treeFrom(shared(), ROOT, keys());
    assert.deepEqual(out.unreadable, [{ path: 'Shared', scopeId: 'share-scope' }]);
  });

  it('leaves everything below it out of the tree, not only the node it could not name', () => {
    // The cascade: a node under something unnamed has no path to be built from either.
    const out = treeFrom(shared(), ROOT, keys());
    assert.deepEqual([...out.tree.keys()], ['Shared']);
  });

  it('reads the whole thing once the key is there', () => {
    const out = treeFrom(shared(), ROOT, keys({ 'share-scope': SHARE_KEY }));
    assert.deepEqual([...out.tree.keys()].sort(), ['Shared', 'Shared/inner', 'Shared/inner/deep.md']);
    assert.deepEqual(out.unreadable, []);
  });

  it('does not let a child of an unnamed folder surface at the vault root', () => {
    // The cascade, and the failure it prevents. Without it a node whose parent has no path takes the
    // empty parent path — and a file that lives three folders deep appears at the top of the vault,
    // which the next pass would faithfully upload as a new file there.
    const out = treeFrom(
      [
        node('s', ROOT, 'Shared', VAULT_KEY),
        node('x', 's', 'inner', SHARE_KEY),
        // Named under a key this device HAS, but sitting under a folder it could not name.
        node('y', 'x', 'stray.md', VAULT_KEY, { sha256: 'addr' }),
      ],
      ROOT,
      keys(),
    );
    assert.equal(out.tree.has('stray.md'), false, 'it must not land at the root');
    assert.deepEqual([...out.tree.keys()], ['Shared']);
  });

  it('reports one entry per scope even when several folders are named under it', () => {
    // One undelivered key is one thing to fix, however many folders it happens to name.
    const out = treeFrom(
      [
        node('s', ROOT, 'Shared', VAULT_KEY),
        node('a', 's', 'first', SHARE_KEY),
        node('b', 's', 'second', SHARE_KEY),
      ],
      ROOT,
      keys(),
    );
    assert.equal(out.unreadable.length, 1);
    assert.equal(out.unreadable[0]!.scopeId, 'share-scope');
  });

  it('never reports the vault root as unreadable', () => {
    // An empty parent path would mean excluding the whole vault, which no missing share key can
    // justify — so the guard holds even for a listing that should not exist.
    const out = treeFrom([node('x', ROOT, 'orphan', SHARE_KEY)], ROOT, keys());
    assert.deepEqual(out.unreadable, []);
    assert.equal(out.tree.size, 0);
  });
});
