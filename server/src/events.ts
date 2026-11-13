/**
 * The new-revision fan-out (docs/04, Change notifications).
 *
 * One process owns this (docs/04): a single `LISTEN` on the channel the journal trigger
 * notifies, and a set of open WebSocket connections, each tied to the device it
 * authenticated as. When a vault gains a revision, every connected device that may read that
 * vault is handed `{vault_id, head_rev}` — a hint to sync, nothing about what changed.
 *
 * The connection set is deliberately dumb: a socket plus its device. Which devices a vault
 * wakes is a query per notification (`wokenBy`), which is the honest cost at family scale —
 * and the only arrangement in which a device revoked a moment ago stops hearing at once,
 * since nothing here remembers an answer that revocation would have to reach and undo.
 */
import type { Db } from './db.js';
import { wokenBy } from './account.js';

/** What the WS route registers for one open, authenticated connection. */
export interface RevisionSubscriber {
  deviceId: string;
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
      // Nobody is listening, so there is nobody to ask about.
      if (connections.size === 0) return;
      // The vault that changed; one module answers who may hear of it and where its journal
      // stands (account.ts) — the fan-out does not re-derive the guard's rule, which is the
      // drift this exists to avoid.
      const woken = await wokenBy(db, payload);
      if (!woken) return; // a vault that no longer exists wakes nobody
      const devices = new Set(woken.deviceIds);
      for (const sub of connections) {
        if (devices.has(sub.deviceId)) sub.send({ vault_id: payload, head_rev: woken.headRev });
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
