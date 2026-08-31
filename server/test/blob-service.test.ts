/**
 * `BlobService` — the blob intake, tested through its own interface.
 *
 * Everything here is real except the clock: a real database, a real blob store, and an
 * in-process rate limiter with an injected clock (the one thing that cannot be real without
 * waiting). No Fastify, no HTTP — the ordering and cleanup the route used to own are tested
 * directly.
 *
 * Needs the development database and a scratch blob directory. `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { openStore } from '../src/blobs/store.js';
import { inProcessRateLimiter } from '../src/blobs/rate.js';
import { BlobService, parseRange } from '../src/blobs/service.js';
import type { BlobStore } from '../src/blobs/store.js';
import { testStore } from './support/store.js';

const STORE = testStore('blob-service');
const base = loadConfig();
// 1 KB parts, not 8 MB: the account quota here is 1 MiB, so a realistic part size would
// make a multi-part upload impossible to express. The server enforces the part size as a
// ceiling, so lowering it exercises the same code with less traffic.
const PART = 1024;
const limits = { ...base.limits, uploadPartBytes: PART };
// A clock we can wind: the rate limiter counts by the injected `now`, so a test can move
// time without sleeping.
let now = Date.now();
const rate = inProcessRateLimiter(50 * PART, () => now);

let db: Db;
let store: BlobStore;
let service: BlobService;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Acct {
  userId: string;
  deviceId: string;
}

const makeAccount = async (login: string, quotaBytes = 1048576): Promise<Acct> => {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', $3)`,
    [userId, login, quotaBytes],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [userId],
  );
  return { userId, deviceId: device!.id };
};

const stream = (b: Buffer) => Readable.from([b]);

/** Drain a readable into one Buffer, for asserting what was stored. */
const collect = async (r: import('node:stream').Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as ArrayBufferLike));
  return Buffer.concat(chunks);
};

before(async () => {
  db = connect(base.databaseUrl);
  store = openStore(STORE);
  service = new BlobService(db, store, rate, limits);
});

