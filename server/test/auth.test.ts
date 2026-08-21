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
import { hashPassword } from '../src/auth/password.js';

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
const redeemBody = (token: string, login = 'admin') => ({
  invitation_token: token,
  login,
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

/**
 * An invitation for a VAULT account, written straight in.
 *
 * The seeded row is a console account now (#115) and there is nothing to redeem on it, so
 * these tests need an invitation the way every real one arrives: issued by an administrator.
 * Issuing it through `/admin/invitations` is `operator.test.ts`'s subject; here it is a
 * fixture, and going through the API would test that endpoint twice and this one not at all.
 */
const seedInvitation = async (login: string, token: string): Promise<string> => {
  const row = await db.one<{ id: string }>(
    `INSERT INTO users (login, state, role, quota_bytes, invite_token_hash, invite_expires_at)
     VALUES ($1, 'provisioned', 'user', 10737418240,
             encode(sha256(convert_to($2,'UTF8')),'hex'), now() + interval '7 days')
     RETURNING id`,
    [login, token],
  );
  return row!.id;
};

/**
 * The vault account the login, refresh and recovery tests are about.
 *
 * It used to be the seeded administrator, redeemed at the top of this file. Under #115 that
 * row is a CONSOLE account — a password and no key material — so it can no longer hold an
 * `auth_secret` to present or a seed envelope to hand back. These describes are about a
 * *vault* account, so they get one, seeded directly like every other suite's fixtures:
 * issuing an invitation is `operator.test.ts`'s subject and redeeming it is tested above.
 */
const VAULT_LOGIN = 'vault-user';
const seedVaultAccount = async (): Promise<void> => {
  await db.query(
    `INSERT INTO users (login, state, role, quota_bytes, auth_secret_hash, account_salt,
                        kdf_params, pubkey, enc_privkey, wrapped_seed, kek_verifier_hash,
                        recovery_key, recovery_code_hash)
     VALUES ($1, 'active', 'user', 10737418240, $2, decode('07070707070707070707070707070707','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}',
             decode(repeat('01', 32), 'hex'), decode(repeat('02', 48), 'hex'),
             decode(repeat('03', 48), 'hex'), $3,
             decode(repeat('04', 48), 'hex'), $4)`,
    [VAULT_LOGIN, sha256hex('a'.repeat(43)), sha256hex(KEK_VERIFIER), sha256hex(RECOVERY_CODE)],
  );
  // And a device, which redeeming used to create along the way: `/auth/login` names one,
  // because a caller not attributed to a device cannot be throttled or signed out (#90).
  await db.query(
    `INSERT INTO devices (user_id, name, platform)
     SELECT id, 'laptop', 'linux' FROM users WHERE login = $1`,
    [VAULT_LOGIN],
  );
};

before(async () => {
  db = connect(cfg.databaseUrl);
  // Undo whatever an earlier run redeemed: these tests need the seeded first-run state.
  //
  // `audit_log` is deliberately NOT among them. It is append-only by trigger (#87), so
  // wiping it only worked while it happened to be empty — a `DELETE` matching no rows
  // fires no per-row trigger — and it failed the moment any other suite recorded something
  // first. A test that has to break a rule to set itself up is asserting against the rule;
  // the one assertion that needed a clean table now takes a baseline instead.
  await db.query(`DELETE FROM devices`);
  // One transaction with the constraint deferred: a vault points at its root node, so
  // removing nodes first trips `vaults_root_node_fkey` and removing vaults first trips the
  // RESTRICT from nodes. The FK is deferrable precisely so a transaction may hold both ends
  // in an inconsistent state until it commits.
  await db.query(`BEGIN; SET CONSTRAINTS ALL DEFERRED;
                  DELETE FROM nodes; DELETE FROM vaults; COMMIT;`);
  // Back to what schema.sql seeds: a console account with no password and no token (#115).
  // There is nothing to redeem on a fresh server — only a password to create.
  await db.query(`UPDATE users SET state = 'provisioned', role = 'admin', password_hash = NULL,
                         auth_secret_hash = NULL, account_salt = NULL, kdf_params = NULL,
                         pubkey = NULL, enc_privkey = NULL, wrapped_seed = NULL,
                         kek_verifier_hash = NULL,
                         recovery_key = NULL, recovery_code_hash = NULL,
                         invite_token_hash = NULL, invite_expires_at = NULL
                   WHERE id = '00000000-0000-0000-0000-000000000001'`);
  // Demoted, not deleted. What "first run" means is that no ACTIVE ADMINISTRATOR exists
  // (#107) — not that the table is empty — and deleting an active account is a procedure
  // rather than a statement (#55), so a teardown that tried it was asking the schema to
  // break its own rule on behalf of a fixture. Other suites' accounts are left alone.
  await db.query(`UPDATE users SET role = 'user'
                   WHERE state = 'active' AND id <> '00000000-0000-0000-0000-000000000001'`);
  app = await buildApp(db, cfg);
  await seedVaultAccount();
});

after(async () => {
  await app.close();
  await db.close();
});

describe('first run', () => {
  it('answers nothing but the setting of the first password', async () => {
    const blocked = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'admin', auth_secret: 'x' } });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.json().error, 'bootstrap_pending');

    const open = await app.inject({ method: 'GET', url: '/auth/kdf?login=admin' });
    assert.equal(open.statusCode, 200);
  });

  it('serves the console, because that is where the first password is set', async () => {
    // The guard is an exact-match allowlist, so this is not automatic: a fresh server would
    // otherwise answer 503 to the page carrying the only screen it has. Found by planning
    // M5 rather than by running it.
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200, page.body);
    assert.match(page.headers['content-type'] as string, /text\/html/);

    // And the API stays shut, which is the point of the guard being a list and not a prefix.
    const api = await app.inject({ method: 'GET', url: '/vaults' });
    assert.equal(api.statusCode, 503);
    assert.equal(api.json().error, 'bootstrap_pending');
  });

  it('creates the first password rather than replacing one, and only once', async () => {
    // The property a seeded default cannot have (#107): there is no value that works until
    // somebody gets round to changing it, because until this call there is no value at all.
    const seeded = await db.one<{ hash: string | null; token: string | null }>(
      `SELECT password_hash AS hash, invite_token_hash AS token FROM users
        WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    assert.equal(seeded!.hash, null, 'nothing to guess before the first run');
    assert.equal(seeded!.token, null, 'and nothing to redeem either');

    const short = await app.inject({ method: 'POST', url: '/auth/bootstrap', payload: { password: 'short' } });
    assert.equal(short.statusCode, 400, short.body);

    const set = await app.inject({
      method: 'POST', url: '/auth/bootstrap', payload: { password: 'a console password' },
    });
    assert.equal(set.statusCode, 201, set.body);
    assert.equal(set.json().login, 'admin');

    // Once only, and by construction: the statement that sets it moves the row out of the
    // state it matched on, so there is no window between checking and writing.
    const again = await app.inject({
      method: 'POST', url: '/auth/bootstrap', payload: { password: 'another password entirely' },
    });
    assert.equal(again.statusCode, 409, again.body);

    const row = await db.one<{ state: string; hash: string; keys: string | null }>(
      `SELECT state::text AS state, password_hash AS hash, pubkey::text AS keys FROM users
        WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    assert.equal(row!.state, 'active');
    assert.match(row!.hash, /^\$argon2id\$/, 'a password a person chose gets a slow hash (#108)');
    assert.equal(row!.keys, null, 'and a console account holds no key material at all (#115)');

    // The line that says the administrator was made, which nothing checked and which used to
    // be written by a second transaction of its own (#88). It commits with the password now:
    // an administrator existing with no record of its creation is the weakest the log can be,
    // on the single account whose creation is the most interesting entry it will ever hold.
    const logged = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'account.bootstrap'`,
    );
    assert.equal(logged!.n, '1', 'exactly one — the refused second attempt records nothing');
  });

  it('lets the first run NAME the administrator, and defaults it when nobody does (#123)', async () => {
    // The seeded login was `admin` on every installation ever deployed — written in the
    // schema, repeated in the docs, and rate-limited against by name. Half a credential,
    // given away. It stays the default because most operators will take it; what changed is
    // that it can be something else.
    // Putting the seeded row back to `provisioned` needs a stand-in first: the schema refuses
    // to leave the server with no active administrator, and it is right to — that guardrail is
    // the reason `deleteAccount` cannot strand an installation either. So a second admin holds
    // the post while the first one is re-run.
    const stand = await db.one<{ id: string }>(
      `INSERT INTO users (login, role, state, quota_bytes, password_hash)
       VALUES ('standin', 'admin', 'active', 0, '$argon2id$test') RETURNING id`,
    );
    await db.query(
      `UPDATE users SET state = 'provisioned', password_hash = NULL, login = 'admin'
        WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );

    const named = await app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      payload: { login: 'oleh.admin', password: 'a console password' },
    });
    assert.equal(named.statusCode, 201, named.body);
    assert.equal(named.json().login, 'oleh.admin', 'the name it was given, not the seeded one');

    const row = await db.one<{ login: string; state: string }>(
      `SELECT login, state::text AS state FROM users WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    assert.equal(row!.login, 'oleh.admin');
    assert.equal(row!.state, 'active', 'and it is still what brings the account to life');

    // Put the file back as the next test expects it, stand-in included.
    await db.query(`UPDATE users SET login = 'admin' WHERE id = '00000000-0000-0000-0000-000000000001'`);
    // Through `deleting`, because the schema refuses to remove an account that never entered
    // it — the same rule that makes deletion a procedure rather than a DELETE (#55).
    await db.query(`UPDATE users SET state = 'deleting' WHERE id = $1`, [stand!.id]);
    await db.query(`DELETE FROM users WHERE id = $1`, [stand!.id]);
  });

  it('refuses a login shaped like something else, before it reaches the database', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      payload: { login: 'has a space', password: 'a console password' },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'login_invalid');
  });

  it('signs the administrator in to the console on ONE device row, however often', async () => {
    // A device row exists so a session can be revoked one at a time (#90) — it stands for
    // something somebody installed. A browser is not that: it signs in, closes, signs in
    // again, and a row per sign-in is a list of devices nobody owns that grows for ever.
    const signIn = () =>
      app.inject({
        method: 'POST',
        url: '/auth/console',
        payload: { login: 'admin', password: 'a console password' },
      });

    const first = await signIn();
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(first.json().access && first.json().refresh);

    const second = await signIn();
    assert.equal(second.statusCode, 200, second.body);

    const rows = await db.query<{ id: string }>(
      `SELECT id FROM devices
        WHERE user_id = '00000000-0000-0000-0000-000000000001' AND revoked_at IS NULL`,
    );
    assert.equal(rows.length, 1, 'the second sign-in reused the first one’s device');

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/console',
      payload: { login: 'admin', password: 'not the password' },
    });
    assert.equal(wrong.statusCode, 401, wrong.body);
  });

  it('refuses a valid invitation claimed under the wrong name, and says which name it is', async () => {
    // The account's name belongs to the invitation, so redeeming cannot choose it — but the
    // client binds `kek_verifier` to the name it was given and writes that name into its
    // connection record, both before it could learn the real one. A live walk found what a
    // silent mismatch produces: a device that syncs until its first relock and then cannot
    // log in, with a recovery proof bound to a name nobody has.
    //
    // Named, unlike "no such token" — that one stays a single answer for three cases so it
    // cannot become an oracle. This is somebody holding a valid invitation who mistyped the
    // name on it, and telling them gives away nothing they were not just handed.
    await seedInvitation('invited-one', 'tok-mismatch');
    const wrong = await app.inject({
      method: 'POST', url: '/auth/redeem', payload: redeemBody('tok-mismatch', 'oleg'),
    });
    assert.equal(wrong.statusCode, 409, wrong.body);
    assert.equal(wrong.json().error, 'login_mismatch');
    assert.match(wrong.json().detail, /"invited-one"/);

    // And the invitation is untouched: a typo must not spend a single-use token. Asserted
    // against the row rather than by redeeming, which would spend it here instead.
    const row = await db.one<{ state: string; token: string | null }>(
      `SELECT state::text AS state, invite_token_hash AS token FROM users
        WHERE login = 'invited-one'`,
    );
    assert.equal(row!.state, 'provisioned');
    assert.ok(row!.token, 'the invitation is still there to be claimed correctly');
  });

  it('redeems an invitation, and that token stops working afterwards', async () => {
    await seedInvitation('invited-two', 'tok-once');
    const first = await app.inject({
      method: 'POST', url: '/auth/redeem', payload: redeemBody('tok-once', 'invited-two'),
    });
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json();
    assert.ok(body.access && body.refresh && body.device_id && body.vault_id && body.root_node_id);

    // Single use by construction: this is what makes a default credential acceptable.
    const again = await app.inject({
      method: 'POST', url: '/auth/redeem', payload: redeemBody('tok-once', 'invited-two'),
    });
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
    const account = await db.one<{ id: string }>(`SELECT id FROM users WHERE login = $1`, [VAULT_LOGIN]);
    const device = await db.one<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [account!.id]);

    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh: ok.json().refresh } });
    assert.equal(refreshed.statusCode, 200);
    assert.ok(refreshed.json().access);
  });

  it('refuses a refresh token that has been superseded', async () => {
    const account = await db.one<{ id: string }>(`SELECT id FROM users WHERE login = $1`, [VAULT_LOGIN]);
    const device = await db.one<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1`, [account!.id]);
    const payload = { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id };

    const first = (await app.inject({ method: 'POST', url: '/auth/login', payload })).json().refresh;
    await app.inject({ method: 'POST', url: '/auth/login', payload });

    const stale = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh: first } });
    assert.equal(stale.statusCode, 401, 'one refresh token per device (#90) means the old one is dead');
  });

  it('gives the same answer for an unknown login and a wrong secret', async () => {
    const unknown = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: 'ghost', auth_secret: 'x', device_id: randomUUID() } });
    const wrong = await app.inject({ method: 'POST', url: '/auth/login', payload: { login: VAULT_LOGIN, auth_secret: 'x', device_id: randomUUID() } });
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

  /** Where the append-only log stood before this suite ran, so a count can be a delta. */
  let auditHighWater = '0';
  before(async () => {
    const top = await db.one<{ id: string }>(`SELECT COALESCE(max(id), 0)::text AS id FROM audit_log`);
    auditHighWater = top!.id;
  });

  it('returns the passphrase envelope against the KEK verifier, and a device to use it from', async () => {
    // The whole milestone in one call: no second device approves anything, and what comes
    // back is the envelope — never the seed, which the server has never held.
    const r = await recover({ login: VAULT_LOGIN, kek_verifier: VERIFIER, device_name: 'new laptop' });
    assert.equal(r.statusCode, 200, r.body);

    const body = r.json();
    assert.equal(body.opened_by, 'passphrase');
    assert.equal(body.seed_envelope, Buffer.alloc(48, 3).toString('base64'), 'wrapped_seed, as redeemed');
    assert.ok(body.enc_privkey, 'the account identity comes too, or shares cannot be received again');
    assert.ok(body.account_salt && body.kdf_params, 'and what the KEK was derived with');

    const device = await db.one<{ name: string }>(`SELECT name FROM devices WHERE id = $1`, [body.device_id]);
    assert.equal(device!.name, 'new laptop', 'the device exists and is bound to the account');

    const audited = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE action = 'account.recover' AND target_user_id = $1 AND id > $2`,
      [body.user_id, auditHighWater],
    );
    assert.equal(audited!.n, '1', 'a recovery is recorded: nobody approved it, so nothing else would show it');
  });

  it('returns the recovery-code envelope against the code, and only that one', async () => {
    // Two proofs, two envelopes, and each opens only its own. Handing back both would give
    // whoever guessed one a free second target.
    const r = await recover({ login: VAULT_LOGIN, recovery_code: CODE });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().opened_by, 'recovery_code');
    assert.equal(r.json().seed_envelope, Buffer.alloc(48, 4).toString('base64'), 'recovery_key, not wrapped_seed');
  });

  it('answers an unknown login exactly as it answers a wrong proof', async () => {
    // The refusal is the enumeration oracle if it differs by so much as a status (#73).
    const unknown = await recover({ login: `ghost-${randomUUID()}`, kek_verifier: VERIFIER });
    const wrong = await recover({ login: VAULT_LOGIN, kek_verifier: 'w'.repeat(43) });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.statusCode, wrong.statusCode);
    assert.deepEqual(unknown.json(), wrong.json());
  });

  it('refuses a request carrying both proofs, or neither', async () => {
    // Both would let a caller test two guesses inside one lockout slot.
    const both = await recover({ login: VAULT_LOGIN, kek_verifier: VERIFIER, recovery_code: CODE });
    const neither = await recover({ login: VAULT_LOGIN });
    assert.equal(both.statusCode, 400, both.body);
    assert.equal(neither.statusCode, 400, neither.body);
  });

  it('locks out after repeated failures, and says how long to wait', async () => {
    // The client cannot rate-limit itself, and this endpoint is the one place in the API
    // where guessing pays. Own limiter: the injected requests all come from one address, so
    // a shared one would leak this test's deliberate failures into every other.
    const solo = await buildApp(db, cfg, { attempts: inProcessAttemptLimiter() });
    const login = VAULT_LOGIN;
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

  it('lets an account made before recovery existed file a verifier on its first unlock', async () => {
    // The live server had accounts predating the column, and nothing on the server can make
    // a verifier for them: it takes the KEK, which exists only on a client holding the
    // phrase. Without this they would be unrecoverable forever, and silently so.
    // The state is not expressible under the current schema, and that is the point: a live
    // account can only be missing a verifier if its database predates the column. So the
    // test reproduces the migration rather than faking the row — drop the constraint, empty
    // the column, re-add it NOT VALID, which is exactly what the deployed database carries.
    const def = await db.one<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'keys_match_state' AND conrelid = 'users'::regclass`,
    );
    await db.query(`ALTER TABLE users DROP CONSTRAINT keys_match_state`);
    await db.query(`UPDATE users SET kek_verifier_hash = NULL WHERE login = $1`, [VAULT_LOGIN]);
    await db.query(`ALTER TABLE users ADD CONSTRAINT keys_match_state ${def!.def} NOT VALID`);

    const account = await db.one<{ id: string }>(`SELECT id FROM users WHERE login = $1`, [VAULT_LOGIN]);
    const device = await db.one<{ id: string }>(`SELECT id FROM devices WHERE user_id = $1 LIMIT 1`, [account!.id]);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().needs_kek_verifier, true, 'the account says what it is missing');

    // Refused until it is filed, which is the state that made this test necessary.
    assert.equal((await recover({ login: VAULT_LOGIN, kek_verifier: VERIFIER })).statusCode, 401);

    const filed = await app.inject({
      method: 'PUT',
      url: '/auth/kek-verifier',
      headers: { authorization: `Bearer ${login.json().access}` },
      payload: { kek_verifier: VERIFIER },
    });
    assert.equal(filed.statusCode, 204, filed.body);

    const after = await recover({ login: VAULT_LOGIN, kek_verifier: VERIFIER });
    assert.equal(after.statusCode, 200, 'and now the account can be taken back');
    assert.equal(
      (await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
      })).json().needs_kek_verifier,
      false,
      'and stops asking',
    );
  });

  it('refuses an account that has no recovery code, without saying that is why', async () => {
    // Null is the honest shape for an account with no code (#112), and the refusal for one
    // must be indistinguishable from a wrong code — otherwise it reports on the account.
    await db.query(`UPDATE users SET recovery_key = NULL, recovery_code_hash = NULL WHERE login = $1`, [VAULT_LOGIN]);
    const none = await recover({ login: VAULT_LOGIN, recovery_code: CODE });
    const wrong = await recover({ login: VAULT_LOGIN, recovery_code: 'not the code' });
    assert.equal(none.statusCode, 401);
    assert.deepEqual(none.json(), wrong.json());

    // …and the passphrase still works, because the two answer different losses.
    const still = await recover({ login: VAULT_LOGIN, kek_verifier: VERIFIER });
    assert.equal(still.statusCode, 200, still.body);
  });
});

