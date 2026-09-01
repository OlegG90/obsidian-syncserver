/**
 * What should happen to one local file — decided, not done.
 *
 * A pass over a vault does two different jobs. It **chooses** what a path's situation means: an
 * ordinary edit, a pull, an adoption, a conflict, a rename, a deletion. And it **carries that out**,
 * which means reading files, sealing bytes, PUTs, and writing back into the pass's state. Those
 * lived in one method, and only the second half ever needed a server.
 *
 * That is what this file is for. Everything here is pure: the same inputs give the same answer,
 * nothing is read from disk, nothing is written anywhere. `engine.ts` still owns the doing.
 *
 * **The cost of not having it is on the record.** #295 and #296 were both wrong-branch defects — a
 * pull undone by an open editor came back as a conflict holding the old text, and a conflict file
 * could be a byte-for-byte copy because the adoption branch compared addresses rather than content.
 * Neither was a mistake in *doing* the work. Both were mistakes in *choosing which branch does it*,
 * and both reached a live vault, because the only way to reach a branch was to build the world that
 * leads to it: a server, a session, a walk, a state file.
 *
 * Now the branches are a table.
 *
 * **Deciding and consuming are separate**, which `rename.ts` already argued one level down: it finds
 * a rename source without removing it from `vanished`, so the same question can be asked twice in a
 * test. `decide` inherits that. A `push-move` answer names the source; taking it out of `vanished`,
 * so a second file with the same bytes cannot claim it, is the caller's act.
 */
import { renameSourceFor, type Vanished } from './rename.js';
import type { KnownNode } from './state.js';
import type { ServerNode } from './wire.js';

/**
 * What this device measured about a local file before deciding anything.
 *
 * `tag` is here rather than computed on demand because the dedup lookup is one batched question
 * asked before the walk (issue #250): by the time a decision is made the answer is already in hand.
 */
export interface LocalMeta {
  plainHash: string;
  /** `HMAC(vault key, sha256(plaintext))` — what the dedup lookup is keyed by (docs/06). */
  tag: string;
  mtime: number;
  size: number;
}

/**
 * How this pass reads an absence, decided by the cursor probe before the walk starts.
 *
 * Three flags rather than the epoch that produced them: `decide` has no business knowing whether the
 * server was restored or merely pruned its journal, only what that means for a file that is missing.
 */
export interface SyncPolicy {
  /** A synced file gone from disk is pushed as a server delete. */
  pushDeletes: boolean;
  /** A known node missing from the walked tree deletes the local copy. */
  applyRemoteDeletes: boolean;
  /** Content the server lost is re-uploaded, not pulled over our newer copy. */
  preferLocal: boolean;
}

/** Everything the decision reads. Nothing in here is mutated. */
export interface Situation {
  /** What this device measured about the file on disk. */
  meta: LocalMeta;
  /** What this device recorded last time it synced this path, if it ever did. */
  known: KnownNode | undefined;
  /** What the walked tree holds at this path, if anything. */
  onServer: ServerNode | undefined;
  /** The walked tree by node id — how a node that left this path is found at its new one. */
  byNodeId: ReadonlyMap<string, ServerNode>;
  /** `content_tag` → address, for this vault's scope. One entry per tag (docs/06). */
  dedup: ReadonlyMap<string, string>;
  /** Paths this device had synced and can no longer find, by plaintext hash. */
  vanished: ReadonlyMap<string, Vanished[]>;
  /** The walked tree by path — `renameSourceFor` checks a candidate is still where it was. */
  tree: ReadonlyMap<string, ServerNode>;
  policy: SyncPolicy;
}

/**
 * The ten answers, and the union is deliberately flat.
 *
 * Nesting them by branch would put the shape of the current ladder into the type, which is the thing
 * being taken apart: what a reader needs is the list of outcomes a file can have, not the route the
 * code took to one of them.
 */
export type Decision =
  /** Identical on both sides, and the recorded hint still describes the file. */
  | { kind: 'nothing' }
  /** Identical on both sides, but `mtime`/`size` moved — record them so the next pass can skip the read. */
  | { kind: 'refresh-hint' }
  /** The server has a newer version of a node this device knows and has not touched. */
  | { kind: 'pull'; node: ServerNode }
  /** Local content changed. Whether the server also changed is the server's to answer, via the precondition. */
  | { kind: 'push-edit'; known: KnownNode; onServer: ServerNode }
  /** A node this device did not sync, holding exactly these bytes at exactly this address. Record it. */
  | { kind: 'adopt'; onServer: ServerNode }
  /** A node this device did not sync, holding something else. */
  | { kind: 'conflict'; onServer: ServerNode }
  /** The node this device knew is on the server under a different path. */
  | { kind: 'remote-rename'; known: KnownNode; movedTo: ServerNode }
  /** Deleted on the server, unchanged here, and this epoch trusts an absence. */
  | { kind: 'remove-local' }
  /** These bytes are a path this device can no longer find: one move, not a delete and an upload. */
  | { kind: 'push-move'; source: Vanished }
  /** Nothing else fits: upload it as a new node. */
  | { kind: 'push-new' };

export const decide = (s: Situation): Decision => {
  const { meta, known, onServer, policy } = s;

  // The node this device knows is still at this path on the server.
  if (onServer && known && known.nodeId === onServer.nodeId) {
    // **Local and remote movement are separate facts.** Reading any difference as a local edit
    // would let an unchanged stale local file overwrite a newer server version.
    const localChanged = known.plainHash !== meta.plainHash;
    const remoteChanged = known.address !== onServer.address;

    if (!localChanged && !remoteChanged) {
      const hintStale = known.mtime !== meta.mtime || known.size !== meta.size;
      return hintStale ? { kind: 'refresh-hint' } : { kind: 'nothing' };
    }

    // Under a restore the server's "change" is the backup going backwards and our copy is the
    // newer one, so the usual remote-wins pull is inverted into a push.
    if (!localChanged && remoteChanged && !policy.preferLocal) return { kind: 'pull', node: onServer };

    return { kind: 'push-edit', known, onServer };
  }

  // A node at this path, but not the one this device knows — deleted and recreated, or a fresh
  // adoption. **Content, not history, decides what happens next** (docs/07, #296).
  if (onServer) {
    return s.dedup.get(meta.tag) === onServer.address
      ? { kind: 'adopt', onServer }
      : { kind: 'conflict', onServer };
  }

  // Nothing at this path on the server.
  if (known) {
    // The node either moved or is gone, and which of those decides between a rename and a delete.
    const movedTo = s.byNodeId.get(known.nodeId);
    if (movedTo) return { kind: 'remote-rename', known, movedTo };

    // Gone entirely: deleted on the server, or lost to a restore. The policy knows which, and a
    // local edit worth keeping outranks either.
    const localChanged = known.plainHash !== meta.plainHash;
    if (policy.applyRemoteDeletes && !localChanged) return { kind: 'remove-local' };
    return { kind: 'push-new' };
  }

  // Never known here, not on the server: a rename source, or genuinely new.
  const source = renameSourceFor(meta, s.vanished, s.tree);
  return source ? { kind: 'push-move', source } : { kind: 'push-new' };
};
