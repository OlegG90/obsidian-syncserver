/**
 * The new-revision fan-out (docs/04, Change notifications).
 *
 * One process owns this (docs/13): a single `LISTEN` on the channel the journal trigger
 * notifies, and a set of open WebSocket connections, each tied to an account. When a vault
 * gains a revision, every connection of an account that owns that vault is handed
 * `{vault_id, head_rev}` — a hint to sync, nothing about what changed.
 *
 * The connection set is deliberately dumb: a socket plus the account it authenticated as.
 * Routing to the right accounts is a query per notification, which is the honest cost at
 * family scale; the alternative (caching vault ownership and invalidating it) is machinery
 * for a server with more writers than this one has.
 */
import type { Db } from './db.js';
import { ownerOf } from './account.js';

/** What the WS route registers for one open, authenticated connection. */
export interface RevisionSubscriber {
  accountId: string;
  send: (msg: { vault_id: string; head_rev: number }) => void;
}

export const CHANNEL = 'sync_vault';

export interface EventsHub {
  /** The route calls this for every authenticated connection. */
  subscribe(sub: RevisionSubscriber): () => void;
  /** Tear down the LISTEN connection; the route owns the sockets. */
  close(): Promise<void>;
}

export const openEventsHub = (db: Db): EventsHub => {
  const connections = new Set<RevisionSubscriber>();
  let listener: { stop: () => Promise<void> } | undefined;

  const subscribe = (sub: RevisionSubscriber): (() => void) => {
    connections.add(sub);
    return () => {
      connections.delete(sub);
    };
  };

  listener = db.listen(CHANNEL, (payload) => {
    void (async () => {
      // The vault that changed; route to the account that owns it, with where its journal
      // stands. One module answers both (account.ts) — the fan-out does not re-derive
      // ownership, which is the drift this exists to avoid.
      const owned = await ownerOf(db, payload);
      if (!owned) return; // a vault that no longer exists wakes nobody
      for (const sub of connections) {
        if (sub.accountId === owned.userId) sub.send({ vault_id: payload, head_rev: owned.headRev });
      }
    })().catch(() => {
      // A failed fan-out is a missed hint, not data loss: the next sync finds the change
      // anyway. Log and move on rather than let one notification take the process down.
      console.error('sync_vault fan-out failed', payload);
    });
  });

  return {
    subscribe,
    async close() {
      connections.clear();
      await listener?.stop();
    },
  };
};
