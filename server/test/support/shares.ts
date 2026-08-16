/**
 * The world every share suite needs, built once per file.
 *
 * Three suites read this — the lifecycle, replication, and the surfaces other route families
 * ask about — and they used to be one file of 2259 lines because these fixtures were in it.
 * Splitting the assertions without moving the fixtures would only have made three copies of
 * the setup, which is the shape this repository argues against everywhere else.
 *
 * **Each file gets its OWN world**, with its own app, its own accounts and its own vaults,
 * distinguished by the label it passes. Sharing one across files would recreate the trap
 * `AGENTS.md` records: whoever claims the seeded administrator first leaves the others
 * answering 503 to everything.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { connect, type Db } from '../../src/db.js';

/**
 * The fixtures, filled in by `openWorld` and read by every helper below.
 *
 * A mutable object rather than module-level `let`s, because the helpers are exported now: a
 * binding that is reassigned after import would leave each importer holding the value it had
 * at import time.
 */
export const w = {
  db: undefined as unknown as Db,
  app: undefined as unknown as FastifyInstance,
  store: '',
  /** The initiator, and a second account that is in none of their shares. */
  access: '',
  userId: '',
  strangerAccess: '',
  strangerId: '',
  strangerVaultId: '',
  vaultId: '',
  vaultKeyId: '',
  rootId: '',
};

