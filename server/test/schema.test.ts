/**
 * The schema, applied by the server to a database that has none.
 *
 * Against a **real, empty database** created for each case, because that is the only state the
 * interesting half is about: the file used to be mounted into PostgreSQL's entrypoint, which
 * runs it once on an empty data directory, and every failure came from a database that had
 * never seen it — an install that left the file behind, or an upgrade whose schema had grown.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { declaredNames, ensureSchema, missingFrom, SCHEMA_FILE } from '../src/schema.js';

let admin: Db;
const made: string[] = [];

/** A fresh, empty database — the state a first start meets. Dropped again in `after`. */
const emptyDatabase = async (name: string): Promise<Db> => {
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  made.push(name);
  const url = new URL(loadConfig().databaseUrl ?? 'postgres:///syncserver_dev?host=/var/run/postgresql');
  url.pathname = `/${name}`;
  return connect(url.toString());
};

before(() => {
  admin = connect(loadConfig().databaseUrl);
});

after(async () => {
  // FORCE, because a test that failed before closing its pool would otherwise leave a database
  // nobody can drop and the next run cannot create.
  for (const name of made) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
});

describe('applying it to an empty database', () => {
  it('creates everything the file declares, and says so', async () => {
    const db = await emptyDatabase('syncserver_schema_fresh');
    const said: string[] = [];

    const out = await ensureSchema(db, { log: (m) => said.push(m) });
    assert.equal(out.state, 'applied');
    assert.match(said.join(' '), /schema applied/);

    // The seeds are part of it, and the one that matters is the invitation a first run redeems
    // (D-107): a database with tables and no seeded administrator invitation is a server nobody
    // can sign into.
    const users = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    assert.equal(Number(users!.n) >= 2, true, 'the tombstone and the first invitation');
    await db.close();
  });

  it('does nothing the second time, rather than failing on what is already there', async () => {
    // This runs at every start. The whole file is `CREATE TABLE`, not `IF NOT EXISTS`, so a
    // second application would not be a no-op — it would be an error that reads like damage.
    const db = await emptyDatabase('syncserver_schema_twice');
    assert.equal((await ensureSchema(db, { log: () => undefined })).state, 'applied');
    assert.equal((await ensureSchema(db, { log: () => undefined })).state, 'level');
    await db.close();
  });

  it('lets only one of two servers apply it', async () => {
    // Two containers starting against one empty database. Without the lock both read "empty"
    // and both apply; the loser fails halfway through with a duplicate-object error, which is
    // indistinguishable from a corrupt database at three in the morning.
    const db = await emptyDatabase('syncserver_schema_race');
    const [a, b] = await Promise.all([
      ensureSchema(db, { log: () => undefined }),
      ensureSchema(db, { log: () => undefined }),
    ]);
    assert.deepEqual([a!.state, b!.state].sort(), ['applied', 'level']);
    await db.close();
  });
});

describe('meeting a database that is behind', () => {
  it('names what is missing and does not touch the data', async () => {
    // The silent class, and the reason this check exists at all: a missing table breaks at the
    // first query, while a missing TRIGGER does not fail — it never fires. This deployment ran
    // for weeks with change notification inert for exactly that reason.
    const db = await emptyDatabase('syncserver_schema_behind');
    await ensureSchema(db, { log: () => undefined });
    await db.query(`DROP TRIGGER journal_notify ON journal`);

    const warned: string[] = [];
    const out = await ensureSchema(db, { log: () => undefined, warn: (m) => warned.push(m) });

    assert.equal(out.state, 'behind');
    assert.deepEqual(out.missing, ['trigger journal_notify'], 'the KIND matters: the function of that name still exists');
    assert.match(warned.join(' '), /BEHIND/);
    assert.match(warned.join(' '), /never fires/, 'and why a missing trigger is the bad kind');

    // Not repaired, deliberately: this is not a migration tool, and re-running the whole file
    // over a live database is not what "bring it forward" means.
    const still = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger WHERE tgname = 'journal_notify'`,
    );
    assert.equal(still!.n, '0');
    await db.close();
  });
});

describe('reading the file', () => {
  it('finds every function and trigger it declares', async () => {
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(SCHEMA_FILE, 'utf8');
    const names = declaredNames(sql);

    assert.ok(names.length > 50, `expected the schema's functions and triggers, got ${names.length}`);
    // Three spellings appear, and the third is easy to miss: a CONSTRAINT TRIGGER is where
    // half the interesting rules live.
    assert.ok(names.includes('function nodes_check_share_membership'), 'a function');
    // The pair that proves the kind is load-bearing: one name, two objects.
    assert.ok(names.includes('function journal_notify'), 'the function');
    assert.ok(names.includes('trigger journal_notify'), 'and the trigger named after it');
    assert.ok(names.includes('trigger nodes_share_membership_is_real'), 'a CONSTRAINT TRIGGER');
  });

  it('compares by name, and reports only what is absent', () => {
    assert.deepEqual(missingFrom(['function a', 'trigger a', 'function c'], ['function a']), ['trigger a', 'function c']);
    assert.deepEqual(missingFrom(['function a'], ['function a', 'trigger b']), [], 'more in the database is not missing');
  });
});
