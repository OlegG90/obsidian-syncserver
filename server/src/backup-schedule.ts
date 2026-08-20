/**
 * The thing that presses the button (docs/10).
 *
 * `runBackup` has existed since M5 and had exactly one caller: the console's trigger. So a
 * backup happened when a person remembered, which for an unattended NAS means an installation
 * nobody touches for a month has no copies from that month — and nothing said so. The roadmap
 * names three callers of the integrity check, and "whatever runs it nightly" was the missing
 * one.
 *
 * **Each scheduled run verifies the copy it just wrote.** That is the self-check of #74: a
 * backup nobody can restore from is not a backup, and the moment it was written is the cheapest
 * moment to find out — the alternative is finding out at restore time, which is the one time
 * nothing can be done about it.
 *
 * **Nothing runs at boot.** A server in a restart loop would otherwise take a backup per
 * restart, each opening a refusal window, which turns a crash into an outage. The interval is
 * the whole schedule.
 *
 * The collector interlock needs nothing here: `runBackup` takes the collector's advisory lock
 * (blocking, bounded), so a scheduled run and a collector pass serialise against each other the
 * same way a console-triggered one does.
 */
import { join } from 'node:path';
import { openStore } from './blobs/store.js';
import { runBackup, type CopyReader, type Legs } from './backup.js';
import { backupRunDir, runDirOf } from './backup-legs.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

/**
 * Take one scheduled backup and say what happened.
 *
 * Exported separately from the timer because this is where the judgement is — which run
 * directory, whether to verify, what to say about each outcome — and a `setInterval` is not
 * worth a test. The stamp is passed in for the same reason: a test that cannot name the
 * directory cannot assert about it.
 */
export const takeScheduledBackup = async (
  db: Db,
  backup: NonNullable<Config['backup']>,
  makeLegs: (runDir: string) => Legs,
  stamp: string,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
  /**
   * How to read back the copy just written. Injected for the same reason the legs are: what a
   * blob store is on this host is a deployment fact, while "verify what you just wrote" is the
   * rule — and a test that cannot supply one has to create real directories to say anything.
   */
  openCopy: (runDestination: string) => CopyReader = (dest) => openStore(join(dest, 'blobs')),
): Promise<void> => {
  const runDir = backupRunDir(stamp);
  const runDestination = runDirOf(backup.destination, runDir);

  // The self-check, on the copy this run just wrote (#74). Same reader the console's trigger
  // uses by default, so a scheduled backup is checked exactly as a hand-pressed one is.
  const out = await runBackup(db, makeLegs(runDir), runDestination, { openCopy });

  // Said at the level the outcome deserves, because on an unattended box the log IS the
  // surface — there is nobody with the console open to notice a row.
  switch (out.status) {
    case 'ok':
      // `error` on an `ok` run is the self-check's complaint: the backup completed and the
      // copy is not whole, which is a warning about a run that otherwise looks fine.
      if (out.error) warn(`scheduled backup ${runDestination} completed but is NOT restorable: ${out.error}`);
      else log(`scheduled backup ${runDestination}: ${out.blobCount ?? 0} blobs, verified whole`);
      return;
    case 'refused':
      warn(`scheduled backup did not start: ${out.error}`);
      return;
    case 'skipped':
      // Another backup held the lock past the timeout. Worth saying rather than passing over:
      // a schedule that silently skips is a schedule that stops being one.
      warn(`scheduled backup skipped: ${out.error}`);
      return;
    default:
      warn(`scheduled backup FAILED: ${out.error}`);
  }
};

/**
 * Start the schedule, and hand back the way to stop it.
 *
 * Shaped like `startCollector` deliberately — same lifecycle, same place in `index.ts`, same
 * `unref` so a timer never holds the process open. A configuration with no backups, or an
 * interval of zero, returns a stop function that stops nothing: "off" is a schedule too, and
 * the caller should not have to ask which case it is in.
 */
export const startBackupSchedule = (
  db: Db,
  cfg: Config,
  makeLegs: (runDir: string) => Legs,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
): (() => void) => {
  const backup = cfg.backup;
  if (!backup || cfg.backupEverySeconds <= 0) return () => {};

  // A slow backup must not pile up behind itself. `runBackup` would serialise them on the
  // advisory lock anyway, but that turns a long run into a queue of waiting ones, and a queue
  // of backups is a queue of refusal windows.
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await takeScheduledBackup(db, backup, makeLegs, new Date().toISOString().replace(/[:.]/g, '-'), log, warn);
    } catch (e) {
      // Nothing above should throw — `runBackup` returns its failures — so reaching here is a
      // defect rather than a failed backup. It still must not kill the timer.
      warn(`scheduled backup threw: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  log(`backups are scheduled every ${cfg.backupEverySeconds}s to ${backup.destination}`);
  const timer = setInterval(() => void tick(), cfg.backupEverySeconds * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
};
