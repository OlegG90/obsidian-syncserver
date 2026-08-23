/**
 * Removing a backup's copy, and keeping the last few (#136).
 *
 * The interesting part is not the deletion — it is everything the server refuses to delete.
 * `backup_runs.destination` is a text column, so a value from a restored dump, another host, or
 * a hand edit would otherwise become a recursive delete of whatever that path names here.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { insideDestination, newestCopy, removeBackupCopy } from '../src/backup-remove.js';

let db: Db;
let root: string;

before(async () => {
  db = connect(loadConfig().databaseUrl);
  root = await mkdtemp(join(tmpdir(), 'syncserver-backups-'));
  await db.query(`DELETE FROM backup_runs`);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await db.close();
});

/** A finished run with a directory on disk, exactly as a real one leaves things. */
const aRun = async (stamp: string, status = 'ok', at = `2026-08-${stamp}`): Promise<string> => {
  const dir = join(root, `backup-${stamp}`);
  await mkdir(join(dir, 'blobs'), { recursive: true });
  await writeFile(join(dir, 'database.dump'), 'not really a dump');
  const row = await db.one<{ id: string }>(
    `INSERT INTO backup_runs (started_at, window_opened_at, db_done_at, blobs_done_at,
                              window_closed_at, finished_at, status, destination)
          VALUES ($1::timestamptz, $1::timestamptz, $1::timestamptz, $1::timestamptz,
                  $1::timestamptz, $1::timestamptz, $2::backup_status, $3)
       RETURNING id::text AS id`,
    [`${at}T00:00:00Z`, status, dir],
  );
  return row!.id;
};

describe('what may be deleted at all', () => {
  it('accepts a run directory of this deployment’s destination', () => {
    assert.ok(insideDestination('/srv/backups', '/srv/backups/backup-2026-08-21T00-00-00-000Z'));
  });

  it('refuses a path outside it, however it is spelled', () => {
    // Both sides are resolved first: `..` inside a stored value must not walk out of the
    // destination and still look like a child of it. This check is what stands between a text
    // column and `rm -rf`.
    assert.ok(!insideDestination('/srv/backups', '/srv/backups-elsewhere/backup-x'));
    assert.ok(!insideDestination('/srv/backups', '/srv/backups/../etc/backup-x'));
    assert.ok(!insideDestination('/srv/backups', '/etc'));
  });

  it('refuses the destination itself, and anything deeper than one level', () => {
    // The destination holds every copy, so deleting it is not "removing a backup"; and a path
    // two levels down is inside somebody's run rather than being one.
    assert.ok(!insideDestination('/srv/backups', '/srv/backups'));
    assert.ok(!insideDestination('/srv/backups', '/srv/backups/backup-x/blobs'));
  });

  it('refuses a child that is not named like a run directory', () => {
    assert.ok(!insideDestination('/srv/backups', '/srv/backups/important-data'));
  });
});

describe('removing one copy', () => {
  it('deletes the directory and keeps the run in the history', async () => {
    const older = await aRun('01', 'ok', '2026-08-01');
    await aRun('02', 'ok', '2026-08-02'); // the newest, which is what protects the one above

    assert.equal(await removeBackupCopy(db, root, older), undefined);
    assert.ok(!existsSync(join(root, 'backup-01')), 'the copy is gone from disk');

    const row = await db.one<{ destination: string | null; status: string }>(
      `SELECT destination, status::text AS status FROM backup_runs WHERE id = $1`,
      [older],
    );
    assert.equal(row!.destination, null, 'and the row says its copy is gone');
    assert.equal(row!.status, 'ok', 'without rewriting what happened');
  });

  it('refuses the newest successful copy — the one a restore would use', async () => {
    const newest = await newestCopy(db);
    assert.ok(newest);
    assert.equal(await removeBackupCopy(db, root, newest), 'newest_copy');
    assert.ok(existsSync(join(root, 'backup-02')));
  });

  it('refuses a destination outside the backup directory, and touches nothing', async () => {
    const stray = await mkdtemp(join(tmpdir(), 'syncserver-not-a-backup-'));
    await writeFile(join(stray, 'keep me'), 'x');
    const id = await aRun('03', 'ok', '2026-08-03');
    await db.query(`UPDATE backup_runs SET destination = $2 WHERE id = $1`, [id, stray]);

    assert.equal(await removeBackupCopy(db, root, id), 'outside_destination');
    assert.deepEqual(await readdir(stray), ['keep me']);
    await rm(stray, { recursive: true, force: true });
  });

  it('refuses a run that is still going', async () => {
    const row = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (window_opened_at, destination, status)
            VALUES (now(), $1, 'running') RETURNING id::text AS id`,
      [join(root, 'backup-99')],
    );
    assert.equal(await removeBackupCopy(db, root, row!.id), 'still_running');
    await db.query(
      `UPDATE backup_runs SET status = 'failed', error = 'test tidy-up', finished_at = now() WHERE id = $1`,
      [row!.id],
    );
  });

  it('says a copy already removed is already removed, rather than failing', async () => {
    const id = await aRun('04', 'ok', '2026-08-04');
    await db.query(`UPDATE backup_runs SET destination = NULL WHERE id = $1`, [id]);
    assert.equal(await removeBackupCopy(db, root, id), 'already_gone');
  });

  it('answers for a run that does not exist', async () => {
    assert.equal(await removeBackupCopy(db, root, '999999'), 'not_found');
  });
});

