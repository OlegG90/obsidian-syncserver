/**
 * The restore surface: the epoch guard, and the halt it produces.
 *
 * docs/11: on every successful start the server writes the newest epoch it has run with to
 * a state file outside the database. If the database's `restore_epoch` is lower than the
 * file's, a restore happened and nobody confirmed it — the server halts, answering
 * `restore_pending` to everything but the console and the restore endpoints, because a
 * restore nobody can confirm is a restore nobody can leave.
 *
 * Named to sort after `auth.test.ts` and `operator.test.ts`, which claim the seeded
 * administrator first (AGENTS.md).
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { checkRestoreState, confirmRestore, restoreStatus } from '../src/restore.js';

let db: Db;
let app: FastifyInstance;
let adminToken: string;
let stateFile: string;
const adminId = '00000000-0000-0000-0000-000000000001';

before(async () => {
  db = connect(loadConfig().databaseUrl);
  stateFile = join(await mkdtemp(join(tmpdir(), 'syncserver-restore-')), 'restore.epoch');
  const cfg = { ...loadConfig(), restoreStateFile: stateFile };
  app = await buildApp(db, cfg);

  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [adminId],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [adminId]);
  adminToken = app.jwt.sign({ sub: adminId, device: device!.id });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(stateFile, { recursive: true, force: true });
});

const admin = () => ({ authorization: `Bearer ${adminToken}` });

describe('the restore status', () => {
  it('is not pending when the database is at or ahead of the state file', async () => {
    const status = await restoreStatus(db, stateFile);
    assert.equal(status.pending, false);
    assert.equal(status.dbEpoch, 1);
    assert.equal(status.fileEpoch, null, 'no file yet — a fresh server has never been restored');
  });

  it('becomes pending when the database is behind the file', async () => {
    // The file is the NEWER truth — a restore brought the database back to an old epoch.
    await writeFile(stateFile, '5', 'utf8');
    const status = await restoreStatus(db, stateFile);
    assert.equal(status.pending, true);
    assert.equal(status.dbEpoch, 1);
    assert.equal(status.fileEpoch, 5);
  });
});

describe('confirming a restore', () => {
  it('raises the epoch above the maximum of both, and records it', async () => {
    // db=1, file=5 → next is 6, never file+1 (the restored DB may be several restores
    // behind, and re-issuing an epoch the server has already used makes stale cursors look
    // current again).
    await writeFile(stateFile, '5', 'utf8');
    const out = await confirmRestore(db, { id: adminId, login: 'admin' }, stateFile);

    assert.equal(out.epoch, 6);
    const status = await restoreStatus(db, stateFile);
    assert.equal(status.pending, false, 'the file now agrees with the database');
    assert.equal(status.fileEpoch, 6, 'and the file was brought up too');
  });

  it('is refused when nothing is pending', async () => {
    const r = await app.inject({
      method: 'POST', url: '/admin/restore/confirm', headers: admin(),
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'nothing_to_confirm');
  });
});

describe('the halt after an unconfirmed restore', () => {
  it('answers restore_pending to ordinary endpoints, and keeps the confirm reachable', async () => {
    await writeFile(stateFile, '9', 'utf8'); // db is 6 from the previous confirm → pending
    // What a start does, and the only thing that can raise the halt (#87). Writing the file
    // under a running server is how a test says "a restore happened"; a real one replaces the
    // database while the server is stopped, so noticing is a boot-time act. Held in memory
    // afterwards rather than re-read per request, which was a query and a `readFile` for an
    // answer that could not have changed.
    await checkRestoreState(db, stateFile);

    const blocked = await app.inject({ method: 'GET', url: '/admin/accounts', headers: admin() });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error, 'restore_pending');

    // The confirm endpoint stays open — a halt that refuses the way out is a halt nobody
    // can leave.
    const confirm = await app.inject({ method: 'POST', url: '/admin/restore/confirm', headers: admin() });
    assert.equal(confirm.statusCode, 200);
    assert.equal(confirm.json().epoch, 10, 'max(6, 9) + 1');

    const status = await app.inject({ method: 'GET', url: '/admin/restore', headers: admin() });
    assert.equal(status.json().pending, false);
  });

  it('lets the server go back to work the moment it is confirmed, without a restart', async () => {
    // The half nothing was watching. The test above confirms and then asks `/admin/restore`,
    // which is open during the halt and answers either way — so removing the line that lifts
    // the halt changed no result. The question is whether an ORDINARY endpoint works again.
    //
    // It has to be immediate. Confirming is done from a screen the halt deliberately leaves
    // reachable, and an operator who has just been told "this is the way out" and still cannot
    // use the server has been told something untrue.
    await writeFile(stateFile, '20', 'utf8');
    await checkRestoreState(db, stateFile);
    const halted = await app.inject({ method: 'GET', url: '/admin/accounts', headers: admin() });
    assert.equal(halted.statusCode, 503, 'halted first, or this proves nothing');

    await app.inject({ method: 'POST', url: '/admin/restore/confirm', headers: admin() });

    const working = await app.inject({ method: 'GET', url: '/admin/accounts', headers: admin() });
    assert.equal(working.statusCode, 200, 'confirming lifted the halt in this process');
  });
});
