import { Pool, type PoolClient } from 'pg';

/**
 * A row is whatever the query asked for. The driver's own row type is deliberately not in
 * this interface: it would put `pg` in the signature of every caller, and the point of the
 * boundary is that they do not know which driver this is.
 */
export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T extends Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  /**
   * Everything that writes more than one row goes through here.
   *
   * The data model leans on it hard: a node write is node + journal + version in one
   * transaction (#14), redeeming an invitation is account + key scope + vault + root +
   * device, and a shared write fans out to every participant or to none (#104). A helper
   * that made a transaction optional would make forgetting one easy.
   */
  tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  /**
   * One pooled connection, held for the callback, with no transaction around it.
   *
   * There is exactly one thing that needs this: a **session-scoped advisory lock**. It is
   * not transactional — it has to outlive several transactions — and it is released by the
   * connection that took it, so the connection must be the same one throughout. Everything
   * else in this codebase wants `tx` and should not reach for this instead.
   *
   * The slot is checked out for the whole callback, so anything the callback does through
   * this same `Db` (`query`, `tx`) takes a *second* connection. The pool must be sized to
   * `session + one`: at `max = 1` a `tx` inside the callback would wait on a slot that is
   * never returned and the pass would hang. The collector's caller holds the pool default
   * of 10; keep that in mind if the pool is ever shrunk.
   */
  session<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  /**
   * Subscribe to a `LISTEN` channel, handing each notification's payload to `handler`.
   *
   * The one thing a persistent connection is for that `query`/`tx`/`session` cannot serve:
   * waiting on a channel. It opens a dedicated client, runs `LISTEN`, and streams
   * `notification` events until `stop()` is called. A dropped connection is re-established
   * with a short backoff, because a notification channel that dies silently is a client that
   * stops learning about changes.
   *
   * The payload is the string `pg_notify` delivers; the channel names what kind of event it
   * is, so the handler decides whether it cares.
   */
  listen(channel: string, handler: (payload: string) => void): { stop: () => Promise<void> };
  close(): Promise<void>;
}

/**
 * With no connection string, `pg` reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
 * `PGDATABASE` from the environment — which is how the container is configured, and
 * deliberately so.
 *
 * A URL has to escape whatever is inside it, and a password is exactly the field most
 * likely to contain something that needs escaping: `openssl rand -base64` emits `/` and
 * `+`, and a single `/` turns the authority into a path and the URL into a parse error.
 * Discrete variables have no syntax to collide with.
 */
export const connect = (databaseUrl?: string): Db => {
  const pool = new Pool(databaseUrl ? { connectionString: databaseUrl } : {});

  return {
    async query<T extends Row>(sql: string, params?: unknown[]): Promise<T[]> {
      const r = await pool.query(sql, params ?? []);
      return r.rows as T[];
    },
    async one<T extends Row>(sql: string, params?: unknown[]): Promise<T | undefined> {
      const r = await pool.query(sql, params ?? []);
      return r.rows[0] as T | undefined;
    },
    async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(c);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    async session<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        return await fn(c);
      } finally {
        c.release();
      }
    },
    listen(channel, handler) {
      let stopped = false;
      let current: PoolClient | undefined;
      let retry: NodeJS.Timeout | undefined;

      const attach = async (): Promise<void> => {
        if (stopped) return;
        let c: PoolClient;
        try {
          c = await pool.connect();
        } catch {
          retry = setTimeout(() => void attach(), 250);
          return;
        }
        current = c;
        try {
          await c.query(`LISTEN ${channel}`);
        } catch {
          await c.release();
          current = undefined;
          retry = setTimeout(() => void attach(), 250);
          return;
        }
        // The connection itself owns its lifetime: `end` or an error restarts it. An
        // `error` listener is mandatory here regardless — without one, a PG fault on the
        // listening socket would crash the process.
        c.on('error', () => void restart());
        c.on('end', () => void restart());
        c.on('notification', (msg) => {
          // Delivered only while THIS client is still the subscribed one; a notification
          // queued on an old client after a restart must not double-fire.
          if (current === c && msg.payload !== undefined) handler(msg.payload);
        });
      };

      const restart = async (): Promise<void> => {
        if (stopped) return;
        const old = current;
        current = undefined;
        try {
          old?.release();
        } catch {
          /* already gone */
        }
        retry = setTimeout(() => void attach(), 250);
      };

      void attach();

      return {
        async stop(): Promise<void> {
          stopped = true;
          if (retry) clearTimeout(retry);
          const old = current;
          current = undefined;
          try {
            old?.release();
          } catch {
            /* already gone */
          }
        },
      };
    },
    close: () => pool.end(),
  };
};
