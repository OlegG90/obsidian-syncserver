/**
 * The pass's decision, as a table (#309).
 *
 * Every case here was previously reachable only by building a server, a session, a walk and a state
 * file, and asserting on what came out the far end. Two defects used that cover to ship: a pull undone
 * by an open editor came back as a conflict holding the old text (#295), and a conflict file could be
 * a byte-for-byte copy of what it conflicted with (#296). Neither was a mistake in doing the work.
 * Both were mistakes in choosing which branch does it.
 *
 * So these are deliberately small and deliberately many. `engine-*.test.ts` still exercises the doing
 * against a real server; what is asked here is only *which answer*, for a situation stated in full.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decide, type Situation, type SyncPolicy } from '../src/engine/reconcile.js';
import type { KnownNode } from '../src/engine/state.js';
import type { ServerNode } from '../src/engine/wire.js';

/** The ordinary epoch: the walk is current, so an absence means a deletion. */
const CURRENT: SyncPolicy = { pushDeletes: true, applyRemoteDeletes: true, preferLocal: false };
/** After a restore, or when the cursor cannot be checked: absence proves nothing (D-100). */
const AFTER_RESTORE: SyncPolicy = { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true };

const meta = (over: Partial<Situation['meta']> = {}) => ({
  plainHash: 'hash-local',
  tag: 'tag-local',
  mtime: 1000,
  size: 10,
  ...over,
});

const node = (over: Partial<ServerNode> = {}): ServerNode =>
  ({ nodeId: 'node-1', rev: 3, address: 'addr-server', type: 'file', path: 'Notes/a.md', ...over }) as ServerNode;

const knownNode = (over: Partial<KnownNode> = {}): KnownNode =>
  ({ nodeId: 'node-1', rev: 3, plainHash: 'hash-local', address: 'addr-server', mtime: 1000, size: 10, ...over });

/** A situation with nothing anywhere; each test says only what it is about. */
const situation = (over: Partial<Situation> = {}): Situation => ({
  meta: meta(),
  known: undefined,
  onServer: undefined,
  byNodeId: new Map(),
  dedup: new Map(),
  vanished: new Map(),
  tree: new Map(),
  policy: CURRENT,
  ...over,
});

describe('a node this device already synced, still at this path', () => {
  it('does nothing when neither side moved', () => {
    assert.deepEqual(decide(situation({ known: knownNode(), onServer: node() })), { kind: 'nothing' });
  });

  it('refreshes the hint when only the timestamp moved', () => {
    // The file was rewritten with identical bytes — a save with no edit, or a restore from a backup.
    // Recording the new mtime is what lets the next pass skip reading it at all (#237).
    const s = situation({ known: knownNode(), onServer: node(), meta: meta({ mtime: 2000 }) });
    assert.deepEqual(decide(s), { kind: 'refresh-hint' });
  });

  it('pulls when the server moved and this device did not', () => {
    const onServer = node({ address: 'addr-new' });
    assert.deepEqual(decide(situation({ known: knownNode(), onServer })), { kind: 'pull', node: onServer });
  });

  /**
   * The inversion a restore causes (D-100). The server's "change" is a backup going backwards, so the
   * local copy is the newer one and pulling would overwrite it with an older version of itself.
   */
  it('pushes instead of pulling when the epoch prefers local', () => {
    const s = situation({ known: knownNode(), onServer: node({ address: 'addr-old' }), policy: AFTER_RESTORE });
    assert.equal(decide(s).kind, 'push-edit');
  });

  it('pushes an edit when this device changed the file', () => {
    const s = situation({ known: knownNode(), onServer: node(), meta: meta({ plainHash: 'hash-edited' }) });
    assert.equal(decide(s).kind, 'push-edit');
  });

  /**
   * Both sides moved, and this still says `push-edit` rather than `conflict`.
   *
   * That is the protocol, not an oversight: the PUT carries a precondition and the SERVER decides
   * whether the two diverged. A client comparing two hashes it fetched a moment ago is a worse arbiter
   * than the row itself, and a 409 is what turns this into a conflict file (docs/04).
   */
  it('still pushes when both sides moved, and lets the precondition arbitrate', () => {
    const s = situation({
      known: knownNode(),
      onServer: node({ address: 'addr-new' }),
      meta: meta({ plainHash: 'hash-edited' }),
    });
    assert.equal(decide(s).kind, 'push-edit');
  });
});

