/**
 * Integration tests against a real PostgreSQL: the schema is where most of the rules live,
 * so a test with the database mocked out would be testing the mock.
 *
 * Routes are exercised through `app.inject()` — no port, no network, real handlers.
 * Requires the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

const cfg = loadConfig();
let db: Db;
let app: FastifyInstance;

/** The material a client produces on the device; opaque to the server, so shape is all that matters here. */
const redeemBody = (token: string) => ({
  invitation_token: token,
  auth_secret: 'a'.repeat(43),
  account_salt: Buffer.alloc(16, 7).toString('base64'),
  kdf_params: { v: 19, m: 65536, t: 3, p: 1 },
  pubkey: Buffer.alloc(32, 1).toString('base64'),
  enc_privkey: Buffer.alloc(48, 2).toString('base64'),
  wrapped_seed: Buffer.alloc(48, 3).toString('base64'),
  recovery_key: Buffer.alloc(48, 4).toString('base64'),
  recovery_code_hash: 'r'.repeat(64),
  initial_vault_id: randomUUID(),
  initial_vault_name_enc: Buffer.from('my vault').toString('base64'),
  device_name: 'laptop',
  device_platform: 'linux',
});

before(async () => {
  db = connect(cfg.databaseUrl);
  // Undo whatever an earlier run redeemed: these tests need the seeded first-run state.
  await db.query(`DELETE FROM audit_log`);
  await db.query(`DELETE FROM devices`);
  await db.query(`DELETE FROM nodes WHERE vault_id IN (SELECT id FROM vaults WHERE user_id <> '00000000-0000-0000-0000-000000000000')`);
  await db.query(`DELETE FROM vaults`);
  await db.query(`UPDATE users SET state = 'provisioned', role = 'admin',
                         auth_secret_hash = NULL, account_salt = NULL, kdf_params = NULL,
                         pubkey = NULL, enc_privkey = NULL, wrapped_seed = NULL,
                         recovery_key = NULL, recovery_code_hash = NULL,
                         invite_token_hash = encode(sha256(convert_to('admin','UTF8')),'hex'),
                         invite_expires_at = now() + interval '7 days'
                   WHERE id = '00000000-0000-0000-0000-000000000001'`);
  await db.query(`DELETE FROM users WHERE state = 'active'`);
  app = await buildApp(db, cfg);
});

after(async () => {
  await app.close();
  await db.close();
});

describe('first run', () => {
  it('answers nothing but the bootstrap redemption while there is no administrator', async () => {
    const blocked = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'admin', auth_secret: 'x' } });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error, 'bootstrap_pending');

    const open = await app.inject({ method: 'GET', url: '/auth/kdf?login=admin' });
    assert.equal(open.statusCode, 200);
  });

  it('redeems the seeded invitation, and the default token stops working afterwards', async () => {
    const first = await app.inject({ method: 'POST', url: '/auth/redeem', payload: redeemBody('admin') });
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json();
    assert.ok(body.access && body.refresh && body.device_id && body.vault_id && body.root_node_id);

    // Single use by construction: this is what makes a default credential acceptable.
    const again = await app.inject({ method: 'POST', url: '/auth/redeem', payload: redeemBody('admin') });
    assert.equal(again.statusCode, 404);
  });

  it('serves the rest of the API once an administrator exists', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'admin', auth_secret: 'wrong' } });
    assert.notEqual(r.statusCode, 503);
    assert.equal(r.statusCode, 401);
  });
});

describe('/auth/kdf does not enumerate accounts (#73)', () => {
  it('answers an unknown login with a salt of the right shape', async () => {
    const r = await app.inject({ method: 'GET', url: '/auth/kdf?login=nobody-here' });
    assert.equal(r.statusCode, 200);
    const salt = Buffer.from(r.json().account_salt, 'base64');
    assert.equal(salt.length, 16, 'a fake salt must be the size of a real one');
  });

  it('answers the same unknown login identically every time', async () => {
    const a = await app.inject({ method: 'GET', url: '/auth/kdf?login=nobody-here' });
    const b = await app.inject({ method: 'GET', url: '/auth/kdf?login=nobody-here' });
    assert.deepEqual(a.json(), b.json(), 'a salt that changed between calls would be the answer');
  });

  it('answers different unknown logins differently', async () => {
    const a = await app.inject({ method: 'GET', url: '/auth/kdf?login=nobody-a' });
    const b = await app.inject({ method: 'GET', url: '/auth/kdf?login=nobody-b' });
    assert.notDeepEqual(a.json().account_salt, b.json().account_salt);
  });
});

describe('login and refresh', () => {
  it('accepts the auth secret, not a passphrase, and rotates the refresh token', async () => {
    const account = await db.one<{ id: string }>(`SELECT id FROM users WHERE login = 'admin'`);
    const device = await db.one<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [account!.id]);

    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: 'admin', auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh: ok.json().refresh } });
    assert.equal(refreshed.statusCode, 200);
    assert.ok(refreshed.json().access);
  });

  it('refuses a refresh token that has been superseded', async () => {
    const account = await db.one<{ id: string }>(`SELECT id FROM users WHERE login = 'admin'`);
    const device = await db.one<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [account!.id]);
    const payload = { login: 'admin', auth_secret: 'a'.repeat(43), device_id: device!.id };

    const first = (await app.inject({ method: 'POST', url: '/auth/login', payload })).json().refresh;
    await app.inject({ method: 'POST', url: '/auth/login', payload });

    const stale = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh: first } });
    assert.equal(stale.statusCode, 401, 'one refresh token per device (#90) means the old one is dead');
  });

  it('gives the same answer for an unknown login and a wrong secret', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'ghost', auth_secret: 'x', device_id: randomUUID() } });
    const wrong = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'admin', auth_secret: 'x', device_id: randomUUID() } });
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.deepEqual(unknown.json(), wrong.json());
  });
});
