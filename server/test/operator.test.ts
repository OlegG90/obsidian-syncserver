/**
 * The operator's surface: what an administrator may do to somebody else's account, and the
 * record every one of those acts leaves behind.
 *
 * **Named to sort after `auth.test.ts`, and that is load-bearing.** This suite claims the
 * seeded administrator, and claiming is irreversible by design: the last active one cannot
 * be demoted or disabled (D-88), and deleting an account is a procedure rather than a
 * statement (D-55). So there is no route back to "no administrator exists" — the first-run
 * state `auth.test.ts` is entirely about — and a file that reaches it first takes that
 * scenario away from everyone. Alphabetical order is the whole mechanism; see AGENTS.md.
 *
 * The theme is that **nothing here is a convenience**. The guard reads the database rather
 * than the token because a role can be taken away between minting one and using it; the
 * audit row is asserted beside the effect in every test, because an action that leaves no
 * record is the kind this log was built to refuse; and the two refusals that matter — the
 * last administrator, and lowering a quota — are about not being able to break the server
 * from inside its own console.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { testStore } from './support/store.js';

const STORE = testStore('admin');
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
/** The operator, and an ordinary account for them to act on. */
let adminToken: string;
let adminId: string;
let userToken: string;
let userId: string;

/**
 * An account of either kind (D-115).
 *
 * A **console** account carries a password and not one byte of key material; a **vault**
 * account is the mirror. They are different shapes rather than one shape with a flag, and
 * `keys_match_state` refuses the mixture — so a fixture that wrote keys onto an administrator
 * would be asking the schema to allow the thing this milestone exists to forbid.
 */
const makeAccount = async (login: string, role: 'user' | 'admin'): Promise<{ id: string; token: string }> => {
  const id = randomUUID();
  if (role === 'admin') {
    await db.query(
      `INSERT INTO users (id, login, state, role, password_hash, quota_bytes)
       VALUES ($1, $2, 'active', 'admin', '$argon2id$test', 0)`,
      [id, login],
    );
  } else {
    await db.query(
      `INSERT INTO users (id, login, state, role, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'user', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 104857600)`,
      [id, login],
    );
  }
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [id]);
  return { id, token: app.jwt.sign({ sub: id, device: device!.id }) };
};

const asAdmin = () => ({ authorization: `Bearer ${adminToken}` });
const asUser = () => ({ authorization: `Bearer ${userToken}` });

/** The newest audit row about this account, which every test asserts beside the effect. */
const lastAudit = (target: string) =>
  db.one<{ action: string; actorLogin: string; details: Record<string, unknown> }>(
    `SELECT action, actor_login AS "actorLogin", details FROM audit_log
      WHERE target_user_id = $1 ORDER BY id DESC LIMIT 1`,
    [target],
  );

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);

  // Claim the seeded administrator so this file stands on its own: until one exists the API
  // answers 503 to everything but its redemption (D-107).
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  // The operator is the SEEDED administrator rather than a second one this file invents.
  // "First run" means no active administrator exists (D-107), and once one does the schema
  // refuses every route back — demoting the last is refused (D-88) and deleting an active
  // account is a procedure (D-55). A suite that left an extra administrator behind would
  // therefore make first-run unreachable for whoever runs next, permanently.
  adminId = '00000000-0000-0000-0000-000000000001';
  const seededDevice = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [adminId]);
  adminToken = app.jwt.sign({ sub: adminId, device: seededDevice!.id });
  const user = await makeAccount(`subject-${process.pid}`, 'user');
  userId = user.id;
  userToken = user.token;
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('who may act on somebody else', () => {
  it('refuses an ordinary account, and says which of the two reasons it was', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/accounts', headers: asUser() });
    assert.equal(r.statusCode, 403);
    assert.match(r.json().detail, /not an administrator/);
  });

  it('refuses a token with no account behind it', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/accounts' });
    assert.equal(r.statusCode, 401);
  });

  it('reads the account from the database, not from the token', async () => {
    // The whole reason this guard costs a query. A demotion an hour ago has to be a
    // demotion now, and an access token minted before it says nothing about that.
    const demoted = await makeAccount(`switched-off-${randomUUID()}`, 'admin');
    assert.equal(
      (await app.inject({ method: 'GET', url: '/admin/accounts', headers: { authorization: `Bearer ${demoted.token}` } }))
        .statusCode,
      200,
    );

    // Switched off rather than demoted: an administrator IS a console account (D-115), so
    // there is no "same row, lesser role" to move it to — it holds no key material to be a
    // vault account with. The guard's rule is the same either way, and it is the rule this
    // test is about: the answer comes from the database, not from the token.
    await db.query(`UPDATE users SET state = 'disabled' WHERE id = $1`, [demoted.id]);
    const after = await app.inject({
      method: 'GET', url: '/admin/accounts', headers: { authorization: `Bearer ${demoted.token}` },
    });
    assert.equal(after.statusCode, 403, 'the same token, and now it is not enough');
  });
});

