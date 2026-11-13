/**
 * The backup window over HTTP: what it refuses, and what it lets through (D-114, D-142).
 *
 * `backup.test.ts` proves the window opens and closes around the legs; this suite proves what a client
 * meets while it is open. Content writes are refused. A token refresh, a vault login and a console
 * sign-in are not — refusing those kept a device from reading, and the operator out of the console,
 * for the length of a backup.
 *
 * The window is opened the way a backup opens it, by holding the interlock, so no dump is taken and
 * nothing is written to a backup destination.
 *
 * Sorts after `auth.test.ts`, which must meet a database nobody has claimed the administrator of
 * (AGENTS.md): this suite claims it. Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { issueRefreshToken } from '../src/auth/service.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { holdForBackup } from '../src/interlock.js';
import { aVaultAccount } from './support/accounts.js';

let db: Db;
let app: FastifyInstance;
let accountLogin: string;
let deviceId: string;
let refresh: string;
let access: string;
const adminId = '00000000-0000-0000-0000-000000000001';

before(async () => {
  db = connect(loadConfig().databaseUrl);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [adminId],
  );
  app = await buildApp(db, loadConfig());

  const account = await aVaultAccount(db);
  accountLogin = account.login;
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'phone', 'android') RETURNING id::text AS id`,
    [account.id],
  );
  deviceId = device!.id;
  refresh = await issueRefreshToken(db, deviceId);
  access = app.jwt.sign({ sub: account.id, device: deviceId });
});

after(async () => {
  await app.close();
  await db.close();
});

/** Run `fn` with the window open, exactly as a backup holds it, and shut it whatever happens. */
const duringABackup = (fn: () => Promise<void>): Promise<void> =>
  db.session(async (lock) => {
    const release = await holdForBackup(lock, 5_000);
    assert.ok(release, 'the window opened');
    try {
      await fn();
    } finally {
      await release();
    }
  });

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload, headers });

describe('the backup window', () => {
  it('refuses a content write, and says why', async () => {
    await duringABackup(async () => {
      const r = await post('/vaults', { id: '00000000-0000-0000-0000-0000000000aa', name_enc: 'AA==' }, {
        authorization: `Bearer ${access}`,
      });
      assert.equal(r.statusCode, 503);
      assert.equal(r.json().error, 'backup_in_progress');
    });
  });

  it('lets a token refresh through, so a device whose token expires can go on reading', async () => {
    await duringABackup(async () => {
      const r = await post('/auth/refresh', { refresh });
      assert.equal(r.statusCode, 200, r.body);
      assert.ok(r.json().access, 'a new access token');
    });
  });

  it('lets a console sign-in through, so the operator can see what is happening', async () => {
    await duringABackup(async () => {
      // A wrong password is answered as one: the window never saw the request, which is the point.
      const r = await post('/auth/console', { login: 'admin', password: 'not the password at all' });
      assert.equal(r.statusCode, 401, r.body);
      assert.equal(r.json().error, 'invalid_credentials');
    });
  });

  it('lets a vault login through', async () => {
    await duringABackup(async () => {
      const r = await post('/auth/login', { login: accountLogin, auth_secret: 'wrong', device_id: deviceId });
      assert.equal(r.statusCode, 401, r.body);
      assert.equal(r.json().error, 'invalid_credentials');
    });
  });

  it('answers a refresh as before once the window has closed', async () => {
    const r = await post('/auth/refresh', { refresh });
    assert.equal(r.statusCode, 200, r.body);
  });
});
