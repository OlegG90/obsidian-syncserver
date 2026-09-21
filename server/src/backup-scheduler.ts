/**
 * The loop that takes a scheduled backup, and the sweep that keeps the last few (#357, D-141).
 *
 * **It adds nothing to how a backup is taken.** A scheduled run goes through `runBackup` on
 * exactly the path the console's button uses, with the same interlock, the same window and the
 * same self-check; what lives here is only the decision to start one, what to record when it
 * does not, and which old copies to drop afterwards.
 *
 * D-121 removed a nightly backup for four reasons, and three of them are answered on this
 * page: nothing is decided in `.env` (the schedule is a row), a skipped or failed run is
 * recorded rather than logged and forgotten, and a run that arrives at a busy moment or too
 * late gives up instead of opening a refusal window nobody chose.
 */
import { runBackup, type CopyReader, type Legs } from './backup.js';
import { backupRunDir, runDirOf } from './backup-legs.js';
import { removeBackupCopy } from './backup-remove.js';
import { claimDue, lastDue, nextRun, readSchedule, type StoredSchedule } from './backup-schedule.js';
import type { Db } from './db.js';

export interface ScheduleDeps {
  /** The configured backup directory — every run writes a subdirectory of it. */
  destination: string;
  makeLegs: (runDir: string) => Legs;
  openCopy?: (runDestination: string) => CopyReader;
}

/**
 * How long after a missed moment the console calls the schedule overdue.
 *
 * An hour, so that a run in progress, a slow dump or a minute's clock drift is not reported
 * as a server that has stopped taking backups — and so that a server which genuinely stopped
 * is reported within the hour rather than at the next restore.
 */
export const OVERDUE_MS = 60 * 60 * 1000;

/** A run this server decided not to take, recorded where every other outcome is recorded. */
const recordSkip = async (db: Db, reason: string): Promise<void> => {
  await db.query(
    `INSERT INTO backup_runs (started_at, finished_at, status, error, source)
     VALUES (now(), now(), 'skipped', $1, 'schedule')`,
    [reason],
  );
};

/**
 * Drop the scheduled copies past the last `keep`, newest kept.
 *
 * **Only runs the schedule took.** A manual copy is one somebody asked for, and a retention
 * rule that quietly deleted it would be the server deciding that a deliberate act expires —
 * which is D-121's second reason, the one that says a server deleting backups on a rule
 * nobody re-reads is a server that deletes backups.
 *
 * Removal is `removeBackupCopy`, so this inherits every refusal it makes: the newest copy
 * survives, a destination outside this deployment's directory is never touched, and the row
 * stays in the history with its destination cleared.
 */
export const sweepScheduledCopies = async (
  db: Db,
  root: string,
  keep: number,
  log: (m: string) => void = console.log,
): Promise<number> => {
  const old = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM backup_runs
      WHERE source = 'schedule' AND status = 'ok' AND destination IS NOT NULL
      ORDER BY started_at DESC
      OFFSET $1`,
    [keep],
  );
  let removed = 0;
  for (const row of old) {
    const refused = await removeBackupCopy(db, root, row.id);
    if (refused) {
      log(`backup schedule: kept ${row.id}, removal refused (${refused})`);
      continue;
    }
    removed++;
  }
  if (removed) log(`backup schedule: removed ${removed} copies past the last ${keep}`);
  return removed;
};

/**
 * Take the backup this moment owes, if it owes one.
 *
 * Returns what happened, so a test can drive a whole night by calling it with the clock it
 * chooses instead of waiting for one.
 */
export const takeScheduledBackup = async (
  db: Db,
  deps: ScheduleDeps,
  now = new Date(),
  log: (m: string) => void = console.log,
): Promise<'none' | 'missed' | 'busy' | 'ok' | 'failed'> => {
  const claim = await claimDue(db, now);
  if (!claim) return 'none';

  if (claim.late) {
    // The server was not running when the moment came, and the moment is now far enough past
    // that taking the copy would refuse writes in the middle of somebody's day.
    const reason = `missed: the server was not running at ${claim.due.toISOString()}`;
    await recordSkip(db, reason);
    log(`backup schedule: ${reason}`);
    return 'missed';
  }

  const runDir = backupRunDir(now.toISOString().replace(/[:.]/g, '-'));
  const runDestination = runDirOf(deps.destination, runDir);
  const out = await runBackup(db, deps.makeLegs(runDir), runDestination, {
    source: 'schedule',
    // **No waiting.** The console's button waits up to a minute for a collector pass, because
    // somebody is standing there having asked for a copy now. Nothing is standing here: a
    // moment that arrives while a backup, a restore or a pass holds the lock is a moment to
    // let go of, and the next one is already on the schedule.
    lockWaitMs: 0,
    log,
    ...(deps.openCopy ? { openCopy: deps.openCopy } : {}),
  });

  if (out.status === 'skipped' || out.status === 'refused') {
    const reason = out.error ?? out.status;
    await recordSkip(db, reason);
    log(`backup schedule: skipped — ${reason}`);
    return 'busy';
  }
  if (out.status === 'failed') return 'failed';

  await sweepScheduledCopies(db, deps.destination, (await readSchedule(db)).keep, log);
  return 'ok';
};

/** What the console shows beside the schedule: when it next runs, and whether it is in trouble. */
export interface ScheduleView extends StoredSchedule {
  /** The next moment it fires, or nothing when it is off or names no day. */
  nextRun: string | null;
  /** The last scheduled run failed. */
  lastFailed: boolean;
  /** A moment passed more than an hour ago and no scheduled run covered it. */
  overdue: boolean;
}

export const scheduleView = async (db: Db, now = new Date()): Promise<ScheduleView> => {
  const s = await readSchedule(db);
  const last = await db.one<{ status: string; startedAt: Date }>(
    `SELECT status::text AS status, started_at AS "startedAt"
       FROM backup_runs WHERE source = 'schedule' AND status <> 'running'
      ORDER BY started_at DESC LIMIT 1`,
  );
  const due = s.enabled ? lastDue(s, now) : undefined;
  // A skip is not a gap: the moment was dealt with, by a server that decided against opening
  // a window. What `overdue` reports is a moment nothing answered at all.
  const answered = due ? Boolean(last && last.startedAt.getTime() >= due.getTime()) : true;
  // **And a moment older than the schedule is not its to answer.** Switching one on at nine in
  // the morning must not light a banner about the 02:00 that passed while it was off — the
  // schedule in force since `updatedAt` owes only the moments that came after it.
  const owed = Boolean(due) && due!.getTime() > s.updatedAt.getTime();
  return {
    ...s,
    nextRun: s.enabled ? (nextRun(s, now)?.toISOString() ?? null) : null,
    lastFailed: last?.status === 'failed',
    overdue: owed && !answered && now.getTime() - due!.getTime() > OVERDUE_MS,
  };
};

/**
 * Check every minute whether the schedule owes a backup, starting one minute from now.
 *
 * A minute is the resolution a schedule set in whole minutes needs and no finer; the check
 * itself is one `SELECT` and one conditional `UPDATE`. Unref'd, like the collector's timer, so
 * it never keeps the process alive on its own, and re-entrant only in the sense the claim
 * settles: a tick that arrives while a backup is still running claims nothing, because the
 * moment it would claim is already marked.
 */
export const startBackupSchedule = (
  db: Db,
  deps: ScheduleDeps,
  log: (m: string) => void = console.log,
): (() => void) => {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await takeScheduledBackup(db, deps, new Date(), log);
    } catch (e) {
      log(`backup schedule failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
};
