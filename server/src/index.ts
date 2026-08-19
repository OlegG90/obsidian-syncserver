import { buildApp } from './app.js';
import { settleInterruptedRuns } from './backup.js';
import { assertPgDumpMatches, pgDumpVersion } from './backup-legs.js';
import { hasActiveAdministrator } from './bootstrap.js';
import { startCollector } from './collector.js';
import { openStore } from './blobs/store.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { openEventsHub } from './events.js';
import { restoreStatus, writeEpochFile } from './restore.js';

const cfg = loadConfig();
const db = connect(cfg.databaseUrl);
const events = openEventsHub(db);
const app = await buildApp(db, cfg, events);

// The collector shares the blob store with the routes — same path, same directory.
const collectorStore = openStore(cfg.blobStorePath);
const stopCollector = startCollector(db, collectorStore, cfg);

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

// A backup whose dump cannot read this server's PostgreSQL is a backup that will fail the
// moment it is asked — checked at startup (docs/10) so the operator learns it here rather
// than on the first real run, when the window is already open. Not fatal: the server still
// serves, but the console's backup button will refuse until the versions agree.
if (cfg.backup) {
  const serverLine = (await db.one<{ version: string }>('SELECT version() AS version'))?.version ?? '';
  try {
    assertPgDumpMatches(await pgDumpVersion(cfg.backup.dumpCommand), serverLine);
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
    void events.close().then(() => app.close()).then(() => db.close()).then(() => process.exit(0));
  });
}
