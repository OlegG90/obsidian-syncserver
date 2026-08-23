/**
 * One lock, and the rule it carries: a backup and a collector pass never run together.
 *
 * The lock id lived in `collector.ts`, which meant the collector owned a key that `backup.ts` and
 * `schema.ts` both imported — the module that happens to have been written first, rather than the one
 * the rule belongs to. Worse, the rule itself was in three pieces: a blocking acquire in the backup, a
 * try-acquire in the collector, and a module-level `windowOpen` boolean in `backup.ts` that the HTTP
 * hook read to refuse writes.
 *
 * **The boolean is the part that could go wrong.** The refusal window is a sub-interval of holding the
 * lock for a backup — it opens after the lock is granted and closes in the same `finally` that releases
 * it. Two variables for one interval is two things to keep in step, and a `windowOpen` left true by a
 * path that forgot it is a server refusing every write until it restarts. Here, the window IS the hold:
 * `release()` closes both or neither.
 *
 * **Two acquisitions, deliberately different, and each is a decision** (docs/08):
 *
 * - a **backup blocks** with a timeout. It waits for a pass already running, so the window is clean from
 *   the moment the lock is granted rather than from the moment it was asked for. `pg_try_advisory_lock`
 *   stood there once and turned a mid-flight collector into a backup that silently did not happen —
 *   and a copy nobody took is worse than one that waited a few seconds. Bounded, because "blocking" and
 *   "for ever" are different promises: past the timeout it is another backup or a session nobody will
 *   release, and waiting on either turns a backup into a hung process;
 * - a **collector tries** and gives up. It runs hourly and the next pass is an hour away, so skipping
 *   one costs nothing; waiting would hold a session open behind a backup for no reason.
 */
import type { PoolClient } from 'pg';

/**
 * `SYNC` as four ASCII bytes. A session-scoped advisory lock under this key means "a pass or a backup
 * owns the sweepable set right now" — a number the database can compare, which is what advisory locks
 * are, so it needs to be stable and to be one.
 */
export const INTERLOCK_ID = 0x53_59_4e_43;

/** Next to it, so the two can never be the same number by accident (`schema.ts`). */
export const SCHEMA_LOCK_ID = INTERLOCK_ID + 1;

/** Let go of the lock, and of the window if this hold opened one. */
export type Release = () => Promise<void>;

let windowOpen = false;

/** Whether writes are being refused right now — the one question the HTTP hook asks (D-114). */
export const inRefusalWindow = (): boolean => windowOpen;

/**
 * Take the lock for a backup, waiting up to `waitMs`, and open the refusal window.
 *
 * @returns how to let go, or `undefined` when the wait ran out — which the caller reports as `skipped`
 *   rather than swallowing, because a schedule that silently skips has stopped being one.
 */
export const holdForBackup = async (lock: PoolClient, waitMs: number): Promise<Release | undefined> => {
  await lock.query(`SET lock_timeout = ${waitMs}`);
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [INTERLOCK_ID]);
  } catch {
    return undefined;
  } finally {
    // Reset on BOTH paths, and that is the reason it lives here rather than at the call site: this
    // connection goes back to the pool, and a `lock_timeout` left on it would apply to whatever runs
    // there next. The timeout is this function's to set, so it is this function's to take back.
    await lock.query('SET lock_timeout = DEFAULT');
  }
  windowOpen = true;
  return async () => {
    windowOpen = false;
    await lock.query('SELECT pg_advisory_unlock($1)', [INTERLOCK_ID]);
  };
};

/** Take the lock for a collector pass, or don't. No window: a sweep refuses nobody. */
export const holdForCollector = async (lock: PoolClient): Promise<Release | undefined> => {
  const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [INTERLOCK_ID]);
  if (!got.rows[0]?.ok) return undefined;
  return async () => {
    await lock.query('SELECT pg_advisory_unlock($1)', [INTERLOCK_ID]);
  };
};
