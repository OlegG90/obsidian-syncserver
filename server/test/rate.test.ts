/**
 * The volume limit, and the device check beside it.
 *
 * The window rolling off is tested with an injected clock rather than by sleeping: a test
 * that waits a minute to prove a minute has passed is a test nobody runs.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { inProcessRateLimiter } from '../src/blobs/rate.js';

const STORE = `var/test-rate-${process.pid}`;
/** Small enough that two ordinary uploads cross it. */
const PER_MINUTE = 8192;
const cfg = {
  ...loadConfig(),
  blobStorePath: STORE,
  limits: { ...loadConfig().limits, uploadBytesPerMinute: PER_MINUTE },
};

let db: Db;
let app: FastifyInstance;
let access: string;
let userId: string;
let deviceId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });

const upload = (body: Buffer) =>
  app.inject({
    method: 'POST', url: '/blobs',
    query: { sha256: sha(body), size: String(body.length), key_id: randomUUID() },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  await db.query(
    `UPDATE users SET state = 'active', role = 'admin', auth_secret_hash = 'h',
            account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\\x01', enc_privkey = '\\x02',
            recovery_key = '\\x03', recovery_code_hash = 'rh', wrapped_seed = '\\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', '\\x03', 'rh', '\\x04', 104857600)`,
    [userId, `rate-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [userId]);
  deviceId = device!.id;
  access = app.jwt.sign({ sub: userId, device: deviceId });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('the limiter itself', () => {
  it('charges the declared size and refuses what does not fit', () => {
    const limiter = inProcessRateLimiter(1000, () => 0);
    assert.deepEqual(limiter.reserve('u', 600), { ok: true });
    assert.deepEqual(limiter.reserve('u', 400), { ok: true });

    const refused = limiter.reserve('u', 1);
    assert.equal(refused.ok, false);
    assert.ok(refused.ok === false && refused.retryAfterSeconds >= 1,
      'a refusal without a wait turns a retry loop into the same retry loop');
  });

  it('counts each account separately', () => {
    const limiter = inProcessRateLimiter(1000, () => 0);
    assert.equal(limiter.reserve('a', 1000).ok, true);
    assert.equal(limiter.reserve('b', 1000).ok, true, 'one account cannot spend another\'s allowance');
  });

  it('lets the window roll off', () => {
    let clock = 0;
    const limiter = inProcessRateLimiter(1000, () => clock);

    assert.equal(limiter.reserve('u', 1000).ok, true);
    assert.equal(limiter.reserve('u', 1).ok, false);

    clock += 60_001;
    assert.equal(limiter.reserve('u', 1000).ok, true, 'a minute later the allowance is whole again');
  });

  it('waits only as long as the oldest entry needs', () => {
    let clock = 0;
    const limiter = inProcessRateLimiter(1000, () => clock);
    limiter.reserve('u', 500);
    clock += 30_000;
    limiter.reserve('u', 500);

    const refused = limiter.reserve('u', 500);
    assert.equal(refused.ok, false);
    // The first 500 rolls off 30s from now, and that is enough — not the 60s a naive
    // answer would give.
    assert.ok(refused.ok === false && refused.retryAfterSeconds <= 30);
  });
});

describe('POST /blobs under the limit', () => {
  it('refuses with 429 and a Retry-After once the minute is spent', async () => {
    const first = await upload(randomBytes(PER_MINUTE - 100));
    assert.equal(first.statusCode, 201, first.body);

    const second = await upload(randomBytes(500));
    assert.equal(second.statusCode, 429);
    assert.ok(second.headers['retry-after'], 'the client is told how long to wait');
    assert.equal(second.json().error, 'rate_limited');
  });

  it('refuses a device that has been signed out, before it costs any disk', async () => {
    // A fresh account, so the limiter's window from the test above does not decide this.
    const other = randomUUID();
    await db.query(
      `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', '\\x03', 'rh', '\\x04', 104857600)`,
      [other, `revoked-${process.pid}`]);
    const dev = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'gone', 'linux') RETURNING id`, [other]);

    const token = app.jwt.sign({ sub: other, device: dev!.id });
    const body = randomBytes(64);
    const query = { sha256: sha(body), size: String(body.length), key_id: randomUUID() };

    const before_ = await app.inject({
      method: 'POST', url: '/blobs', query,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: body,
    });
    assert.equal(before_.statusCode, 201, before_.body);

    await db.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [dev!.id]);

    const body2 = randomBytes(64);
    const after_ = await app.inject({
      method: 'POST', url: '/blobs',
      query: { sha256: sha(body2), size: String(body2.length), key_id: randomUUID() },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: body2,
    });
    assert.equal(after_.statusCode, 401,
      'the access token is still valid; the device it names is not');
    assert.equal(after_.json().error, 'device_revoked');
  });
});
