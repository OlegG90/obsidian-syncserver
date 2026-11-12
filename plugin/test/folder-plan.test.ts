/**
 * The folder plan, asked directly.
 *
 * Each case here used to need a fake vault, a fake server and a whole pass, because the rule lived
 * between two server calls and read the disk itself (#409, #412, #417, #419). The disk is now one
 * set handed in, so a case is a fixture and an assertion. `engine-share-boundary.test.ts` still
 * proves the engine carries the plan out; this file proves the plan.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldersToAsk, planFolders, type FolderPlanInput, type PlanNode } from '../src/engine/folder-plan.js';
import type { FolderMove, Vanished } from '../src/engine/rename.js';

const SHARE = 's1';
const KV = 'kv';
const KS = 'ks';

const gone = (path: string): Vanished => ({ path, nodeId: `id:${path}`, rev: 1, address: `addr:${path}` });
const folder = (path: string, extra: Partial<PlanNode> = {}): [string, PlanNode] => [
  path,
  { nodeId: `id:${path}`, rev: 1, isFile: false, nameKeyId: KV, ...extra },
];
const file = (path: string, extra: Partial<PlanNode> = {}): [string, PlanNode] => [
  path,
  { nodeId: `id:${path}`, rev: 1, isFile: true, nameKeyId: KV, ...extra },
];
/** A share root: in the share, named under the holder's own key (SH-01). */
const root = (path: string): [string, PlanNode] => folder(path, { shareId: SHARE, nameKeyId: KV });
const inShare = (path: string): [string, PlanNode] => file(path, { shareId: SHARE, nameKeyId: KS });

/**
 * A vault whose shared folder `Team` held `a.md` and `b.md`, both gone from where they were.
 *
 * `here` is what is on disk now, and doubles as the queue: every local file is new to this device
 * unless `known` says otherwise, which is what a file turning up somewhere else looks like.
 */
const world = (here: string[], over: Partial<FolderPlanInput> = {}): FolderPlanInput => {
  const tree = new Map<string, PlanNode>([root('Team'), inShare('Team/a.md'), inShare('Team/b.md'), folder('Notes')]);
  const vanished = new Map([
    ['ha', [gone('Team/a.md')]],
    ['hb', [gone('Team/b.md')]],
  ]);
  return {
    vanished,
    tree,
    byNodeId: new Map([...tree].map(([path, n]) => [n.nodeId, { path }])),
    here: new Set(here),
    queue: here,
    known: new Set(['Team/a.md', 'Team/b.md']),
    shareScopes: new Map([[SHARE, KS]]),
    ...over,
  };
};

const move = (from: string, to: string): FolderMove => ({ from, to, nodeId: `id:${from}`, rev: 1, children: [] });

describe('folder moves and the disk (#419, #421)', () => {
  it('drops a move whose source folder is still on disk', () => {
    const plan = planFolders([move('Notes', 'Elsewhere')], world([]), new Set(['Notes']));
    assert.deepEqual(plan.moves, []);
  });

  it('keeps a move whose source is gone', () => {
    const m = move('Notes', 'Elsewhere');
    assert.deepEqual(planFolders([m], world([]), new Set()).moves, [m]);
  });

  it('keeps a change of letter case, which a case-blind disk still answers to by its old name', () => {
    const m = move('Notes', 'notes');
    assert.deepEqual(planFolders([m], world([]), new Set(['Notes'])).moves, [m]);
  });

  it('asks about move sources except case-only ones, and about share roots emptied here', () => {
    const asked = foldersToAsk([move('Notes', 'Elsewhere'), move('Old', 'old')], world([]));
    assert.deepEqual(asked.sort(), ['Notes', 'Team']);
  });

  it('does not ask about a share root that still has files here', () => {
    assert.deepEqual(foldersToAsk([], world(['Team/a.md'])), []);
  });
});

