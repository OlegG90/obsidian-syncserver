/**
 * The rehearsal that actually restores (#159).
 *
 * Against a **real dump of a real database**, taken here with `pg_dump`, because the whole point is the
 * one thing a mocked archive cannot have: whether `pg_restore` can read it. The check this replaces
 * confirms that a copy's blobs are present, which says the copy arrived and not that the archive can be
 * read — and those come apart exactly where it matters.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { pgMajor, serverVersionLine } from '../src/backup-legs.js';
import { readRehearsal, rehearsalFile, rehearseRestore } from '../src/rehearsal.js';

const cfg = loadConfig();
let db: Db;
let root: string;
/** The matching `pg_dump`, or nothing — see `findPgDump`. */
let pgDump: string | undefined;

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    );
  });

/**
 * A `pg_dump` of the SAME major as the server, or nothing.
 *
 * The fixture here takes a real dump, and `pg_dump` refuses a server newer than itself — the platform
 * trap this project has a guard for (`assertPgDumpMatches`, docs/10). CI runs `postgres:18` as a service
 * while the runner's own client is whatever Ubuntu ships, so a bare `pg_dump` aborts with "server version
 * mismatch" and the failure looks like the feature rather than the fixture.
 *
 * Versioned paths are tried because a runner usually carries several majors side by side. When none
 * matches, the tests that need a dump **skip and say so** — a machine that cannot take one is not a
 * broken rehearsal, and a silent pass would be worse than either.
 */
const findPgDump = async (): Promise<string | undefined> => {
  const want = pgMajor(await serverVersionLine(db));
  if (want === undefined) return undefined;
  for (const candidate of ['pg_dump', `/usr/lib/postgresql/${want}/bin/pg_dump`]) {
    const line = await run(candidate, ['--version']).catch(() => undefined);
    if (line && pgMajor(line) === want) return candidate;
  }
  return undefined;
};

/**
 * Any scratch database an earlier run left behind.
 *
 * A rehearsal drops its own in a `finally`, so this should always find nothing — but a crashed run, or a
 * mutation test that removed the drop, leaves one named after a moment nobody remembers, and every run
 * after it fails on a name that already exists. Cleaning up before rather than assuming means a broken
 * run costs one run.
 */
const dropStrayScratchDatabases = async (): Promise<void> => {
  const stray = await db.query<{ name: string }>(
    `SELECT datname AS name FROM pg_database WHERE datname LIKE 'syncserver_rehearsal_%'`,
  );
  for (const { name } of stray) await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
};

before(async () => {
  db = connect(cfg.databaseUrl);
  root = await mkdtemp(join(tmpdir(), 'syncserver-rehearsal-'));
  pgDump = await findPgDump();
  await dropStrayScratchDatabases();
});

after(async () => {
  await dropStrayScratchDatabases();
  await rm(root, { recursive: true, force: true });
  await db.close();
});

/**
 * A backup run with a real dump of the development database behind it.
 *
 * `backup_runs` is where the rehearsal looks for "the newest good copy", so the fixture has to be a row
 * as well as a directory — the two halves that make a backup findable.
 */
const aBackupOf = async (name: string, dump: 'real' | 'corrupt'): Promise<string> => {
  const dir = join(root, name);
  await mkdir(join(dir, 'blobs'), { recursive: true });

  if (dump === 'real') {
    await run(pgDump!, ['--format=custom', '--file', join(dir, 'database.dump'), cfg.databaseUrl ?? '']);
  } else {
    await writeFile(join(dir, 'database.dump'), 'this is not an archive at all');
  }

  await db.query(`DELETE FROM backup_runs`);
  const row = await db.one<{ id: string }>(
    `INSERT INTO backup_runs (started_at, window_opened_at, db_done_at, blobs_done_at, window_closed_at,
                              finished_at, status, destination)
          VALUES (now(), now(), now(), now(), now(), now(), 'ok', $1)
       RETURNING id::text AS id`,
    [dir],
  );
  assert.ok(row);
  return dir;
};

const stateFile = (): string => join(root, 'state', 'restore.epoch');

describe('loading the newest backup into a scratch database', () => {
  it('says what came out, and leaves no database behind', async (t) => {
    if (!pgDump) return t.skip('no pg_dump of the server’s own major on this machine');
    await aBackupOf('good', 'real');
    const said: string[] = [];

    const out = await rehearseRestore(db, {
      databaseUrl: cfg.databaseUrl,
      restoreCommand: cfg.restoreCommand,
      stateFile: stateFile(),
      stamp: 'good-one',
      log: (m) => said.push(m),
    });

    assert.ok(out);
    assert.equal(out.ok, true, out.detail);
    assert.match(out.detail, /schema complete/);
    assert.match(out.detail, /account\(s\)/, 'and that it holds accounts, which every real one does');

    // Dropped in a `finally`: a rehearsal that left its scratch database behind would fill the server
    // with them, one a week, named after the moment nobody remembers.
    const left = await db.query<{ name: string }>(
      `SELECT datname AS name FROM pg_database WHERE datname LIKE 'syncserver_rehearsal_%'`,
    );
    assert.deepEqual(left, []);
  });

  it('records the outcome where a restart cannot lose it', async (t) => {
    if (!pgDump) return t.skip('the case above did not run, so there is no record to read');
    // "The last successful rehearsal was 60 days ago" has to be answerable after the container has been
    // replaced, which is why this is a file beside the restore epoch and not a variable.
    const written = await readRehearsal(stateFile());
    assert.ok(written);
    assert.equal(written.ok, true);
    assert.match(written.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rehearsalFile(stateFile()), join(root, 'state', 'rehearsal.json'));
  });

  it('reports an archive that cannot be read, rather than throwing', async () => {
    // This is the failure the blob check cannot see, and the only reason this rehearsal exists: a dump
    // that is present, sized, and unreadable.
    await aBackupOf('corrupt', 'corrupt');
    const warned: string[] = [];

    const out = await rehearseRestore(db, {
      databaseUrl: cfg.databaseUrl,
      restoreCommand: cfg.restoreCommand,
      stateFile: stateFile(),
      stamp: 'corrupt-one',
      log: () => undefined,
      warn: (m) => warned.push(m),
    });

    assert.ok(out);
    assert.equal(out.ok, false);
    assert.match(out.detail, /did not restore/);
    assert.match(warned.join(' '), /rehearsal/);

    const written = await readRehearsal(stateFile());
    assert.equal(written!.ok, false, 'and the record says so, so the console can stop saying "healthy"');
  });

  it('says nothing at all when there is nothing to rehearse', async () => {
    // No successful backup with a copy on disk is not a failure: a server that has never been backed up
    // has nothing to say about restoring, and saying it anyway would be noise on every fresh install.
    await db.query(`DELETE FROM backup_runs`);
    const said: string[] = [];
    const out = await rehearseRestore(db, {
      databaseUrl: cfg.databaseUrl,
      restoreCommand: cfg.restoreCommand,
      stateFile: stateFile(),
      stamp: 'nothing',
      log: (m) => said.push(m),
      warn: (m) => said.push(m),
    });
    assert.equal(out, undefined);
    assert.deepEqual(said, []);
  });
});
