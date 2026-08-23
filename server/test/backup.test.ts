/**
 * The backup window, and the leg order that follows from what kind of window it is.
 *
 * The rule under test is D-114: this server takes a **refusal window**, not a freeze, so a
 * write already running goes on to commit — and that is what makes database-first the only
 * safe order. Blobs-first under a real freeze would be equivalent; blobs-first under this one
 * produces a copy that restores cleanly and is missing files, discovered months later.
 *
 * The legs are injected, so what is asserted here is the window rather than `pg_dump`: which
 * ran first, that the row records both, and that a failure between them still releases.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { backupInProgress, listBackups, runBackup, settleInterruptedRuns, verifyBackup, type Legs } from '../src/backup.js';
import { assertPgDumpMatches, backupLegs, pgMajor } from '../src/backup-legs.js';

let db: Db;

before(() => {
  db = connect(loadConfig().databaseUrl);
});

after(async () => {
  await db.query(`DELETE FROM backup_runs`);
  await db.close();
});

/** Legs that record the order they were called in, and report plausible sizes. */
const recording = (order: string[]): Legs => ({
  assertReady: async () => {},
  dumpDatabase: async () => {
    order.push('database');
    return { bytes: 1024 };
  },
  copyBlobs: async () => {
    order.push('blobs');
    return { bytes: 2048, count: 3 };
  },
});

/** A vault with one file node referencing one blob — the minimal world a verify checks. */
const seedWorld = async (): Promise<{ vaultId: string; sha: string }> => {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 1048576)`,
    [userId, `backup-verify-${randomUUID()}`],
  );
  const vaultId = randomUUID();
  const rootId = randomUUID();
  const keyId = randomUUID();
  // Content-addressed: a blob IS its sha256, so each seeded world needs its own bytes.
  const sha = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO key_scopes (id, kind) VALUES ($1, 'vault')`, [keyId]);
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\x00', $3, $4, 'vault')`,
      [vaultId, userId, rootId, keyId],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev, ancestry)
       VALUES ($1, $2, NULL, 'folder', now(), 1, ARRAY[]::uuid[])`,
      [vaultId, rootId],
    );
    await c.query(`UPDATE vaults SET head_rev = 1 WHERE id = $1`, [vaultId]);
    await c.query(
      `INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
       VALUES (decode($1,'hex'), 1, $1, 'xchacha20-poly1305', $2)`,
      [sha, keyId],
    );
    // The schema demands a file node's blob carry its envelope and dedup tag under the
    // vault scope — the same material a real client would have produced.
    await c.query(
      `INSERT INTO blob_keys (sha256, scope_id, wrapped_key)
       VALUES (decode($1,'hex'), $2, '\\xbeef')`,
      [sha, keyId],
    );
    await c.query(
      `INSERT INTO dedup_index (scope_id, content_tag, sha256)
       VALUES ($1, decode($2,'hex'), decode($3,'hex'))`,
      [keyId, 'ab'.repeat(32), sha],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, name_enc, name_hmac, name_key_id, type,
                          sha256, size, mtime, rev, ancestry)
       VALUES ($1, $2, $3, '\\x00', decode($4,'hex'), $5, 'file', decode($6,'hex'), 1, now(), 2, ARRAY[$3]::uuid[])`,
      [vaultId, randomUUID(), rootId, '00'.repeat(32), keyId, sha],
    );
    await c.query(`UPDATE vaults SET head_rev = 2 WHERE id = $1`, [vaultId]);
  });
  return { vaultId, sha };
};

