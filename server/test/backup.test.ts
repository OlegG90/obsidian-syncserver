/**
 * The backup window, and the leg order that follows from what kind of window it is.
 *
 * The rule under test is #114: this server takes a **refusal window**, not a freeze, so a
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
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { backupInProgress, runBackup, settleInterruptedRuns, type Legs } from '../src/backup.js';

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
  dumpDatabase: async () => {
    order.push('database');
    return { bytes: 1024 };
  },
  copyBlobs: async () => {
    order.push('blobs');
    return { bytes: 2048, count: 3 };
  },
});

describe('the window a backup takes', () => {
  it('dumps the database first and copies the blobs second (#114)', async () => {
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
