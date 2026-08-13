/**
 * Blob store: authorisation by the caller's own reference, the no-short-circuit rule, and
 * the address verification that dedup depends on.
 *
 * Needs the development database and a scratch blob directory. `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { storageKeyFor } from '../src/blobs/store.js';

const STORE = `var/test-blobs-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let otherAccess: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** An active account with a device, and an access token for it. */
const makeAccount = async (login: string): Promise<string> => {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', '\\x03', 'rh', '\\x04', 1048576)`,
    [userId, login],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [userId],
  );
  return app.jwt.sign({ sub: userId, device: device!.id });
};

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  // The bootstrap guard is not what these tests are about; give the server an administrator.
  await db.query(
    `UPDATE users SET state = 'active', role = 'admin',
            auth_secret_hash = 'h', account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\\x01', enc_privkey = '\\x02',
            recovery_key = '\\x03', recovery_code_hash = 'rh', wrapped_seed = '\\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );
  access = await makeAccount(`blobs-a-${process.pid}`);
  otherAccess = await makeAccount(`blobs-b-${process.pid}`);
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

const upload = (token: string, body: Buffer, overrides: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/blobs',
    query: { sha256: sha(body), size: String(body.length), key_id: randomUUID(), ...overrides },
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: body,
  });

describe('uploading', () => {
  it('stores the bytes at the address they hash to', async () => {
    const body = randomBytes(4096);
    const r = await upload(access, body);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().sha256, sha(body));

    const row = await db.one<{ storageKey: string }>(
      `SELECT storage_key AS "storageKey" FROM blobs WHERE sha256 = $1`,
      [Buffer.from(sha(body), 'hex')],
    );
    assert.equal(row!.storageKey, storageKeyFor(sha(body)), 'two levels of fan-out, full address as the name');
  });

  it('refuses bytes that do not hash to the address they claim', async () => {
    const body = randomBytes(64);
    const r = await upload(access, body, { sha256: sha(randomBytes(64)) });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'address_mismatch');
  });

  it('counts the upload against quota before it lands, not after', async () => {
    // The account's quota is 1 MiB; this is larger, and the answer must not depend on
    // the bytes having already been written.
    const body = randomBytes(2048);
    const r = await upload(access, body, { size: String(64 * 1024 * 1024) });
    assert.equal(r.statusCode, 413);
    assert.equal(r.json().error, 'over_quota');
  });

  it('has no "already have it" short circuit (#46)', async () => {
    const body = randomBytes(1024);
    const first = await upload(access, body);
    assert.equal(first.statusCode, 201);

    // Re-sending the same content is accepted rather than answered "I have this", which
    // would tell the caller whether somebody holds it.
    const again = await upload(otherAccess, body);
    assert.equal(again.statusCode, 201, 'the server takes the bytes and deduplicates internally');
  });
});

describe('reading is authorised by the caller\'s own reference (#20)', () => {
  it('answers HEAD 404 for a blob the caller does not hold, even though it exists', async () => {
    const body = randomBytes(512);
    await upload(access, body);
    // Uploading leaves refs_pending, not refs_own: the caller has no live reference yet.
    const mine = await app.inject({
      method: 'HEAD',
      url: `/blobs/${sha(body)}`,
      headers: { authorization: `Bearer ${access}` },
    });
    assert.equal(mine.statusCode, 404, 'pending is not a live reference');

    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 0, pending_since = NULL, pending_device_id = NULL
                     WHERE sha256 = $1`, [Buffer.from(sha(body), 'hex')]);

    const now = await app.inject({
      method: 'HEAD',
      url: `/blobs/${sha(body)}`,
      headers: { authorization: `Bearer ${access}` },
    });
    assert.equal(now.statusCode, 200);

    const stranger = await app.inject({
      method: 'HEAD',
      url: `/blobs/${sha(body)}`,
      headers: { authorization: `Bearer ${otherAccess}` },
    });
    assert.equal(stranger.statusCode, 404, '404, never 403 — a 403 confirms the file exists');
  });

  it('serves content and a byte range to a holder', async () => {
    const body = randomBytes(1000);
    await upload(access, body);
    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 0, pending_since = NULL, pending_device_id = NULL
                     WHERE sha256 = $1`, [Buffer.from(sha(body), 'hex')]);

    const whole = await app.inject({ method: 'GET', url: `/blobs/${sha(body)}`, headers: { authorization: `Bearer ${access}` } });
    assert.equal(whole.statusCode, 200);
    assert.deepEqual(whole.rawPayload, body);

    const part = await app.inject({
      method: 'GET',
      url: `/blobs/${sha(body)}`,
      headers: { authorization: `Bearer ${access}`, range: 'bytes=10-19' },
    });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 10-19/1000`);
    assert.deepEqual(part.rawPayload, body.subarray(10, 20));
  });

  it('refuses an unauthenticated read', async () => {
    const r = await app.inject({ method: 'GET', url: `/blobs/${'0'.repeat(64)}` });
    assert.equal(r.statusCode, 401);
  });
});
