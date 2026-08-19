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
 * a pass while the lock is held, so taking it here is the whole of that interlock — and it
 * serialises backups against each other for free. It is taken **blocking, with a timeout**
 * (docs/08): waiting for a pass that is already running is what makes the window clean from
 * the moment the lock is granted, while the timeout stops a backup job inheriting somebody
 * else's stuck session.
 */
import type { Db } from './db.js';
import { COLLECTOR_LOCK_ID } from './collector.js';
import { storageKeyFor } from './blobs/store.js';

/** What each leg reports, so the run can record what it actually produced. */
export interface Legs {
  /** `pg_dump`, or whatever this deployment calls it. */
  dumpDatabase(): Promise<{ bytes: number }>;
  /** A copy of the blob store, taken AFTER the dump (#114). */
  copyBlobs(): Promise<{ bytes: number; count: number }>;
}

export interface BackupResult {
  /**
   * Absent when nothing ran. A skipped call never inserted a row, so there is no id to
   * report — and an empty string in its place is a value a caller can log, store or compare
   * without ever being told it means "none".
   */
  id?: string;
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

/** How long a run waits for the collector's lock before calling itself skipped. */
const LOCK_WAIT_MS = 60_000;

/**
 * Run one backup, or say that another is already running.
 *
 * **The window closes in a `finally`; the row is settled on both paths before it.** A run that
 * failed between the legs must not leave the server refusing writes — that is a backup taking
 * the whole installation down with it — so releasing the window cannot depend on which way the
 * run ended. The row is written in `try` and `catch` instead, because `finally` cannot tell
 * them apart and `ok` and `failed` are exactly what has to be told apart. A `running` row that
 * outlives its process is not settled here at all: `settleInterruptedRuns` clears it at the
 * next boot, since a dead process runs no `finally`.
 */
export const runBackup = async (
  db: Db,
  legs: Legs,
  destination: string,
  opts: { triggeredBy?: string; lockWaitMs?: number } = {},
): Promise<BackupResult> =>
  db.session(async (lock) => {
    const { triggeredBy, lockWaitMs = LOCK_WAIT_MS } = opts;
    // The BLOCKING form, which is docs/08's requirement rather than a preference: it waits
    // for a collector pass already running, so the window is clean from the moment the lock
    // is granted rather than from the moment it was asked for. `pg_try_advisory_lock` stood
    // here and turned a pass that happened to be mid-flight into a backup that silently did
    // not happen — and a nightly copy nobody took is a worse outcome than one that waited a
    // few seconds for a collector.
    //
    // Bounded, because "blocking" and "for ever" are not the same promise: a collector pass
    // is seconds, so anything past this is another backup or a session nobody will release,
    // and waiting on either is how a backup job becomes a hung process. The timeout is what
    // keeps `skipped` an honest answer instead of the usual one.
    await lock.query(`SET lock_timeout = ${lockWaitMs}`);
    try {
      await lock.query('SELECT pg_advisory_lock($1)', [COLLECTOR_LOCK_ID]);
    } catch {
      return {
        status: 'skipped' as const,
        error: `the collector lock was still held after ${lockWaitMs}ms; another backup is probably running`,
      };
    } finally {
      // This connection goes back to the pool, and a lock_timeout left on it would apply to
      // whatever runs there next.
      await lock.query('SET lock_timeout = DEFAULT');
    }

    const started = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (window_opened_at, destination, triggered_by)
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
            SET window_closed_at = now(), finished_at = now(), status = 'ok',
                bytes = $2, blob_count = $3
          WHERE id = $1`,
        [id, dumped.bytes + blobs.bytes, blobs.count],
      );
      return { id, status: 'ok' as const, bytes: dumped.bytes + blobs.bytes, blobCount: blobs.count };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.query(
        `UPDATE backup_runs
            SET window_closed_at = now(), finished_at = now(), status = 'failed', error = $2
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
 * the refusal, so nothing was being turned away afterwards. Calling that anything but `failed`
 * would leave a row an operator could mistake for a usable copy, which is the one thing
 * `backup_runs` exists to prevent.
 */
export const settleInterruptedRuns = async (db: Db): Promise<number> => {
  const rows = await db.query(
    `UPDATE backup_runs
        SET status = 'failed', finished_at = now(),
            window_closed_at = COALESCE(window_closed_at, now()),
            error = 'interrupted by a restart'
      WHERE status = 'running'
      RETURNING id`,
  );
  return rows.length;
};

/** One run, as a console or an operator sees it. */
export type BackupRunRow = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  bytes: string | null;
  blobCount: string | null;
  verifiedAt: string | null;
  error: string | null;
};

/** The previous runs, newest first — what the console's backup list shows. */
export const listBackups = async (db: Db, limit = 50): Promise<BackupRunRow[]> =>
  db.query<BackupRunRow>(
    `SELECT id::text AS id, started_at AS "startedAt", finished_at AS "finishedAt",
            status::text AS status, bytes::text AS bytes, blob_count::text AS "blobCount",
            verified_at AS "verifiedAt", error
       FROM backup_runs
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
  );

/**
 * Whether every blob the database references is present at the copy's address.
 *
 * The **one integrity check** the roadmap names, and the three callers share it: the
 * console's verify button, the periodic restore rehearsal, and the nightly run that checks
 * the backup it just took. A backup is two stores captured as one window (#114); this is
 * the question that proves they agree — for every `nodes.sha256` and `versions.sha256`,
 * the bytes exist in the blob copy under that address.
 *
 * The store is the BACKUP's, not the live one's: checking the live store would ask "is the
 * live data whole" and always answer yes. This asks "did the copy arrive".
 *
 * @param copy a reader over the backup's blob directory.
 * @returns the missing addresses, empty when the backup is whole. The count of checked
 *   blobs travels with it, because "whole" is only meaningful against "all of them".
 */
export const verifyBackup = async (
  db: Db,
  copy: { size(storageKey: string): Promise<number | undefined> },
  runId: string,
): Promise<{ missing: string[]; checked: number }> => {
  const addresses = await db.query<{ sha256: string }>(
    `SELECT encode(sha256, 'hex') AS sha256
       FROM nodes WHERE sha256 IS NOT NULL
     UNION
     SELECT encode(sha256, 'hex') AS sha256
       FROM versions`,
  );

  const missing: string[] = [];
  for (const { sha256 } of addresses) {
    const key = storageKeyFor(sha256);
    if ((await copy.size(key)) === undefined) missing.push(sha256);
  }

  await db.query(`UPDATE backup_runs SET verified_at = now() WHERE id = $1`, [runId]);
  return { missing, checked: addresses.length };
};
