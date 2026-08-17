/**
 * Taking a copy of both stores as one usable thing (docs/08, #114).
 *
 * A backup is **two stores captured as one window**: the database, and the blobs the
 * database points at. Getting them separately is easy and useless — a dump that references
 * bytes the copy does not hold restores cleanly, looks whole, and cannot open a note. Nobody
 * finds out at restore time; somebody opens an old note months later.
 *
 * **A refusal window, not a freeze** (#114), and the order follows from that. Holding a lock
 * across `pg_dump` would stop the writes already running; a window that answers new ones with
 * "the server is being backed up" does not. So a write in flight can still upload a blob
 * after the blob copy — which makes **database first, blobs second** the only safe order
 * here: the blob copy is then a superset of what the dump references, and surplus blobs are
 * swept by the collector while dangling references are not.
 *
 * **The legs are injected.** What runs `pg_dump` and what copies a directory are deployment
 * facts — a binary that must match the server's major version, a mount that may be anything
 * — while the *window* is a rule. Passing them in keeps the rule testable without spawning a
 * database dump, and keeps this file free of the one thing most likely to differ per host.
 *
 * The advisory lock is the collector's, deliberately: a backup and a garbage collection must
 * never overlap, because one removes blobs the other is copying. `collector.ts` already skips
 * a pass while the lock is held, so taking it here is the whole of that interlock.
 */
import type { Db } from './db.js';
import { COLLECTOR_LOCK_ID } from './collector.js';

/** What each leg reports, so the run can record what it actually produced. */
export interface Legs {
  /** `pg_dump`, or whatever this deployment calls it. */
  dumpDatabase(): Promise<{ bytes: number }>;
  /** A copy of the blob store, taken AFTER the dump (#114). */
  copyBlobs(): Promise<{ bytes: number; count: number }>;
}

export interface BackupResult {
  id: string;
  status: 'ok' | 'failed' | 'skipped';
  bytes?: number;
  blobCount?: number;
  error?: string;
}

/**
 * Whether new writes are being refused right now.
 *
 * In memory rather than read per request: one process owns the window it opened, and a write
 * path that asked the database on every call would pay for a backup that runs nightly. The
 * consequence is named where it matters — this is what makes the window a refusal for *new*
 * writes rather than a freeze, and therefore what forces the leg order.
 */
let windowOpen = false;

export const backupInProgress = (): boolean => windowOpen;

/**
 * Run one backup, or say that another is already running.
 *
 * The window closes in a `finally` and the row is settled there too. A run that failed
 * between the legs must not leave the server refusing writes — that is a backup taking the
 * whole installation down with it — and a `running` row that outlived its process is a lie
 * the next boot has to clear rather than something to reason about.
 */
export const runBackup = async (
  db: Db,
  legs: Legs,
  destination: string,
  triggeredBy?: string,
): Promise<BackupResult> =>
  db.session(async (lock) => {
    const got = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [COLLECTOR_LOCK_ID]);
    if (!got.rows[0]?.ok) return { id: '', status: 'skipped' as const };

    const started = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (writes_frozen_at, destination, triggered_by)
       VALUES (now(), $1, $2) RETURNING id::text AS id`,
      [destination, triggeredBy ?? null],
    );
    const id = started!.id;
    windowOpen = true;

    try {
      // The database FIRST (#114). Reversing these two is the one mistake in this file that
      // produces a copy which restores without complaint and is missing files.
      const dumped = await legs.dumpDatabase();
      await db.query(`UPDATE backup_runs SET db_done_at = now() WHERE id = $1`, [id]);

      const blobs = await legs.copyBlobs();
      await db.query(`UPDATE backup_runs SET blobs_done_at = now() WHERE id = $1`, [id]);

      await db.query(
        `UPDATE backup_runs
            SET writes_thawed_at = now(), finished_at = now(), status = 'ok',
                bytes = $2, blob_count = $3
          WHERE id = $1`,
        [id, dumped.bytes + blobs.bytes, blobs.count],
      );
      return { id, status: 'ok' as const, bytes: dumped.bytes + blobs.bytes, blobCount: blobs.count };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.query(
        `UPDATE backup_runs
            SET writes_thawed_at = now(), finished_at = now(), status = 'failed', error = $2
          WHERE id = $1`,
        [id, message],
      );
      return { id, status: 'failed' as const, error: message };
    } finally {
      windowOpen = false;
      await lock.query('SELECT pg_advisory_unlock($1)', [COLLECTOR_LOCK_ID]);
    }
  });

/**
 * Settle any run that a restart interrupted.
 *
 * A `running` row means a window was open when the process died — and with the process went
 * the refusal, so nothing was actually frozen afterwards. Calling that anything but `failed`
 * would leave a row an operator could mistake for a usable copy, which is the one thing
 * `backup_runs` exists to prevent.
 */
export const settleInterruptedRuns = async (db: Db): Promise<number> => {
  const rows = await db.query(
    `UPDATE backup_runs
        SET status = 'failed', finished_at = now(),
            writes_thawed_at = COALESCE(writes_thawed_at, now()),
            error = 'interrupted by a restart'
      WHERE status = 'running'
      RETURNING id`,
  );
  return rows.length;
};