/**
 * Giving an account a recovery code, and replacing it (M7).
 *
 * The redeem path could already carry the pair, and `/auth/recover` could already take a code
 * as its second proof — both since M3.5. What did not exist was any way to acquire one
 * afterwards, which is the only way this product offers it: an action in the settings, not a
 * step of registration (docs/06). Without these endpoints, an account created without a code
 * could never get one, and one whose code was lost could never replace it.
 */
describe('the recovery code an account can be given later', () => {
  const CODE = 'the-code-a-person-writes-down';
  const OTHER = 'a-second-code-issued-later';
  const envelope = Buffer.alloc(48, 5).toString('base64');

  const signIn = async (): Promise<string> => {
    const device = await db.one<{ id: string }>(
      `SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE u.login = $1 LIMIT 1`,
      [VAULT_LOGIN],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().access;
  };

  const put = async (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/auth/recovery-code',
      headers: { authorization: `Bearer ${await signIn()}` },
      payload,
    });

  const recover = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/auth/recover', payload });

  it('files a code on an account that has none, and that code then opens it', async () => {
    await db.query(`UPDATE users SET recovery_key = NULL, recovery_code_hash = NULL WHERE login = $1`, [VAULT_LOGIN]);

    const set = await put({ recovery_key: envelope, recovery_code_hash: sha256hex(CODE) });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().replaced, false, 'there was nothing to replace');

    const back = await recover({ login: VAULT_LOGIN, recovery_code: CODE });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().seed_envelope, envelope, 'the envelope it filed is the envelope it gets back');
  });

  it('replacing invalidates the previous code, which is the point of replacing', async () => {
    // The whole risk this feature carries is a slip of paper from three years ago that still
    // opens the account. There is deliberately no way to hold two.
    await put({ recovery_key: envelope, recovery_code_hash: sha256hex(CODE) });
    const again = await put({ recovery_key: envelope, recovery_code_hash: sha256hex(OTHER) });
    assert.equal(again.json().replaced, true, 'and it says so, which the client cannot know on its own');

    assert.equal((await recover({ login: VAULT_LOGIN, recovery_code: CODE })).statusCode, 401);
    assert.equal((await recover({ login: VAULT_LOGIN, recovery_code: OTHER })).statusCode, 200);
  });

  it('says whether there is one, and never what it is', async () => {
    // A code the server could show again would be a code the server could use. It is stored
    // as a hash precisely so that it cannot.
    await db.query(`UPDATE users SET recovery_key = NULL, recovery_code_hash = NULL WHERE login = $1`, [VAULT_LOGIN]);
    const access = await signIn();
    const ask = () =>
      app.inject({ method: 'GET', url: '/auth/recovery-code', headers: { authorization: `Bearer ${access}` } });

    assert.deepEqual((await ask()).json(), { present: false });
    await put({ recovery_key: envelope, recovery_code_hash: sha256hex(CODE) });
    assert.deepEqual((await ask()).json(), { present: true }, 'a boolean, and nothing else');
  });

  it('refuses half a pair rather than letting the schema catch it', async () => {
    // `recovery_code_is_whole` would refuse it anyway, from inside a transaction. A client
    // that sent one field should hear a bad request, not a constraint violation.
    assert.equal((await put({ recovery_key: envelope })).statusCode, 400);
    assert.equal((await put({ recovery_code_hash: sha256hex(CODE) })).statusCode, 400);
  });

  it('refuses a hash that is not one — the only check it can make on material it cannot read', async () => {
    // The envelope is opaque by design. The hash has a shape, and a client sending the wrong
    // encoding would store a verifier no correct code will ever match — found out years
    // later, by somebody who did everything right.
    const bad = await put({ recovery_key: envelope, recovery_code_hash: 'not a sha-256' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'recovery_code_hash_invalid');
    assert.equal(
      (await put({ recovery_key: envelope, recovery_code_hash: sha256hex(CODE).toUpperCase() })).statusCode,
      400,
      'and the encoding is part of the contract (#108), so upper-case hex is not it',
    );
  });

  it('takes nothing from a caller who is not signed in', async () => {
    const anon = await app.inject({
      method: 'PUT',
      url: '/auth/recovery-code',
      payload: { recovery_key: envelope, recovery_code_hash: sha256hex(CODE) },
    });
    assert.equal(anon.statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/recovery-code' })).statusCode, 401);
  });

  it('records the change, saying only that it happened', async () => {
    // It changes what can open the account, which is the class of event this log exists for.
    // Not the code, obviously — and not the hash either: that is a verifier, and a log is
    // read by more people than a users table.
    const before = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'account.recovery_code'`,
    );
    await put({ recovery_key: envelope, recovery_code_hash: sha256hex(CODE) });
    const row = await db.one<{ details: { replaced: boolean }; actor: string; target: string }>(
      `SELECT details, actor_login AS actor, target_login AS target FROM audit_log
        WHERE action = 'account.recovery_code' ORDER BY at DESC LIMIT 1`,
    );
    const after = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'account.recovery_code'`,
    );

    assert.equal(Number(after!.n), Number(before!.n) + 1);
    assert.equal(row!.actor, VAULT_LOGIN, 'the account acting on itself is both actor and target');
    assert.equal(row!.target, VAULT_LOGIN);
    assert.deepEqual(Object.keys(row!.details), ['replaced']);
  });
});

