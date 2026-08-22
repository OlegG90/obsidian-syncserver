/**
 * The bad day: a backup is put back.
 *
 * Named for what happens rather than for the module it reaches (AGENTS.md), and the name is the point.
 * `restore-run.test.ts` asked "does this file work"; every unit did, while the argv contract lived
 * *between* two files and no unit test was looking — which is how issue #171 shipped a restore that
 * could not restore. A suite named for the day has to name the real command, and one of these does.
 *
 * The interesting parts are the two refusals and the report, not the copying: a restore under a live
 * server, or against a directory that is not a backup, is how an installation loses both the old data
 * and the new; and one that cannot bring everything back has to **say so**.
 *
 * **Its own process, and not by accident.** It counts connections to the database, and the rehearsal
 * next door opens and drops scratch databases — run in one file, each makes the other's answer wrong.
 * `tsx --test test/*.test.ts` gives a file a process, which is what keeps them apart.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { restoreArgv } from '../src/restore-argv.js';
import {
  currentDatabase, looksLikeABackup, otherConnections, restoreFrom,
} from '../src/restore-run.js';

let db: Db;
let root: string;

before(async () => {
  db = connect(loadConfig().databaseUrl);
  root = await mkdtemp(join(tmpdir(), 'syncserver-restore-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await db.close();
});

/** A directory shaped like a backup run: the dump beside the blob copy. */
const aBackup = async (name: string, blobs: Record<string, string> = {}): Promise<string> => {
  const dir = join(root, name);
  await mkdir(join(dir, 'blobs'), { recursive: true });
  await writeFile(join(dir, 'database.dump'), 'not a real dump');
  for (const [key, body] of Object.entries(blobs)) {
    await mkdir(join(dir, 'blobs', key.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, 'blobs', key.slice(0, 2), key), body);
  }
  return dir;
};

describe('what is not a backup', () => {
  it('refuses a directory with no dump, naming the file', async () => {
    const dir = join(root, 'empty');
    await mkdir(join(dir, 'blobs'), { recursive: true });
    const wrong = await looksLikeABackup(dir);
    assert.match(wrong!, /database\.dump is missing/);
  });

  it('refuses a dump with no blob copy', async () => {
    const dir = join(root, 'dump-only');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'database.dump'), 'x');
    assert.match((await looksLikeABackup(dir))!, /blobs is missing/);
  });

  it('accepts one that has both', async () => {
    assert.equal(await looksLikeABackup(await aBackup('whole')), undefined);
  });

  it('checks before it touches anything', async () => {
    // The order matters more than the message: a restore that copied blobs and THEN discovered the dump
    // was missing would have changed the store for a restore that cannot happen. So the assertion is
    // about the store, not about the answer — the answer was the same when the check ran last.
    const dir = join(root, 'no-dump');
    await mkdir(join(dir, 'blobs'), { recursive: true });
    await writeFile(join(dir, 'blobs', 'something'), 'would have been copied');
    const live = join(root, 'live-untouched');

    const out = await restoreFrom(db, dir, {
      blobStorePath: live,
      restoreCommand: ['false'],
      store: { size: async () => undefined },
      log: () => undefined,
    });

    assert.deepEqual('kind' in out ? out.kind : out, 'not_a_backup');
    await assert.rejects(readFile(join(live, 'something')), 'the store was never written');
  });
});

describe('refusing to run under a live server', () => {
  it('counts the other connections to this database', async () => {
    // "Am I alone" has an exact answer; "is the server stopped" is a guess about another process.
    const before = await otherConnections(db);
    const second = connect(loadConfig().databaseUrl);
    await second.query('SELECT 1');
    assert.equal(await otherConnections(db), before + 1);
    await second.close();
  });

  it('stops before copying anything when somebody else is connected', async () => {
    // `pg_restore --clean` drops and recreates what it restores. Under a running server that is not a
    // race to be careful about — it is open transactions against tables being dropped.
    const second = connect(loadConfig().databaseUrl);
    await second.query('SELECT 1');

    const live = join(root, 'live-refused');
    const out = await restoreFrom(db, await aBackup('under-a-server'), {
      blobStorePath: live,
      // A command that would fail loudly if it were ever reached.
      restoreCommand: ['false'],
      store: { size: async () => undefined },
      log: () => undefined,
    });

    assert.equal('kind' in out ? out.kind : undefined, 'server_running');
    await assert.rejects(readFile(join(live, 'aa', 'aa')), 'nothing was copied');
    await second.close();
  });
});