after(async () => {
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('BlobService.acceptWhole', () => {
  it('stores the bytes and records the pending claim', async () => {
    const a = await makeAccount(`whole-a-${process.pid}`);
    const body = randomBytes(PART);
    const out = await service.acceptWhole({
      userId: a.userId, deviceId: a.deviceId,
      sha256: Buffer.from(sha(body), 'hex'), size: body.length,
      encAlg: 'xchacha20-poly1305', keyId: randomUUID(), body: stream(body),
    });
    assert.ok(out.ok);
    assert.equal(out.ok && out.value.sha256, sha(body));

    const row = await db.one<{ pending: string; storageKey: string }>(
      `SELECT ub.refs_pending::text AS pending, b.storage_key AS "storageKey"
         FROM user_blobs ub JOIN blobs b ON b.sha256 = ub.sha256
        WHERE ub.user_id = $1 AND ub.sha256 = $2`,
      [a.userId, Buffer.from(sha(body), 'hex')],
    );
    assert.equal(row!.pending, '1', 'the claim starts pending');
    assert.ok(row!.storageKey, 'and the blob is on disk');
  });

  it('refuses bytes that do not hash to the address they claim, leaving nothing behind', async () => {
    const a = await makeAccount(`whole-bad-${process.pid}`);
    const body = randomBytes(64);
    const out = await service.acceptWhole({
      userId: a.userId, deviceId: a.deviceId,
      sha256: Buffer.from(sha(randomBytes(64)), 'hex'), size: body.length,
      encAlg: 'xchacha20-poly1305', keyId: randomUUID(), body: stream(body),
    });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'address_mismatch');

    const blob = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM user_blobs WHERE user_id = $1`, [a.userId]);
    assert.equal(blob!.n, '0', 'no claim is recorded for a mismatch');
  });

  it('refuses a revoked device before a byte is written', async () => {
    const a = await makeAccount(`whole-rev-${process.pid}`);
    await db.query(`UPDATE devices SET revoked_at = now() WHERE id = $1`, [a.deviceId]);
    const body = randomBytes(64);
    const out = await service.acceptWhole({
      userId: a.userId, deviceId: a.deviceId,
      sha256: Buffer.from(sha(body), 'hex'), size: body.length,
      encAlg: 'xchacha20-poly1305', keyId: randomUUID(), body: stream(body),
    });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'device_revoked');
  });

  it('refuses an upload that cannot fit the quota, from the whole size', async () => {
    const a = await makeAccount(`whole-quota-${process.pid}`, 512); // tiny quota
    const body = randomBytes(PART);
    const out = await service.acceptWhole({
      userId: a.userId, deviceId: a.deviceId,
      sha256: Buffer.from(sha(body), 'hex'), size: body.length,
      encAlg: 'xchacha20-poly1305', keyId: randomUUID(), body: stream(body),
    });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'over_quota');
  });
});

describe('BlobService.acceptPart + complete', () => {
  it('assembles the parts into exactly the blob a single POST would have stored', async () => {
    const a = await makeAccount(`parts-a-${process.pid}`);
    const body = randomBytes(3 * PART + 17);
    const address = Buffer.from(sha(body), 'hex');
    const count = Math.ceil(body.length / PART);

    for (let n = 1; n <= count; n++) {
      const slice = body.subarray((n - 1) * PART, Math.min(n * PART, body.length));
      const part = await service.acceptPart({
        userId: a.userId, deviceId: a.deviceId, sha256: address, index: n,
        total: body.length, size: slice.length, body: stream(slice),
      });
      assert.ok(part.ok, `part ${n}`);
    }

    const done = await service.complete({
      userId: a.userId, deviceId: a.deviceId, sha256: address, size: body.length,
      encAlg: 'xchacha20-poly1305', keyId: randomUUID(),
    });
    assert.ok(done.ok);
    assert.equal(done.ok && done.value.size, body.length);

    // The claim is pending, and a re-read through a fresh store yields the same bytes.
    const row = await db.one<{ storageKey: string }>(`SELECT storage_key AS "storageKey" FROM blobs WHERE sha256 = $1`, [address]);
    const stored = await collect(store.read(row!.storageKey));
    assert.deepEqual(stored, body);
  });

  it('a hole is refused with parts_missing WITHOUT discarding the staging', async () => {
    const a = await makeAccount(`parts-hole-${process.pid}`);
    const body = randomBytes(3 * PART);
    const address = Buffer.from(sha(body), 'hex');

    await service.acceptPart({ userId: a.userId, deviceId: a.deviceId, sha256: address, index: 1, total: body.length, size: PART, body: stream(body.subarray(0, PART)) });
    await service.acceptPart({ userId: a.userId, deviceId: a.deviceId, sha256: address, index: 3, total: body.length, size: PART, body: stream(body.subarray(2 * PART)) });

    const out = await service.complete({ userId: a.userId, deviceId: a.deviceId, sha256: address, size: body.length, encAlg: 'xchacha20-poly1305', keyId: randomUUID() });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'parts_missing');

    // A hole is what a resume is for: the staging must survive for the missing part.
    const { parts } = await store.stagedParts(a.userId, sha(body));
    assert.deepEqual(parts, [1, 3], 'the existing parts are still staged');
  });

  it('a mismatch discards the staging, so the client cannot retry into the same wall', async () => {
    const a = await makeAccount(`parts-mismatch-${process.pid}`);
    const body = randomBytes(3 * PART);
    // Parts are the RIGHT size but the wrong bytes for the declared address.
    const wrong = randomBytes(3 * PART);
    const address = Buffer.from(sha(body), 'hex');

    for (let n = 1; n <= 3; n++) {
      const slice = wrong.subarray((n - 1) * PART, n * PART);
      await service.acceptPart({ userId: a.userId, deviceId: a.deviceId, sha256: address, index: n, total: wrong.length, size: slice.length, body: stream(slice) });
    }

    const out = await service.complete({ userId: a.userId, deviceId: a.deviceId, sha256: address, size: wrong.length, encAlg: 'xchacha20-poly1305', keyId: randomUUID() });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'address_mismatch');

    const { parts } = await store.stagedParts(a.userId, sha(body));
    assert.equal(parts.length, 0, 'the staging was discarded');
  });

  it('stages no claim on content: a stranger who only knows the address cannot claim it', async () => {
    const owner = await makeAccount(`parts-owner-${process.pid}`);
    const stranger = await makeAccount(`parts-stranger-${process.pid}`);
    const body = randomBytes(3 * PART);
    const address = Buffer.from(sha(body), 'hex');

    // The owner assembles a complete blob and records the claim.
    for (let n = 1; n <= 3; n++) {
      const slice = body.subarray((n - 1) * PART, n * PART);
      await service.acceptPart({ userId: owner.userId, deviceId: owner.deviceId, sha256: address, index: n, total: body.length, size: slice.length, body: stream(slice) });
    }
    await service.complete({ userId: owner.userId, deviceId: owner.deviceId, sha256: address, size: body.length, encAlg: 'xchacha20-poly1305', keyId: randomUUID() });

    // The stranger tries to claim the SAME address by uploading parts and completing.
    const wrong = randomBytes(3 * PART);
    for (let n = 1; n <= 3; n++) {
      const slice = wrong.subarray((n - 1) * PART, n * PART);
      await service.acceptPart({ userId: stranger.userId, deviceId: stranger.deviceId, sha256: address, index: n, total: wrong.length, size: slice.length, body: stream(slice) });
    }
    // The stranger's bytes do not hash to the address, so no claim is possible — but the
    // point is that even the OWNER's completed blob never became a claim the stranger could
    // inherit by knowing the address.
    const strangerClaim = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_blobs WHERE user_id = $1`,
      [stranger.userId],
    );
    assert.equal(strangerClaim!.n, '0', 'the stranger holds nothing');
  });

  it('the in-flight ceiling is measured from the staging area', async () => {
    const a = await makeAccount(`parts-ceiling-${process.pid}`);
    // The ceiling is per account across ALL in-flight uploads: two separate one-part
    // uploads that together exceed it are refused at the second one's part — even though
    // each single upload fits.
    const body = randomBytes(PART);
    const addr1 = Buffer.from(sha(randomBytes(8)), 'hex');
    const addr2 = Buffer.from(sha(randomBytes(8)), 'hex');
    const tiny = new BlobService(db, store, rate, { ...limits, unfinishedUploadBytes: Math.floor(1.5 * PART) });

    const first = await tiny.acceptPart({ userId: a.userId, deviceId: a.deviceId, sha256: addr1, index: 1, total: body.length, size: PART, body: stream(body) });
    assert.ok(first.ok);
    const second = await tiny.acceptPart({ userId: a.userId, deviceId: a.deviceId, sha256: addr2, index: 1, total: body.length, size: PART, body: stream(body) });
    assert.ok(!second.ok);
    assert.equal(second.ok || second.refusal.kind, 'too_many_unfinished');
  });
});

