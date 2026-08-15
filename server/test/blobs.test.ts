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
const base = loadConfig();
// 1 KB parts, not 8 MB: the account quota here is 1 MiB, so a realistic part size would
// make a multi-part upload impossible to express. The server enforces the part size as a
// ceiling, so lowering it exercises the same code with less traffic.
const PART = 1024;
const cfg = { ...base, blobStorePath: STORE, limits: { ...base.limits, uploadPartBytes: PART } };

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
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
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
            kek_verifier_hash = 'kv',
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

  it('takes the bytes whatever media type the client declared', async () => {
    // A phone got `415` here and a desktop did not: Obsidian's `requestUrl` declares
    // something different on Android, and the parser was registered for one exact type.
    // The server never reads the media type — it hashes the body and checks it against the
    // address — so the only thing a strict parser could do was refuse correct uploads.
    // A type nobody registered, a parameterised one, and none at all — each was a `415`
    // before. (A `text/*` type cannot be exercised through `inject`: it stringifies the
    // payload and the content length stops matching, which is the injector, not the server.)
    const body = randomBytes(512);
    for (const contentType of [
      'application/x-whatever',
      'application/octet-stream; charset=utf-8',
      undefined,
    ]) {
      const r = await app.inject({
        method: 'POST',
        url: '/blobs',
        query: { sha256: sha(body), size: String(body.length), key_id: randomUUID() },
        headers: {
          authorization: `Bearer ${access}`,
          ...(contentType === undefined ? {} : { 'content-type': contentType }),
        },
        payload: body,
      });
      assert.equal(r.statusCode, 201, `${contentType ?? 'no content-type'}: ${r.body}`);
    }
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

describe('resumable upload (docs/04)', () => {
  const parts = (body: Buffer): Buffer[] => {
    const out: Buffer[] = [];
    for (let at = 0; at < body.length; at += PART) out.push(body.subarray(at, Math.min(at + PART, body.length)));
    return out;
  };

  const putPart = (token: string, address: string, n: number, chunk: Buffer, total: number, overrides: Record<string, string> = {}) =>
    app.inject({
      method: 'PUT',
      url: `/blobs/${address}/parts/${n}`,
      query: { total: String(total), size: String(chunk.length), ...overrides },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: chunk,
    });

  const listParts = (token: string, address: string) =>
    app.inject({ method: 'GET', url: `/blobs/${address}/parts`, headers: { authorization: `Bearer ${token}` } });

  const complete = (token: string, address: string, size: number) =>
    app.inject({
      method: 'POST',
      url: `/blobs/${address}/complete`,
      query: { size: String(size), key_id: randomUUID() },
      headers: { authorization: `Bearer ${token}` },
    });

  it('assembles the parts into exactly the blob a single POST would have stored', async () => {
    const body = randomBytes(PART * 3 + 17);
    const address = sha(body);
    for (const [i, chunk] of parts(body).entries()) {
      const r = await putPart(access, address, i + 1, chunk, body.length);
      assert.equal(r.statusCode, 204, r.body);
    }

    const done = await complete(access, address, body.length);
    assert.equal(done.statusCode, 201, done.body);
    assert.equal(done.json().size, body.length);

    // The same row a single-shot upload writes, at the same storage key — one code path.
    const row = await db.one<{ storageKey: string }>(
      `SELECT storage_key AS "storageKey" FROM blobs WHERE sha256 = $1`,
      [Buffer.from(address, 'hex')],
    );
    assert.equal(row!.storageKey, storageKeyFor(address));

    // And it reads back byte for byte, once the caller holds a live reference.
    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 0, pending_since = NULL, pending_device_id = NULL
                     WHERE sha256 = $1`, [Buffer.from(address, 'hex')]);
    const read = await app.inject({ method: 'GET', url: `/blobs/${address}`, headers: { authorization: `Bearer ${access}` } });
    assert.equal(read.statusCode, 200);
    assert.deepEqual(read.rawPayload, body);
  });

  it('answers a resume with what this caller staged, and re-sending a part overwrites it', async () => {
    const body = randomBytes(PART * 2);
    const address = sha(body);
    const [one, two] = parts(body);

    const untouched = await listParts(access, address);
    assert.equal(untouched.statusCode, 200, 'an address never started answers 200, not 404');
    assert.deepEqual(untouched.json(), { parts: [], bytes: 0 });

    await putPart(access, address, 1, one!, body.length);
    assert.deepEqual((await listParts(access, address)).json(), { parts: [1], bytes: PART });

    // A client unsure whether part 1 landed simply sends it again.
    const again = await putPart(access, address, 1, one!, body.length);
    assert.equal(again.statusCode, 204);
    assert.deepEqual((await listParts(access, address)).json(), { parts: [1], bytes: PART }, 'overwritten, not appended');

    await putPart(access, address, 2, two!, body.length);
    assert.equal((await complete(access, address, body.length)).statusCode, 201);
  });

  it('tells a stranger nothing about an upload or a finished blob', async () => {
    const body = randomBytes(PART * 2);
    const address = sha(body);
    for (const [i, chunk] of parts(body).entries()) await putPart(access, address, i + 1, chunk, body.length);
    assert.equal((await complete(access, address, body.length)).statusCode, 201);

    // The blob now exists on the server. The resume call must not be the oracle that the
    // 404-not-403 rule and the missing short circuit on POST /blobs both exist to close.
    const stranger = await listParts(otherAccess, address);
    assert.equal(stranger.statusCode, 200);
    assert.deepEqual(stranger.json(), { parts: [], bytes: 0 });
  });

  it('stages no claim on content, so parts alone never acquire somebody else\'s blob', async () => {
    // The account stages parts for an address and never completes it. Another account then
    // uploads that very content. Without the "no row before the bytes" rule, the first
    // account would now hold a claim on a file it never sent.
    const body = randomBytes(PART * 2);
    const address = sha(body);
    await putPart(otherAccess, address, 1, parts(body)[0]!, body.length);

    const sha256 = Buffer.from(address, 'hex');
    const claim = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_blobs WHERE sha256 = $1`,
      [sha256],
    );
    assert.equal(claim!.n, '0', 'staging parts writes no user_blobs row');

    assert.equal((await upload(access, body)).statusCode, 201);
    await db.query(`UPDATE user_blobs SET refs_own = 1, refs_pending = 0, pending_since = NULL, pending_device_id = NULL
                     WHERE sha256 = $1`, [sha256]);

    const stranger = await app.inject({
      method: 'HEAD',
      url: `/blobs/${address}`,
      headers: { authorization: `Bearer ${otherAccess}` },
    });
    assert.equal(stranger.statusCode, 404, 'a staged part is not a reference to what somebody else uploaded');
  });

  it('refuses a hole without destroying the upload, because a hole is what a resume is for', async () => {
    const body = randomBytes(PART * 3);
    const address = sha(body);
    const [one, two, three] = parts(body);
    await putPart(access, address, 1, one!, body.length);
    await putPart(access, address, 3, three!, body.length);

    const early = await complete(access, address, body.length);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'parts_missing');
    assert.deepEqual(early.json().have, [1, 3]);

    assert.deepEqual((await listParts(access, address)).json().parts, [1, 3], 'the staging survived the refusal');
    await putPart(access, address, 2, two!, body.length);
    assert.equal((await complete(access, address, body.length)).statusCode, 201);
  });

  it('refuses parts that do not hash to the address, and discards them', async () => {
    const body = randomBytes(PART * 2);
    const address = sha(randomBytes(64)); // an address these bytes do not produce
    for (const [i, chunk] of parts(body).entries()) await putPart(access, address, i + 1, chunk, body.length);

    const r = await complete(access, address, body.length);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'address_mismatch');

    // Discarded, because the server cannot say which part was wrong: retrying `complete`
    // would otherwise fail identically for ever.
    assert.deepEqual((await listParts(access, address)).json(), { parts: [], bytes: 0 });
  });

  it('refuses a part above the part size, and an upload above the quota at its first part', async () => {
    const body = randomBytes(PART * 2);
    const address = sha(body);

    const tooBig = await putPart(access, address, 1, randomBytes(PART + 1), body.length);
    assert.equal(tooBig.statusCode, 413);
    assert.equal(tooBig.json().error, 'part_too_large');

    // Quota is answered from the WHOLE size, so an upload that cannot fit is refused
    // before its first part rather than after its last.
    const tooMuch = await putPart(access, address, 1, parts(body)[0]!, body.length, { total: String(64 * 1024 * 1024) });
    assert.equal(tooMuch.statusCode, 413);
    assert.equal(tooMuch.json().error, 'over_quota');
    assert.deepEqual((await listParts(access, address)).json(), { parts: [], bytes: 0 }, 'nothing was written');
  });
});