describe('a share root emptied with no move to explain it is held (#409, #412)', () => {
  it('holds it when its files turned up in a folder the server has never seen', () => {
    const plan = planFolders([], world(['Renamed/a.md', 'Renamed/b.md']), new Set());
    assert.equal(plan.held.length, 1);
    const [hold] = plan.held;
    assert.equal(hold!.root, 'Team');
    assert.deepEqual(hold!.claimed.map((v) => v.path).sort(), ['Team/a.md', 'Team/b.md']);
    assert.deepEqual(hold!.outOfWalk.sort(), ['Renamed/a.md', 'Renamed/b.md']);
    assert.equal(hold!.mergeInto, undefined);
    assert.deepEqual(plan.restored, [], 'a held root has nothing left to put back');
  });

  it('does not hold files dropped into folders the server already has — they left on purpose (#402)', () => {
    const plan = planFolders([], world(['Notes/a.md', 'Notes/b.md']), new Set());
    assert.deepEqual(plan.held, []);
  });

  it('holds a regrouping under a folder of its own name the server already has, as a merge (#412)', () => {
    const input = world(['Archive/Team/a.md', 'Archive/Team/b.md']);
    const tree = new Map(input.tree);
    tree.set(...folder('Archive'));
    tree.set(...folder('Archive/Team'));
    const plan = planFolders([], { ...input, tree }, new Set());
    assert.equal(plan.held[0]?.mergeInto, 'Archive/Team');
  });

  it('does not hold a root still on disk: it was emptied, not moved (#419)', () => {
    const plan = planFolders([], world(['Renamed/a.md', 'Renamed/b.md']), new Set(['Team']));
    assert.deepEqual(plan.held, []);
  });

  it('leaves a root a planned move accounts for — moved itself, or inside a folder that moved', () => {
    for (const m of [move('Team', 'Renamed'), move('Team/sub', 'Elsewhere')]) {
      const plan = planFolders([m], world(['Renamed/a.md', 'Renamed/b.md']), new Set());
      assert.deepEqual(plan.held, [], `${m.from} → ${m.to}`);
    }
  });

  it('leaves a root inside a folder that moved: the move carries it along', () => {
    const tree = new Map<string, PlanNode>([folder('Area'), root('Area/Team'), inShare('Area/Team/a.md')]);
    const input = world(['Zone/Team/a.md'], {
      tree,
      vanished: new Map([['ha', [gone('Area/Team/a.md')]]]),
      byNodeId: new Map([...tree].map(([path, n]) => [n.nodeId, { path }])),
      known: new Set(['Area/Team/a.md']),
    });
    const plan = planFolders([move('Area', 'Zone')], input, new Set());
    assert.deepEqual([plan.held, plan.restored], [[], []]);
  });
});

describe('each decision sees what the previous one left', () => {
  it('a file one held root keeps out of the walk is no longer evidence that another root moved', () => {
    // `Club` lost its own `a.md`. The only `a.md` that turned up is `Team`'s, under a folder the
    // server has never seen — so `Team` is held, and once its files are out of the walk nothing
    // says `Club`'s went anywhere: it was deleted as a folder, and comes back.
    const input = world(['Renamed/a.md', 'Renamed/b.md']);
    const tree = new Map(input.tree);
    tree.set(...folder('Club', { shareId: 's2', nameKeyId: KV }));
    tree.set(...file('Club/a.md', { shareId: 's2', nameKeyId: 'ks2' }));
    const vanished = new Map(input.vanished);
    vanished.set('hc', [gone('Club/a.md')]);
    const plan = planFolders(
      [],
      {
        ...input,
        tree,
        vanished,
        byNodeId: new Map([...tree].map(([path, n]) => [n.nodeId, { path }])),
        known: new Set([...input.known, 'Club/a.md']),
        shareScopes: new Map([...input.shareScopes, ['s2', 'ks2']]),
      },
      new Set(),
    );
    assert.deepEqual(plan.held.map((h) => h.root), ['Team']);
    assert.deepEqual(plan.restored.map((r) => r.root), ['Club']);
  });
});

describe('a share root deleted as a folder comes back (#417)', () => {
  it('puts back the files of a root gone from disk whose files turned up nowhere', () => {
    const plan = planFolders([], world([]), new Set());
    assert.equal(plan.restored.length, 1);
    assert.deepEqual(plan.restored[0]!.files.map((v) => v.path).sort(), ['Team/a.md', 'Team/b.md']);
  });

  it('puts nothing back when the root is still on disk — its files were deleted one by one (SH-10)', () => {
    assert.deepEqual(planFolders([], world([]), new Set(['Team'])).restored, []);
  });

  it('leaves a file the server shows somewhere else: renamed there, and #418 answers for it', () => {
    const input = world([]);
    const byNodeId = new Map(input.byNodeId);
    byNodeId.set('id:Team/a.md', { path: 'Team/moved.md' });
    const plan = planFolders([], { ...input, byNodeId }, new Set());
    assert.deepEqual(plan.restored[0]!.files.map((v) => v.path), ['Team/b.md']);
  });

  it('puts nothing back when its files turned up elsewhere — that is a move', () => {
    assert.deepEqual(planFolders([], world(['Notes/a.md']), new Set()).restored, []);
  });
});

describe('the plan reads its input and never changes it', () => {
  it('leaves the vanished set and the queue as they were', () => {
    const input = world(['Renamed/a.md', 'Renamed/b.md']);
    const before = { vanished: structuredClone([...input.vanished]), queue: [...input.queue] };
    planFolders([], input, new Set());
    assert.deepEqual([...input.vanished], before.vanished);
    assert.deepEqual(input.queue, before.queue);
  });
});