describe('the window a backup takes', () => {
  it('dumps the database first and copies the blobs second (D-114)', async () => {
    // Not interchangeable here, and the comment is the test: the window refuses NEW writes
    // and leaves the ones in flight, so a blob uploaded after the copy can still reach a
    // dump taken before it. Database-first makes the blob copy a superset instead.
    const order: string[] = [];
    const out = await runBackup(db, recording(order), '/backups');

    assert.equal(out.status, 'ok');
    assert.deepEqual(order, ['database', 'blobs']);
  });

  it('records both legs inside the window, which the schema insists on', async () => {
    const out = await runBackup(db, recording([]), '/backups');
    const row = await db.one<{
      opened: string; closed: string; db: string; blobs: string; status: string; bytes: string; count: string;
    }>(
      `SELECT window_opened_at AS opened, window_closed_at AS closed, db_done_at AS db,
              blobs_done_at AS blobs, status::text AS status, bytes::text AS bytes,
              blob_count::text AS count
         FROM backup_runs WHERE id = $1`,
      [out.id],
    );
    assert.equal(row!.status, 'ok');
    assert.ok(row!.opened && row!.closed && row!.db && row!.blobs, 'every timestamp is on the row');
    assert.equal(row!.bytes, '3072', 'both legs counted');
    assert.equal(row!.count, '3');
  });

  it('refuses writes while it is open, and stops refusing when it closes', async () => {
    let insideWindow: boolean | undefined;
    const out = await runBackup(
      db,
      {
        assertReady: async () => {},
        dumpDatabase: async () => {
          insideWindow = backupInProgress();
          return { bytes: 1 };
        },
        copyBlobs: async () => ({ bytes: 1, count: 0 }),
      },
      '/backups',
    );

    assert.equal(out.status, 'ok');
    assert.equal(insideWindow, true, 'the window is open while the legs run');
    assert.equal(backupInProgress(), false, 'and shut afterwards');
  });

  it('releases the window even when a leg throws', async () => {
    // A backup that failed halfway must not take the installation down with it: a server
    // left refusing writes because a dump broke is a worse outage than the missing copy.
    const out = await runBackup(
      db,
      {
        assertReady: async () => {},
        dumpDatabase: async () => {
          throw new Error('pg_dump: server version mismatch');
        },
        copyBlobs: async () => ({ bytes: 0, count: 0 }),
      },
      '/backups',
    );

    assert.equal(out.status, 'failed');
    assert.equal(backupInProgress(), false, 'the window closed anyway');

    const row = await db.one<{ status: string; error: string; closed: string }>(
      `SELECT status::text AS status, error, window_closed_at AS closed FROM backup_runs WHERE id = $1`,
      [out.id],
    );
    assert.equal(row!.status, 'failed');
    assert.match(row!.error, /version mismatch/, 'and says what broke, not that something did');
    assert.ok(row!.closed, 'a failed run still records the window closing');
  });

  it('runs one at a time, sharing the collector’s lock', async () => {
    // A backup and a garbage collection must never overlap: one removes blobs the other is
    // copying. The collector already skips a pass while this lock is held, so taking it here
    // is the whole interlock — and it serialises backups with each other for free.
    //
    // WAITS rather than skips, which is the point of the blocking form (docs/08): the second
    // run's window opens only once the first has closed, so both produce a whole copy. The
    // try-form stood here and turned a second run into one that silently did not happen.
    const first = runBackup(
      db,
      {
        assertReady: async () => {},
        dumpDatabase: async () => {
          await new Promise((r) => setTimeout(r, 60));
          return { bytes: 1 };
        },
        copyBlobs: async () => ({ bytes: 1, count: 0 }),
      },
      '/backups',
    );
    await new Promise((r) => setTimeout(r, 15));
    const second = await runBackup(db, recording([]), '/backups');
    const firstRun = await first;

    assert.equal(second.status, 'ok', 'it waited for the lock rather than giving up');
    assert.equal(firstRun.status, 'ok');

    const overlap = await db.one<{ serialised: boolean }>(
      `SELECT (SELECT window_opened_at FROM backup_runs WHERE id = $2)
              >= (SELECT window_closed_at FROM backup_runs WHERE id = $1) AS serialised`,
      [firstRun.id, second.id],
    );
    assert.equal(overlap!.serialised, true, 'the two windows did not overlap');
  });

  it('gives up rather than hanging when the lock is never released', async () => {
    // Bounded blocking: a collector pass is seconds, so a wait past the timeout is another
    // session nobody will release — and a backup job that hangs on it is how a nightly job
    // stops being nightly. `skipped` carries the reason rather than looking like nothing
    // needed doing.
    const held = runBackup(
      db,
      {
        assertReady: async () => {},
        dumpDatabase: async () => {
          await new Promise((r) => setTimeout(r, 300));
          return { bytes: 1 };
        },
        copyBlobs: async () => ({ bytes: 1, count: 0 }),
      },
      '/backups',
    );
    await new Promise((r) => setTimeout(r, 15));
    const gaveUp = await runBackup(db, recording([]), '/backups', { lockWaitMs: 50 });

    assert.equal(gaveUp.status, 'skipped');
    assert.equal(gaveUp.id, undefined, 'nothing ran, so there is no run to point at');
    assert.match(gaveUp.error!, /still held/);
    assert.equal((await held).status, 'ok');
  });
});

