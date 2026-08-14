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


/** Upload bytes and return their address — a node may only reference a blob that exists. */
const putBlob = async (body: Buffer, keyId: string): Promise<string> => {
  const hex = sha(body);
  const r = await app.inject({
    method: 'POST',
    url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: keyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return hex;
};

const materialFor = (hex: string, keyId: string) => ({
  blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
  dedup_tags: [{ sha256: hex, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
});

/** A file inside a share, sealed under the share key like every interior node. */
const createFile = async (parentId: string, name: string, body: string, keyId: string) => {
  const bytes = Buffer.from(body);
  const hex = await putBlob(bytes, keyId);
  const r = await app.inject({
    method: 'POST',
    url: `/vaults/${vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: parentId, type: 'file', sha256: hex, size: bytes.length,
      mtime: new Date().toISOString(),
      name_enc: b64(name), name_hmac: sha(Buffer.from(name)), name_key_id: keyId,
      ...materialFor(hex, keyId),
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { nodeId: (r.json() as { node_id: string }).node_id, sha256: hex, keyId };
};

/** A second revision of that file, which is what gives it a history to carry. */
const putFile = async (file: { nodeId: string; sha256: string; keyId: string }, body: string) => {
  const bytes = Buffer.from(body);
  const hex = await putBlob(bytes, file.keyId);
  const r = await app.inject({
    method: 'PUT',
    url: `/vaults/${vaultId}/nodes/${file.nodeId}`,
    headers: auth(),
    payload: {
      sha256: hex, size: bytes.length, mtime: new Date().toISOString(),
      base_sha256: file.sha256,
      ...materialFor(hex, file.keyId),
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  file.sha256 = hex;
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
    // A third member, and not for decoration: revoking the LAST participant ends the share
    // (SH-07), and an ended share is no place to observe propagation. Somebody has to be
    // left for the write to still have a destination.
    const { shareId, inside, ks } = await sharedWith('revoked');
    const third = await makeAccount('shares-revoked-third');
    const theirVault = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${third.access}` },
      payload: { id: theirVault, name_enc: b64('third vault') },
    });
    await db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ($1, $2, $3, now(), '\x01')`,
      [shareId, third.id, theirVault],
    );

    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.json().outcome, 'revoked');
    assert.equal(r.json().ended, false, 'the share carries on for the third member');

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


/** Every node of the stranger's replica, in the shape finalize-leave wants. */
const theirReplicaNodes = async (shareId: string) => {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
    [strangerVaultId, shareId],
  );
  const keyId = await strangerVaultKey();
  return rows.map((r) => {
    const name = `back-under-kv-${r.id}`;
    return { node_id: r.id, name_enc: b64(name), name_hmac: sha(Buffer.from(name)), name_key_id: keyId };
  });
};

const leaveBegin = (shareId: string, token = strangerAccess) =>
  app.inject({
    method: 'POST',
    url: `/shares/${shareId}/leave/begin`,
    headers: { authorization: `Bearer ${token}` },
  });

const finalize = (shareId: string, nodes: unknown[], token = strangerAccess) =>
  app.inject({
    method: 'POST',
    url: `/shares/${shareId}/finalize-leave`,
    headers: { authorization: `Bearer ${token}` },
    payload: { nodes },
  });

describe('history arrives with the folder', () => {
  it('delivers a file’s retained versions, not only its head', async () => {
    // A folder that arrives with no past is one whose "restore an earlier version" does
    // nothing, and that only shows up on the day somebody needs it.
    const { shareId, inside, ks } = await invitedShare('history');

    // Two revisions of one file, made before anybody joined.
    const file = await createFile(inside, `hist-${randomUUID()}`, 'first', ks);
    await putFile(file, 'second');

    const rootNodeId = (await join(shareId)).json().root_node_id;
    assert.ok(rootNodeId);

    const theirs = await theirCopyOf(file.nodeId);
    const versions = await db.query<{ rev: string; author: string }>(
      `SELECT rev::text AS rev, author_id AS author FROM versions
        WHERE vault_id = $1 AND node_id = $2 ORDER BY rev`,
      [strangerVaultId, theirs],
    );
    assert.equal(versions.length, 2, 'both revisions came across');
    assert.ok(
      versions.every((v) => v.author === userId),
      'and every one credits the original writer, not the joiner (SH-19)',
    );
    assert.ok(Number(versions[1]!.rev) > Number(versions[0]!.rev), 'in order, renumbered into their sequence');
  });
});

describe('leaving', () => {
  it('stops propagation at once, before anything is converted', async () => {
    // finalization_started_at IS the stop: the fan-out set excludes it the moment it is
    // written, long before the client has converted anything. That exclusion is proved
    // against a live write by the revocation test above; what matters here is that leaving
    // writes the mark immediately rather than at the end of the pass.
    const { shareId } = await sharedWith('leave-stops');
    assert.equal((await leaveBegin(shareId)).statusCode, 200);

    const row = await db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, strangerId],
    );
    assert.ok(row!.started, 'propagation stopped');
    assert.equal(row!.left, null, 'and nothing is converted yet — that is the client’s pass');
  });

  it('ends the share when the last other participant goes', async () => {
    // SH-07: a departure, never a head count. With only the initiator left there is nobody
    // to share with.
    const { shareId } = await sharedWith('leave-ends');
    const r = await leaveBegin(shareId);

    assert.equal(r.json().ended, true);
    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'ended');
  });

  it('ends it for everybody when the initiator goes', async () => {
    // SH-17: "the initiator leaves" and "the share is dissolved" are one operation, and
    // every remaining member is put into finalization by it.
    const { shareId } = await sharedWith('initiator-leaves');
    const r = await leaveBegin(shareId, access);
    assert.equal(r.json().ended, true);

    const rows = await db.query<{ started: string | null }>(
      `SELECT finalization_started_at AS started FROM share_members WHERE share_id = $1`,
      [shareId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((m) => m.started), 'both sides are finalizing, each on their own client');
  });

  it('does not end a share that still has somebody in it', async () => {
    const { shareId } = await sharedWith('two-left');
    const third = await makeAccount('shares-third');
    await db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
       SELECT $1, $2, v.id, now(), '\\x01' FROM vaults v WHERE v.user_id = $2 LIMIT 1`,
      [shareId, third.id],
    ).catch(() => undefined);

    // The third account has no vault, so seed one and try again through the API path.
    const theirVault = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${third.access}` },
      payload: { id: theirVault, name_enc: b64('third vault') },
    });
    await db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ($1, $2, $3, now(), '\\x01')
       ON CONFLICT (share_id, user_id) DO UPDATE SET joined_at = now(), vault_id = $3`,
      [shareId, third.id, theirVault],
    );

    const r = await leaveBegin(shareId);
    assert.equal(r.json().ended, false, 'somebody else is still in it');
  });

  it('can be begun twice, because the second call is a client coming back', async () => {
    // This asserted a refusal until a live vault got stuck between the two steps. The pass
    // that converts the replica is the client's, so a device interrupted after `begin` has
    // to be able to return — refusing it left the vault unreadable for good.
    const { shareId } = await sharedWith('twice-leave');
    assert.equal((await leaveBegin(shareId)).statusCode, 200);

    const again = await leaveBegin(shareId);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().ended, true, 'and it reports the state as it now is');
  });
});

