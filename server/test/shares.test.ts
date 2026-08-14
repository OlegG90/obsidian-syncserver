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
let strangerId: string;
let strangerVaultId: string;
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
  const stranger = await makeAccount('shares-other');
  strangerAccess = stranger.access;
  strangerId = stranger.id;

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

  strangerVaultId = randomUUID();
  const theirs = await app.inject({
    method: 'POST',
    url: '/vaults',
    headers: { authorization: `Bearer ${strangerAccess}` },
    payload: { id: strangerVaultId, name_enc: b64('their vault') },
  });
  assert.equal(theirs.statusCode, 201, theirs.body);
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

const createNode = async (type: 'folder', name: string, parent = rootId, keyId?: string) => {
  const r = await app.inject({
    method: 'POST',
    url: `/vaults/${vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: parent,
      type,
      mtime: new Date().toISOString(),
      name_enc: b64(name),
      name_hmac: sha(Buffer.from(name)),
      // Inside an active share a name must use the SHARE key: the schema refuses one
      // that does not (SH-26).
      name_key_id: keyId ?? vaultKeyId,
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

describe('activation, the one completeness check the schema cannot make', () => {
  it('opens an empty share, where there is nothing left to prepare', async () => {
    const folder = await createNode('folder', `activate-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().state, 'active');
  });

  it('refuses while an interior name is still under the vault key, and names the node', async () => {
    // The hole activation exists to close: a participant holds `KS` and nothing else, so a
    // name left under `KV` is one they could never decrypt. The gap list is the point —
    // without it the client would have to re-scan the whole subtree to find the work.
    const folder = await createNode('folder', `unprepared-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_prepared');
    assert.deepEqual(r.json().gaps, [{ nodeId: inside, missing: 'name' }]);
  });

  it('accepts once the interior name is re-keyed to the share key', async () => {
    const folder = await createNode('folder', `prepared-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const created = await openShare(folder);
    const shareId = created.json().share_id;

    // Preparation is the client's `POST /shares/{id}/prepare`, which is not built yet; the
    // effect it will have is written directly so activation can be tested on its own.
    const keyId = await db.one<{ id: string }>(`SELECT subtree_key_id AS id FROM shares WHERE id = $1`, [
      shareId,
    ]);
    await db.query(`UPDATE nodes SET name_key_id = $1 WHERE vault_id = $2 AND id = $3`, [
      keyId!.id,
      vaultId,
      inside,
    ]);

    const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('is not something a second activation can do', async () => {
    const folder = await createNode('folder', `twice-active-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });

    const again = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().state, 'active');
  });
});

/** A folder that is shared and open for invitations. */
const activeShare = async (label: string) => {
  const folder = await createNode('folder', `${label}-${randomUUID()}`);
  const shareId = (await openShare(folder)).json().share_id;
  const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
  assert.equal(r.statusCode, 200, r.body);
  return shareId;
};

const inviteTo = (shareId: string, target: string, token = access) =>
  app.inject({
    method: 'POST',
    url: `/shares/${shareId}/invite`,
    headers: { authorization: `Bearer ${token}` },
    payload: { user_id: target, wrapped_key: b64('an HPKE envelope') },
  });

describe('inviting somebody', () => {
  it('puts an unanswered membership row in their list, and in the share', async () => {
    const shareId = await activeShare('invite');
    const r = await inviteTo(shareId, strangerId);
    assert.equal(r.statusCode, 204, r.body);

    const theirs = await app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    const waiting = theirs.json().invitations.find((i: { share_id: string }) => i.share_id === shareId);
    assert.ok(waiting, 'it is waiting for them');
    assert.ok(waiting.initiator_login, 'and says who is asking');

    // Not in `joined`: an invitation is a decision they have not made, not a folder they hold.
    assert.ok(!theirs.json().joined.some((s: { share_id: string }) => s.share_id === shareId));

    const members = await app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    const row = members.json().find((m: { user_id: string }) => m.user_id === strangerId);
    assert.equal(row.joined_at, null, 'outstanding is joined_at being null; there is no state column');
  });

  it('refuses while the share is still preparing', async () => {
    const folder = await createNode('folder', `early-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await inviteTo(shareId, strangerId);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_active');
    assert.equal(r.json().state, 'preparing');
  });

  it('answers an unknown account exactly as it answers one already invited', async () => {
    // Deliberate: two different situations, one answer. Telling them apart would say
    // whether a login exists, which is the oracle #73 closed on /auth/kdf.
    const shareId = await activeShare('oracle');
    assert.equal((await inviteTo(shareId, strangerId)).statusCode, 204);

    const twice = await inviteTo(shareId, strangerId);
    const nobody = await inviteTo(shareId, randomUUID());

    assert.equal(twice.statusCode, 409);
    assert.equal(nobody.statusCode, 409);
    assert.deepEqual(twice.json(), nobody.json(), 'the same answer, byte for byte');
  });

  it('is the initiator’s to do and nobody else’s', async () => {
    const shareId = await activeShare('not-yours');
    const r = await inviteTo(shareId, strangerId, strangerAccess);
    assert.equal(r.statusCode, 404, 'a share they are not in stays invisible');
  });
});

describe('an invitation nobody accepted', () => {
  it('vanishes when declined, leaving nothing behind', async () => {
    const shareId = await activeShare('decline');
    await inviteTo(shareId, strangerId);

    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(r.statusCode, 204, r.body);

    // Absence IS the record. There is no declined state to read, by design.
    const members = await app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    assert.ok(!members.json().some((m: { user_id: string }) => m.user_id === strangerId));

    const rows = await db.query(`SELECT 1 FROM share_members WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      strangerId,
    ]);
    assert.equal(rows.length, 0, 'the row is deleted, not marked');
  });

  it('frees its slot at once, so the same person can be invited again', async () => {
    const shareId = await activeShare('reinvite');
    await inviteTo(shareId, strangerId);
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });

    assert.equal((await inviteTo(shareId, strangerId)).statusCode, 204, 'the slot came back');
  });

  it('is withdrawn by the initiator the same way, from the other side', async () => {
    const shareId = await activeShare('withdraw');
    await inviteTo(shareId, strangerId);

    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'withdrawn', 'not "revoked" — there is no replica to finalize');

    const rows = await db.query(`SELECT 1 FROM share_members WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      strangerId,
    ]);
    assert.equal(rows.length, 0);
  });

  it('cannot be declined by somebody who was never invited', async () => {
    const shareId = await activeShare('uninvited');
    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(r.statusCode, 404);
  });
});

describe('removing a member', () => {
  it('revokes rather than withdraws once they have joined, and stops propagation now', async () => {
    // Joining is not built yet, so the row is put in the state joining will leave it in.
    // What is asserted is the branch: a joined member is revoked, and revocation is only
    // begun here — their client finalizes the copy it alone holds the keys for.
    const shareId = await activeShare('revoke');
    await inviteTo(shareId, strangerId);
    await db.query(`UPDATE share_members SET joined_at = now(), vault_id = $3 WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      strangerId,
      strangerVaultId,
    ]);

    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'revoked');

    const row = await db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, strangerId],
    );
    assert.ok(row!.started, 'propagation stopped');
    assert.equal(row!.left, null, 'but they have not left: that needs their own metadata pass');

    const members = await app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    const them = members.json().find((m: { user_id: string }) => m.user_id === strangerId);
    assert.equal(them.finalizing, true, 'and the list says so');
  });

  it('refuses to remove the initiator, because that is ending the share', async () => {
    const shareId = await activeShare('self');
    const r = await app.inject({ method: 'DELETE', url: `/shares/${shareId}/members/${userId}`, headers: auth() });

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'initiator_cannot_be_removed');
  });
});

/** The share key scope of a share, which is what preparation must name. */
const shareKeyOf = async (shareId: string) => {
  const row = await db.one<{ id: string }>(`SELECT subtree_key_id AS id FROM shares WHERE id = $1`, [shareId]);
  return row!.id;
};

const prepare = (shareId: string, items: unknown[], token = access) =>
  app.inject({
    method: 'POST',
    url: `/shares/${shareId}/prepare`,
    headers: { authorization: `Bearer ${token}` },
    payload: { items },
  });

describe('preparing a subtree for its share key', () => {
  it('re-keys an interior name, and activation then has nothing to complain about', async () => {
    // The two halves of one job, in sequence: the client converts, the server verifies.
    // Neither is much use alone, which is why this asserts the pair rather than the write.
    const folder = await createNode('folder', `prep-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const blocked = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(blocked.statusCode, 409, 'unprepared to begin with');

    const r = await prepare(shareId, [
      { node_id: inside, name_enc: b64('under KS'), name_hmac: sha(Buffer.from('under KS')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 204, r.body);

    const ok = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('applies the same batch twice without complaint, because a lost response is not a fault', async () => {
    // Batches are resumable (docs/04) and nothing records which ones landed: a client that
    // did not hear the answer resends, and `activate` recomputes what is still missing.
    const folder = await createNode('folder', `resume-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);
    const item = {
      node_id: inside,
      name_enc: b64('under KS'),
      name_hmac: sha(Buffer.from('under KS')),
      name_key_id: ks,
    };

    assert.equal((await prepare(shareId, [item])).statusCode, 204);
    assert.equal((await prepare(shareId, [item])).statusCode, 204, 'a repeat changes nothing and is not an error');
  });

  it('refuses a scope that is not this share’s', async () => {
    // It would produce names no participant could read, and activation would then refuse
    // the share for a reason the client had just created.
    const folder = await createNode('folder', `wrongkey-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await prepare(shareId, [
      { node_id: inside, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: vaultKeyId },
    ]);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /key scope/);
  });

  it('refuses a node outside the share rather than skipping it', async () => {
    // Skipping would be the worse failure: activate would later report the item as missing
    // and send the client back to prepare something it believes it already prepared.
    const folder = await createNode('folder', `outside-${randomUUID()}`);
    const elsewhere = await createNode('folder', `elsewhere-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(shareId, [
      { node_id: elsewhere, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /not a live interior node/);
  });

  it('will not prepare the share root, whose label stays under the vault key', async () => {
    // SH-01/SH-25: the root sits beside private siblings, and a participant names their own
    // copy's root when they join. `ancestry` excludes the node itself, so this is refused
    // by the same condition that keeps outsiders out.
    const folder = await createNode('folder', `root-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(shareId, [
      { node_id: folder, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 400, r.body);
  });

  it('stops once the share is active, when a name change is an ordinary write', async () => {
    const shareId = await activeShare('late-prep');
    const ks = await shareKeyOf(shareId);
    const r = await prepare(shareId, [
      { node_id: randomUUID(), name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_preparing');
  });

  it('is the initiator’s to do', async () => {
    const folder = await createNode('folder', `whose-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(
      shareId,
      [{ node_id: inside, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks }],
      strangerAccess,
    );
    assert.equal(r.statusCode, 404);
  });

  it('wants something to do', async () => {
    const folder = await createNode('folder', `empty-batch-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    assert.equal((await prepare(shareId, [])).statusCode, 400);
  });
});

/** The joiner's own root folder, where a replica can land. */
const strangerRoot = async () => {
  const row = await db.one<{ id: string }>(`SELECT root_node_id AS id FROM vaults WHERE id = $1`, [strangerVaultId]);
  return row!.id;
};

const strangerVaultKey = async () => {
  const row = await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [strangerVaultId]);
  return row!.id;
};

// A fresh name per join: siblings must be uniquely named, and several tests land a
// replica under the same folder of the same vault.
const join = async (shareId: string, name = `their copy ${randomUUID()}`) =>
  app.inject({
    method: 'POST',
    url: `/shares/${shareId}/join`,
    headers: { authorization: `Bearer ${strangerAccess}` },
    payload: {
      vault_id: strangerVaultId,
      parent_id: await strangerRoot(),
      name_enc: b64(name),
      name_hmac: sha(Buffer.from(name)),
      name_key_id: await strangerVaultKey(),
    },
  });

/** An active share with one interior folder, and an outstanding invitation to the stranger. */
const invitedShare = async (label: string) => {
  const folder = await createNode('folder', `${label}-${randomUUID()}`);
  const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
  const shareId = (await openShare(folder)).json().share_id;
  const ks = await shareKeyOf(shareId);
  await prepare(shareId, [
    { node_id: inside, name_enc: b64('interior'), name_hmac: sha(Buffer.from('interior')), name_key_id: ks },
  ]);
  const activated = await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal((await inviteTo(shareId, strangerId)).statusCode, 204);
  return { shareId, folder, inside, ks };
};

describe('accepting an invitation', () => {
  it('materialises a copy in the joiner’s own vault, under the folder they chose', async () => {
    const { shareId } = await invitedShare('join');
    const r = await join(shareId);

    assert.equal(r.statusCode, 201, r.body);
    const rootNodeId = r.json().root_node_id;

    const replica = await db.one<{ vaultId: string; parentId: string; shareId: string }>(
      `SELECT vault_id AS "vaultId", parent_id AS "parentId", share_id AS "shareId"
         FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, rootNodeId],
    );
    assert.equal(replica!.vaultId, strangerVaultId, 'their vault, not the initiator’s');
    assert.equal(replica!.parentId, await strangerRoot());
    assert.equal(replica!.shareId, shareId);
  });

  it('gives corresponding nodes the same share_item_id, which is how two copies are one item', async () => {
    // Neither participant can see the other's node ids, so this is the only handle that
    // says "your file and mine are the same file".
    const { shareId, folder, inside } = await invitedShare('items');
    const rootNodeId = (await join(shareId)).json().root_node_id;

    const pairs = await db.query<{ src: string; dst: string }>(
      `SELECT a.id AS src, b.id AS dst
         FROM nodes a JOIN nodes b ON b.share_item_id = a.share_item_id AND b.vault_id = $3
        WHERE a.vault_id = $1 AND a.id = ANY($2::uuid[])`,
      [vaultId, [folder, inside], strangerVaultId],
    );
    assert.equal(pairs.length, 2, 'both the root and the interior folder have a counterpart');
    assert.ok(pairs.some((p) => p.src === folder && p.dst === rootNodeId));
  });

  it('names the replica root itself, and copies interior names untouched', async () => {
    // The root sits among their private folders and is theirs to call anything; the
    // interior is already under KS, which their envelope opens.
    const { shareId, inside, ks } = await invitedShare('names');
    const rootNodeId = (await join(shareId, 'my copy')).json().root_node_id;

    const root = await db.one<{ nameEnc: string; keyId: string }>(
      `SELECT encode(name_enc,'base64') AS "nameEnc", name_key_id AS "keyId"
         FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, rootNodeId],
    );
    assert.equal(Buffer.from(root!.nameEnc, 'base64').toString(), 'my copy');
    assert.equal(root!.keyId, await strangerVaultKey(), 'the root label is under THEIR vault key');

    const copy = await db.one<{ nameEnc: string; keyId: string }>(
      `SELECT encode(n.name_enc,'base64') AS "nameEnc", n.name_key_id AS "keyId"
         FROM nodes n JOIN nodes src ON src.share_item_id = n.share_item_id
        WHERE n.vault_id = $1 AND src.vault_id = $2 AND src.id = $3`,
      [strangerVaultId, vaultId, inside],
    );
    assert.equal(copy!.keyId, ks, 'the interior stays under the share key');
    assert.equal(Buffer.from(copy!.nameEnc, 'base64').toString(), 'interior', 'byte for byte');
  });

  it('puts the replica in the joiner’s journal, so their other devices learn about it', async () => {
    const { shareId } = await invitedShare('journal');
    const rootNodeId = (await join(shareId)).json().root_node_id;

    const entry = await db.one<{ op: string }>(
      `SELECT op::text AS op FROM journal WHERE vault_id = $1 AND node_id = $2`,
      [strangerVaultId, rootNodeId],
    );
    assert.equal(entry!.op, 'put', 'a replica arrives as an ordinary change, not out of band');
  });

  it('marks them joined, in the vault they were running in', async () => {
    const { shareId } = await invitedShare('member');
    await join(shareId);

    const row = await db.one<{ joined: string | null; vaultId: string }>(
      `SELECT joined_at AS joined, vault_id AS "vaultId" FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, strangerId],
    );
    assert.ok(row!.joined);
    assert.equal(row!.vaultId, strangerVaultId, 'observed from the request, never asked of the user');

    // And it moves from their invitations to the folders they hold.
    const lists = await app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.ok(lists.json().joined.some((s: { share_id: string }) => s.share_id === shareId));
    assert.ok(!lists.json().invitations.some((s: { share_id: string }) => s.share_id === shareId));
  });

  it('is redeemed once: a second acceptance finds nothing outstanding', async () => {
    const { shareId } = await invitedShare('once');
    assert.equal((await join(shareId)).statusCode, 201);

    const again = await join(shareId);
    assert.equal(again.statusCode, 404, 'the invitation is spent, not repeatable from another vault either');
  });

  it('refuses somebody who was never invited', async () => {
    const folder = await createNode('folder', `uninvited-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });

    assert.equal((await join(shareId)).statusCode, 404);
  });

  it('refuses a destination folder that is not the joiner’s', async () => {
    const { shareId } = await invitedShare('elsewhere');
    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/join`,
      headers: { authorization: `Bearer ${strangerAccess}` },
      payload: {
        vault_id: vaultId, // the INITIATOR's vault
        parent_id: rootId,
        name_enc: b64('x'),
        name_hmac: sha(Buffer.from('x')),
        name_key_id: await strangerVaultKey(),
      },
    });
    assert.equal(r.statusCode, 404, r.body);
  });

  it('leaves nothing behind when it refuses', async () => {
    // One transaction: a join that fails must not leave a half-materialised folder, which
    // would be worse than no folder at all — the user would see files that sync nowhere.
    const { shareId } = await invitedShare('atomic');
    const before = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [strangerVaultId]);

    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/join`,
      headers: { authorization: `Bearer ${strangerAccess}` },
      payload: {
        vault_id: strangerVaultId,
        parent_id: randomUUID(), // no such folder
        name_enc: b64('x'),
        name_hmac: sha(Buffer.from('x')),
        name_key_id: await strangerVaultKey(),
      },
    });
    assert.equal(r.statusCode, 404);

    const after = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [strangerVaultId]);
    assert.equal(after.length, before.length, 'no partial replica');

    const row = await db.one<{ joined: string | null }>(
      `SELECT joined_at AS joined FROM share_members WHERE share_id = $1 AND user_id = $2`,
      [shareId, strangerId],
    );
    assert.equal(row!.joined, null, 'and the invitation is still outstanding');
  });

  it('refuses while the share is not active', async () => {
    const folder = await createNode('folder', `inactive-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const r = await join(shareId);

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_active');
  });
});

/** A share the stranger has actually joined, with both replicas in place. */
const sharedWith = async (label: string) => {
  const { shareId, folder, inside, ks } = await invitedShare(label);
  const r = await join(shareId);
  assert.equal(r.statusCode, 201, r.body);
  return { shareId, folder, inside, ks, replicaRoot: r.json().root_node_id };
};

/** The stranger's copy of an item the initiator holds. */
const theirCopyOf = async (srcNodeId: string) => {
  const row = await db.one<{ id: string }>(
    `SELECT b.id FROM nodes a JOIN nodes b ON b.share_item_id = a.share_item_id AND b.vault_id = $3
      WHERE a.vault_id = $1 AND a.id = $2`,
    [vaultId, srcNodeId, strangerVaultId],
  );
  return row?.id;
};

describe('a write inside a shared folder reaches every copy', () => {
  it('creates the new node in the other participant’s vault too', async () => {
    const { inside, ks } = await sharedWith('fanout-create');
    const made = await createNode('folder', `new-${randomUUID()}`, inside, ks);

    const theirs = await theirCopyOf(made);
    assert.ok(theirs, 'the item exists in their replica');

    const row = await db.one<{ shareId: string | null; vaultId: string }>(
      `SELECT share_id AS "shareId", vault_id AS "vaultId" FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, theirs],
    );
    assert.ok(row!.shareId, 'and carries the share mark, which the schema demands of it');
  });

  it('gives the recipient a journal entry, so it arrives as an ordinary change', async () => {
    // Not a special channel: their client learns about it through the same delta as
    // anything else they did themselves.
    const { inside, ks } = await sharedWith('fanout-journal');
    const made = await createNode('folder', `new-${randomUUID()}`, inside, ks);
    const theirs = await theirCopyOf(made);

    const entry = await db.one<{ op: string }>(
      `SELECT op::text AS op FROM journal WHERE vault_id = $1 AND node_id = $2`,
      [strangerVaultId, theirs],
    );
    assert.equal(entry!.op, 'put');
  });

  it('propagates a deletion', async () => {
    const { inside, ks } = await sharedWith('fanout-delete');
    const made = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const theirs = await theirCopyOf(made);

    const rev = await db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      vaultId,
      made,
    ]);
    const r = await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}/nodes/${made}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    assert.equal(r.statusCode, 200, r.body);

    const gone = await db.one<{ deleted: string | null }>(
      `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, theirs],
    );
    assert.ok(gone!.deleted, 'their copy is in the trash too');
  });

  it('propagates a move within the share, and the subtree follows', async () => {
    const { inside, ks } = await sharedWith('fanout-move');
    const a = await createNode('folder', `a-${randomUUID()}`, inside, ks);
    const b = await createNode('folder', `b-${randomUUID()}`, inside, ks);
    const child = await createNode('folder', `child-${randomUUID()}`, a, ks);

    const rev = await db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      vaultId,
      a,
    ]);
    const moved = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/nodes/${a}/move`,
      headers: { ...auth(), 'if-match': rev!.rev },
      payload: {
        parent_id: b,
        name_enc: b64('moved'),
        name_hmac: sha(Buffer.from(`moved-${randomUUID()}`)),
        name_key_id: (await db.one<{ id: string }>(`SELECT name_key_id AS id FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, a]))!.id,
      },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    const theirA = await theirCopyOf(a);
    const theirB = await theirCopyOf(b);
    const theirChild = await theirCopyOf(child);

    const placed = await db.one<{ parentId: string; ancestry: string[] }>(
      `SELECT parent_id AS "parentId", ancestry FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, theirA],
    );
    assert.equal(placed!.parentId, theirB, 'their copy moved to the same place');

    const descendant = await db.one<{ ancestry: string[] }>(
      `SELECT ancestry FROM nodes WHERE vault_id = $1 AND id = $2`,
      [strangerVaultId, theirChild],
    );
    assert.ok(
      descendant!.ancestry.includes(theirB!),
      'and the subtree came with it, rather than claiming its old parent',
    );
  });

  it('does not send a participant their own write back', async () => {
    // The fan-out set excludes the vault the write happened in. Without that the originator
    // would get a second revision of their own change and see it as a remote edit.
    const { inside, ks } = await sharedWith('fanout-self');
    const made = await createNode('folder', `mine-${randomUUID()}`, inside, ks);

    const copies = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1 AND share_item_id = (
      SELECT share_item_id FROM nodes WHERE vault_id = $1 AND id = $2)`, [vaultId, made]);
    assert.equal(copies.length, 1, 'one copy in the writer’s own vault, not two');
  });
});

describe('who a write reaches, and who it does not', () => {
  it('skips a participant whose account is frozen, in both directions', async () => {
    // A freeze is the account having no room; delivering more is the one thing it cannot
    // absorb (SH-20). Their copy catches up on thaw.
    const { inside, ks } = await sharedWith('frozen');
    await db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [strangerId]);

    const made = await createNode('folder', `while-frozen-${randomUUID()}`, inside, ks);
    assert.equal(await theirCopyOf(made), undefined, 'nothing was delivered');

    await db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [strangerId]);
  });

  it('skips a participant who is finalizing, because revocation stops propagation now', async () => {
    const { shareId, inside, ks } = await sharedWith('revoked');
    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.json().outcome, 'revoked');

    const made = await createNode('folder', `after-revoke-${randomUUID()}`, inside, ks);
    assert.equal(await theirCopyOf(made), undefined, 'a revoked device receives no further changes');
  });
});

describe('all of them or none of them', () => {
  it('advances no replica when one of them cannot be written', async () => {
    // The atomicity contract docs/04 states, and the test it explicitly asks for. The
    // replica is made unwritable by removing the parent the propagated create needs, so
    // the fan-out raises inside the transaction that already wrote the original.
    const { inside, ks } = await sharedWith('atomic-fanout');

    const beforeSrc = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [vaultId]);
    const beforeDst = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [strangerVaultId]);

    // A name that is already taken in the RECIPIENT's replica but free in the source: the
    // propagated insert violates their unique sibling name, and nothing may survive it.
    const clashName = `clash-${randomUUID()}`;
    const theirInside = await theirCopyOf(inside);
    await db.query(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                          share_id, share_item_id)
       SELECT $1, $2, decode($3,'base64'), decode($4,'hex'), n.name_key_id, 'folder', now(), 0,
              n.ancestry || n.id, n.share_id, gen_random_uuid()
         FROM nodes n WHERE n.vault_id = $1 AND n.id = $2`,
      [strangerVaultId, theirInside, b64(clashName), sha(Buffer.from(clashName))],
    );

    const r = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/nodes`,
      headers: auth(),
      payload: {
        parent_id: inside,
        type: 'folder',
        mtime: new Date().toISOString(),
        name_enc: b64(clashName),
        name_hmac: sha(Buffer.from(clashName)),
        name_key_id: (await db.one<{ id: string }>(`SELECT name_key_id AS id FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, inside]))!.id,
      },
    });
    assert.notEqual(r.statusCode, 201, 'the write did not succeed');

    const afterSrc = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [vaultId]);
    const afterDst = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [strangerVaultId]);
    assert.equal(afterSrc.length, beforeSrc.length, 'the ORIGINAL rolled back too, not only the replica');
    assert.equal(afterDst.length, beforeDst.length + 1, 'and the replica gained nothing beyond the row we planted');
  });
});