describe('invitations', () => {
  it('creates one, hands back the token once, and stores only its hash', async () => {
    const login = `invited-${randomUUID()}`;
    const r = await app.inject({
      method: 'POST', url: '/admin/invitations', headers: asAdmin(),
      payload: { login, quota_bytes: '1048576' },
    });
    assert.equal(r.statusCode, 201, r.body);
    const { user_id: id, token } = r.json();
    assert.ok(token, 'the plaintext comes back exactly here');

    const row = await db.one<{ state: string; hash: string }>(
      `SELECT state::text AS state, invite_token_hash AS hash FROM users WHERE id = $1`, [id]);
    assert.equal(row!.state, 'provisioned', 'an account is an unclaimed invitation until it is redeemed');
    assert.notEqual(row!.hash, token, 'and a database dump does not hand somebody an account');

    const audited = await lastAudit(id);
    assert.equal(audited!.action, 'account.invite');
    assert.equal(audited!.details.quota_bytes, '1048576');
  });

  it('reissuing invalidates what came before', async () => {
    // The usual reason to want a new token is that the old one went to the wrong person, so
    // one that quietly kept working would answer the opposite of what was asked.
    const login = `reissued-${randomUUID()}`;
    const first = await app.inject({
      method: 'POST', url: '/admin/invitations', headers: asAdmin(),
      payload: { login, quota_bytes: '1048576' },
    });
    const id = first.json().user_id as string;
    const before = await db.one<{ hash: string }>(`SELECT invite_token_hash AS hash FROM users WHERE id = $1`, [id]);

    const again = await app.inject({
      method: 'POST', url: `/admin/invitations/${id}/reissue`, headers: asAdmin(), payload: {},
    });
    assert.equal(again.statusCode, 200, again.body);
    const after = await db.one<{ hash: string }>(`SELECT invite_token_hash AS hash FROM users WHERE id = $1`, [id]);
    assert.notEqual(after!.hash, before!.hash, 'the old token no longer opens anything');
    assert.equal((await lastAudit(id))!.action, 'invitation.reissue');
  });

  it('revoking removes the row, because the row is the invitation', async () => {
    const first = await app.inject({
      method: 'POST', url: '/admin/invitations', headers: asAdmin(),
      payload: { login: `withdrawn-${randomUUID()}`, quota_bytes: '1048576' },
    });
    const id = first.json().user_id as string;

    assert.equal(
      (await app.inject({ method: 'DELETE', url: `/admin/invitations/${id}`, headers: asAdmin() })).statusCode,
      204,
    );
    assert.equal(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [id]), undefined);
    // The record outlives the row it names — which is why it carries no foreign key (D-93).
    assert.equal((await lastAudit(id))!.action, 'invitation.revoke');
  });

  it('refuses to revoke an account somebody actually redeemed', async () => {
    const r = await app.inject({ method: 'DELETE', url: `/admin/invitations/${userId}`, headers: asAdmin() });
    assert.equal(r.statusCode, 404, 'this is not an invitation any more; deleting an account is a procedure');
  });
});

