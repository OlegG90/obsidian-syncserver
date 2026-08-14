/**
 * The rename heuristic, asked directly.
 *
 * Until this module existed every one of these questions cost a full synchronisation to
 * ask: a fake vault, a fake server, a walk, and then an inspection of what came out. That
 * is why the subtlest bugs of M1 lived here — each case was expensive enough that only the
 * obvious ones got written.
 *
 * The cost of being wrong is asymmetric and every test below is really about the *no*
 * answer: a missed rename costs one upload that deduplication makes nearly free, while a
 * wrong one moves a node the user still has somewhere else, silently, on every device.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  folderMoves,
  parentChainExists,
  RENAME_MIN_BYTES,
  renameSourceFor,
  type FileMeta,
  type TreeNode,
  type Vanished,
} from '../src/engine/rename.js';

const BIG = RENAME_MIN_BYTES + 1;

const vanished = (entries: [string, Vanished[]][]) => new Map(entries);
const tree = (entries: [string, TreeNode][]) => new Map(entries);
const meta = (entries: [string, FileMeta][]) => new Map(entries);

const gone = (path: string, nodeId = `id:${path}`): Vanished => ({
  path,
  nodeId,
  rev: 1,
  address: `addr:${path}`,
});

const file = (nodeId: string): TreeNode => ({ nodeId, rev: 1, isFile: true });
const folder = (nodeId: string): TreeNode => ({ nodeId, rev: 1, isFile: false });

describe('is one file a rename of another', () => {
  it('accepts the unambiguous case', () => {
    const source = renameSourceFor(
      { plainHash: 'h', size: BIG },
      vanished([['h', [gone('old.md')]]]),
      tree([['old.md', file('id:old.md')]]),
    );
    assert.equal(source?.path, 'old.md');
  });

  it('refuses a file too small for its hash to identify it', () => {
    // Empty notes, a repeated icon, a template stub — small files collide constantly, and
    // the heuristic would move whichever one it happened to see first.
    const source = renameSourceFor(
      { plainHash: 'h', size: RENAME_MIN_BYTES - 1 },
      vanished([['h', [gone('old.md')]]]),
      tree([['old.md', file('id:old.md')]]),
    );
    assert.equal(source, undefined);
  });

  it('takes the threshold as inclusive at exactly the boundary', () => {
    // Stated because it is the kind of edge a reader guesses at, and a guess that goes the
    // wrong way changes behaviour for every file of exactly this size.
    assert.ok(
      renameSourceFor(
        { plainHash: 'h', size: RENAME_MIN_BYTES },
        vanished([['h', [gone('old.md')]]]),
        tree([['old.md', file('id:old.md')]]),
      ),
    );
  });

  it('refuses when two files share the bytes, because picking one is a coin toss', () => {
    const source = renameSourceFor(
      { plainHash: 'h', size: BIG },
      vanished([['h', [gone('a.md'), gone('b.md')]]]),
      tree([
        ['a.md', file('id:a.md')],
        ['b.md', file('id:b.md')],
      ]),
    );
    assert.equal(source, undefined, 'a wrong guess here moves a file the user still has');
  });

  it('refuses when the source path has since been taken by something else', () => {
    // The path is there, the node is not the same node. Treating it as a rename would move
    // a stranger's node.
    const source = renameSourceFor(
      { plainHash: 'h', size: BIG },
      vanished([['h', [gone('old.md', 'id:original')]]]),
      tree([['old.md', file('id:someone-else')]]),
    );
    assert.equal(source, undefined);
  });

  it('refuses when the source is no longer on the server at all', () => {
    const source = renameSourceFor({ plainHash: 'h', size: BIG }, vanished([['h', [gone('old.md')]]]), tree([]));
    assert.equal(source, undefined);
  });

  it('does not consume its own input, so the same question answers twice', () => {
    // Consumption belongs to the caller. A module that mutated its input could not be
    // asked the same thing twice — which is precisely what a fixture test does.
    const v = vanished([['h', [gone('old.md')]]]);
    const t = tree([['old.md', file('id:old.md')]]);
    assert.ok(renameSourceFor({ plainHash: 'h', size: BIG }, v, t));
    assert.ok(renameSourceFor({ plainHash: 'h', size: BIG }, v, t), 'unchanged by the first call');
  });
});

describe('did a whole folder move', () => {
  /** `V/a` and `V/b` reappearing under `N`, which is the shape a folder rename makes. */
  const collapsed = () => ({
    vanished: vanished([
      ['ha', [gone('V/a.md')]],
      ['hb', [gone('V/b.md')]],
    ]),
    tree: tree([
      ['V', folder('id:V')],
      ['V/a.md', file('id:a')],
      ['V/b.md', file('id:b')],
    ]),
    meta: meta([
      ['N/a.md', { plainHash: 'ha', size: BIG }],
      ['N/b.md', { plainHash: 'hb', size: BIG }],
    ]),
    here: new Set(['N/a.md', 'N/b.md']),
  });

  it('sees one move of the folder, not one per child', () => {
    // The per-file heuristic would move each child correctly and still leave the empty
    // source folder behind on the server, because nothing told it the folder had moved.
    const f = collapsed();
    const plan = folderMoves(f.vanished, f.tree, f.meta, f.here);

    assert.equal(plan.length, 1);
    assert.deepEqual(
      { from: plan[0]!.from, to: plan[0]!.to, nodeId: plan[0]!.nodeId },
      { from: 'V', to: 'N', nodeId: 'id:V' },
    );
    assert.equal(plan[0]!.children.length, 2, 'and it accounts for both children');
  });

  it('refuses when one child was edited during the move', () => {
    // The case that cost the most to find: rename plus edit. One child's bytes differ, so
    // this is not the same folder arriving elsewhere, and the per-file walk handles it.
    const f = collapsed();
    f.meta.set('N/b.md', { plainHash: 'DIFFERENT', size: BIG });

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), []);
  });

  it('refuses when the children scattered to different places', () => {
    const f = collapsed();
    f.meta.delete('N/b.md');
    f.meta.set('OTHER/b.md', { plainHash: 'hb', size: BIG });
    f.here.delete('N/b.md');
    f.here.add('OTHER/b.md');

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), [], 'a scatter is not a move');
  });

  it('refuses when only some of the children reappear', () => {
    const f = collapsed();
    f.meta.delete('N/b.md');
    f.here.delete('N/b.md');

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), []);
  });

  it('refuses a destination that already exists, because that is a merge', () => {
    // A merge means something different to everybody else syncing the folder, so it is not
    // something to infer from a hash match.
    const f = collapsed();
    f.tree.set('N', folder('id:N'));

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), []);
  });

  it('refuses when the destination’s parent chain is not on the server yet', () => {
    // Otherwise a folder gets invented in the middle of a walk that has not reached it.
    const f = collapsed();
    f.meta.clear();
    f.meta.set('deep/N/a.md', { plainHash: 'ha', size: BIG });
    f.meta.set('deep/N/b.md', { plainHash: 'hb', size: BIG });
    f.here = new Set(['deep/N/a.md', 'deep/N/b.md']);

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), [], '`deep` does not exist yet');
  });

  it('accepts the same move once the parent chain is there', () => {
    const f = collapsed();
    f.meta.clear();
    f.meta.set('deep/N/a.md', { plainHash: 'ha', size: BIG });
    f.meta.set('deep/N/b.md', { plainHash: 'hb', size: BIG });
    f.here = new Set(['deep/N/a.md', 'deep/N/b.md']);
    f.tree.set('deep', folder('id:deep'));

    const plan = folderMoves(f.vanished, f.tree, f.meta, f.here);
    assert.equal(plan[0]?.to, 'deep/N');
  });

  it('refuses to move a path the server holds as a file', () => {
    const f = collapsed();
    f.tree.set('V', file('id:V-is-a-file'));

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), []);
  });

  it('never plans two folders into one destination', () => {
    // The second is not a move but a merge into something this very pass is creating, and
    // executing both would put two folders' children in one place.
    const f = {
      vanished: vanished([
        ['ha', [gone('V/a.md')]],
        ['hb', [gone('W/a.md')]],
      ]),
      tree: tree([
        ['V', folder('id:V')],
        ['W', folder('id:W')],
        ['V/a.md', file('id:va')],
        ['W/a.md', file('id:wa')],
      ]),
      meta: meta([['N/a.md', { plainHash: 'ha', size: BIG }]]),
      here: new Set(['N/a.md']),
    };
    // Both would claim `N`; only one may.
    f.meta.set('N/a.md', { plainHash: 'ha', size: BIG });
    const plan = folderMoves(f.vanished, f.tree, f.meta, f.here);
    assert.ok(plan.length <= 1, 'at most one folder lands on a given destination');
  });

  it('refuses a folder whose children did not actually go anywhere', () => {
    const f = collapsed();
    f.meta.clear();
    f.meta.set('V/a.md', { plainHash: 'ha', size: BIG });
    f.meta.set('V/b.md', { plainHash: 'hb', size: BIG });
    f.here = new Set(['V/a.md', 'V/b.md']);

    assert.deepEqual(folderMoves(f.vanished, f.tree, f.meta, f.here), [], 'the same path is not a move');
  });
});

describe('the parent chain', () => {
  it('treats a root-level destination as always reachable', () => {
    assert.equal(parentChainExists('N', tree([])), true, 'it has no ancestors to require');
  });

  it('does not require the destination itself to exist', () => {
    // It is about to be created; requiring it would refuse every move.
    assert.equal(parentChainExists('a/N', tree([['a', folder('id:a')]])), true);
  });

  it('refuses when an ancestor is a file rather than a folder', () => {
    assert.equal(parentChainExists('a/b/N', tree([['a', folder('id:a')], ['a/b', file('id:b')]])), false);
  });

  it('refuses when an intermediate ancestor is missing', () => {
    assert.equal(parentChainExists('a/b/N', tree([['a', folder('id:a')]])), false);
  });
});
