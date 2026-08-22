/**
 * The bad day, asked for: the console requests a restore and the server stops (D-92).
 *
 * The button is the heaviest act this surface carries: it replaces the database and stops the server.
 * So what is asserted here is mostly the **refusals** — which copies cannot be asked for, and why — plus
 * the one thing the happy path must leave behind, because the request is all that survives the restart
 * that carries it out.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { clearRestoreRequest, readRestoreRequest, requestFile, writeRestoreRequest } from '../src/restore-request.js';

let db: Db;
let app: FastifyInstance;
let root: string;
let token: string;
let stopped = 0;
/**
 * Every run this suite invents, so it can take them away again.
 *
 * The alternative is a name chosen to sort after every suite that would notice them, which is how the
 * ordering convention in this directory works and is one rename away from being wrong — it was, the
 * moment this file was renamed for what it tests. A suite that leaves the tables as it found them does
 * not care what it is called.
 */
const invented: string[] = [];

const ADMIN = '00000000-0000-0000-0000-000000000001';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'syncserver-ask-'));
  await mkdir(join(root, 'backups'), { recursive: true });
  db = connect(loadConfig().databaseUrl);
  const cfg = {
    ...loadConfig(),
    restoreStateFile: join(root, 'state', 'restore.epoch'),
    backup: {
      destination: join(root, 'backups'),
      dumpCommand: ['true'],
      blobSource: join(root, 'blobs'),
      everySeconds: 0,
      keep: undefined,
    },
  };
  app = await buildApp(db, cfg, { stop: () => void (stopped += 1) });

  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [ADMIN],
  );
  token = app.jwt.sign({ sub: ADMIN, device: ADMIN, role: 'console' });
});

after(async () => {
  if (invented.length > 0) {
    await db.query(`DELETE FROM backup_runs WHERE id = ANY($1::bigint[])`, [invented]);
  }
  await app.close();
  await db.close();
  await rm(root, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${token}` });

/** A finished run pointing at a directory shaped like one of this server's own. */
const aRun = async (name: string | null, status = 'ok'): Promise<string> => {
  const dest = name === null ? null : join(root, 'backups', name);
  const row = await db.one<{ id: string }>(
    `INSERT INTO backup_runs (status, destination, error, window_opened_at, finished_at, db_done_at,
                              blobs_done_at, window_closed_at)
     VALUES ($1::backup_status, $2, $3, now(), now(), now(), now(), now()) RETURNING id::text AS id`,
    [status, dest, status === 'ok' ? null : 'a failure the schema insists is explained'],
  );
  invented.push(row!.id);
  return row!.id;
};

describe('the request a restore leaves behind', () => {
  it('survives a restart, which is the only reason it is a file', async () => {
    const stateFile = join(root, 'state', 'restore.epoch');
    await writeRestoreRequest(stateFile, { runId: 'r', destination: '/d', by: 'admin', at: '2026-01-01T00:00:00Z' });
    assert.deepEqual(await readRestoreRequest(stateFile), {
      runId: 'r',
      destination: '/d',
      by: 'admin',
      at: '2026-01-01T00:00:00Z',
    });
    await clearRestoreRequest(stateFile);
    assert.equal(await readRestoreRequest(stateFile), undefined);
  });

  it('reads a half-written one as no request at all', async () => {
    // The alternative is `rm -rf` of whatever a broken `destination` happens to name, so refusing to
    // read it is the safe answer: the cost is a restore that has to be asked for again.
    const stateFile = join(root, 'state', 'restore.epoch');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(requestFile(stateFile), '{"runId":"r","destination":', 'utf8');
    assert.equal(await readRestoreRequest(stateFile), undefined);
    await writeFile(requestFile(stateFile), '{"runId":"r"}', 'utf8');
    assert.equal(await readRestoreRequest(stateFile), undefined, 'a request naming no copy is not one');
    await clearRestoreRequest(stateFile);
  });
});

describe('asking for a restore from the console', () => {
  it('refuses a run that did not finish well', async () => {
    const id = await aRun('failed-one', 'failed');
    const r = await app.inject({ method: 'POST', url: `/admin/backups/${id}/restore`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'not_a_good_copy');
  });

  it('refuses one whose copy has been removed', async () => {
    const id = await aRun(null);
    const r = await app.inject({ method: 'POST', url: `/admin/backups/${id}/restore`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'already_gone');
  });

  it('refuses a destination outside this server’s backup directory', async () => {
    // `destination` is a text column. A value from a restored dump, another deployment or a hand edit
    // would otherwise become a restore FROM a path this server never wrote.
    const row = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (status, destination, window_opened_at, finished_at, db_done_at,
                                blobs_done_at, window_closed_at)
       VALUES ('ok', '/etc', now(), now(), now(), now(), now()) RETURNING id::text AS id`);
    invented.push(row!.id);
    const r = await app.inject({ method: 'POST', url: `/admin/backups/${row!.id}/restore`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'outside_destination');
  });

  it('writes the request, records who asked, and stops the server', async () => {
    const id = await aRun('backup-2026-08-22T06-43-28-113Z');
    const before_ = stopped;
    const r = await app.inject({ method: 'POST', url: `/admin/backups/${id}/restore`, headers: auth() });
    assert.equal(r.statusCode, 202, r.body);

    const asked = await readRestoreRequest(join(root, 'state', 'restore.epoch'));
    assert.equal(asked?.runId, id);
    assert.equal(asked?.destination, join(root, 'backups', 'backup-2026-08-22T06-43-28-113Z'));
    assert.ok(asked?.by, 'the log after the restart has to be able to say who asked');

    // Recorded BEFORE the server goes, because after it goes there is nobody to record it.
    const entry = await db.one<{ action: string }>(
      `SELECT action FROM audit_log ORDER BY id DESC LIMIT 1`);
    assert.equal(entry?.action, 'restore.request');

    // The stop is deferred past the reply; the assertion waits for it rather than racing it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(stopped, before_ + 1, 'and the server stops, or the request is never carried out');
    await clearRestoreRequest(join(root, 'state', 'restore.epoch'));
  });
});