describe('what has to be true before a window is worth opening', () => {
  it('refuses without taking the lock, inserting a row or opening the window', async () => {
    // D-73's failure, one layer in: the pg_dump major check lived at the top of `dumpDatabase`,
    // which reads as "before the work" and is not — by then the collector's lock is held, a
    // `backup_runs` row exists and the server is refusing writes. A mismatched binary
    // announced itself with the window already open, which is the thing the check replaced
    // rather than relocated.
    const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM backup_runs`);
    let legsRan = false;

    const out = await runBackup(
      db,
      {
        assertReady: async () => {
          throw new Error('pg_dump is major 17 but the server’s PostgreSQL is major 18');
        },
        dumpDatabase: async () => {
          legsRan = true;
          return { bytes: 1 };
        },
        copyBlobs: async () => {
          legsRan = true;
          return { bytes: 1, count: 0 };
        },
      },
      '/backups/not-ready',
    );

    assert.equal(out.status, 'refused', 'not `failed` — nothing was attempted');
    assert.match(out.error!, /major 17/, 'and it carries the sentence that says what to fix');
    assert.equal(out.id, undefined, 'no run to point at');
    assert.equal(legsRan, false, 'neither leg ran');
    assert.equal(backupInProgress(), false, 'and no window was ever opened');

    const after = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM backup_runs`);
    assert.equal(after!.n, before!.n, 'the history gained no row for a backup nobody took');
  });

  it('is the real legs’ assertReady that catches a mismatched pg_dump, not the dump itself', async () => {
    // The test above proves `runBackup` asks early. This one proves the production legs put
    // the pg_dump check in the thing it asks — without it, moving the check back to the first
    // line of `dumpDatabase` passes every other test in this file, which is exactly the state
    // #78 was opened about.
    //
    // A real `pg_dump` against a fabricated server line: the binary is whatever this machine
    // has, and 99 is a major no server will ever report, so the mismatch is the assertion and
    // not an accident of the environment.
    const legs = backupLegs('/nonexistent', ['pg_dump'], '/nonexistent', 'run', 'PostgreSQL 99.0 on x86_64');

    await assert.rejects(() => legs.assertReady(), /major/, 'assertReady is where the mismatch is found');
  });

  it('runs the legs when the precondition holds', async () => {
    const order: string[] = [];
    const out = await runBackup(db, recording(order), '/backups');

    assert.equal(out.status, 'ok');
    assert.deepEqual(order, ['database', 'blobs'], 'and in the order D-114 forces');
  });
});

