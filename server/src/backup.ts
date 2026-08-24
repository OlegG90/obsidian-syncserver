/**
 * Taking a copy of both stores as one usable thing (docs/08, D-114).
 *
 * A backup is **two stores captured as one window**: the database, and the blobs the
 * database points at. Getting them separately is easy and useless — a dump that references
 * bytes the copy does not hold restores cleanly, looks whole, and cannot open a note. Nobody
 * finds out at restore time; somebody opens an old note months later.
 *
 * **A refusal window, not a freeze** (D-114), and the order follows from that. Holding a lock
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
import { holdForBackup, inRefusalWindow } from './interlock.js';
import { openStore, storageKeyFor } from './blobs/store.js';
import { join } from 'node:path';
import type { BackupRun } from '@syncserver/shared';

/** What each leg reports, so the run can record what it actually produced. */
export interface Legs {
  /**
   * Everything that must already be true before a window is worth opening.
   *
   * **Runs before the lock, before the row, before the window** — which is the whole point
   * of its existing separately from the legs it guards. The `pg_dump` major check lived inside
   * `dumpDatabase`, so a mismatched binary was discovered with writes already being refused
   * and a `backup_runs` row already inserted: the exact failure D-73 was opened to prevent,
   * reproduced one layer further in. A precondition that can only be checked by starting the
   * work is not a precondition.
   *
   * Required rather than optional, because a leg set that forgets it is silent and the thing
   * it forgets is the thing that makes a backup a backup. A set with genuinely nothing to
   * check says so with an empty body.
   *
   * @throws with a sentence naming what is wrong and what to fix.
   */
  assertReady(): Promise<void>;
  /** `pg_dump`, or whatever this deployment calls it. */
  dumpDatabase(): Promise<{ bytes: number }>;
  /** A copy of the blob store, taken AFTER the dump (D-114). */
  copyBlobs(): Promise<{ bytes: number; count: number }>;
}

export interface BackupResult {
  /**
   * Absent when nothing ran. A skipped call never inserted a row, so there is no id to
   * report — and an empty string in its place is a value a caller can log, store or compare
   * without ever being told it means "none".
   */
  id?: string;
  /**
   * `refused` is not `failed`: nothing ran, no window opened, no row exists. A deployment
   * whose dump binary cannot read its own database has a configuration problem, not a broken
   * backup, and recording it as a failed run would put a row in the history for a backup that
   * was never attempted.
   */
  status: 'ok' | 'failed' | 'skipped' | 'refused';
  bytes?: number;
  blobCount?: number;
  error?: string;
}

/** A reader over a backup's blob copy — the one thing an integrity check needs (docs/10). */
export interface CopyReader {
  size(storageKey: string): Promise<number | undefined>;
}

/**
 * Whether new writes are being refused right now.
 *
 * In memory rather than read per request: one process owns the window it opened, and a write path that
 * asked the database on every call would pay for something that happens when somebody presses a button.
 * The consequence is named where it matters — this is what makes the window a refusal for *new* writes
 * rather than a freeze, and therefore what forces the leg order (D-114).
 *
 * **Re-exported, not owned.** The window is a sub-interval of holding the interlock, so the flag lives
 * beside the lock that opens it (`interlock.ts`) — two variables for one interval is two things to keep
 * in step, and a window left open by a path that forgot is a server refusing every write until it
 * restarts.
 */
