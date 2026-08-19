/**
 * The shared-folder marks module: the map, the reconcile guard, and the badge decision.
 *
 * The whole point of the module is that it is testable at its seam — Obsidian, the server
 * and the session are ports, so a test drives the module with fakes and asserts what it
 * does through what comes back. The two rules that used to hide in closures on the plugin
 * class, and that a two-account live walk paid for, are pinned here: the tree read is only
 * paid when the share list actually changed, and a re-materialised share (same id, new
 * root) still gets resolved rather than trusted by its id alone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  openSharedFolderMarks,
  type JoinedShareWire,
  type SharedFolderMarksDeps,
} from '../src/shared-folder-marks.js';

const share = (id: string, root: string | null, over: Partial<JoinedShareWire> = {}): JoinedShareWire => ({
  share_id: id,
  is_initiator: false,
  state: 'active',
  root_node_id: root,
  ...over,
});

const emptyDeps = (): SharedFolderMarksDeps & { saved: Record<string, string>[]; rendered: string[] } => {
  const saved: Record<string, string>[] = [];
  const rendered: string[] = [];
  let map: Record<string, string> = {};
  return {
    load: () => map,
    save: async (m) => {
      map = { ...m };
      saved.push(m);
    },
    resolve: async () => new Map(),
    existing: (paths) => paths,
    render: (css) => rendered.push(css),
    saved,
    rendered,
  };
};

describe('shared folder marks', () => {
  it('resolves on the first reconcile even when nothing has been stored yet', async () => {
    // A vault whose map predates the feature is exactly the state that needs fixing: the
    // guard must not trust a missing map as "nothing to do", or the participant in a live
    // test would stay badge-less while the initiator had one.
    const deps = emptyDeps();
    let resolves = 0;
    deps.resolve = async () => {
      resolves++;
      return new Map([['s1', 'Notes']]);
    };

    const marks = openSharedFolderMarks(deps);
    const rows = await marks.reconcile([share('s1', 'root1')]);

    assert.equal(resolves, 1, 'the first reconcile reads the tree');
    assert.deepEqual(rows, [{ shareId: 's1', isInitiator: false, state: 'active', folder: 'Notes' }]);
    assert.deepEqual(deps.saved, [{ s1: 'Notes' }], 'and the answer is written down for the next startup');
  });

  it('skips the tree read while the share list is unchanged', async () => {
    const deps = emptyDeps();
    let resolves = 0;
    deps.resolve = async (joined) => {
      resolves++;
      return new Map(joined.map((s) => [s.share_id, `Folder ${s.share_id}`]));
    };

    const marks = openSharedFolderMarks(deps);
    const first = await marks.reconcile([share('a', 'r1'), share('b', 'r2')]);
    const second = await marks.reconcile([share('a', 'r1'), share('b', 'r2')]);

    assert.equal(resolves, 1, 'the second reconcile pays nothing');
    assert.deepEqual(second, first, 'and answers identically, from the stored map');
  });

  it('resolves again when the same share changes its root node', async () => {
    // The guard compares share_id:root_node_id pairs, not ids alone — a re-materialised
    // share keeps its id but lands at a new node, and the badge must follow the folder.
    const deps = emptyDeps();
    let resolves = 0;
    deps.resolve = async (joined) => {
      resolves++;
      return new Map(joined.map((s) => [s.share_id, `Folder ${s.share_id}`]));
    };

    const marks = openSharedFolderMarks(deps);
    await marks.reconcile([share('s', 'oldRoot')]);
    await marks.reconcile([share('s', 'newRoot')]);

    assert.equal(resolves, 2, 'a new root is a new fact, however unchanged the id');
  });

  it('resolves again when a stored folder is renamed, though no server fact moved', async () => {
    // Nothing on the server changes when a folder is renamed — the share, its id and its
    // root node are all the same — so the pair guard alone would never notice, and the
    // badge would stay filtered out until the settings screen happened to repair it. The
    // badge has to follow the folder, so a stored path that vanished from disk counts.
    const deps = emptyDeps();
    let resolves = 0;
    let path = 'Old/Place';
    deps.existing = (paths) => paths.filter((p) => p === path);
    deps.resolve = async () => {
      resolves++;
      return new Map([['s1', path]]);
    };

    const marks = openSharedFolderMarks(deps);
    await marks.reconcile([share('s1', 'r1')]);
    const before = resolves;
    await marks.reconcile([share('s1', 'r1')]);
    assert.equal(resolves, before, 'while the stored path is still on disk, the guard holds');

    path = 'New/s1';
    const rows = await marks.reconcile([share('s1', 'r1')]);

    assert.equal(resolves, before + 1, 'a vanished path is as much a reason to re-resolve as a new root');
    assert.deepEqual(rows, [{ shareId: 's1', isInitiator: false, state: 'active', folder: 'New/s1' }]);
  });

  it('resolves again when a share is added or ends', async () => {
    const deps = emptyDeps();
    let resolves = 0;
    deps.resolve = async (joined) => {
      resolves++;
      return new Map(joined.map((s) => [s.share_id, `Folder ${s.share_id}`]));
    };

    const marks = openSharedFolderMarks(deps);
    await marks.reconcile([share('a', 'r1')]);
    await marks.reconcile([share('a', 'r1'), share('b', 'r2')]);
    await marks.reconcile([share('a', 'r1')]);

    assert.equal(resolves, 3, 'both a newcomer and a departed share change the set');
  });

  it('reports a share without a folder as a row without one', async () => {
    const deps = emptyDeps();
    const marks = openSharedFolderMarks(deps);

    const rows = await marks.reconcile([share('s', null)]);

    assert.deepEqual(rows, [{ shareId: 's', isInitiator: false, state: 'active' }], 'folder stays absent');
  });

  it('renders the badge after every change, from the paths that exist on disk', async () => {
    const deps = emptyDeps();
    deps.existing = (paths) => paths.filter((p) => p !== 'Gone');
    const marks = openSharedFolderMarks(deps);

    await marks.reconcile([share('a', 'r1')]);
    await marks.remember('b', 'Notes');
    await marks.forget('a');
    await marks.applyMarks();

    assert.ok(deps.rendered.at(-1)?.includes('data-path="Notes"'), 'only the live folder is still marked');
    assert.ok(!deps.rendered.at(-1)?.includes('Gone'), 'a folder that left disk is not marked');
    assert.equal(deps.saved.at(-1)?.['a'], undefined, 'forget takes the share out of the stored map');
  });

  it('clears everything on disconnect, including the guard state', async () => {
    const deps = emptyDeps();
    let resolves = 0;
    deps.resolve = async (joined) => {
      resolves++;
      return new Map(joined.map((s) => [s.share_id, `Folder ${s.share_id}`]));
    };
    const marks = openSharedFolderMarks(deps);

    await marks.reconcile([share('a', 'r1')]);
    await marks.clear();

    assert.deepEqual(deps.saved.at(-1), {}, 'nothing is shared from here any more');
    await marks.reconcile([share('a', 'r1')]);
    assert.equal(resolves, 2, 'and the reset guard does not trust the pre-disconnect map');
  });
});
