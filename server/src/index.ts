import { buildApp } from './app.js';
import { settleInterruptedRuns } from './backup.js';
import { hasActiveAdministrator } from './bootstrap.js';
import { startCollector } from './collector.js';
import { openStore } from './blobs/store.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { openEventsHub } from './events.js';

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