describe('a run the process did not outlive', () => {
  it('is settled as failed, because nothing was being refused after the crash', async () => {
    // The window lived in the dead process, so a `running` row means neither a backup nor a
    // refusal — and calling it anything else leaves a row an operator could mistake for a
    // usable copy.
    const orphan = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (window_opened_at, destination) VALUES (now(), '/backups')
       RETURNING id::text AS id`,
    );
    assert.equal(await settleInterruptedRuns(db), 1);

    const row = await db.one<{ status: string; error: string }>(
      `SELECT status::text AS status, error FROM backup_runs WHERE id = $1`,
      [orphan!.id],
    );
    assert.equal(row!.status, 'failed');
    assert.match(row!.error, /interrupted by a restart/);
  });
});

describe('verifying a backup', () => {
  /** A fake blob store: every address asked for is "present" unless the test says otherwise. */
  const present = (absent: Set<string> = new Set()) => ({
    // `verifyBackup` asks for the storage key (`ab/cd/full`), so "absent" has to match
    // that shape, not the bare address.
    size: async (key: string) => (absent.has(key) ? undefined : 1),
  });

  const runId = async (): Promise<string> => {
    const r = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (status, window_opened_at, finished_at, db_done_at, blobs_done_at,
                                window_closed_at, destination)
       VALUES ('ok', now(), now(), now(), now(), now(), '/backups')
       RETURNING id::text AS id`,
    );
    return r!.id;
  };

  const absentKey = (sha: string): string => `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}`;

  it('reports a backup whole when every referenced blob is present', async () => {
    await seedWorld();
    const id = await runId();
    const out = await verifyBackup(db, present(), id);
    assert.deepEqual(out.missing, []);
    assert.ok(out.checked > 0, 'there is at least one blob in this world to have checked');
  });

  it('names every referenced blob that is absent from the copy', async () => {
    // The whole point of the check: a dump can reference bytes the copy does not hold, and
    // that restores cleanly and is missing files. The missing half is named, not counted.
    const { sha } = await seedWorld();
    const id = await runId();
    const out = await verifyBackup(db, present(new Set([absentKey(sha)])), id);

    assert.ok(out.missing.includes(sha), `the absent blob is named: ${out.missing}`);
  });

  it('marks the run verified, which is what the console shows as the answer', async () => {
    await seedWorld();
    const id = await runId();
    await verifyBackup(db, present(), id);
    const row = await db.one<{ verified: string | null }>(
      `SELECT verified_at AS verified FROM backup_runs WHERE id = $1`, [id]);
    assert.ok(row!.verified, 'verified_at is written');
  });

  it('does NOT mark a run verified when it just found blobs missing', async () => {
    // `verified_at` was stamped unconditionally, so a run this very function had found an
    // incomplete copy for was listed in the console as verified — the check wearing the badge
    // of the thing that would have caught it. Worse than not checking: it answers the question
    // wrongly rather than not at all.
    const { sha } = await seedWorld();
    const id = await runId();

    const out = await verifyBackup(db, present(new Set([absentKey(sha)])), id);

    assert.ok(out.missing.includes(sha), 'the fixture really is missing a blob');
    const row = await db.one<{ verified: string | null }>(
      `SELECT verified_at AS verified FROM backup_runs WHERE id = $1`, [id]);
    assert.equal(row!.verified, null, 'checked and found wanting is not verified');
  });
});