describe('finalizing a departure', () => {
  it('refuses a pass that leaves part of the replica converted', async () => {
    // The failure it prevents is silent and permanent: a folder whose files the owner can
    // no longer open, discovered long after the share is gone.
    const { shareId } = await sharedWith('partial');
    await leaveBegin(shareId);

    const all = await theirReplicaNodes(shareId);
    const r = await finalize(shareId, all.slice(1));

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'finalization_incomplete');
    assert.ok(r.json().missing.length > 0, 'and it says which nodes are missing');
  });

  it('converts the replica to private files and records the departure', async () => {
    const { shareId } = await sharedWith('finalize');
    await leaveBegin(shareId);
    const r = await finalize(shareId, await theirReplicaNodes(shareId));
    assert.equal(r.statusCode, 204, r.body);

    const left = await db.query(
      `SELECT 1 FROM nodes WHERE vault_id = $1 AND share_id = $2`,
      [strangerVaultId, shareId],
    );
    assert.equal(left.length, 0, 'nothing still carries the share mark');

    const member = await db.one<{ left: string | null }>(
      `SELECT left_at AS left FROM share_members WHERE share_id = $1 AND user_id = $2`,
      [shareId, strangerId],
    );
    assert.ok(member!.left, 'and the departure is recorded only now');
  });

  it('keeps the files: leaving a share leaves you with your copy (SH-05)', async () => {
    const { shareId, replicaRoot } = await sharedWith('keeps');
    await leaveBegin(shareId);
    await finalize(shareId, await theirReplicaNodes(shareId));

    const still = await db.one<{ id: string; keyId: string }>(
      `SELECT id, name_key_id AS "keyId" FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [strangerVaultId, replicaRoot],
    );
    assert.ok(still, 'the folder is still theirs');
    assert.equal(still!.keyId, await strangerVaultKey(), 'and everything is back under their own key');
  });

  it('is refused before finalization has been begun', async () => {
    const { shareId } = await sharedWith('too-early');
    const r = await finalize(shareId, await theirReplicaNodes(shareId));
    assert.equal(r.statusCode, 404, 'nothing to finalize yet');
  });
});

describe('the keys a client needs to read a vault', () => {
  it('gives the initiator their own share key, wrapped under the vault key', async () => {
    // Without this a restart leaves a client able to see shared nodes and unable to name
    // them: the interior is under KS, and KS reaches a device only wrapped.
    const folder = await createNode('folder', `scopes-${randomUUID()}`);
    const created = await openShare(folder);
    const shareId = created.json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    const scope = r.json().scopes.find((s: { key_id: string }) => s.key_id === ks);

    assert.ok(scope, 'the share scope is reported');
    assert.equal(scope.scope, 'share');
    assert.equal(scope.share_id, shareId);
    assert.equal(scope.wrapping, 'vault', 'theirs is a wrap, not an envelope — it needed no delivery');
    assert.ok(scope.wrapped_key);
  });

  it('gives a participant theirs as an account envelope instead', async () => {
    // Different row, different wrapping, and the client cannot guess which: the two are
    // opened with different keys entirely.
    const { shareId } = await sharedWith('scopes-member');
    const ks = await shareKeyOf(shareId);

    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${strangerVaultId}`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    const scope = r.json().scopes.find((s: { key_id: string }) => s.key_id === ks);

    assert.ok(scope, 'the participant is told about the scope their replica is named under');
    assert.equal(scope.wrapping, 'account');
  });

  it('says nothing about a share the caller is not in', async () => {
    const folder = await createNode('folder', `private-scope-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${strangerVaultId}`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.ok(!r.json().scopes.some((s: { key_id: string }) => s.key_id === ks));
  });

  it('keeps reporting it after the share is over, until the pass has run', async () => {
    // This asserted the opposite until a live vault stopped syncing. An ended share still
    // has a replica named under KS, and converting it back needs this key — so the share
    // being over is exactly the wrong moment to withhold it. `left_at` is what ends it, and
    // `left_at` is what the finalization pass writes.
    const { shareId } = await sharedWith('scopes-ended');
    const ks = await shareKeyOf(shareId);
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}`, headers: auth() });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'the initiator still owes the same pass, and still needs the key',
    );
  });

  it('still reports the vault’s own scope first, which everything else defaults to', async () => {
    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}`, headers: auth() });
    assert.equal(r.json().scopes[0].scope, 'vault');
    assert.equal(r.json().scopes[0].key_id, vaultKeyId);
  });
});

