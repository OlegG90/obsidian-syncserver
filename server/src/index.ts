import { buildApp } from './app.js';
import { settleInterruptedRuns } from './backup.js';
import { assertPgDumpMatches, backupLegs, pgDumpVersion, serverVersionLine } from './backup-legs.js';
import { startBackupSchedule } from './backup-schedule.js';
import { hasActiveAdministrator } from './bootstrap.js';
import { startCollector } from './collector.js';
import { openStore } from './blobs/store.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { openEventsHub } from './events.js';
import { restoreStatus, writeEpochFile } from './restore.js';
import { ensureSchema } from './schema.js';
import { rehearseRestore } from './rehearsal.js';

const cfg = loadConfig();
const db = connect(cfg.databaseUrl);

// **First, before anything queries a table.** On a fresh installation there is nothing to query
// until this has run: the schema travels inside this image now, not as a file the operator has
// to mount beside the compose file (docs/13). On an existing database it only compares, and
// says in the log what is missing.
await ensureSchema(db);
const events = openEventsHub(db);
const app = await buildApp(db, cfg, events);

// The collector shares the blob store with the routes — same path, same directory.
const collectorStore = openStore(cfg.blobStorePath);
const stopCollector = startCollector(db, collectorStore, cfg);

// The PostgreSQL major a dump must match (docs/10), used by both the things here that need it:
// the legs the schedule builds, and the advisory check below. Through the reader that owns the
// fact — `buildApp` needs the same string, and this used to ask for it a second time (D-89).
const versionLine = cfg.backup ? await serverVersionLine(db) : '';

/**
 * The **rehearsal**: it *loads* the newest dump into a scratch database, where a verification only
 * confirms the copy's blobs are all present. "The copy arrived" and "the archive can be read" are two
 * claims, and only the second is what docs/08 means by *"a backup that has never been restored is not a
 * backup"* — which is why this one runs on a schedule and the verification does not run on one at all.
 *
 * On its own, much rarer interval, and NOT at boot: restoring a whole dump on a NAS is minutes, and a
 * server that spent them before it started serving would be paying for the check at the worst moment.
 */
let rehearsalTimer: ReturnType<typeof setInterval> | undefined;
if (cfg.backup && cfg.rehearsalIntervalSeconds > 0) {
  const rehearse = async (): Promise<void> => {
    try {
      await rehearseRestore(db, {
        databaseUrl: cfg.databaseUrl,
        restoreCommand: cfg.restoreCommand,
        stateFile: cfg.restoreStateFile,
        stamp: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`rehearsal failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  rehearsalTimer = setInterval(() => void rehearse(), cfg.rehearsalIntervalSeconds * 1000);
  rehearsalTimer.unref?.();
}

// The caller docs/10 named and nothing was: whatever runs a backup nightly. Off when no backup
// is configured, and off when the interval is zero — a deployment driving backups from cron on
// the host wants one schedule, not two. Nothing runs at boot: a server in a restart loop would
// otherwise take a backup per restart, each opening a refusal window.
const stopBackupSchedule = startBackupSchedule(db, cfg, (runDir) =>
  backupLegs(
    cfg.backup!.destination,
    cfg.backup!.dumpCommand,
    cfg.backup!.blobSource,
    runDir,
    versionLine,
  ),
);

// A `running` backup row that survived a restart is a lie: the window it recorded went with
// the process, so nothing has been refusing writes since. Nothing else will ever settle it —
// the `finally` that would have belongs to a process that no longer exists — and a row an
// operator could mistake for a usable copy is the one thing `backup_runs` exists to prevent.
const interrupted = await settleInterruptedRuns(db);
if (interrupted > 0) {
  console.warn(
    `${interrupted} backup run(s) were still marked running from before this restart and have ` +
      'been recorded as failed. Whatever they produced is not a copy to restore from.',
  );
}

// A backup whose dump cannot read this server's PostgreSQL is a backup that cannot be taken
// — checked at startup (docs/10) so the operator learns it here, at boot, rather than the
// first time somebody needs a copy.
//
// Advisory, and deliberately so: the ENFORCEMENT is `assertReady`, which every run calls
// before it takes the lock, inserts a row or opens the window, so the button refuses with
// nothing started whether or not anybody read this line. Warning here and refusing there is
// not two checks disagreeing — it is the difference between telling somebody early and
// stopping the thing that would go wrong.
if (cfg.backup) {
  try {
    assertPgDumpMatches(await pgDumpVersion(cfg.backup.dumpCommand), versionLine);
  } catch (e) {
    console.warn(`backup disabled: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (cfg.serverSecretIsDefault) {
  console.warn(
    'SERVER_SECRET is unset and the development default is in use. It signs access tokens, ' +
      'the delta cursor and the salt an unknown login receives — set it before this server ' +
      'is reachable by anyone else.',
  );
}

if (!(await hasActiveAdministrator(db))) {
  console.warn(
    'No administrator yet: this server answers only /auth/kdf, /auth/bootstrap, /health and ' +
      'the console until the first administrator password is set. Open the console, or POST ' +
      'a password to /auth/bootstrap.',
  );
}

// The restore guard (docs/11): on every successful start the newest epoch this server has
// run with is written to the state file, so a later restore that lowers the database's
// epoch is detectable. When the database is BEHIND the file, the app's hooks will answer
// `restore_pending` to everything but the confirm path — say so here, because a server
// that answers only one endpoint is not a broken one.
//
// `buildApp` has already established whether this server is halted (D-87); this read is for
// the two things only a boot does — telling the operator, and bringing the file up. Both need
// the numbers rather than the yes/no, so it asks for them rather than reusing a flag that
// cannot answer.
const restore = await restoreStatus(db, cfg.restoreStateFile);
if (restore.pending) {
  console.warn(
    `The database's restore_epoch (${restore.dbEpoch}) is behind this server's state file ` +
      `(${restore.fileEpoch}). A restore happened and was not confirmed — the server is ` +
      'answering only the console and the restore endpoints until it is.',
  );
} else {
  // Not pending: the file was at or below the database. Bring it up to the database so the
  // guard knows the newest value — this is what "writes the current epoch at startup" means.
  await writeEpochFile(cfg.restoreStateFile, restore.dbEpoch);
}

const port = Number(process.env['PORT'] ?? 8080);
// Loopback by default, because a development server that binds every interface is one
// somebody eventually reaches from the network without deciding to allow it. In a
// container there is no loopback worth binding, so HOST is set there instead — and the
// deployment perimeter is the private network, not this line (docs/02).
const host = process.env['HOST'] ?? '127.0.0.1';
await app.listen({ port, host });
console.log(`syncserver listening on ${host}:${port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopCollector();
    stopBackupSchedule();
    if (rehearsalTimer) clearInterval(rehearsalTimer);
    void events.close().then(() => app.close()).then(() => db.close()).then(() => process.exit(0));
  });
}