describe('disabling', () => {
  it('revokes the sessions and switches the account off, in that order', async () => {
    // The order is not cosmetic: a disabled account may not own or write devices, so a
    // revocation attempted afterwards is refused by the very state it accompanies.
    const victim = await makeAccount(`switched-${randomUUID()}`, 'user');
    const r = await app.inject({
      method: 'POST', url: `/admin/accounts/${victim.id}/enabled`, headers: asAdmin(), payload: { enabled: false },
    });
    assert.equal(r.statusCode, 204, r.body);

    const row = await db.one<{ state: string; live: string }>(
      `SELECT u.state::text AS state,
              (SELECT count(*)::text FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS live
         FROM users u WHERE u.id = $1`,
      [victim.id],
    );
    assert.equal(row!.state, 'disabled');
    assert.equal(row!.live, '0', 'and nothing is still signed in');
    assert.equal((await lastAudit(victim.id))!.action, 'account.disable');
  });

  it('enabling does not sign anybody back in', async () => {
    const victim = await makeAccount(`returning-${randomUUID()}`, 'user');
    await app.inject({
      method: 'POST', url: `/admin/accounts/${victim.id}/enabled`, headers: asAdmin(), payload: { enabled: false },
    });
    const back = await app.inject({
      method: 'POST', url: `/admin/accounts/${victim.id}/enabled`, headers: asAdmin(), payload: { enabled: true },
    });
    assert.equal(back.statusCode, 204, back.body);

    const row = await db.one<{ state: string; live: string }>(
      `SELECT u.state::text AS state,
              (SELECT count(*)::text FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS live
         FROM users u WHERE u.id = $1`,
      [victim.id],
    );
    assert.equal(row!.state, 'active');
    assert.equal(row!.live, '0', 'switched off means signed out; coming back means signing in');
  });

  it('will not switch off the last administrator, whoever asks', async () => {
    // Enforced by a trigger rather than by this module (D-88), because locking yourself out
    // of your own server is otherwise one keystroke — and the refusal has to reach the
    // caller as something they can act on rather than as a 500.
    const r = await app.inject({
      method: 'POST', url: `/admin/accounts/${adminId}/enabled`, headers: asAdmin(), payload: { enabled: false },
    });
    assert.ok(r.statusCode >= 400 && r.statusCode < 500, `expected a refusal, got ${r.statusCode}: ${r.body}`);

    const still = await db.one<{ state: string }>(`SELECT state::text AS state FROM users WHERE id = $1`, [adminId]);
    assert.equal(still!.state, 'active', 'and the server still has somebody who can run it');
  });
});