describe('listing backups', () => {
  it('returns the runs newest first', async () => {
    // A clean slate: the verify tests above have left rows behind, and this asserts an
    // ORDER, not a count of whatever the suite has accumulated.
    await db.query(`DELETE FROM backup_runs`);
    const older = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (status, destination, window_opened_at, finished_at, db_done_at,
                                blobs_done_at, window_closed_at)
       VALUES ('ok', '/a', now(), now(), now(), now(), now()) RETURNING id::text AS id`);
    await db.query(
      `INSERT INTO backup_runs (status, destination) VALUES ('running', '/b')`);
    const rows = await listBackups(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.status, 'running', 'the newest (the later insert) is first');
    assert.equal(rows[1]!.id, older!.id);
  });

  it('leaves out a run whose copy is gone, because it is not a backup this server has', async () => {
    // A list of backups is a list of things that can be restored. The row survives a removal — losing it
    // while its files stayed would leave free space vanishing with nothing to explain it (#136) — but
    // what happened to it belongs in the audit log, not as a stub every reader learns to skip.
    await db.query(`DELETE FROM backup_runs`);
    const kept = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (status, destination, window_opened_at, finished_at, db_done_at,
                                blobs_done_at, window_closed_at)
       VALUES ('ok', '/still-here', now(), now(), now(), now(), now()) RETURNING id::text AS id`);
    await db.query(
      `INSERT INTO backup_runs (status, destination, window_opened_at, finished_at, db_done_at,
                                blobs_done_at, window_closed_at)
       VALUES ('ok', NULL, now(), now(), now(), now(), now())`);

    const rows = await listBackups(db);
    assert.deepEqual(rows.map((r) => r.id), [kept!.id], 'only the one with a copy');
    // Still in the table, which is what makes the audit entry naming it resolvable.
    const all = await db.query(`SELECT 1 FROM backup_runs`);
    assert.equal(all.length, 2);
  });

  it('still lists a run in progress, which has no copy yet', async () => {
    // The filter is "has a copy OR is still making one". A running row dropping out of the list would
    // make the button somebody just pressed look like it did nothing.
    await db.query(`DELETE FROM backup_runs`);
    await db.query(`INSERT INTO backup_runs (status, destination) VALUES ('running', NULL)`);
    assert.equal((await listBackups(db)).length, 1);
  });
});

describe('the pg_dump version check', () => {
  it('reads the major out of either version line', () => {
    assert.equal(pgMajor('pg_dump (PostgreSQL) 18.4 (Ubuntu 18.4-0ubuntu0.26.04.1)'), 18);
    assert.equal(pgMajor('PostgreSQL 18.4 (Ubuntu 18.4-0ubuntu0.26.04.1) on aarch64'), 18);
  });

  it('refuses a version line it cannot trust', () => {
    assert.equal(pgMajor('not a postgres tool at all'), undefined);
    assert.equal(pgMajor(''), undefined);
  });

  it('lets a matching dump through', () => {
    assert.doesNotThrow(() => assertPgDumpMatches('pg_dump (PostgreSQL) 18.4', 'PostgreSQL 18.4 on x86_64'));
  });

  it('refuses a dump of the wrong major, naming both', () => {
    assert.throws(
      () => assertPgDumpMatches('pg_dump (PostgreSQL) 17.0', 'PostgreSQL 18.4 on x86_64'),
      /pg_dump is major 17 but the server's PostgreSQL is major 18/,
    );
  });

  it('refuses rather than guessing when either version cannot be read', () => {
    assert.throws(() => assertPgDumpMatches('pg_dump (PostgreSQL) 18.4', 'not a version'), /cannot verify/);
  });
});

describe('the backup self-check', () => {
  it('flags a copy with missing blobs on the row, without failing the run', async () => {
    // A backup nobody can restore from is not a backup — but the copy exists and is
    // recorded, so the run is 'ok' with an error telling the operator, not a failure that
    // hides the fact a copy was made at all (docs/10).
    const out = await runBackup(
      db,
      {
        assertReady: async () => {},
        dumpDatabase: async () => ({ bytes: 1 }),
        copyBlobs: async () => ({ bytes: 1, count: 0 }),
      },
      '/backups/self-check',
      {
        openCopy: () => ({ size: async () => undefined }), // every blob absent
      },
    );

    assert.equal(out.status, 'ok', 'the copy was made');
    assert.match(out.error ?? '', /missing/, 'and the operator is told it is not restorable');

    const row = await db.one<{ status: string; error: string | null }>(
      `SELECT status::text AS status, error FROM backup_runs WHERE id = $1`, [out.id]);
    assert.equal(row!.status, 'ok');
    assert.match(row!.error ?? '', /missing/, 'the row carries the sentence too');
  });

  it('says nothing on the row when the copy is whole', async () => {
    const out = await runBackup(
      db,
      { assertReady: async () => {}, dumpDatabase: async () => ({ bytes: 1 }), copyBlobs: async () => ({ bytes: 1, count: 0 }) },
      '/backups/whole',
      { openCopy: () => ({ size: async () => 1 }) }, // every blob present
    );
    assert.equal(out.status, 'ok');
    assert.equal(out.error, undefined, 'a whole copy is not a warning');
  });
});

