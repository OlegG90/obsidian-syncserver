/**
 * The schema, applied to an empty database and brought forward on an existing one (#354).
 *
 * Against **real databases** created for each case, because every interesting state is a
 * database: empty, from before migrations, one migration behind, ahead of the image, or holding a
 * migration whose file has since changed. Migrations beyond the real ones are written into a
 * temporary directory, numbered after the last real one, so the runner is exercised without
 * shipping a test migration — and without these tests breaking each time a real one is added.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import {
  baselineNames,
  declaredNames,
  ensureSchema,
  MIGRATIONS_DIR,
  missingFrom,
  readMigrations,
  SCHEMA_FILE,
  SchemaRefusal,
  schemaVersion,
} from '../src/schema.js';

let admin: Db;
const made: string[] = [];
const dirs: string[] = [];
const quiet = { log: () => undefined };

/** How many real migrations there are; test migrations are numbered after them. */
const realMigrationCount = (await readMigrations()).length;

/** `NNNN-name.sql` for the k-th migration after the real ones. */
const afterReal = (k: number, name: string): string => `${String(realMigrationCount + k).padStart(4, '0')}-${name}.sql`;

/** A fresh, empty database — the state a first start meets. Dropped again in `after`. */
const emptyDatabase = async (name: string): Promise<Db> => {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  made.push(name);
  const url = new URL(loadConfig().databaseUrl ?? 'postgres:///syncserver_dev?host=/var/run/postgresql');
  url.pathname = `/${name}`;
  return connect(url.toString());
};

/** Some of the real migrations — all of them by default — plus extra files, in a directory of their own. */
const migrationsWith = async (extra: Record<string, string>, keep: number = realMigrationCount): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'syncserver-migrations-'));
  dirs.push(dir);
  const real = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort().slice(0, keep);
  for (const f of real) await copyFile(join(MIGRATIONS_DIR, f), join(dir, f));
  for (const [name, sql] of Object.entries(extra)) await writeFile(join(dir, name), sql);
  return dir;
};

const count = async (db: Db, sql: string): Promise<number> => Number((await db.one<{ n: string }>(sql))!.n);

const tableExists = async (db: Db, name: string): Promise<boolean> =>
  Boolean((await db.one<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [name]))?.r);

before(() => {
  admin = connect(loadConfig().databaseUrl);
});

