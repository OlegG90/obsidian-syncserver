/**
 * The server's tree, kept between passes so an idle one does not rebuild it (issue #252).
 *
 * Measured on a real vault of 624 nodes: the listing is **313 KB**, and turning it into paths costs
 * **12–17 ms of decryption** — a name at a time, all the way down, because the server holds no paths and
 * one exists only once a client has opened every name above it (docs/03). At 5 000 nodes that is 92 ms.
 * A pass used to pay it whenever somebody pressed a button; since #238 it pays whenever the vault
 * settles, which on a working afternoon is most of the time.
 *
 * **What it is keyed on is a cursor AND the keys the names were read with**, because the tree is a
 * function of both. A delta probe against a cursor the server signed answers "has any node changed
 * since"; if the answer is nothing, no node was written, moved or removed. But a path exists only once
 * every name above it has been opened, so a subtree whose scope will not open is absent from the tree
 * and listed as unreadable instead — and **share membership travels as delta events, outside the
 * journal**. A key arriving, or a share ending, moves what a walk would produce while the node listing
 * has not changed at all.
 *
 * Keyed on the cursor alone, this cache went on hiding a share whose key had just arrived, until some
 * unrelated node happened to change. That is the failure this product can least afford — a device
 * silently and permanently out of step — and it was introduced by the first version of this file.
 * `VaultScopes.fingerprint()` is the other half of the key.
 *
 * Any other answer, and any epoch that is not continuous, rebuilds.
 *
 * **It holds plaintext paths, so its lifetime is the unlock's** — the rule and its reasoning are in
 * docs/06, with the other plaintext derivatives that may not outlive a lock. What is here is only where
 * that lifetime comes from: it hangs off the session's handle, which is made at unlock and dropped at
 * lock, so nobody has to remember to clear it.
 *
 * **Copies go in and copies come out.** A pass mutates the tree it is given — a pushed file joins it, a
 * reset remaps it — and a cache handing out its own map would be corrupted by the first pass that used
 * it. Cloning 624 entries costs microseconds against the 15 ms it saves.
 */
import type { ServerNode } from './wire.js';
import type { UnreadableFolder } from './tree.js';

export interface WalkedTree {
  /** The snapshot the walk was taken at. */
  cursor: string;
  /** `VaultScopes.fingerprint()` — which keys the names in it were read with. */
  scopes: string;
  tree: Map<string, ServerNode>;
  unreadable: UnreadableFolder[];
}

export interface TreeCache {
  /** The tree walked at exactly this cursor **and** under exactly these scopes, or nothing. */
  get(at: { cursor: string; scopes: string }): WalkedTree | undefined;
  put(walked: WalkedTree): void;
}

const copy = (w: WalkedTree): WalkedTree => ({
  cursor: w.cursor,
  scopes: w.scopes,
  tree: new Map(w.tree),
  unreadable: [...w.unreadable],
});

export const openTreeCache = (): TreeCache => {
  let held: WalkedTree | undefined;
  return {
    get: (at) => (held && held.cursor === at.cursor && held.scopes === at.scopes ? copy(held) : undefined),
    // One tree, not a map of them: a plugin instance is bound to one vault (docs/02), so a second entry
    // could only ever be a stale one nothing would ask for again.
    put: (walked) => void (held = copy(walked)),
  };
};
