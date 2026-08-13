import { buildApp } from './app.js';
import { hasActiveAdministrator } from './bootstrap.js';
import { startCollector } from './collector.js';
import { openStore } from './blobs/store.js';
import { loadConfig } from './config.js';
import { connect } from './db.js';

const cfg = loadConfig();
const db = connect(cfg.databaseUrl);
const app = await buildApp(db, cfg);

// The collector shares the blob store with the routes — same path, same directory.
const collectorStore = openStore(cfg.blobStorePath);
const stopCollector = startCollector(db, collectorStore, cfg);

if (cfg.serverSecretIsDefault) {
  console.warn(
    'SERVER_SECRET is unset and the development default is in use. It signs access tokens, ' +
      'the delta cursor and the salt an unknown login receives — set it before this server ' +
      'is reachable by anyone else.',
  );
}

if (!(await hasActiveAdministrator(db))) {
  console.warn(
    'No administrator yet: this server answers only /auth/kdf and /auth/redeem until the ' +
      'seeded invitation for login "admin" is redeemed.',
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
    void app.close().then(() => db.close()).then(() => process.exit(0));
  });
}