after(async () => {
  // FORCE, because a test that failed before closing its pool would otherwise leave a database
  // nobody can drop and the next run cannot create.
  for (const name of made) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('applying it to an empty database', () => {
  it('creates everything, and records every migration in the image as already had', async () => {
    const db = await emptyDatabase('syncserver_schema_fresh');
    const said: string[] = [];

    const out = await ensureSchema(db, { log: (m) => said.push(m) });
    const real = await readMigrations();
    assert.deepEqual(out, { state: 'applied', ran: [], version: real.length });
    assert.match(said.join(' '), /schema applied/);

    // The seeds are part of it: a database with tables and no seeded invitation is a server
    // nobody can sign into (D-107).
    assert.ok((await count(db, 'SELECT count(*)::text AS n FROM users')) >= 2, 'the tombstone and the first invitation');
    // A fresh database already IS every migration; running them again would fail on objects the
    // file created. So schema.sql seeds one ledger row per migration, and a new migration fails
    // here until its row — with the checksum this assertion prints — is added beside the table.
    const rows = await db.query<{ id: number; name: string; checksum: string }>(
      'SELECT id, name, checksum FROM schema_migrations ORDER BY id',
    );
    assert.deepEqual(
      rows,
      real.map((m) => ({ id: m.id, name: m.name, checksum: m.checksum })),
      'the rows schema.sql seeds must be exactly the migrations beside it',
    );
    assert.equal(await schemaVersion(db), real.length);
    await db.close();
  });

  it('does nothing the second time, rather than failing on what is already there', async () => {
    const db = await emptyDatabase('syncserver_schema_twice');
    assert.equal((await ensureSchema(db, quiet)).state, 'applied');
    assert.equal((await ensureSchema(db, quiet)).state, 'level');
    await db.close();
  });

  it('lets only one of two servers apply it', async () => {
    // Two containers starting against one empty database. The file used to carry a COMMIT that
    // ended the locked transaction halfway; the loser would then find a half-built schema.
    const db = await emptyDatabase('syncserver_schema_race');
    const [a, b] = await Promise.all([ensureSchema(db, quiet), ensureSchema(db, quiet)]);
    assert.deepEqual([a.state, b.state].sort(), ['applied', 'level']);
    await db.close();
  });
});

describe('a database from before migrations', () => {
  /**
   * A database with no ledger, meeting a build whose only migration is the ledger — the shape of 0.7.10
   * meeting 0.7.11. Built from today's file with the table dropped, so the image it meets carries
   * migration 1 alone: any later one would find its own change already there.
   */
  const beforeMigrations = async (name: string): Promise<{ db: Db; image: string }> => {
    const db = await emptyDatabase(name);
    await ensureSchema(db, quiet);
    await db.query('DROP TABLE schema_migrations');
    return { db, image: await migrationsWith({}, 1) };
  };

  it('is brought forward by the first start, and says so', async () => {
    const { db, image } = await beforeMigrations('syncserver_schema_adopt');
    const said: string[] = [];

    const out = await ensureSchema(db, { log: (m) => said.push(m), migrationsDir: image });
    assert.deepEqual(out, { state: 'migrated', ran: [1], version: 1 }, 'the ledger is migration 1');
    assert.equal(await tableExists(db, 'schema_migrations'), true);
    assert.match(said.join(' '), /migration 1 \(schema-migrations\) applied/);
    await db.close();
  });

  it('is refused when it is not level with the baseline, and nothing is applied', async () => {
    // The silent class the old BEHIND check existed for: a missing trigger does not fail, it never
    // fires. Migrating on top of such a database would build on something that is not there.
    const { db, image } = await beforeMigrations('syncserver_schema_adopt_behind');
    await db.query('DROP TRIGGER journal_notify ON journal');

    await assert.rejects(ensureSchema(db, { ...quiet, migrationsDir: image }), (e: Error) => {
      assert.ok(e instanceof SchemaRefusal);
      assert.match(e.message, /trigger journal_notify/);
      return true;
    });
    assert.equal(await tableExists(db, 'schema_migrations'), false, 'refused before anything ran');
    await db.close();
  });
});

describe('bringing a database forward', () => {
  it('applies a pending migration at start, in order, and records it', async () => {
    const db = await emptyDatabase('syncserver_schema_pending');
    await ensureSchema(db, quiet);
    const dir = await migrationsWith({
      [afterReal(1, 'probe')]: 'CREATE TABLE migration_probe (x integer);\n',
      [afterReal(2, 'probe-row')]: 'INSERT INTO migration_probe VALUES (3);\n',
    });

    const out = await ensureSchema(db, { ...quiet, migrationsDir: dir });
    assert.deepEqual(out, { state: 'migrated', ran: [realMigrationCount + 1, realMigrationCount + 2], version: realMigrationCount + 2 });
    assert.equal(await count(db, 'SELECT count(*)::text AS n FROM migration_probe'), 1, 'and the second ran after the first');
    assert.equal(await schemaVersion(db), realMigrationCount + 2);
    assert.equal((await ensureSchema(db, { ...quiet, migrationsDir: dir })).state, 'level', 'once, not every start');
    await db.close();
  });

  it('lets only one of two servers apply each migration', async () => {
    const db = await emptyDatabase('syncserver_schema_pending_race');
    await ensureSchema(db, quiet);
    const dir = await migrationsWith({ [afterReal(1, 'probe')]: 'CREATE TABLE migration_probe (x integer);\n' });

    const [a, b] = await Promise.all([
      ensureSchema(db, { ...quiet, migrationsDir: dir }),
      ensureSchema(db, { ...quiet, migrationsDir: dir }),
    ]);
    assert.deepEqual([...a.ran, ...b.ran], [realMigrationCount + 1], 'a second CREATE TABLE would have failed the other start');
    await db.close();
  });

  it('refuses to start when a migration fails, and rolls that migration back whole', async () => {
    const db = await emptyDatabase('syncserver_schema_failing');
    await ensureSchema(db, quiet);
    const dir = await migrationsWith({ [afterReal(1, 'broken')]: 'CREATE TABLE half_done (x integer);\nSELECT 1 / 0;\n' });

    await assert.rejects(ensureSchema(db, { ...quiet, migrationsDir: dir }), (e: Error) => {
      assert.ok(e instanceof SchemaRefusal);
      assert.match(e.message, new RegExp(`migration ${realMigrationCount + 1} \\(broken\\) failed and was rolled back: division by zero`));
      return true;
    });
    assert.equal(await tableExists(db, 'half_done'), false, 'not half of it');
    assert.equal(
      await count(db, `SELECT count(*)::text AS n FROM schema_migrations WHERE id = ${realMigrationCount + 1}`),
      0,
      'and not recorded',
    );
    await db.close();
  });

  it('refuses to start against a database a newer image brought forward', async () => {
    const db = await emptyDatabase('syncserver_schema_ahead');
    await ensureSchema(db, quiet);
    // Brought forward by an image that has one more migration than this one.
    await ensureSchema(db, { ...quiet, migrationsDir: await migrationsWith({ [afterReal(1, 'probe')]: 'SELECT 1;\n' }) });

    await assert.rejects(ensureSchema(db, quiet), (e: Error) => {
      assert.ok(e instanceof SchemaRefusal);
      assert.match(e.message, new RegExp(`migration ${realMigrationCount + 1}, which this image does not know`));
      return true;
    });
    await db.close();
  });

  it('refuses to start when an applied migration has been edited', async () => {
    const db = await emptyDatabase('syncserver_schema_edited');
    await ensureSchema(db, quiet);
    await ensureSchema(db, { ...quiet, migrationsDir: await migrationsWith({ [afterReal(1, 'probe')]: 'SELECT 1;\n' }) });
    const edited = await migrationsWith({ [afterReal(1, 'probe')]: 'SELECT 2;\n' });

    await assert.rejects(ensureSchema(db, { ...quiet, migrationsDir: edited }), (e: Error) => {
      assert.ok(e instanceof SchemaRefusal);
      assert.match(e.message, new RegExp(`migration ${realMigrationCount + 1} \\(probe\\) differs`));
      return true;
    });
    await db.close();
  });
});

describe('reading the migrations', () => {
  it('reads the real ones as numbered from 1, the first being the ledger', async () => {
    const real = await readMigrations();
    assert.equal(real[0]?.name, 'schema-migrations');
    assert.match(real[0]!.sql, /CREATE TABLE schema_migrations/);
  });

  it('does not count a line ending as a change', async () => {
    const lf = await readMigrations(await migrationsWith({ [afterReal(1, 'probe')]: 'SELECT 1;\nSELECT 2;\n' }));
    const crlf = await readMigrations(await migrationsWith({ [afterReal(1, 'probe')]: 'SELECT 1;\r\nSELECT 2;\r\n' }));
    assert.equal(lf[realMigrationCount]!.checksum, crlf[realMigrationCount]!.checksum);
  });

  it('refuses a gap, a misnamed file, and a migration that controls its own transaction', async () => {
    await assert.rejects(readMigrations(await migrationsWith({ [afterReal(2, 'skipped')]: 'SELECT 1;\n' })), /without gaps/);
    await assert.rejects(readMigrations(await migrationsWith({ '2-short.sql': 'SELECT 1;\n' })), /not named NNNN-name\.sql/);
    await assert.rejects(
      readMigrations(await migrationsWith({ [afterReal(1, 'own-tx')]: 'BEGIN;\nSELECT 1;\nCOMMIT;\n' })),
      /controls its own transaction/,
    );
  });
});

describe('reading the file', () => {
  it('finds every function and trigger it declares', async () => {
    const { readFile } = await import('node:fs/promises');
    const names = declaredNames(await readFile(SCHEMA_FILE, 'utf8'));

    assert.ok(names.length > 50, `expected the schema's functions and triggers, got ${names.length}`);
    assert.ok(names.includes('function nodes_check_share_membership'), 'a function');
    // The pair that proves the kind is load-bearing: one name, two objects.
    assert.ok(names.includes('function journal_notify'), 'the function');
    assert.ok(names.includes('trigger journal_notify'), 'and the trigger named after it');
    assert.ok(names.includes('trigger nodes_share_membership_is_real'), 'a CONSTRAINT TRIGGER');
  });

  it('reads CREATE OR REPLACE, which is how a migration changes a function', () => {
    assert.deepEqual(declaredNames('CREATE OR REPLACE FUNCTION f() RETURNS void AS $$ $$;'), ['function f']);
  });

  it('leaves out of the baseline what a migration declares', () => {
    const schema = 'CREATE FUNCTION old() RETURNS void AS $$ $$;\nCREATE FUNCTION added() RETURNS void AS $$ $$;\n';
    const later = [{ id: 2, name: 'added', sql: 'CREATE OR REPLACE FUNCTION added() RETURNS void AS $$ $$;\n', checksum: '' }];
    assert.deepEqual(baselineNames(schema, later), ['function old']);
  });

  it('compares by name, and reports only what is absent', () => {
    assert.deepEqual(missingFrom(['function a', 'trigger a', 'function c'], ['function a']), ['trigger a', 'function c']);
    assert.deepEqual(missingFrom(['function a'], ['function a', 'trigger b']), [], 'more in the database is not missing');
  });
});