describe('a departure ends a share whichever door it came through', () => {
  it('ends the share when the initiator revokes the last participant', async () => {
    // SH-22: leaving and being revoked are the same state, so SH-07's "the last one out
    // ends it" has to hold for both. It held only for leaving — revoking the last
    // participant left the share active with nobody in it but the initiator.
    const { shareId } = await sharedWith('revoke-last');

    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'revoked');
    assert.equal(r.json().ended, true, 'and the caller is told, because it changes what they say');

    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'ended');
  });

  it('puts the initiator into finalization too when a revoke ends it', async () => {
    // Ending is not something one member does to another: everybody's copy has to come
    // back to KV, the initiator's included.
    const { shareId } = await sharedWith('revoke-ends-all');
    await app.inject({ method: 'DELETE', url: `/shares/${shareId}/members/${strangerId}`, headers: auth() });

    const rows = await db.query<{ started: string | null }>(
      `SELECT finalization_started_at AS started FROM share_members WHERE share_id = $1`,
      [shareId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((m) => m.started), 'both sides finalize, each on their own client');
  });

  it('does not end it while somebody else is still in', async () => {
    const { shareId } = await sharedWith('revoke-not-last');
    const third = await makeAccount('shares-revoke-third');
    const theirVault = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${third.access}` },
      payload: { id: theirVault, name_enc: b64('third vault') },
    });
    await db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ($1, $2, $3, now(), '\x01')`,
      [shareId, third.id, theirVault],
    );

    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });
    assert.equal(r.json().ended, false);

    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'active', 'the share carries on for the one who is left');
  });

  it('withdrawing an invitation is not a departure and ends nothing', async () => {
    // Nobody joined, so nobody left. The slot simply comes back.
    const { shareId } = await invitedShare('withdraw-not-departure');
    const r = await app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${strangerId}`,
      headers: auth(),
    });

    assert.equal(r.json().outcome, 'withdrawn');
    assert.equal(r.json().ended, undefined, 'there is no departure to report');

    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'active');
  });
});

describe('the states the delta carries', () => {
  /** The events of this account's own vault, as a sync would meet them. */
  const eventsOf = async (token = access, vault = vaultId) => {
    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${vault}/delta`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().events as { type: string; share_id?: string; at: string }[];
  };

  it('says nothing to an account with nothing true of it', async () => {
    // A fresh account, because this suite's own vault accumulates ended shares — which is
    // itself the point: the events are about what is true NOW, per account.
    const fresh = await makeAccount('events-quiet');
    const theirVault = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${fresh.access}` },
      payload: { id: theirVault, name_enc: b64('quiet vault') },
    });

    assert.deepEqual(await eventsOf(fresh.access, theirVault), []);
  });

  it('tells a member their share ended, and keeps telling them until they finalize', async () => {
    // The prompt IS the reminder that a metadata pass is owed. Delivered once and lost, a
    // device that was offline would never learn its replica has to come back to KV.
    const { shareId } = await sharedWith('event-ended');
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });

    const mine = (list: { type: string; share_id?: string }[]) =>
      list.some((e) => e.type === 'share_ended' && e.share_id === shareId);

    assert.ok(mine(await eventsOf(strangerAccess, strangerVaultId)), 'the participant is told');
    assert.ok(mine(await eventsOf(strangerAccess, strangerVaultId)), 'and again, because the pass is still owed');
  });

  it('stops once the replica has been converted back', async () => {
    const { shareId } = await sharedWith('event-finalized');
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    const nodes = await db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [strangerVaultId, shareId],
    );
    const keyId = await strangerVaultKey();
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: { authorization: `Bearer ${strangerAccess}` },
      payload: {
        nodes: nodes.map((n) => ({
          node_id: n.id,
          name_enc: b64(`back-${n.id}`),
          name_hmac: sha(Buffer.from(`back-${n.id}`)),
          name_key_id: keyId,
        })),
      },
    });

    const after = await eventsOf(strangerAccess, strangerVaultId);
    assert.ok(
      !after.some((e) => e.type === 'share_ended' && e.share_id === shareId),
      'left_at is what stops it',
    );
  });

  it('tells a frozen account it is frozen, which nothing else does', async () => {
    // Before this the only way to learn was to be refused a write — a state discovered by
    // bumping into it.
    await db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [userId]);
    const events = await eventsOf();

    const frozen = events.find((e) => e.type === 'account_frozen');
    assert.ok(frozen, 'the state is reported');
    assert.equal(frozen!.share_id, undefined, 'and names no share: the quota is per account (SH-20)');

    await db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [userId]);
    assert.ok(!(await eventsOf()).some((e) => e.type === 'account_frozen'), 'and stops when it stops being true');
  });
});

describe('who to seal a share key to', () => {
  it('gives the initiator a real recipient’s public key', async () => {
    const shareId = await activeShare('pubkey');
    const login = (await db.one<{ login: string }>(`SELECT login FROM users WHERE id = $1`, [strangerId]))!.login;

    const r = await app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/${encodeURIComponent(login)}/pubkey`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().user_id, strangerId);
    assert.ok(r.json().pubkey, 'and the key to seal to');
  });

  it('answers an unknown login with a fake pair rather than a 404 (#73)', async () => {
    // A distinct answer for "no such account" is an enumeration oracle, and this endpoint
    // takes a login. The fake must also be indistinguishable in shape from a real answer.
    const shareId = await activeShare('pubkey-unknown');
    const r = await app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/nobody-at-all/pubkey`,
      headers: auth(),
    });

    assert.equal(r.statusCode, 200, 'not a 404');
    assert.match(r.json().user_id, /^[0-9a-f-]{36}$/, 'shaped like an id');
    assert.ok(r.json().pubkey.length > 0);
  });

  it('gives the SAME fake twice, because a changing one gives it away', async () => {
    // A random fake would differ between two calls and answer the question more plainly
    // than a 404 would.
    const shareId = await activeShare('pubkey-stable');
    const ask = () =>
      app.inject({
        method: 'GET',
        url: `/shares/${shareId}/recipients/still-nobody/pubkey`,
        headers: auth(),
      });

    assert.deepEqual((await ask()).json(), (await ask()).json());
  });

  it('is the initiator’s question and nobody else’s', async () => {
    const shareId = await activeShare('pubkey-whose');
    const r = await app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/admin/pubkey`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(r.statusCode, 404);
  });
});

