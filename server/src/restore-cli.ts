/**
 * The command an operator runs to put a backup back (#155).
 *
 * Deliberately a **one-off container and not an endpoint**: a server that can overwrite itself from a
 * web console is a new way to lose a vault. The console's part is what it already does — confirming the
 * restore afterwards, which is the act only a person can take responsibility for.
 *
 *     docker compose stop server
 *     docker compose run --rm server node server/dist/restore-cli.js /backups/backup-2026-08-21T…
 *     docker compose start server
 *
 * The server then notices by itself: the epoch file outside the database is ahead of the database it has
 * just been given, so it halts and answers `restore_pending` until somebody confirms in the console
 * ([08](../../docs/08-backup-restore.md)).
 */
import { loadConfig } from './config.js';
import { connect } from './db.js';
import { openStore } from './blobs/store.js';
import { restoreFrom } from './restore-run.js';

const dir = process.argv[2];
if (!dir) {
  console.error(
    'usage: node server/dist/restore-cli.js <backup directory>\n' +
      'The directory is one of the run directories under the backup destination — the console lists them.',
  );
  process.exit(2);
}

const cfg = loadConfig();
const db = connect(cfg.databaseUrl);

try {
  const out = await restoreFrom(db, dir, {
    blobStorePath: cfg.blobStorePath,
    restoreCommand: cfg.restoreCommand,
    store: openStore(cfg.blobStorePath),
  });

  if ('kind' in out) {
    // Both refusals are things the operator can act on in one step, so each says the step rather than
    // the state: a count of connections is what "stop the server" looks like from in here.
    if (out.kind === 'server_running') {
      console.error(
        `refusing: ${out.connections} other connection(s) to this database. Stop the server first — ` +
          '`docker compose stop server` — and run this again. A restore under a running server leaves ' +
          'neither the old data nor the new.',
      );
    } else {
      console.error(`refusing: ${out.detail}`);
    }
    process.exit(1);
  }

  for (const address of out.missing) console.error(`not restored: ${address}`);
  // A restore that could not bring everything back still HAPPENED, and the operator has to know both
  // halves. Exit 0 with the list, rather than a failure that reads as "nothing was restored".
  process.exit(0);
} finally {
  await db.close();
}