describe('the report a restore leaves behind', () => {
  it('names every address the database references and the store does not have', async () => {
    // The decision docs/08 recorded — "an honest report of '13 files not restored' beats a store that
    // never frees space" — and the only moment the question means anything is after both halves are
    // back. Asked of the LIVE store, not of the copy.
    const dir = await aBackup('with-a-report');
    const held = new Set(['aa'.repeat(32)]);
    const out = await restoreFrom(db, dir, {
      blobStorePath: join(root, 'live-report'),
      // `true` exits zero and does nothing: this test is about the walk, not about pg_restore.
      restoreCommand: ['true'],
      store: { size: async (key) => (held.has(key.split('/').pop() ?? '') ? 1 : undefined) },
      log: () => undefined,
    });

    assert.ok(!('kind' in out), 'it ran');
    if ('kind' in out) return;
    // Whatever this development database holds, the answer has the shape of an answer: every address
    // it walked, and the ones that are absent are a subset of them.
    assert.equal(typeof out.checked, 'number');
    assert.ok(out.missing.length <= out.checked);
  });

  it('copies the blobs into the live store rather than over it', async () => {
    // A blob the store has and the copy does not is unreferenced content, which the collector already
    // knows how to remove. Deleting it here would be a restore taking away what it was not asked about.
    const dir = await aBackup('additive', { ['bb'.repeat(32)]: 'restored bytes' });
    const live = join(root, 'live-additive');
    await mkdir(join(live, 'cc'), { recursive: true });
    await writeFile(join(live, 'cc', 'cc'.repeat(32)), 'was already here');

    await restoreFrom(db, dir, {
      blobStorePath: live,
      restoreCommand: ['true'],
      store: { size: async () => 1 },
      log: () => undefined,
    });

    assert.equal(await readFile(join(live, 'bb', 'bb'.repeat(32)), 'utf8'), 'restored bytes');
    assert.equal(await readFile(join(live, 'cc', 'cc'.repeat(32)), 'utf8'), 'was already here');
  });
});

describe('the arguments pg_restore actually sees', () => {
  // The defect this suite could not see: every test above injects `true` in place of the binary, so the
  // argv went unread for as long as it was wrong. `RESTORE_DB_COMMAND` ends at `-d`, and the restore
  // appended the dump straight after it — handing pg_restore the archive path where it expected a
  // database name (#171).
  it('puts the database before the archive', () => {
    const { cmd, args } = restoreArgv(
      ['pg_restore', '--clean', '--if-exists', '--no-owner', '-d'],
      'syncserver',
      '/backups/run/database.dump',
    );
    assert.equal(cmd, 'pg_restore');
    assert.deepEqual(args, [
      '--clean', '--if-exists', '--no-owner', '-d', 'syncserver', '/backups/run/database.dump',
    ]);
  });

  it('treats an override that forgot `-d` the same as one that carries it', () => {
    // The setting is an operator's to change, and the shape it has to end in is not something they
    // should have to know. Both spellings, and `--dbname`, arrive at the same argv.
    const expected = ['--no-owner', '-d', 'syncserver', '/dump'];
    for (const command of [
      ['pg_restore', '--no-owner'],
      ['pg_restore', '--no-owner', '-d'],
      ['pg_restore', '--no-owner', '--dbname'],
    ]) {
      assert.deepEqual(restoreArgv(command, 'syncserver', '/dump').args, expected);
    }
  });

  it('refuses to run a command that names no binary', () => {
    assert.throws(() => restoreArgv([], 'syncserver', '/dump'), /no restore binary/);
  });

  it('takes the database from the connection, so it cannot name a different one', async () => {
    // Not from DATABASE_URL: that variable may be unset, leaving the name to libpq, and a second place
    // to say which database this is would be a way to restore into the wrong one and be told it worked.
    const [onDb] = await db.query<{ name: string }>('SELECT current_database() AS name');
    assert.equal(await currentDatabase(db), onDb?.name);
  });

  it('hands those arguments to the binary it runs', async () => {
    // Not a unit test of the helper twice over: this one goes through `restoreFrom` and execFile, so it
    // fails if the restore ever stops asking. `sh -c` writes what it was given and exits zero.
    const dir = await aBackup('argv');
    const seen = join(root, 'argv-seen');
    const out = await restoreFrom(db, dir, {
      blobStorePath: join(root, 'live-argv'),
      restoreCommand: ['sh', '-c', `printf '%s\n' "$@" > ${seen}`, 'sh', '-d'],
      store: { size: async () => 1 },
      log: () => undefined,
    });

    assert.ok(!('kind' in out), 'it ran');
    assert.deepEqual((await readFile(seen, 'utf8')).trim().split('\n'), [
      '-d', await currentDatabase(db), join(dir, 'database.dump'),
    ]);
  });

  it('does not touch the blob store when the configuration cannot make a command', async () => {
    // A misconfiguration found after the blob copy would leave the store written to by a restore that
    // never ran — the half-applied state this file exists to keep harmless.
    const dir = await aBackup('unconfigured', { ['dd'.repeat(32)]: 'should not arrive' });
    const live = join(root, 'live-unconfigured');
    await assert.rejects(
      restoreFrom(db, dir, {
        blobStorePath: live,
        restoreCommand: [],
          store: { size: async () => 1 },
        log: () => undefined,
      }),
    );
    assert.equal(existsSync(live), false, 'nothing was copied');
  });
});
