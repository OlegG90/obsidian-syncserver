/**
 * "My client is the source of truth": what a reset destroys, and the two things it must
 * not touch.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

const STORE = `var/test-reset-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let userId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });

/** A fresh vault each time: a reset is destructive, so tests must not share one. */
const freshVault = async () => {
  const id = randomUUID();
  const r = await app.inject({
    method: 'POST', url: '/vaults', headers: auth(),
    payload: { id, name_enc: Buffer.from('reset vault').toString('base64') },
  });
  assert.equal(r.statusCode, 201, r.body);
  const keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [id]))!.id;
  return { vaultId: id, rootId: r.json().root_node_id as string, keyId };
};

const putBlob = async (body: Buffer, keyId: string) => {
  const hex = sha(body);
  const r = await app.inject({
    method: 'POST', url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: keyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return hex;
};

const addNode = async (
  v: { vaultId: string; keyId: string },
  name: string,
  parent: string,
  type: 'file' | 'folder' = 'file',
) => {
  const body = randomBytes(24);
  const hex = type === 'file' ? await putBlob(body, v.keyId) : undefined;
  const r = await app.inject({
    method: 'POST', url: `/vaults/${v.vaultId}/nodes`, headers: auth(),
    payload: {
      parent_id: parent, type, ...(hex ? { sha256: hex, size: body.length } : {}),
      mtime: new Date().toISOString(),
      name_enc: Buffer.from(name).toString('base64'),
      name_hmac: sha(Buffer.from(name)), name_key_id: v.keyId,
      ...(hex
        ? {
            blob_envelopes: [{ sha256: hex, scope_id: v.keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
            dedup_tags: [{ sha256: hex, scope_id: v.keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
          }
        : {}),
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().node_id as string;
};

const alive = async (vaultId: string, nodeId: string) =>
  (await db.one(`SELECT 1 AS x FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, nodeId])) !== undefined;

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 104857600)`,
    [userId, `reset-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [userId]);
  access = app.jwt.sign({ sub: userId, device: device!.id });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('reset', () => {
  it('hard-destroys the vault tree and keeps the root', async () => {
    const v = await freshVault();
    const folder = await addNode(v, 'Notes', v.rootId, 'folder');
    const file = await addNode(v, 'a.md', folder);

    const r = await app.inject({ method: 'POST', url: `/vaults/${v.vaultId}/reset`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().root_node_id, v.rootId);

    assert.equal(await alive(v.vaultId, v.rootId), true, 'the root stays; it is the vault');
    assert.equal(await alive(v.vaultId, folder), false);
    assert.equal(await alive(v.vaultId, file), false);

    // Hard, not soft (AC-14): nothing is left in the trash to purge later.
    const trash = await app.inject({ method: 'GET', url: `/vaults/${v.vaultId}/trash`, headers: auth() });
    assert.equal(trash.json().total, 0, 'space is freed at once, with no leftover occupying quota');
  });

  it('bumps the epoch, so every other device is answered 410 reset', async () => {
    const v = await freshVault();
    await addNode(v, 'b.md', v.rootId);

    // A cursor taken before the reset, exactly as another device would hold.
    const before_ = await app.inject({ method: 'GET', url: `/vaults/${v.vaultId}/delta`, headers: auth() });
    const staleCursor = before_.json().next_cursor;

    const epochBefore = (await db.one<{ e: string }>(
      `SELECT reset_epoch::text AS e FROM vaults WHERE id = $1`, [v.vaultId]))!.e;

    const r = await app.inject({ method: 'POST', url: `/vaults/${v.vaultId}/reset`, headers: auth() });
    assert.equal(r.json().reset_epoch, Number(epochBefore) + 1);

    const after_ = await app.inject({
      method: 'GET', url: `/vaults/${v.vaultId}/delta`, headers: auth(), query: { cursor: staleCursor },
    });
    assert.equal(after_.statusCode, 410);
    assert.equal(after_.json().reason, 'reset', 'this device applies the deletions; it does not upload them back');
  });

  it('recounts quota rather than leaving it to a later reconciliation', async () => {
    const v = await freshVault();
    await addNode(v, 'heavy.md', v.rootId);

    const before_ = (await app.inject({ method: 'GET', url: '/usage', headers: auth() })).json().used;
    await app.inject({ method: 'POST', url: `/vaults/${v.vaultId}/reset`, headers: auth() });
    const after_ = (await app.inject({ method: 'GET', url: '/usage', headers: auth() })).json().used;

    assert.ok(after_ < before_, 'the accounting is right when the transaction commits');
  });

  it('recounts quota when a whole vault goes, not only when it is reset', async () => {
    // Removing a vault takes its tree and its history with it (#175), so the blobs it was the last to
    // reference are held by nothing — and an account that deleted a vault to make room would otherwise
    // still read as full until the sweep ran.
    const v = await freshVault();
    await addNode(v, 'heavy.md', v.rootId);

    const before_ = (await app.inject({ method: 'GET', url: '/usage', headers: auth() })).json().used;
    const gone = await app.inject({ method: 'DELETE', url: `/vaults/${v.vaultId}`, headers: auth() });
    assert.equal(gone.statusCode, 204, gone.body);
    const after_ = (await app.inject({ method: 'GET', url: '/usage', headers: auth() })).json().used;

    assert.ok(after_ < before_, 'the accounting is right when the transaction commits');
  });

  it('answers 404 for a vault of another account', async () => {
    const stranger = randomUUID();
    await db.query(
      `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
      [stranger, `reset-stranger-${process.pid}`]);
    const scope = await db.one<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    const theirVault = randomUUID();
    const theirRoot = randomUUID();
    await db.tx(async (c) => {
      await c.query(`INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
                     VALUES ($1, $2, '\\xbb', $3, $4, 'vault')`, [theirVault, stranger, theirRoot, scope!.id]);
      await c.query(`INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev)
                     VALUES ($1, $2, NULL, 'folder', now(), 0)`, [theirVault, theirRoot]);
    });

    const r = await app.inject({ method: 'POST', url: `/vaults/${theirVault}/reset`, headers: auth() });
    assert.equal(r.statusCode, 404);
    assert.equal(await alive(theirVault, theirRoot), true, 'and it destroyed nothing');
  });
});

describe('a reset never touches a share (SH-27)', () => {
  it('keeps the replica AND the private chain it hangs from', async () => {
    const v = await freshVault();

    // A private folder the shared folder sits inside — the ordinary case, since a joiner
    // picks a local parent for the replica root.
    const parent = await addNode(v, 'Shared folders', v.rootId, 'folder');
    const shareRoot = await addNode(v, 'Family', parent, 'folder');

    // Ordinary content that the reset is supposed to destroy, one of it a sibling of the
    // share inside the same private folder.
    const loose = await addNode(v, 'loose.md', v.rootId);
    const sibling = await addNode(v, 'sibling.md', parent);

    const shareId = randomUUID();
    const itemId = randomUUID();
    await db.tx(async (c) => {
      await c.query(`INSERT INTO key_scopes (id, kind) VALUES ($1, 'share')`, [randomUUID()]);
      await c.query(
        `INSERT INTO shares (id, initiator_id, initiator_vault_id, subtree_node_id, state, root_item_id)
         VALUES ($1, $2, $3, $4, 'preparing', $5)`,
        [shareId, userId, v.vaultId, shareRoot, itemId]);
      await c.query(
        `INSERT INTO share_members (share_id, user_id, vault_id, joined_at) VALUES ($1, $2, $3, now())`,
        [shareId, userId, v.vaultId]);
      await c.query(
        `UPDATE nodes SET share_id = $3, share_item_id = $4 WHERE vault_id = $1 AND id = $2`,
        [v.vaultId, shareRoot, shareId, itemId]);
    });

    const r = await app.inject({ method: 'POST', url: `/vaults/${v.vaultId}/reset`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);

    assert.equal(await alive(v.vaultId, shareRoot), true, 'the replica is excluded (SH-27)');
    assert.equal(await alive(v.vaultId, parent), true,
      'and so is the chain it hangs from — parent_id is ON DELETE RESTRICT, so keeping one without the other fails');
    assert.equal(await alive(v.vaultId, v.rootId), true);

    assert.equal(await alive(v.vaultId, loose), false, 'ordinary content still goes');
    assert.equal(await alive(v.vaultId, sibling), false, 'including a sibling of the share');
  });
});