/**
 * Putting the account behind a different passphrase (#34).
 *
 * Built because recovery by code has nowhere to land without it: somebody who recovered with a
 * code has no passphrase, and an account left under the forgotten one would be openable by its
 * code and nothing else, for ever.
 */
describe('the passphrase an account can be given again', () => {
  const envelope = Buffer.alloc(48, 8).toString('base64');
  const VERIFIER = 'n'.repeat(43);

  const signIn = async (): Promise<string> => {
    const device = await db.one<{ id: string }>(
      `SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE u.login = $1 LIMIT 1`,
      [VAULT_LOGIN],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().access;
  };

  const put = async (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/auth/passphrase',
      headers: { authorization: `Bearer ${await signIn()}` },
      payload,
    });

  it('moves the envelope and the verifier together, so recovery answers the new one', async () => {
    // The pair is the whole point. Written apart, the endpoint would hand back an envelope
    // that the proof it just accepted cannot open — a state no constraint can catch, because
    // each column on its own is valid.
    assert.equal((await put({ wrapped_seed: envelope, kek_verifier: VERIFIER })).statusCode, 204);

    const back = await app.inject({
      method: 'POST',
      url: '/auth/recover',
      payload: { login: VAULT_LOGIN, kek_verifier: VERIFIER },
    });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().seed_envelope, envelope);

    // And the old proof is done, which is what makes this a change rather than a second key.
    const old = await app.inject({
      method: 'POST',
      url: '/auth/recover',
      payload: { login: VAULT_LOGIN, kek_verifier: KEK_VERIFIER },
    });
    assert.equal(old.statusCode, 401);
  });

  it('leaves account_salt alone, because the recovery code is derived through it', async () => {
    // Rolling the salt would be ordinary hygiene and here it is a trap: it is an input to the
    // code's KDF (M7), so a new salt silently turns a written-down code into a string that
    // opens nothing — and the client cannot re-wrap that envelope, having no code.
    const before = await db.one<{ salt: string }>(
      `SELECT encode(account_salt, 'hex') AS salt FROM users WHERE login = $1`,
      [VAULT_LOGIN],
    );
    await put({ wrapped_seed: envelope, kek_verifier: VERIFIER });
    const after = await db.one<{ salt: string }>(
      `SELECT encode(account_salt, 'hex') AS salt FROM users WHERE login = $1`,
      [VAULT_LOGIN],
    );
    assert.equal(after!.salt, before!.salt);
  });

  it('refuses half a pair', async () => {
    assert.equal((await put({ wrapped_seed: envelope })).statusCode, 400);
    assert.equal((await put({ kek_verifier: VERIFIER })).statusCode, 400);
  });

  it('takes nothing from a caller who is not signed in', async () => {
    const anon = await app.inject({
      method: 'PUT',
      url: '/auth/passphrase',
      payload: { wrapped_seed: envelope, kek_verifier: VERIFIER },
    });
    assert.equal(anon.statusCode, 401);
  });

  it('records it, because it changes what opens the account', async () => {
    await put({ wrapped_seed: envelope, kek_verifier: VERIFIER });
    const row = await db.one<{ actor: string; target: string }>(
      `SELECT actor_login AS actor, target_login AS target FROM audit_log
        WHERE action = 'account.passphrase' ORDER BY at DESC LIMIT 1`,
    );
    assert.equal(row!.actor, VAULT_LOGIN);
    assert.equal(row!.target, VAULT_LOGIN);
  });
});

