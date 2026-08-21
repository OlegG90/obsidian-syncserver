/**
 * What may be offered as a folder to share.
 *
 * The rule that matters here is not the one about typing: it is that a share may not overlap
 * another in either direction. The schema enforces it with a trigger
 * (`nodes_check_share_membership`), and a trigger's answer is a check violation — so anything
 * this list offers by mistake fails in the one place nobody can act on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { holdsSynced, nothingToShare, shareableFolders } from '../src/shareable-folders.js';

const folders = ['Work', 'Work/Notes', 'Personal', 'Drafts'];
const synced = ['Work/Notes/a.md', 'Work/b.md', 'Personal/c.md'];

describe('a folder is offered when the server could root a share at it', () => {
  it('offers the folders that hold something synced, and nothing else', () => {
    // `Drafts` exists on disk and has never been uploaded. It was exactly the case whose
    // refusal — "the server does not know that folder yet" — was indistinguishable from a
    // typo, which is why it is absent rather than present-and-refused.
    assert.deepEqual(shareableFolders(folders, synced, []), ['Personal', 'Work', 'Work/Notes']);
  });

  it('never offers the vault root', () => {
    // Obsidian's folder list can carry it, and it is not a folder anybody means: it has no
    // name to show, and sharing it is sharing the vault, which is a different act.
    assert.deepEqual(shareableFolders(['', 'Work'], synced, []), ['Work']);
  });

  it('reads in the order a person would look for a name', () => {
    assert.deepEqual(shareableFolders(['Zeta', 'alpha', 'Beta'], ['Zeta/x', 'alpha/x', 'Beta/x'], []), [
      'alpha',
      'Beta',
      'Zeta',
    ]);
  });
});

describe('a share may not overlap another, in either direction', () => {
  it('drops the folder that is already shared', () => {
    assert.ok(!shareableFolders(folders, synced, ['Work']).includes('Work'));
  });

  it('drops a folder INSIDE a share', () => {
    // `nodes_check_share_membership`: a marked node whose parent is in a different share is
    // refused, so `Work/Notes` cannot start its own share while `Work` is one.
    assert.ok(!shareableFolders(folders, synced, ['Work']).includes('Work/Notes'));
  });

  it('drops a folder that CONTAINS a share — the direction people do not expect', () => {
    // The same trigger from the other side: marking `Work` leaves a child carrying a
    // different mark, which it calls an incompletely shared subtree. Nothing about the
    // screen suggests this, which is why it must not be offered.
    assert.ok(!shareableFolders(folders, synced, ['Work/Notes']).includes('Work'));
  });

  it('keeps the folders that merely share a prefix of a NAME', () => {
    // `Workshop` is not inside `Work`, and a `startsWith` without the separator would have
    // said it was. Two sibling folders whose names begin alike are ordinary.
    const near = ['Work', 'Workshop'];
    assert.deepEqual(shareableFolders(near, ['Work/a', 'Workshop/a'], ['Work']), ['Workshop']);
  });

  it('leaves everything unrelated alone', () => {
    assert.deepEqual(shareableFolders(folders, synced, ['Work']), ['Personal']);
  });
});

describe('holdsSynced is the predicate the refusal used, not a second one', () => {
  it('counts anything below the folder', () => {
    assert.ok(holdsSynced('Work', ['Work/Notes/a.md']));
  });

  it('counts the folder itself when the server knows it by that path', () => {
    assert.ok(holdsSynced('Work', ['Work']));
  });

  it('does not count a sibling with a longer name', () => {
    assert.ok(!holdsSynced('Work', ['Workshop/a.md']));
  });
});

describe('an empty list says which kind of empty it is', () => {
  it('is silent when there is something to offer', () => {
    assert.equal(nothingToShare(['Work'], folders, []), undefined);
  });

  it('separates "nothing synced" from "all of it is already shared"', () => {
    // Only one of the two is waiting on a sync. Collapsing them into "nothing to share"
    // would send somebody to run a sync that changes nothing.
    assert.match(nothingToShare([], folders, [])!, /has been synced yet/);
    assert.match(nothingToShare([], folders, ['Work', 'Personal'])!, /already in a share/);
  });

  it('says so plainly when the vault has no folders at all', () => {
    assert.match(nothingToShare([], [], [])!, /no folders yet/);
  });
});