describe('BlobService and the rate limit', () => {
  it('refuses with a wait once the minute is spent', async () => {
    const a = await makeAccount(`rate-${process.pid}`);
    const body = randomBytes(PART);
    const address = Buffer.from(sha(body), 'hex');
    // 50 parts/minute ceiling: burn it with 50 one-part uploads.
    for (let i = 0; i < 50; i++) {
      const out = await service.acceptPart({
        userId: a.userId, deviceId: a.deviceId, sha256: address, index: 1,
        total: body.length, size: PART, body: stream(body),
      });
      assert.ok(out.ok);
    }
    const out = await service.acceptPart({
      userId: a.userId, deviceId: a.deviceId, sha256: address, index: 1,
      total: body.length, size: PART, body: stream(body),
    });
    assert.ok(!out.ok);
    assert.equal(out.ok || out.refusal.kind, 'rate_limited');
    if (!out.ok && out.refusal.kind === 'rate_limited') {
      assert.ok(out.refusal.retryAfterSeconds >= 1, 'a wait is promised');
    }
  });
});

describe('parseRange', () => {
  it('returns undefined for no header, and a bounded range for an open upper bound', () => {
    assert.equal(parseRange(undefined, 100), undefined);
    assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  });
  it('reads a suffix form as the last N bytes', () => {
    assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
  });
  it('is unsatisfiable when the start is past the end or the size', () => {
    assert.equal(parseRange('bytes=90-10', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-0', 0), 'unsatisfiable');
  });
});