describe('what a refusal window leaves in the log', () => {
  // The live walk that produced this: a backup was taken from the console, the copy landed,
  // the row was right, and `docker logs` had one line in it — the schedule announcing itself
  // at boot. Every sentence about an outcome was composed by the schedule wrapper, so the
  // trigger that had existed since M5 said nothing at all.
  //
  // The window is why it matters rather than being a nicety. It is the only thing in this
  // server that stops writes being accepted, and a run that hangs inside one is an outage
  // whose cause is unreadable unless something said a backup had begun.
  const good: Legs = {
    assertReady: async () => {},
    dumpDatabase: async () => ({ bytes: 1 }),
    copyBlobs: async () => ({ bytes: 1, count: 2 }),
  };

  it('says the window opened, and says how it closed', async () => {
    const said: string[] = [];

    const out = await runBackup(db, good, '/backups/logged', {
      log: (m) => said.push(m),
      warn: (m) => said.push(m),
      openCopy: () => ({ size: async () => 1 }),
    });

    assert.equal(out.status, 'ok');
    assert.ok(
      said.some((m) => /started/.test(m) && /refused/.test(m) && /backups\/logged/.test(m)),
      `the window opening, and what it costs: ${said.join(' | ')}`,
    );
    assert.ok(
      said.some((m) => /ok in/.test(m) && /2 blobs/.test(m) && /verified whole/.test(m)),
      `and how it settled: ${said.join(' | ')}`,
    );
  });

  it('does not claim a copy was verified when nothing checked it', async () => {
    // "Not checked" and "checked and whole" are different claims about the same run, and a
    // log that ran them together would let an unverified copy read as a verified one.
    const said: string[] = [];

    await runBackup(db, good, '/backups/unchecked', { log: (m) => said.push(m) });

    assert.ok(said.some((m) => /not checked/.test(m)), `said which it was: ${said.join(' | ')}`);
  });

  it('says a failed run failed, and how long the window was open for it', async () => {
    const said: string[] = [];
    const breaks: Legs = { ...good, copyBlobs: async () => { throw new Error('the mount went away'); } };

    const out = await runBackup(db, breaks, '/backups/broken', { warn: (m) => said.push(m) });

    assert.equal(out.status, 'failed');
    assert.ok(
      said.some((m) => /FAILED/.test(m) && /the mount went away/.test(m) && /ms/.test(m)),
      `warned: ${said.join(' | ')}`,
    );
  });

  it('logs for a caller that wired nothing, because that caller is the one that forgot', async () => {
    // The regression, exactly. `runBackup` had one caller wrapping its outcomes and one caller
    // wrapping nothing, and the silent one was the button a person presses. A logger that has
    // to be remembered is a logger the next caller will forget, so the default is the console
    // rather than silence.
    const said: string[] = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (m: unknown) => said.push(String(m));
    console.warn = (m: unknown) => said.push(String(m));
    try {
      await runBackup(db, good, '/backups/unwired');
    } finally {
      console.log = log;
      console.warn = warn;
    }

    assert.ok(said.some((m) => /started/.test(m)), `it announced itself: ${said.join(' | ')}`);
    assert.ok(said.some((m) => /ok in/.test(m)), `and settled: ${said.join(' | ')}`);
  });
});

