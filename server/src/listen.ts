/**
 * The `LISTEN`/reconnect cycle behind `Db.listen`, as a module with an owner.
 *
 * `Db.listen`'s interface promises that a dropped connection is re-established with a
 * short backoff. Against a healthy PostgreSQL that promise is reachable only by killing
 * the backend, which is why the cycle is here behind an injected connection factory: a
 * test can drive it with a scripted connection and pin the state machine down (see
 * test/listen.test.ts). The pool wiring in db.ts is the only place that touches `pg`.
 *
 * The state machine exists because two of its transitions are races, and races need one
 * owner with explicit rules:
 *
 * - a socket drop fires `error` **and** `end`; teardown must run exactly once, or a
 *   single fault starts two reconnects and leaks the losing connection;
 * - `stop()` may land between two awaits of a connect in flight. Every `await` in the
 *   cycle therefore re-checks, through a generation counter, whether this attempt is
 *   still the one being asked for — a superseded or stopped attempt releases its
 *   connection instead of letting it subscribe.
 *
 * `stop()` resolves only once nothing is subscribed and nothing is in flight, so a
 * process that calls it and then `close()` never waits on a connection this module
 * leaked.
 */

export interface NotificationMsg {
  /** The payload `NOTIFY` carried, when it carried one. */
  payload?: string;
}

/** A connection produced by the injected factory — `pg`'s type is the adapter's business. */
export interface ListenConnection {
  /** Runs a one-shot statement on this connection (`LISTEN`, `UNLISTEN`). */
  query(sql: string): Promise<unknown>;
  on(event: string, listener: (msg?: NotificationMsg) => void): void;
  /** Hands the connection back to whatever produced it. */
  release(): void;
}

export type ConnectionFactory = () => Promise<ListenConnection>;

export interface ListenHandle {
  stop(): Promise<void>;
}

export interface ListenOptions {
  /** How long to wait before trying the channel again after a drop. */
  backoffMs?: number;
}

export const subscribe = (
  channel: string,
  onMessage: (payload: string) => void,
  connect: ConnectionFactory,
  options: ListenOptions = {},
): ListenHandle => {
  const backoffMs = options.backoffMs ?? 250;

  // Bumped whenever the current attempt is superseded (a restart, a stop). An attempt
  // takes a snapshot before its first `await` and re-checks it after every `await`, so
  // a stale one always releases its connection instead of subscribing.
  let generation = 0;
  let current: ListenConnection | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;

  const release = (c: ListenConnection): void => {
    try {
      c.release();
    } catch {
      // The connection is already gone; there is nothing left to return to a pool.
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void run();
    }, backoffMs);
  };

  const teardown = (c: ListenConnection): void => {
    if (current !== c) return; // a stale event from a connection already replaced
    current = undefined;
    release(c);
    scheduleReconnect();
  };

  const attach = async (): Promise<void> => {
    if (stopped) return;
    const mine = ++generation;
    let c: ListenConnection;
    try {
      c = await connect();
    } catch {
      // The pool itself is down; the backoff gives it a moment to recover.
      scheduleReconnect();
      return;
    }
    if (stopped || mine !== generation) {
      release(c);
      return;
    }
    try {
      await c.query(`LISTEN ${channel}`);
    } catch {
      release(c);
      scheduleReconnect();
      return;
    }
    if (stopped || mine !== generation) {
      release(c);
      return;
    }
    current = c;
    c.on('notification', (msg) => {
      // Delivered only while this is still the live connection: a notification queued
      // on a replaced client after a restart must not double-fire.
      if (current === c && msg?.payload !== undefined) onMessage(msg.payload);
    });
    c.on('error', () => teardown(c));
    c.on('end', () => teardown(c));
  };

  const run = (): void => {
    if (stopped) return;
    inFlight = attach();
  };

  run();

  return {
    async stop(): Promise<void> {
      stopped = true;
      generation++;
      if (retry) {
        clearTimeout(retry);
        retry = undefined;
      }
      const c = current;
      current = undefined;
      if (c) {
        // Take the live connection off the channel before returning it, so a pooled
        // client is never handed out still subscribed.
        try {
          await c.query('UNLISTEN *');
        } catch {
          /* already gone */
        }
        release(c);
      }
      await inFlight;
    },
  };
};
