/**
 * The server's tree, kept between passes so an idle one does not rebuild it (issue #252).
 *
 * Measured on a real vault of 624 nodes: the listing is **313 KB**, and turning it into paths costs
 * **12–17 ms of decryption** — a name at a time, all the way down, because the server holds no paths and
 * one exists only once a client has opened every name above it (docs/03). At 5 000 nodes that is 92 ms.
 * A pass used to pay it whenever somebody pressed a button; since #238 it pays whenever the vault
 * settles, which on a working afternoon is most of the time.
 *
 * **The cursor is what makes reuse safe, and nothing else would.** A delta probe against a cursor the
 * server signed answers "has anything happened since". If the answer is *nothing* — no changes, no
 * further pages — then no node was written, moved or removed, and the tree this device built at that
 * cursor is still exactly what a fresh walk would produce. Any other answer, and any epoch that is not
 * continuous, rebuilds: a cache that guessed would diverge from the server silently and permanently,
 * which is the worst failure this product has.
 *
 * **It holds plaintext paths, so it lives and dies with the unlocked session.** That is why it hangs off
 * the session's handle rather than off the plugin: the handle is created at unlock and dropped at lock,
 * and a cache that had to be cleared by somebody remembering to clear it would keep decrypted names in
 * memory after the person locked the vault — the one thing locking is for.
 *
 * **Copies go in and copies come out.** A pass mutates the tree it is given — a pushed file joins it, a
 * reset remaps it — and a cache handing out its own map would be corrupted by the first pass that used
 * it. Cloning 624 entries costs microseconds against the 15 ms it saves.
 */
import type { ServerNode } from './wire.js';
import type { UnreadableFolder } from './tree.js';

export interface WalkedTree {
  /** The snapshot the walk was taken at — the cache key, and the only thing that makes it reusable. */
  cursor: string;
  tree: Map<string, ServerNode>;
  unreadable: UnreadableFolder[];
}

export interface TreeCache {
  /** The tree walked at exactly this cursor, or nothing. */
  get(cursor: string): WalkedTree | undefined;
  put(walked: WalkedTree): void;
}

const copy = (w: WalkedTree): WalkedTree => ({
  cursor: w.cursor,
  tree: new Map(w.tree),
  unreadable: [...w.unreadable],
});

export const openTreeCache = (): TreeCache => {
  let held: WalkedTree | undefined;
  return {
    get: (cursor) => (held && held.cursor === cursor ? copy(held) : undefined),
    // One tree, not a map of them: a device syncs one vault (AC-Q4), and a second entry could only ever
    // be a stale one nothing would ask for again.
    put: (walked) => void (held = copy(walked)),
  };
};