describe('finishing a departure that was interrupted', () => {
  it('keeps offering the share key while the pass is still owed', async () => {
    // The deadlock this closes: an ended share still has a replica named under KS until its
    // owner converts it back, and that conversion needs this key. Withholding it because
    // the share is over locks the vault out of both — it cannot read the names, so it
    // cannot sync, and it cannot convert them, so it never will.
    const { shareId } = await sharedWith('key-after-end');
    const ks = await shareKeyOf(shareId);
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });

    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${strangerVaultId}`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'the key the finalization pass needs is still there',
    );
  });

  it('lets a client come back and begin again, rather than refusing', async () => {
    // A device interrupted between begin and finalize has to be able to return. Refusing
    // the second begin left it with no way to finish at all.
    const { shareId } = await sharedWith('begin-twice');
    const first = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(first.statusCode, 200);

    const again = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().ended, true, 'and it says the share is over, which it is');
  });

  it('stops offering the key once the pass has run', async () => {
    const { shareId } = await sharedWith('key-after-finalize');
    const ks = await shareKeyOf(shareId);
    await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    const nodes = await db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [strangerVaultId, shareId],
    );
    const keyId = await strangerVaultKey();
    const done = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: { authorization: `Bearer ${strangerAccess}` },
      payload: {
        nodes: nodes.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: keyId,
        })),
      },
    });
    assert.equal(done.statusCode, 204, done.body);

    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${strangerVaultId}`,
      headers: { authorization: `Bearer ${strangerAccess}` },
    });
    assert.ok(!r.json().scopes.some((s: { key_id: string }) => s.key_id === ks), 'nothing is named under it now');
  });
});

