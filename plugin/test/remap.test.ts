/**
 * The rewrite a folder move leaves in the walk's two views.
 *
 * These were two private methods reaching into a pass's context, and the only way to ask them anything
 * was to stage a whole sync and read the answer off what got uploaded. The cases below are the ones that
 * shape had made expensive to check — a move to the vault root, a move INTO a folder, and a path that
 * merely starts with the same letters.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { remapState, remapTree } from '../src/engine/remap.js';
import type { ServerNode } from '../src/engine/wire.js';

const node = (path: string, rev = 1): ServerNode => ({
  nodeId: `id-${path}`,
  parentId: null,
  path,
  rev,
  address: null,
  isFile: !path.endsWith('/') && path.includes('.'),
  nameKeyId: null,
});

const treeOf = (...paths: string[]): Map<string, ServerNode> => new Map(paths.map((p) => [p, node(p)]));

describe('rewriting the walked tree after a folder move', () => {
  it('moves the folder and everything under it', () => {
    const out = remapTree(treeOf('a', 'a/one.md', 'a/deep/two.md'), 'a', 'b', 9);
    assert.deepEqual([...out.keys()].sort(), ['b', 'b/deep/two.md', 'b/one.md']);
    assert.equal(out.get('b/one.md')!.path, 'b/one.md', 'the node carries its new path, not only its key');
  });

  it('gives the new revision to the folder and to nothing else', () => {
    // The server just moved the folder, so the pass's copy of ITS rev is one behind; the children were
    // not written, and handing them a rev they never had would make the next write a conflict.
    const out = remapTree(treeOf('a', 'a/one.md'), 'a', 'b', 9);
    assert.equal(out.get('b')!.rev, 9);
    assert.equal(out.get('b/one.md')!.rev, 1);
  });

  it('leaves a path that merely starts with the same letters alone', () => {
    // `about/` is not inside `a/`, and a prefix compared without the separator would move it.
    const out = remapTree(treeOf('a', 'a/one.md', 'about', 'about/three.md'), 'a', 'b', 2);
    assert.ok(out.has('about/three.md'));
    assert.equal(out.has('b/three.md'), false);
  });

  it('handles a move to the vault root, where the destination is empty', () => {
    // `''` must not become `'/'` — the root is the one path that is not a name.
    const out = remapTree(treeOf('nested/a', 'nested/a/one.md'), 'nested/a', 'a', 3);
    assert.deepEqual([...out.keys()].sort(), ['a', 'a/one.md']);
  });

  it('handles a move INTO a folder, which is the same rewrite the other way', () => {
    const out = remapTree(treeOf('a', 'a/one.md'), 'a', 'kept/a', 4);
    assert.deepEqual([...out.keys()].sort(), ['kept/a', 'kept/a/one.md']);
  });
});

describe('rewriting what this device remembers', () => {
  const known = { nodeId: 'n', rev: 1, address: 'x', plainHash: 'h' };

  it('follows the files to their new paths', () => {
    const out = remapState({ 'a/one.md': known, other: known }, 'a', 'b');
    assert.deepEqual(Object.keys(out).sort(), ['b/one.md', 'other']);
  });

  it('keeps what it knows about each file unchanged', () => {
    // The move changed where, not what: a rewritten rev or hash here would make the next pass believe
    // the file had been edited by somebody else.
    const out = remapState({ 'a/one.md': known }, 'a', 'b');
    assert.deepEqual(out['b/one.md'], known);
  });
});