/** Build the world: an app, two accounts, a vault each, and the seeded administrator claimed. */
export const openWorld = async (label: string): Promise<void> => {
  w.store = `var/test-${label}-${process.pid}`;
  w.db = connect(loadConfig().databaseUrl);
  w.app = await buildApp(w.db, { ...loadConfig(), blobStorePath: w.store });

  // Claim the seeded administrator, so each file stands on its own. Until one exists the API
  // answers 503 to everything but its redemption (#107) — and this suite used to pass only
  // because another file had happened to run first and claim it.
  await w.db.query(
    `UPDATE users SET state = 'active', role = 'admin', auth_secret_hash = 'h',
            account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\x01', enc_privkey = '\x02',
            kek_verifier_hash = 'kv',
            recovery_key = '\x03', recovery_code_hash = 'rh', wrapped_seed = '\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  const initiator = await makeAccount(`${label}-initiator`);
  w.userId = initiator.id;
  w.access = initiator.access;
  const stranger = await makeAccount(`${label}-stranger`);
  w.strangerAccess = stranger.access;
  w.strangerId = stranger.id;

  w.vaultId = randomUUID();
  const created = await w.app.inject({
    method: 'POST',
    url: '/vaults',
    headers: auth(),
    payload: { id: w.vaultId, name_enc: b64('shared vault') },
  });
  assert.equal(created.statusCode, 201, created.body);
  w.rootId = created.json().root_node_id;

  const scope = await w.db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [w.vaultId]);
  w.vaultKeyId = scope!.id;

  w.strangerVaultId = randomUUID();
  const theirs = await w.app.inject({
    method: 'POST',
    url: '/vaults',
    headers: { authorization: `Bearer ${w.strangerAccess}` },
    payload: { id: w.strangerVaultId, name_enc: b64('their vault') },
  });
  assert.equal(theirs.statusCode, 201, theirs.body);
};

export const closeWorld = async (): Promise<void> => {
  await w.app.close();
  await w.db.close();
  await rm(w.store, { recursive: true, force: true });
};

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export const auth = () => ({ authorization: `Bearer ${w.access}` });

export const b64 = (s: string) => Buffer.from(s).toString('base64');

/** An active account with a device token, since every route here is behind auth. */
export const makeAccount = async (label: string) => {
  const id = randomUUID();
  await w.db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
    [id, `${label}-${process.pid}`],
  );
  const device = await w.db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [id],
  );
  return { id, access: w.app.jwt.sign({ sub: id, device: device!.id }) };
};

export const createNode = async (type: 'folder', name: string, parent = w.rootId, keyId?: string) => {
  const r = await w.app.inject({
    method: 'POST',
    url: `/vaults/${w.vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: parent,
      type,
      mtime: new Date().toISOString(),
      name_enc: b64(name),
      name_hmac: sha(Buffer.from(name)),
      // Inside an active share a name must use the SHARE key: the schema refuses one
      // that does not (SH-26).
      name_key_id: keyId ?? w.vaultKeyId,
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return (r.json() as { node_id: string }).node_id;
};

/** Upload bytes and return their address — a node may only reference a blob that exists. */
export const putBlob = async (body: Buffer, keyId: string): Promise<string> => {
  const hex = sha(body);
  const r = await w.app.inject({
    method: 'POST',
    url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: keyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return hex;
};

export const materialFor = (hex: string, keyId: string) => ({
  blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
  dedup_tags: [{ sha256: hex, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
});

/** A file inside a share, sealed under the share key like every interior node. */
export const createFile = async (parentId: string, name: string, body: string, keyId: string) => {
  const bytes = Buffer.from(body);
  const hex = await putBlob(bytes, keyId);
  const r = await w.app.inject({
    method: 'POST',
    url: `/vaults/${w.vaultId}/nodes`,
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
export const putFile = async (file: { nodeId: string; sha256: string; keyId: string }, body: string) => {
  const bytes = Buffer.from(body);
  const hex = await putBlob(bytes, file.keyId);
  const r = await w.app.inject({
    method: 'PUT',
    url: `/vaults/${w.vaultId}/nodes/${file.nodeId}`,
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

export const openShare = (nodeId: string, token = w.access) =>
  w.app.inject({
    method: 'POST',
    url: '/shares',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      vault_id: w.vaultId,
      node_id: nodeId,
      subtree_key_id: randomUUID(),
      wrapped_key_initiator: b64('a wrapped KS'),
    },
  });

/** A folder that is shared and open for invitations. */
export const activeShare = async (label: string) => {
  const folder = await createNode('folder', `${label}-${randomUUID()}`);
  const shareId = (await openShare(folder)).json().share_id;
  const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
  assert.equal(r.statusCode, 200, r.body);
  return shareId;
};

export const inviteTo = (shareId: string, target: string, token = w.access) =>
  w.app.inject({
    method: 'POST',
    url: `/shares/${shareId}/invite`,
    headers: { authorization: `Bearer ${token}` },
    payload: { user_id: target, wrapped_key: b64('an HPKE envelope') },
  });

/** The share key scope of a share, which is what preparation must name. */
export const shareKeyOf = async (shareId: string) => {
  const row = await w.db.one<{ id: string }>(`SELECT subtree_key_id AS id FROM shares WHERE id = $1`, [shareId]);
  return row!.id;
};

export const prepare = (shareId: string, items: unknown[], token = w.access) =>
  w.app.inject({
    method: 'POST',
    url: `/shares/${shareId}/prepare`,
    headers: { authorization: `Bearer ${token}` },
    payload: { items },
  });

/** The joiner's own root folder, where a replica can land. */
export const strangerRoot = async () => {
  const row = await w.db.one<{ id: string }>(`SELECT root_node_id AS id FROM vaults WHERE id = $1`, [w.strangerVaultId]);
  return row!.id;
};

export const strangerVaultKey = async () => {
  const row = await w.db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [w.strangerVaultId]);
  return row!.id;
};

// A fresh name per join: siblings must be uniquely named, and several tests land a
// replica under the same folder of the same vault.
export const join = async (shareId: string, name = `their copy ${randomUUID()}`) =>
  w.app.inject({
    method: 'POST',
    url: `/shares/${shareId}/join`,
    headers: { authorization: `Bearer ${w.strangerAccess}` },
    payload: {
      vault_id: w.strangerVaultId,
      parent_id: await strangerRoot(),
      name_enc: b64(name),
      name_hmac: sha(Buffer.from(name)),
      name_key_id: await strangerVaultKey(),
    },
  });

/** An active share with one interior folder, and an outstanding invitation to the stranger. */
export const invitedShare = async (label: string) => {
  const folder = await createNode('folder', `${label}-${randomUUID()}`);
  const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
  const shareId = (await openShare(folder)).json().share_id;
  const ks = await shareKeyOf(shareId);
  await prepare(shareId, [
    { node_id: inside, name_enc: b64('interior'), name_hmac: sha(Buffer.from('interior')), name_key_id: ks },
  ]);
  const activated = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal((await inviteTo(shareId, w.strangerId)).statusCode, 204);
  return { shareId, folder, inside, ks };
};

/** A share the stranger has actually joined, with both replicas in place. */
export const sharedWith = async (label: string) => {
  const { shareId, folder, inside, ks } = await invitedShare(label);
  const r = await join(shareId);
  assert.equal(r.statusCode, 201, r.body);
  return { shareId, folder, inside, ks, replicaRoot: r.json().root_node_id };
};

/** The stranger's copy of an item the initiator holds. */
export const theirCopyOf = async (srcNodeId: string) => {
  const row = await w.db.one<{ id: string }>(
    `SELECT b.id FROM nodes a JOIN nodes b ON b.share_item_id = a.share_item_id AND b.vault_id = $3
      WHERE a.vault_id = $1 AND a.id = $2`,
    [w.vaultId, srcNodeId, w.strangerVaultId],
  );
  return row?.id;
};

/** Every node of the stranger's replica, in the shape finalize-leave wants. */
export const theirReplicaNodes = async (shareId: string) => {
  const rows = await w.db.query<{ id: string }>(
    `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
    [w.strangerVaultId, shareId],
  );
  const keyId = await strangerVaultKey();
  return rows.map((r) => {
    const name = `back-under-kv-${r.id}`;
    return { node_id: r.id, name_enc: b64(name), name_hmac: sha(Buffer.from(name)), name_key_id: keyId };
  });
};

export const leaveBegin = (shareId: string, token = w.strangerAccess) =>
  w.app.inject({
    method: 'POST',
    url: `/shares/${shareId}/leave/begin`,
    headers: { authorization: `Bearer ${token}` },
  });

export const finalize = (shareId: string, nodes: unknown[], token = w.strangerAccess) =>
  w.app.inject({
    method: 'POST',
    url: `/shares/${shareId}/finalize-leave`,
    headers: { authorization: `Bearer ${token}` },
    payload: { nodes },
  });

/** The replica as its owner sees it, in the shape a departure has to answer with. */
export type ReplicaRow = {
  node_id: string;
  sha256: string | null;
  deleted: boolean;
  needs_vault_material: boolean;
  history_needing_material: string[];
};
