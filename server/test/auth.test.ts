/**
 * Integration tests against a real PostgreSQL: the schema is where most of the rules live,
 * so a test with the database mocked out would be testing the mock.
 *
 * Routes are exercised through `app.inject()` — no port, no network, real handlers.
 * Requires the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { inProcessAttemptLimiter } from '../src/auth/attempts.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

const cfg = loadConfig();
let db: Db;
let app: FastifyInstance;

/**
 * The two proofs of the account redeemed below, and the shapes they are stored in.
 *
 * They are not stored alike, and the difference is the client's: `auth_secret` and
 * `kek_verifier` are values the device presents again later, so the server hashes what
 * arrives; the **recovery code** is never sent at all, so the client hashes it and sends
 * only that.
 */
const KEK_VERIFIER = 'v'.repeat(43);
const RECOVERY_CODE = 'a-code-the-client-showed-once';
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The material a client produces on the device; opaque to the server, so shape is all that matters here. */
const redeemBody = (token: string) => ({
  invitation_token: token,
  auth_secret: 'a'.repeat(43),
  account_salt: Buffer.alloc(16, 7).toString('base64'),
  kdf_params: { v: 19, m: 65536, t: 3, p: 1 },
  pubkey: Buffer.alloc(32, 1).toString('base64'),
  enc_privkey: Buffer.alloc(48, 2).toString('base64'),
  wrapped_seed: Buffer.alloc(48, 3).toString('base64'),
  kek_verifier: KEK_VERIFIER,
  recovery_key: Buffer.alloc(48, 4).toString('base64'),
  recovery_code_hash: sha256hex(RECOVERY_CODE),
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
                         kek_verifier_hash = NULL,
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

describe('recovery — the account comes back to a device that holds nothing', () => {
  // The seeded administrator redeemed at the top of this file is the account under test: it
  // has a kek_verifier and, from `redeemBody`, a recovery pair as well.
  const VERIFIER = KEK_VERIFIER;
  const CODE = RECOVERY_CODE;

  const recover = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/auth/recover', payload });

  it('returns the passphrase envelope against the KEK verifier, and a device to use it from', async () => {
    // The whole milestone in one call: no second device approves anything, and what comes
    // back is the envelope — never the seed, which the server has never held.
    const r = await recover({ login: 'admin', kek_verifier: VERIFIER, device_name: 'new laptop' });
    assert.equal(r.statusCode, 200, r.body);

    const body = r.json();
    assert.equal(body.opened_by, 'passphrase');
    assert.equal(body.seed_envelope, Buffer.alloc(48, 3).toString('base64'), 'wrapped_seed, as redeemed');
    assert.ok(body.enc_privkey, 'the account identity comes too, or shares cannot be received again');
    assert.ok(body.account_salt && body.kdf_params, 'and what the KEK was derived with');

    const device = await db.one<{ name: string }>(`SELECT name FROM devices WHERE id = $1`, [body.device_id]);
    assert.equal(device!.name, 'new laptop', 'the device exists and is bound to the account');

    const audited = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'account.recover' AND target_user_id = $1`,
      [body.user_id],
    );
    assert.equal(audited!.n, '1', 'a recovery is recorded: nobody approved it, so nothing else would show it');
  });

  it('returns the recovery-code envelope against the code, and only that one', async () => {
    // Two proofs, two envelopes, and each opens only its own. Handing back both would give
    // whoever guessed one a free second target.
    const r = await recover({ login: 'admin', recovery_code: CODE });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().opened_by, 'recovery_code');
    assert.equal(r.json().seed_envelope, Buffer.alloc(48, 4).toString('base64'), 'recovery_key, not wrapped_seed');
  });

  it('answers an unknown login exactly as it answers a wrong proof', async () => {
    // The refusal is the enumeration oracle if it differs by so much as a status (#73).
    const unknown = await recover({ login: `ghost-${randomUUID()}`, kek_verifier: VERIFIER });
    const wrong = await recover({ login: 'admin', kek_verifier: 'w'.repeat(43) });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.deepEqual(unknown.json(), wrong.json());
  });

  it('refuses a request carrying both proofs, or neither', async () => {
    // Both would let a caller test two guesses inside one lockout slot.
    const both = await recover({ login: 'admin', kek_verifier: VERIFIER, recovery_code: CODE });
    const neither = await recover({ login: 'admin' });
    assert.equal(both.statusCode, 400, both.body);
    assert.equal(neither.statusCode, 400, neither.body);
  });

  it('locks out after repeated failures, and says how long to wait', async () => {
    // The client cannot rate-limit itself, and this endpoint is the one place in the API
    // where guessing pays. Own limiter: the injected requests all come from one address, so
    // a shared one would leak this test's deliberate failures into every other.
    const solo = await buildApp(db, cfg, { attempts: inProcessAttemptLimiter() });
    const login = 'admin';
    let last = await solo.inject({ method: 'POST', url: '/auth/recover', payload: { login, kek_verifier: 'x' } });
    for (let i = 0; i < 5; i++) {
      assert.equal(last.statusCode, 401, `attempt ${i} is answered, not throttled`);
      last = await solo.inject({ method: 'POST', url: '/auth/recover', payload: { login, kek_verifier: 'x' } });
    }
    assert.equal(last.statusCode, 429, last.body);
    assert.ok(last.json().retry_after > 0, 'and the wait is stated rather than left to a retry loop');
    assert.ok(last.headers['retry-after'], 'in the header too, where a client library looks');

    // The lockout is about the attempt, not about the account: a correct proof is refused
    // just the same while it stands, which is what makes it worth having.
    const correct = await solo.inject({
      method: 'POST',
      url: '/auth/recover',
      payload: { login, kek_verifier: VERIFIER },
    });
    assert.equal(correct.statusCode, 429, 'the limiter runs before the proof is evaluated');
    await solo.close();
  });

  it('refuses an account that has no recovery code, without saying that is why', async () => {
    // Null is the honest shape for an account with no code (#112), and the refusal for one
    // must be indistinguishable from a wrong code — otherwise it reports on the account.
    await db.query(`UPDATE users SET recovery_key = NULL, recovery_code_hash = NULL WHERE login = 'admin'`);
    const none = await recover({ login: 'admin', recovery_code: CODE });
    const wrong = await recover({ login: 'admin', recovery_code: 'not the code' });
    assert.equal(none.statusCode, 401);
    assert.deepEqual(none.json(), wrong.json());

    // …and the passphrase still works, because the two answer different losses.
    const still = await recover({ login: 'admin', kek_verifier: VERIFIER });
    assert.equal(still.statusCode, 200, still.body);
  });
});