describe('quotas', () => {
  it('records the change, and says what the next write will find', async () => {
    const r = await app.inject({
      method: 'PUT', url: `/admin/accounts/${userId}/quota`, headers: asAdmin(), payload: { quota_bytes: '2048' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(typeof r.json().freezes, 'boolean', 'the caller is told before, not after');

    const audited = await lastAudit(userId);
    assert.equal(audited!.action, 'quota.change');
    assert.equal(audited!.details.to, '2048');
    assert.ok(audited!.details.from, 'both ends of the change, or the row answers half a question');
  });

  it('deletes nothing when the new limit is below what they hold', async () => {
    // SH-20: lowering a quota freezes, it does not reclaim. The console has to be able to
    // say so, which means the server has to know it before it acts.
    const holder = await makeAccount(`squeezed-${randomUUID()}`, 'user');
    const sha = Buffer.from(randomUUID().replace(/-/g, '').padEnd(64, 'a').slice(0, 64), 'hex');
    await db.query(`INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
                    VALUES ($1, 4096, $2, 'xchacha20poly1305', $3)`,
      [sha, `k-${randomUUID()}`, randomUUID()]);
    await db.query(`INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, $2, 1)`, [holder.id, sha]);

    const r = await app.inject({
      method: 'PUT', url: `/admin/accounts/${holder.id}/quota`, headers: asAdmin(), payload: { quota_bytes: '1024' },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().freezes, true, 'the answer names the consequence');
    assert.equal(r.json().used_bytes, '4096');

    const held = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_blobs WHERE user_id = $1`, [holder.id]);
    assert.equal(held!.n, '1', 'and not one byte was taken away');
  });

  it('refuses a quota that is not a positive number of bytes', async () => {
    for (const quota of ['0', '-1', 'lots', '']) {
      const r = await app.inject({
        method: 'PUT', url: `/admin/accounts/${userId}/quota`, headers: asAdmin(), payload: { quota_bytes: quota },
      });
      assert.equal(r.statusCode, 400, `expected a refusal for ${JSON.stringify(quota)}`);
    }
  });
});

describe('what the operator can see', () => {
  it('lists accounts with what they hold, and never a tombstone', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/accounts', headers: asAdmin() });
    assert.equal(r.statusCode, 200, r.body);
    const accounts = r.json().accounts as { id: string; usedBytes: string; state: string }[];
    assert.ok(accounts.some((a) => a.id === userId));
    assert.ok(!accounts.some((a) => a.state === 'tombstone'), 'the reserved row is not a person');
    assert.ok(accounts.every((a) => /^\d+$/.test(a.usedBytes)), 'usage is summed, not guessed');
  });

  it('reports storage, including what deduplication saves and what is in quarantine', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/storage', headers: asAdmin() });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    for (const field of ['storedBytes', 'chargedBytes', 'blobs', 'quarantined']) {
      assert.ok(/^\d+$/.test(body[field]), `${field} is a number: ${body[field]}`);
    }
  });

  it('shows the log newest first, and can be asked about one account', async () => {
    const r = await app.inject({ method: 'GET', url: `/admin/audit?target=${userId}`, headers: asAdmin() });
    assert.equal(r.statusCode, 200, r.body);
    const entries = r.json().entries as { action: string; targetLogin: string | null }[];
    assert.ok(entries.length > 0, 'the quota change above is in here');
    assert.ok(entries.every((e) => e.action.includes('.')), 'a verb with its subject, for somebody scanning');
  });
});

describe('deleting an account, which is a procedure', () => {
  /** A vault with one file, so the account has a tree to be taken apart. */
  const vaultWithAFile = async (owner: string, token: string) => {
    const vaultId = randomUUID();
    const created = await app.inject({
      method: 'POST', url: '/vaults', headers: { authorization: `Bearer ${token}` },
      payload: { id: vaultId, name_enc: Buffer.from('theirs').toString('base64') },
    });
    assert.equal(created.statusCode, 201, created.body);
    const rootId = created.json().root_node_id as string;
    const keyId = (await db.one<{ id: string }>(
      `SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [vaultId]))!.id;

    const body = Buffer.from(`content-${randomUUID()}`);
    const hex = createHash('sha256').update(body).digest('hex');
    const up = await app.inject({
      method: 'POST', url: '/blobs',
      query: { sha256: hex, size: String(body.length), key_id: keyId },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      payload: body,
    });
    assert.equal(up.statusCode, 201, up.body);
    const node = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: { authorization: `Bearer ${token}` },
      payload: {
        parent_id: rootId, type: 'file', sha256: hex, size: body.length,
        mtime: new Date().toISOString(),
        name_enc: Buffer.from('note.md').toString('base64'),
        name_hmac: createHash('sha256').update(Buffer.from('note.md')).digest('hex'),
        name_key_id: keyId,
        blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
        dedup_tags: [{ sha256: hex, scope_id: keyId,
                       content_tag: createHash('sha256').update(Buffer.from(`t:${hex}`)).digest('hex') }],
      },
    });
    assert.equal(node.statusCode, 201, node.body);
    return { vaultId, nodeId: node.json().node_id as string, owner };
  };

  it('takes the account, its vaults and its tree, in one procedure', async () => {
    const doomed = await makeAccount(`doomed-${randomUUID()}`, 'user');
    const { vaultId } = await vaultWithAFile(doomed.id, doomed.token);

    const r = await app.inject({
      method: 'POST', url: `/admin/accounts/${doomed.id}/deletion`, headers: asAdmin(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().finished, true, 'nobody else held a copy, so there was nothing to wait for');

    assert.equal(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [doomed.id]), undefined);
    assert.equal(await db.one(`SELECT 1 AS x FROM vaults WHERE id = $1`, [vaultId]), undefined,
      'the vaults go with it, which they could not have done while they held nodes');
  });

  it('moves authorship to the tombstone rather than erasing it', async () => {
    // A share participant routinely writes into somebody else's history (SH-19), so a
    // CASCADE would delete another person's record of their own file. "Written by an account
    // that is gone" is a different fact from "written by nobody", and the version row keeps
    // saying the first.
    const author = await makeAccount(`author-${randomUUID()}`, 'user');
    const keeper = await makeAccount(`keeper-${randomUUID()}`, 'user');
    const theirs = await vaultWithAFile(keeper.id, keeper.token);

    // The doomed account is named as the author of a version in somebody else's vault.
    await db.query(`UPDATE versions SET author_id = $1 WHERE vault_id = $2`, [author.id, theirs.vaultId]);

    const r = await app.inject({
      method: 'POST', url: `/admin/accounts/${author.id}/deletion`, headers: asAdmin(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().finished, true);

    const version = await db.one<{ author: string }>(
      `SELECT author_id AS author FROM versions WHERE vault_id = $1 LIMIT 1`, [theirs.vaultId]);
    assert.equal(version!.author, '00000000-0000-0000-0000-000000000000', 'the tombstone, not null and not gone');
    const surviving = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM versions WHERE vault_id = $1`, [theirs.vaultId]);
    assert.equal(surviving!.n, '1', 'and the other account still has its history');
  });

  it('refuses to delete an unclaimed invitation, and the tombstone', async () => {
    const invited = await app.inject({
      method: 'POST', url: '/admin/invitations', headers: asAdmin(),
      payload: { login: `never-${randomUUID()}`, quota_bytes: '1048576' },
    });
    const id = invited.json().user_id as string;

    const r = await app.inject({ method: 'POST', url: `/admin/accounts/${id}/deletion`, headers: asAdmin() });
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /revoked, not deleted/);

    const t = await app.inject({
      method: 'POST', url: '/admin/accounts/00000000-0000-0000-0000-000000000000/deletion', headers: asAdmin(),
    });
    assert.equal(t.statusCode, 400, t.body);
    assert.match(t.json().detail, /permanent/);
  });

  it('records both ends of the procedure', async () => {
    const doomed = await makeAccount(`logged-${randomUUID()}`, 'user');
    await app.inject({ method: 'POST', url: `/admin/accounts/${doomed.id}/deletion`, headers: asAdmin() });

    const entries = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_user_id = $1 ORDER BY id`, [doomed.id]);
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('account.delete.begin'), `expected a begin: ${actions.join(', ')}`);
    assert.ok(actions.includes('account.delete.finish'), `expected a finish: ${actions.join(', ')}`);
    // The row outlives the account it names, which is why it carries no foreign key (D-93).
    assert.equal(await db.one(`SELECT 1 AS x FROM users WHERE id = $1`, [doomed.id]), undefined);
  });

  it('will not delete the last administrator', async () => {
    const r = await app.inject({ method: 'POST', url: `/admin/accounts/${adminId}/deletion`, headers: asAdmin() });
    assert.ok(r.statusCode >= 400 && r.statusCode < 500, `expected a refusal, got ${r.statusCode}: ${r.body}`);
    const still = await db.one<{ state: string }>(`SELECT state::text AS state FROM users WHERE id = $1`, [adminId]);
    assert.equal(still!.state, 'active');
  });

  it('reports progress without moving it', async () => {
    const doomed = await makeAccount(`watched-${randomUUID()}`, 'user');
    const before = await app.inject({
      method: 'GET', url: `/admin/accounts/${doomed.id}/deletion`, headers: asAdmin(),
    });
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().state, 'active', 'looking is not starting');

    const still = await db.one<{ state: string }>(`SELECT state::text AS state FROM users WHERE id = $1`, [doomed.id]);
    assert.equal(still!.state, 'active');
  });
});

/**
 * How much audit log there is (D-117).
 *
 * The size travels with the page because the decision rests on a number nothing enforces; this is the
 * assertion that it still travels.
 */
describe('the size of the audit log', () => {
  it('comes back beside the entries, in rows and bytes', async () => {
    const out = await app.inject({ method: 'GET', url: '/admin/audit', headers: asAdmin() });
    assert.equal(out.statusCode, 200, out.body);
    const size = out.json().size as { rows: number; bytes: string };

    assert.equal(typeof size.rows, 'number');
    // Bytes as a string, like every other size on this API: it is a `bigint` in the database and a
    // number here would be a quiet ceiling somebody meets years later.
    assert.equal(typeof size.bytes, 'string');
    assert.ok(Number(size.bytes) > 0, 'a table always occupies something');

    // The whole log, not the page: `limit` bounds what comes back and must not bound what is counted.
    const page = out.json().entries as unknown[];
    assert.ok(size.rows >= page.length);
  });
});