/**
 * Changing a console password (#137).
 *
 * There was no way to do it at all: `/auth/bootstrap` creates the first password and refuses
 * once one exists, and nothing else wrote `password_hash`. An administrator whose password had
 * been shared to get somebody started had an `UPDATE` by hand as their only option.
 */
describe('a console administrator changing their password', () => {
  const FIRST = 'the first password';
  const SECOND = 'the second password';
  /**
   * The account the schema seeds, put back into the state a bootstrapped server leaves it in.
   *
   * NOT a console account of its own, and the first attempt at one taught why: an active
   * administrator cannot be deleted — deletion is a procedure, not a statement (#55) — and the
   * schema separately refuses to leave the server with no active administrator. So a fixture
   * that created one left it behind, and the NEXT run's `before` hook, which demotes every
   * active administrator but this row, was refused by that guard: `23001, refusing to remove
   * the last active administrator`, before a single test of this file ran.
   *
   * This row is the one `before` already normalises on every run, so borrowing it leaves
   * nothing behind for the next.
   */
  const SEEDED = '00000000-0000-0000-0000-000000000001';
  let login = 'admin';

  const seedConsole = async (password: string): Promise<void> => {
    const row = await db.one<{ login: string }>(
      `UPDATE users SET state = 'active', role = 'admin', password_hash = $2 WHERE id = $1
       RETURNING login`,
      [SEEDED, hashPassword(password)],
    );
    login = row!.login;
    // Any console session from an earlier test in this describe is not this test's session.
    await db.query(`UPDATE devices SET refresh_token_hash = NULL WHERE user_id = $1`, [SEEDED]);
  };

  const signIn = async (password: string) =>
    app.inject({ method: 'POST', url: '/auth/console', payload: { login, password } });

  const change = async (access: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PUT',
      url: '/auth/password',
      headers: { authorization: `Bearer ${access}` },
      payload: body,
    });

  it('replaces the password, and the new one is the one that works', async () => {
    await seedConsole(FIRST);
    const session = await signIn(FIRST);
    assert.equal(session.statusCode, 200, session.body);

    assert.equal((await change(session.json().access, { current: FIRST, password: SECOND })).statusCode, 204);

    assert.equal((await signIn(SECOND)).statusCode, 200, 'the new password signs in');
    assert.equal((await signIn(FIRST)).statusCode, 401, 'and the old one does not');
  });

  it('demands the current password, although the caller is already authenticated', async () => {
    // The token proves the session; the password proves the person. A browser somebody walked
    // away from must not be enough to lock the owner out of their own console.
    await seedConsole(FIRST);
    const access = (await signIn(FIRST)).json().access;

    assert.equal((await change(access, { password: SECOND })).statusCode, 400);
    assert.equal((await change(access, { current: 'not it', password: SECOND })).statusCode, 401);
    assert.equal((await signIn(FIRST)).statusCode, 200, 'and nothing changed');
  });

  it('ends the session, so a leaked one cannot outlive the password', async () => {
    // There is one console device per account, shared by every browser that signs in. Leaving
    // its refresh token alive would let whoever else holds it stay signed in indefinitely —
    // which is the case a password gets changed for.
    await seedConsole(FIRST);
    const session = await signIn(FIRST);
    const refresh = session.json().refresh;

    await change(session.json().access, { current: FIRST, password: SECOND });

    const renewed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refresh } });
    assert.equal(renewed.statusCode, 401, 'the refresh token is done');

    // And the device row is still there, not revoked: it must be made to prove itself again,
    // not retired — a revoked row would have the next sign-in mint a second one.
    const devices = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM devices
        WHERE user_id = $1 AND platform = 'console' AND revoked_at IS NULL`,
      [SEEDED],
    );
    assert.equal(devices!.n, '1');
    assert.equal((await signIn(SECOND)).statusCode, 200);
  });

  it('holds the same floor the first password had', async () => {
    await seedConsole(FIRST);
    const access = (await signIn(FIRST)).json().access;
    // Eleven characters, counted rather than eyeballed: the first attempt at this line used a
    // twelve-character string that reads like eleven, and the test failed the code for being
    // right.
    const eleven = 'elevenchars';
    assert.equal(eleven.length, 11);
    const short = await change(access, { current: FIRST, password: eleven });
    assert.equal(short.statusCode, 400);
    assert.equal(short.json().error, 'password_too_short');
  });

  it('refuses an account that has no password to change', async () => {
    // A vault account is not a console account. The endpoint is right, so this is a 409 and
    // not a 404 — the same distinction /auth/bootstrap makes once the first run is over.
    const device = await db.one<{ id: string }>(
      `SELECT d.id FROM devices d JOIN users u ON u.id = d.user_id WHERE u.login = $1 LIMIT 1`,
      [VAULT_LOGIN],
    );
    const vault = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { login: VAULT_LOGIN, auth_secret: 'a'.repeat(43), device_id: device!.id },
    });
    const out = await change(vault.json().access, { current: 'anything', password: 'a long enough one' });
    assert.equal(out.statusCode, 409);
  });

  it('takes nothing from a caller who is not signed in', async () => {
    const anon = await app.inject({
      method: 'PUT',
      url: '/auth/password',
      payload: { current: FIRST, password: SECOND },
    });
    assert.equal(anon.statusCode, 401);
  });

  it('records it, because it changes what opens the console', async () => {
    await seedConsole(FIRST);
    const access = (await signIn(FIRST)).json().access;
    await change(access, { current: FIRST, password: SECOND });
    const row = await db.one<{ actor: string }>(
      `SELECT actor_login AS actor FROM audit_log WHERE action = 'account.password' ORDER BY at DESC LIMIT 1`,
    );
    assert.equal(row!.actor, login);
  });
});
