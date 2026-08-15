/**
 * Device pairing: the relay, its once-only lifecycle, and what it refuses to tell.
 *
 * The seed never appears here, in the tests or in the server — `seed_envelope` is bytes the
 * relay carries. What is worth asserting is everything around it: who may approve, that
 * approving and claiming happen exactly once, and that a caller guessing at pairing ids
 * learns nothing about which ones exist.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

const cfg = loadConfig();
let db: Db;
let app: FastifyInstance;

/** An authorised device of an active account — the only thing allowed to approve. */
let access: string;
let userId: string;
/** A second account, to prove approval binds the caller's own and not one it names. */
let strangerAccess: string;

/**
 * A secret is unique per run, because `pairing_token_hash` is UNIQUE and the development
 * database keeps what earlier runs left. A literal secret passes once and then collides
 * with itself for ever, which reads as a server fault rather than a fixture.
 */
const run = randomBytes(6).toString('hex');
const secretFor = (name: string) => `${name}-${run}`;
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const pubkey = () => randomBytes(32).toString('base64');

const makeAccount = async (login: string): Promise<{ userId: string; access: string }> => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x0a0b', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
    [id, login],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'desktop', 'linux') RETURNING id`,
    [id],
  );
  return { userId: id, access: app.jwt.sign({ sub: id, device: device!.id }) };
};

/** Start a pairing the way a new device does: it makes the secret, the server sees a hash. */
const begin = async (secret: string) => {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/pairings',
    payload: { device_pubkey: pubkey(), pairing_token_hash: sha(secret) },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().pairing_id as string;
};

/** Approval carries the secret and nothing else — that is all the human moved. */
const approve = (secret: string, token = access, envelope = 'ZW52ZWxvcGU=') =>
  app.inject({
    method: 'POST',
    url: '/auth/pairings/approve',
    headers: { authorization: `Bearer ${token}` },
    payload: { pairing_secret: secret, seed_envelope: envelope },
  });

const claim = (id: string, secret: string) =>
  app.inject({
    method: 'POST',
    url: `/auth/pairings/${id}/claim`,
    payload: { pairing_secret: secret, name: 'phone', platform: 'android' },
  });

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  const owner = await makeAccount(`pair-a-${process.pid}`);
  userId = owner.userId;
  access = owner.access;
  strangerAccess = (await makeAccount(`pair-b-${process.pid}`)).access;
});

after(async () => {
  await app.close();
  await db.close();
});

describe('pairing a second device', () => {
  it('carries an opaque envelope from an authorised device to a new one', async () => {
    const secret = secretFor('a-secret-the-human-carries');
    const id = await begin(secret);

    const approved = await approve(secret);
    assert.equal(approved.statusCode, 200, approved.body);
    assert.ok(approved.json().device_pubkey, 'the approver is told what it sealed to');

    const claimed = await claim(id, secret);
    assert.equal(claimed.statusCode, 200, claimed.body);
    const out = claimed.json();

    assert.equal(out.seed_envelope, 'ZW52ZWxvcGU=', 'exactly the bytes the approver left');
    assert.equal(out.enc_privkey, Buffer.from('0a0b', 'hex').toString('base64'), 'and the account identity');
    assert.ok(out.account_salt, 'plus what the device needs to derive the KEK');
    assert.deepEqual(out.kdf_params, { v: 19, m: 65536, t: 3, p: 1 });

    // Claiming IS becoming a device: the row exists and belongs to the approving account.
    const device = await db.one<{ userId: string; name: string }>(
      `SELECT user_id AS "userId", name FROM devices WHERE id = $1`,
      [out.device_id],
    );
    assert.equal(device!.userId, userId, 'bound to the account that approved, not to a named one');
    assert.equal(device!.name, 'phone');
  });

  it('approves once and claims once', async () => {
    const secret = secretFor('once-only');
    const id = await begin(secret);

    assert.equal((await approve(secret)).statusCode, 200);
    const twice = await approve(secret);
    assert.equal(twice.statusCode, 409);
    assert.equal(twice.json().error, 'already_settled', 'a second approval cannot replace the envelope');

    assert.equal((await claim(id, secret)).statusCode, 200);
    const again = await claim(id, secret);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'already_settled', 'and a replayed claim mints no second device');

    const devices = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM device_pairings WHERE id = $1 AND claimed_device_id IS NOT NULL`,
      [id],
    );
    assert.equal(devices!.n, '1');
  });

  it('tells a claimant to wait rather than to give up', async () => {
    const secret = secretFor('not-yet');
    const id = await begin(secret);

    const early = await claim(id, secret);
    assert.equal(early.statusCode, 409);
    assert.equal(early.json().error, 'not_approved', 'the pairing is real; nobody has approved it');
  });

  it('answers a wrong secret and an unknown id the same way', async () => {
    // The id travels in a URL and can be guessed at; the secret is the credential. Two
    // different answers here would say which ids exist.
    const secret = secretFor('the-right-one');
    const id = await begin(secret);

    const wrong = await claim(id, 'the-wrong-one');
    const missing = await claim(randomUUID(), secret);

    assert.equal(wrong.statusCode, 404);
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(wrong.json(), missing.json(), 'a wrong secret is indistinguishable from no pairing');
  });

  it('refuses to approve without an authorised device behind the request', async () => {
    const secret = secretFor('needs-a-caller');
    const id = await begin(secret);

    const anonymous = await app.inject({
      method: 'POST',
      url: '/auth/pairings/approve',
      payload: { pairing_secret: secret, seed_envelope: 'ZQ==' },
    });
    assert.equal(anonymous.statusCode, 401, 'only a device that already holds the seed can seal it');
  });

  it('binds the approver’s own account, so a stranger’s approval takes the pairing to theirs', async () => {
    // Not an attack on the owner: a stranger who learns a secret can only bind the new
    // device to the STRANGER's account, which the human will notice, and never to somebody
    // else's. The account is taken from the token and never from the body.
    const secret = secretFor('whose-account');
    const id = await begin(secret);

    assert.equal((await approve(secret, strangerAccess)).statusCode, 200);
    const out = await claim(id, secret);
    assert.equal(out.statusCode, 200);

    const device = await db.one<{ userId: string }>(`SELECT user_id AS "userId" FROM devices WHERE id = $1`, [
      out.json().device_id,
    ]);
    assert.notEqual(device!.userId, userId, 'bound where the approver belongs');
  });

  it('refuses a public key that is not one, and a hash that is not one', async () => {
    const short = await app.inject({
      method: 'POST',
      url: '/auth/pairings',
      payload: { device_pubkey: Buffer.alloc(16).toString('base64'), pairing_token_hash: sha('x') },
    });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error, 'bad_device_pubkey', 'X25519 keys are 32 bytes');

    const notAHash = await app.inject({
      method: 'POST',
      url: '/auth/pairings',
      payload: { device_pubkey: pubkey(), pairing_token_hash: 'nonsense' },
    });
    assert.equal(notAHash.statusCode, 400);
    assert.equal(notAHash.json().error, 'bad_pairing_token_hash');
  });

  it('lets an expired pairing be neither approved nor claimed', async () => {
    // An expired pairing cannot be manufactured: `device_pairings_lifecycle` fires on INSERT
    // and on any UPDATE of `expires_at`, and refuses a row that is already past it. That is
    // a stronger guarantee than this test needed and the reason it costs a real second — the
    // only way to have an expired pairing is to have waited for one.
    const brief = await buildApp(db, { ...cfg, limits: { ...cfg.limits, pairingTtlSeconds: 1 } });
    const secret = secretFor('too-late');
    const started = await brief.inject({
      method: 'POST',
      url: '/auth/pairings',
      payload: { device_pubkey: pubkey(), pairing_token_hash: sha(secret) },
    });
    assert.equal(started.statusCode, 201, started.body);
    const id = started.json().pairing_id as string;
    await brief.close();

    await new Promise((r) => setTimeout(r, 1100));

    assert.equal((await approve(secret)).statusCode, 404, 'expired reads as absent');
    assert.equal((await claim(id, secret)).statusCode, 404);
  });
});