describe('a node at this path that this device did not sync', () => {
  /**
   * #296, as one case. The branch used to compare addresses, and `KC` is random — so the same
   * plaintext sealed twice lands at two addresses and this looked like a divergence. It produced a
   * conflict file that was a byte-for-byte copy of the note beside it, on a vault where nothing had
   * gone wrong. Content decides, and the dedup tag is what carries content across the encryption.
   */
  it('adopts when the dedup tag says the bytes are already at that address', () => {
    const onServer = node({ nodeId: 'node-other', address: 'addr-server' });
    const s = situation({ onServer, dedup: new Map([['tag-local', 'addr-server']]) });
    assert.deepEqual(decide(s), { kind: 'adopt', onServer });
  });

  it('conflicts when the tag points somewhere else', () => {
    const onServer = node({ nodeId: 'node-other', address: 'addr-server' });
    const s = situation({ onServer, dedup: new Map([['tag-local', 'addr-elsewhere']]) });
    assert.deepEqual(decide(s), { kind: 'conflict', onServer });
  });

  it('conflicts when the tag is unknown to the lookup', () => {
    const onServer = node({ nodeId: 'node-other' });
    assert.deepEqual(decide(situation({ onServer })), { kind: 'conflict', onServer });
  });

  // Deleted and recreated on the server under a new id, while this device held the old one. Same
  // branch as a fresh adoption, and it must be: history is exactly what cannot be trusted here.
  it('treats a recreated node the same way, by content', () => {
    const onServer = node({ nodeId: 'node-recreated', address: 'addr-server' });
    const s = situation({ known: knownNode({ nodeId: 'node-gone' }), onServer, dedup: new Map([['tag-local', 'addr-server']]) });
    assert.deepEqual(decide(s), { kind: 'adopt', onServer });
  });
});

describe('nothing at this path on the server', () => {
  it('follows the node to where it moved', () => {
    const movedTo = node({ path: 'Notes/renamed.md' });
    const known = knownNode();
    const s = situation({ known, byNodeId: new Map([['node-1', movedTo]]) });
    assert.deepEqual(decide(s), { kind: 'remote-rename', known, movedTo });
  });

  it('removes a local copy the server deleted, when nothing was typed here', () => {
    assert.deepEqual(decide(situation({ known: knownNode() })), { kind: 'remove-local' });
  });

  it('keeps a local edit rather than applying a remote delete', () => {
    const s = situation({ known: knownNode(), meta: meta({ plainHash: 'hash-edited' }) });
    assert.deepEqual(decide(s), { kind: 'push-new' });
  });

  /**
   * After a restore an absence proves nothing — the backup simply predates the file. Deleting on that
   * evidence is how fresh work disappears from every device at once, which is the failure D-100 exists
   * to prevent, and it happens at the moment people are already recovering from something.
   */
  it('never applies a remote delete when absence proves nothing', () => {
    const s = situation({ known: knownNode(), policy: AFTER_RESTORE });
    assert.deepEqual(decide(s), { kind: 'push-new' });
  });
});

describe('a path this device never synced and the server does not have', () => {
  const vanishedAt = (path: string) => ({ path, nodeId: 'node-1', rev: 3, address: 'addr-server' });

  it('is a move when exactly one vanished path held these bytes', () => {
    const source = vanishedAt('Notes/old-name.md');
    const s = situation({
      meta: meta({ size: 4096 }),
      vanished: new Map([['hash-local', [source]]]),
      tree: new Map([['Notes/old-name.md', node()]]),
    });
    assert.deepEqual(decide(s), { kind: 'push-move', source });
  });

  it('is new when two vanished paths held them, because neither is the source', () => {
    const s = situation({
      meta: meta({ size: 4096 }),
      vanished: new Map([['hash-local', [vanishedAt('Notes/a-old.md'), vanishedAt('Notes/b-old.md')]]]),
      tree: new Map([['Notes/a-old.md', node()], ['Notes/b-old.md', node()]]),
    });
    assert.deepEqual(decide(s), { kind: 'push-new' });
  });

  it('is new when nothing vanished', () => {
    assert.deepEqual(decide(situation()), { kind: 'push-new' });
  });

  /**
   * Deciding does not consume. `engine.ts` removes the source from `vanished` when it acts on a
   * `push-move`, and the separation is what lets this suite ask the same question twice — the same
   * argument `rename.ts` makes one level down about its own input.
   */
  it('gives the same answer asked twice', () => {
    const source = vanishedAt('Notes/old-name.md');
    const s = situation({
      meta: meta({ size: 4096 }),
      vanished: new Map([['hash-local', [source]]]),
      tree: new Map([['Notes/old-name.md', node()]]),
    });
    assert.deepEqual(decide(s), decide(s));
    assert.equal(s.vanished.get('hash-local')?.length, 1, 'the candidate is still there');
  });
});