export const backupInProgress = inRefusalWindow;

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
  opts: {
    triggeredBy?: string;
    lockWaitMs?: number;
    /**
     * Where this run says what it is doing. **Defaulted to the console rather than to
     * silence**, because silence is the defect this was added for: the schedule wrapped its
     * own outcomes in log lines, the console's trigger wrapped nothing, and a hand-pressed
     * backup therefore opened a refusal window and closed it leaving no trace anywhere but a
     * row nobody was looking at. A logger a caller must remember to pass is a logger the next
     * caller will forget.
     *
     * The window is the reason this is not merely nice to have. It is the only thing in the
     * server that stops writes being accepted, and a run that hangs inside one is an outage
     * whose cause is unreadable unless something said it had begun — `settleInterruptedRuns`
     * exists precisely because a run can outlive its process, and until now the log had
     * nothing to say about the run it was cleaning up after.
     */
    log?: (message: string) => void;
    warn?: (message: string) => void;
    /**
     * A reader over the blob copy this run just wrote, when the caller wants it verified on the spot.
     * A copy with missing blobs is still a completed backup, but a flagged one — a backup nobody can
     * restore from is not a backup, and the operator is told rather than left to find out at restore
     * time.
     *
     * **Called after the window has closed and the lock is released** (#225). It used to run between
     * the legs and the settle, which put a walk over every blob address in the copy inside the interval
     * where the server turns new writes away — and the window buys nothing for it. What the window is
     * for is the two legs describing nearly the same instant in the one safe order (D-114); by the time
     * this runs both are on disk and the copy cannot change, whether or not writes are being accepted.
     * The cost scaled with the store: seconds on an empty vault, a full walk added to an outage on a
     * real one.
     */
    openCopy?: (runDestination: string) => CopyReader;
  } = {},
): Promise<BackupResult> => {
  // **Before the connection, the lock, the row and the window.** Everything below this line
  // costs something to undo: a lock other work waits on, a row in the backup history, and a
  // server that has stopped accepting writes. A precondition checked after any of them is not
  // protecting the thing it was written to protect — which is exactly how the `pg_dump` major
  // check came to run with the window already open.
  const { log = console.log, warn = console.warn, openCopy } = opts;
  try {
    await legs.assertReady();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // The loudest of the outcomes, because it is the one that will still be true tomorrow:
    // nothing ran, nothing will run, and no row records the fact.
    warn(`backup did not start: ${error}`);
    return { status: 'refused' as const, error };
  }

  const run = await db.session(async (lock) => {
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
    const release = await holdForBackup(lock, lockWaitMs);
    if (!release) {
      const error = `the collector lock was still held after ${lockWaitMs}ms; another backup is probably running`;
      // A schedule that silently skips is a schedule that has stopped being one.
      warn(`backup skipped: ${error}`);
      return { status: 'skipped' as const, error };
    }
    const started = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (window_opened_at, destination, triggered_by)
       VALUES (now(), $1, $2) RETURNING id::text AS id`,
      [destination, triggeredBy ?? null],
    );
    const id = started!.id;
    // Said as the window opens rather than after it closes: a run that never reaches its
    // settle line is exactly the run somebody needs to read about.
    const openedAt = Date.now();
    log(`backup ${id} started, writes refused until it finishes → ${destination}`);

    try {
      // The database FIRST (D-114). Reversing these two is the one mistake in this file that
      // produces a copy which restores without complaint and is missing files.
      const dumped = await legs.dumpDatabase();
      await db.query(`UPDATE backup_runs SET db_done_at = now() WHERE id = $1`, [id]);

      const blobs = await legs.copyBlobs();
      await db.query(`UPDATE backup_runs SET blobs_done_at = now() WHERE id = $1`, [id]);

      // **Settled here, checked afterwards** (#225). The copy is written and cannot change, so the
      // window has nothing left to protect and every moment it stays open is a write turned away.
      // The row is briefly `ok` with nothing recorded about its wholeness, which is exactly the state
      // it is in — and the same state a caller that passes no `openCopy` leaves it in for good.
      await db.query(
        `UPDATE backup_runs
            SET window_closed_at = now(), finished_at = now(), status = 'ok',
                bytes = $2, blob_count = $3
          WHERE id = $1`,
        [id, dumped.bytes + blobs.bytes, blobs.count],
      );
      log(
        `backup ${id} ok in ${Date.now() - openedAt}ms: ${blobs.count} blobs, ` +
          `${dumped.bytes + blobs.bytes} bytes, writes accepted again`,
      );
      const out: BackupResult = {
        id,
        status: 'ok',
        bytes: dumped.bytes + blobs.bytes,
        blobCount: blobs.count,
      };
      return out;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warn(`backup ${id} FAILED after ${Date.now() - openedAt}ms: ${message}`);
      await db.query(
        `UPDATE backup_runs
            SET window_closed_at = now(), finished_at = now(), status = 'failed', error = $2
          WHERE id = $1`,
        [id, message],
      );
      return { id, status: 'failed' as const, error: message };
    } finally {
      await release();
    }
  });

  // **The self-check, with the window shut and the lock gone** (#225).
  //
  // It answers the question the operator is standing there to ask — did the copy I just took arrive
  // whole? — and it is the only moment anybody is watching, on a server where nothing checks anything
  // on a schedule (D-121). What it is not is a reason to keep refusing writes: the copy is on disk and
  // immutable, so this reads the same bytes whether the server is serving or not.
  //
  // A failure here does not fail the run. The copy exists, its row says so, and the flag is what turns
  // "a backup ran" into "a backup ran and you cannot restore from it" — which is the sentence that has
  // to arrive now rather than at restore time.
  if (run.status !== 'ok' || run.id === undefined || !openCopy) return run;
  let selfCheckError: string | undefined;
  try {
    const out = await verifyBackup(db, openCopy(destination), run.id);
    if (out.missing.length > 0) {
      selfCheckError = `${out.missing.length} of ${out.checked} blobs missing from the copy`;
    }
  } catch (e) {
    selfCheckError = `self-check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!selfCheckError) {
    // "Not checked" and "checked and whole" are different claims, and a log that ran them together
    // would let an unverified copy read as a verified one.
    log(`backup ${run.id} verified whole`);
    return run;
  }
  await db.query(`UPDATE backup_runs SET error = $2 WHERE id = $1`, [run.id, selfCheckError]);
  warn(`backup ${run.id} completed but is NOT restorable: ${selfCheckError}`);
  return { ...run, error: selfCheckError };
};

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

/**
 * The backups this server **has**, newest first — what the console's list shows.
 *
 * **A run whose copy is gone is not one of them.** The row survives a removal, because forgetting the
 * run while its files stayed would leave an operator watching free space vanish with nothing that
 * explains it (#136) — but a list of backups is a list of things that can be restored, and a row that
 * cannot be is a stub somebody has to learn to read past. What happened to it is in the audit log, which
 * is where the record of an act belongs.
 *
 * The filter also settles the rows an upgrade brings with it: an installation that removed copies under
 * the old rule has them already, and there is no migration tool to go and tidy them (docs/13).
 */
export const listBackups = async (db: Db, limit = 50): Promise<BackupRun[]> =>
  db.query<BackupRun>(
    `SELECT id::text AS id, started_at AS "startedAt", finished_at AS "finishedAt",
            status::text AS status, bytes::text AS bytes, blob_count::text AS "blobCount",
            verified_at AS "verifiedAt", error, destination
       FROM backup_runs
      WHERE destination IS NOT NULL OR status = 'running'
      ORDER BY started_at DESC
      LIMIT $1`,
    [limit],
  );

/**
 * Every address the database references that a store does not have.
 *
 * Extracted from `verifyBackup` because it answers a second question with the same walk: pointed at a
 * **backup copy** it asks "did this copy arrive whole", and pointed at the **live store** it asks "what
 * did this restore fail to bring back" (#155). The decision that the second question gets an answer at
 * all is [08](../../docs/08-backup-restore.md)'s — *"an honest report of '13 files not restored' beats a
 * store that never frees space"* — and it had no implementation until the restore did.
 */
export const missingBlobs = async (
  db: Db,
  store: { size(storageKey: string): Promise<number | undefined> },
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
    if ((await store.size(key)) === undefined) missing.push(sha256);
  }
  return { missing, checked: addresses.length };
};

/**
 * Whether every blob the database references is present at the copy's address.
 *
 * The **one integrity check** the roadmap names, and the three callers share it: the
 * console's verify button, the periodic verification, and the nightly run that checks
 * the backup it just took. A backup is two stores captured as one window (D-114); this is
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
  const { missing, checked } = await missingBlobs(db, copy);

  // **Only when it is whole.** `verified_at` was stamped unconditionally, so a copy this very
  // function had just found blobs missing from was listed in the console as verified — the
  // check wearing the badge of the thing that would have caught it, which is worse than not
  // checking at all. A run that was checked and failed is left unstamped, so "verified" and
  // "not verified" keep meaning what an operator reads them to mean; the missing addresses go
  // back to the caller, which is where the console gets its sentence from.
  if (missing.length === 0) {
    await db.query(`UPDATE backup_runs SET verified_at = now() WHERE id = $1`, [runId]);
  }
  return { missing, checked };
};

