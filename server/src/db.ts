import { Pool, type PoolClient } from 'pg';
import { subscribe, type NotificationMsg } from './listen.js';

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
   *
   * The cycle itself lives in `listen.ts`, whose contract `stop()` honours: when it
   * resolves, nothing is subscribed and nothing is in flight, so `close()` never waits on
   * a connection this primitive leaked.
   */
  listen(channel: string, handler: (payload: string) => void): { stop: () => Promise<void> };
  close(): Promise<void>;
}

/**
 * The smallest surface a predicate needs: run one statement, keep the first row.
 *
 * Both `Db` (the route and hub seam) and a `PoolClient` inside `db.tx` (the write seam)
 * satisfy it — the latter through `oneFrom`. Account-scope predicates take this so one
 * formulation serves both seams (account.ts): the write paths that run in a transaction
 * use the same function the routes use, instead of restating the fact as a second query.
 */
export type Queryable = Pick<Db, 'one'>;

/** The one line that lets a predicate run on the client a transaction already holds. */
export const oneFrom = (c: PoolClient): Queryable => ({
  one: async (sql, params) => (await c.query(sql, params ?? [])).rows[0],
});

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
      return subscribe(channel, handler, async () => {
        const c = await pool.connect();
        return {
          query: (sql: string): Promise<unknown> => c.query(sql),
          on: (event, listener) => {
            // `pg`'s event types are the driver's; the listen module keeps its own.
            c.on(event as never, listener as never);
          },
          release: (): void => c.release(),
        };
      });
    },
    close: () => pool.end(),
  };
};