describe('leaving a share that never got off the ground', () => {
  it('cancels it rather than ending it, which the schema does not allow', async () => {
    // A 500 in a live vault: departMember wrote `ended` unconditionally, and `preparing`
    // may go only to `cancelled`. The share could not be left, and had no other way out
    // either — cancelling has no button.
    const folder = await createNode('folder', `leave-preparing-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().ended, true, 'it is over, whichever word the state uses');

    const state = await db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'cancelled');
  });

  it('still hands the replica back, so its names can return to the vault key', async () => {
    // The point of going through leave rather than a bare state change: the initiator's
    // client owes the same conversion pass, and it needs the key to run it.
    const folder = await createNode('folder', `leave-preparing-keys-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);
    await app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const member = await db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, userId],
    );
    assert.ok(member!.started, 'the pass is owed');
    assert.equal(member!.left, null, 'and not yet run');

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}`, headers: auth() });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'so the key it needs is still offered',
    );
  });
});

describe('a departure has to account for the trash too', () => {
  it('refuses a pass that leaves a deleted node still marked', async () => {
    // The 500 a live vault hit: the schema refuses to let a member leave while any node of
    // theirs carries the mark, and the completeness check only looked at LIVE ones. It is
    // not a technicality — a trashed node keeps its name, that name is under KS, and after
    // the pass the key is gone, so it would come back from the trash unopenable.
    const { shareId, inside, ks } = await sharedWith('trash-marked');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      vaultId,
      doomed,
    ]);
    await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });

    await app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    // Only the live nodes, which is what the client used to send.
    const liveOnly = await db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [vaultId, shareId],
    );
    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: liveOnly.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: vaultKeyId,
        })),
      },
    });

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'finalization_incomplete');
    assert.ok(r.json().missing.length > 0, 'and the trashed one is named among the missing');
  });

  it('accepts the pass once the trash is included, and clears its marks', async () => {
    const { shareId, inside, ks } = await sharedWith('trash-included');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      vaultId,
      doomed,
    ]);
    await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    await app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const all = await db.query<{ id: string }>(`SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2`, [
      vaultId,
      shareId,
    ]);
    const r = await app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: all.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: vaultKeyId,
        })),
      },
    });
    assert.equal(r.statusCode, 204, r.body);

    const left = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1 AND share_id = $2`, [vaultId, shareId]);
    assert.equal(left.length, 0, 'nothing carries the share any more, trashed or not');
  });

  it('lists a trashed FOLDER as part of the replica, which no other listing shows', async () => {
    // The deeper half of the same defect. The trash offers what can be restored, so it
    // shows only nodes with versions and never folders — and a trashed folder still carries
    // the mark that blocks a departure. A client asking the trash could not even discover
    // what was stopping it.
    const { shareId, inside, ks } = await sharedWith('trash-scope');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      vaultId,
      doomed,
    ]);
    await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });

    const r = await app.inject({ method: 'GET', url: `/shares/${shareId}/replica`, headers: auth() });
    const entry = (r.json() as { node_id: string; name_key_id: string; deleted: boolean }[]).find(
      (t) => t.node_id === doomed,
    );
    assert.ok(entry, 'the replica listing shows it');
    assert.equal(entry!.deleted, true);
    assert.equal(entry!.name_key_id, ks, 'still under the share key, which is why it must be converted');

    const trash = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/trash`, headers: auth() });
    assert.ok(
      !(trash.json() as { node_id: string }[]).some((t) => t.node_id === doomed),
      'and the trash does not, which is the whole point of asking somewhere else',
    );
  });
});
