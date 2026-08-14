/**
 * A share before anybody else is in it: creating one, cancelling it, and the two lists.
 *
 * Most of what is asserted here is enforced by `schema.sql` rather than by the service —
 * `shares_check_root()` decides "a folder", "alive", "not already shared", and the
 * composite foreign key pins the root to the initiator's own vault. These tests exist to
 * prove the server turns each of those into an answer a caller can act on, because a
 * refusal that reaches the client as `500` is the same as no rule at all.
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

const STORE = `var/test-shares-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;

/** The initiator, and a second account that is in none of their shares. */
let access: string;
let userId: string;
let strangerAccess: string;
let vaultId: string;
let vaultKeyId: string;
let rootId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });
const b64 = (s: string) => Buffer.from(s).toString('base64');

/** An active account with a device token, since every route here is behind auth. */
const makeAccount = async (label: string) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', '\\x03', 'rh', '\\x04', 1048576)`,
    [id, `${label}-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [id],
  );
  return { id, access: app.jwt.sign({ sub: id, device: device!.id }) };
};

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);

  const initiator = await makeAccount('shares');
  userId = initiator.id;
  access = initiator.access;
  strangerAccess = (await makeAccount('shares-other')).access;

  vaultId = randomUUID();
  const created = await app.inject({
    method: 'POST',
    url: '/vaults',
    headers: auth(),
    payload: { id: vaultId, name_enc: b64('shared vault') },
  });
  assert.equal(created.statusCode, 201, created.body);
  rootId = created.json().root_node_id;

  const scope = await db.one<{ id: string }>(
    `SELECT vault_key_id AS id FROM vaults WHERE id = $1`,
    [vaultId],
  );
  vaultKeyId = scope!.id;
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

const createNode = async (type: 'folder', name: string) => {
  const r = await app.inject({
    method: 'POST',
    url: `/vaults/${vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: rootId,
      type,
      mtime: new Date().toISOString(),
      name_enc: b64(name),
      name_hmac: sha(Buffer.from(name)),
      name_key_id: vaultKeyId,
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return (r.json() as { node_id: string }).node_id;
};

const openShare = (nodeId: string, token = access) =>
  app.inject({
    method: 'POST',
    url: '/shares',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      vault_id: vaultId,
      node_id: nodeId,
      subtree_key_id: randomUUID(),
      wrapped_key_initiator: b64('a wrapped KS'),
    },
  });

describe('opening a share over a folder', () => {
  it('starts in preparing, because nobody may be invited before preparation is verified', async () => {
    const folder = await createNode('folder', `shared-${randomUUID()}`);
    const r = await openShare(folder);

    assert.equal(r.statusCode, 201, r.body);
    const body = r.json();
    assert.equal(body.state, 'preparing', 'not active — invite and join are refused until activation');
    assert.ok(body.share_id);
  });

  it('refuses a second share over the same folder', async () => {
    // One share per folder, `UNIQUE (initiator_vault_id, subtree_node_id)`. Without the
    // mapping this arrives as a 500 and the client cannot tell it from a server fault.
    const folder = await createNode('folder', `twice-${randomUUID()}`);
    assert.equal((await openShare(folder)).statusCode, 201);

    const again = await openShare(folder);
    assert.equal(again.statusCode, 400, again.body);
    assert.equal(again.json().error, 'invalid_write');
    assert.match(again.json().detail, /already part of share/, "the trigger's own sentence");
  });

  // "a share must be rooted at a folder, not a file" is enforced by `shares_check_root()`
  // and proved by db/tests.sql; asserting it here would mean building a file node with its
  // blob, upload and material rows for a rule this layer does not decide.

  it('refuses a node in a vault the caller does not own, without saying which half was wrong', async () => {
    // The composite foreign key fails; answering `not_found` keeps the endpoint from
    // reporting on another account's tree (#20).
    const folder = await createNode('folder', `mine-${randomUUID()}`);
    const r = await openShare(folder, strangerAccess);

    assert.equal(r.statusCode, 404, r.body);
  });

  it('checks the identifiers it is given, since all three become keys', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/shares',
      headers: auth(),
      payload: {
        vault_id: vaultId,
        node_id: rootId,
        subtree_key_id: 'not-a-uuid',
        wrapped_key_initiator: b64('k'),
      },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'bad_subtree_key_id');
  });
});

describe('cancelling a share nobody has joined', () => {
  it('takes it straight to cancelled, with no finalization pass', async () => {
    // Legitimate precisely because no participant copy exists yet; ending a live share is
    // a different operation with a different cost.
    const folder = await createNode('folder', `cancel-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });
    assert.equal(r.statusCode, 204, r.body);

    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'cancelled');
  });

  it('says what state it is actually in when cancelling is no longer right', async () => {
    const folder = await createNode('folder', `twice-cancel-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });

    const again = await app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error, 'share_not_preparing');
    assert.equal(again.json().state, 'cancelled', 'the state decides which operation is the right one');
  });

  it('is not something another account can do', async () => {
    const folder = await createNode('folder', `not-yours-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/cancel`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(r.statusCode, 404, 'and not 403 — a share they cannot see stays invisible');
  });
});

describe('the lists a client opens', () => {
  it('shows the initiator their own share before any member row exists', async () => {
    // They are in it: it is their folder. Waiting for a `share_members` row would leave a
    // share the initiator created invisible to them.
    const folder = await createNode('folder', `listed-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'GET', url: '/shares', headers: auth() });
    assert.equal(r.statusCode, 200);
    const mine = r.json().joined.find((s: { share_id: string }) => s.share_id === shareId);
    assert.ok(mine, 'the share is in the list');
    assert.equal(mine.is_initiator, true);
    assert.equal(mine.vault_id, vaultId);
  });

  it('drops a cancelled share from the list rather than showing a dead one', async () => {
    const folder = await createNode('folder', `gone-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });

    const r = await app.inject({ method: 'GET', url: '/shares', headers: auth() });
    assert.ok(!r.json().joined.some((s: { share_id: string }) => s.share_id === shareId));
  });

  it('lists the initiator as a member although they hold no membership row', async () => {
    const folder = await createNode('folder', `members-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json() as { user_id: string; is_initiator: boolean; finalizing: boolean }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, userId);
    assert.equal(rows[0]!.is_initiator, true);
    assert.equal(rows[0]!.finalizing, false);
  });

  it('does not show the membership list to somebody outside the share', async () => {
    const folder = await createNode('folder', `private-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({
      method: 'GET',
      url: `/shares/${shareId}/members`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(r.statusCode, 404, 'the same answer as a share that does not exist');
  });
});
