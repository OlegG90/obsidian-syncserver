/**
 * History, trash and restore — the other half of "delete", which until now had no way back.
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

const STORE = `var/test-history-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let userId: string;
let vaultId: string;
let rootId: string;
let keyId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });

const putBlob = async (body: Buffer) => {
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

const material = (hex: string) => ({
  blob_envelopes: [{ sha256: hex, scope_id: keyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
  dedup_tags: [{ sha256: hex, scope_id: keyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
});

const createNode = async (name: string, parent: string, type: 'file' | 'folder' = 'file') => {
  const body = randomBytes(32);
  const hex = type === 'file' ? await putBlob(body) : undefined;
  const r = await app.inject({
    method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
    payload: {
      parent_id: parent, type, ...(hex ? { sha256: hex, size: body.length } : {}),
      mtime: new Date().toISOString(),
      name_enc: Buffer.from(name).toString('base64'),
      name_hmac: sha(Buffer.from(name)), name_key_id: keyId,
      ...(hex ? material(hex) : {}),
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { node_id: string; rev: number };
};

const del = (nodeId: string, rev: number) =>
  app.inject({ method: 'DELETE', url: `/vaults/${vaultId}/nodes/${nodeId}`, headers: { ...auth(), 'if-match': String(rev) } });

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  await db.query(
    `UPDATE users SET state = 'active', role = 'admin', auth_secret_hash = 'h',
            account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\\x01', enc_privkey = '\\x02',
            kek_verifier_hash = 'kv',
            recovery_key = '\\x03', recovery_code_hash = 'rh', wrapped_seed = '\\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 104857600)`,
    [userId, `history-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [userId]);
  access = app.jwt.sign({ sub: userId, device: device!.id });

  vaultId = randomUUID();
  const created = await app.inject({
    method: 'POST', url: '/vaults', headers: auth(),
    payload: { id: vaultId, name_enc: Buffer.from('history vault').toString('base64') },
  });
  rootId = created.json().root_node_id;
  keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [vaultId]))!.id;
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('versions', () => {
  it('records one per write, newest first, attributed to the writer', async () => {
    const file = await createNode('versioned.md', rootId);

    const body = randomBytes(24);
    const hex = await putBlob(body);
    const cur = await db.one<{ s: string }>(
      `SELECT encode(sha256,'hex') AS s FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, file.node_id]);
    await app.inject({
      method: 'PUT', url: `/vaults/${vaultId}/nodes/${file.node_id}`, headers: auth(),
      payload: { sha256: hex, size: body.length, mtime: new Date().toISOString(), base_sha256: cur!.s, ...material(hex) },
    });

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() });
    assert.equal(r.statusCode, 200);
    const versions = r.json();
    assert.equal(versions.length, 2);
    assert.ok(versions[0].rev > versions[1].rev, 'newest first');
    assert.equal(versions[0].author_id, userId);
  });
});

describe('trash', () => {
  it('is a query, not a place: the deleted row IS the entry', async () => {
    const file = await createNode('doomed.md', rootId);
    assert.equal((await del(file.node_id, file.rev)).statusCode, 200);

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/trash`, headers: auth() });
    assert.equal(r.statusCode, 200);
    const entry = r.json().entries.find((e: { node_id: string }) => e.node_id === file.node_id);
    assert.ok(entry, 'the soft-deleted node is what the trash lists');
    assert.ok(entry.versions > 0);
  });

  it('omits what can no longer be brought back', async () => {
    const file = await createNode('thinned.md', rootId);
    await del(file.node_id, file.rev);
    // What retention thinning eventually does; its effect on the trash is the point here.
    await db.query(`DELETE FROM versions WHERE vault_id = $1 AND node_id = $2`, [vaultId, file.node_id]);

    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/trash`, headers: auth() });
    assert.ok(!r.json().entries.some((e: { node_id: string }) => e.node_id === file.node_id),
      'offering a restore that cannot happen is worse than not offering it');
  });
});

describe('restore', () => {
  it('is an ordinary write: a put carrying an old hash, producing a NEW version', async () => {
    const file = await createNode('back.md', rootId);
    const original = (await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() })).json()[0];
    await del(file.node_id, file.rev);

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/restore`, headers: auth(),
      payload: { node_id: file.node_id, rev: original.rev },
    });
    assert.equal(r.statusCode, 200, r.body);

    const node = await db.one<{ deleted: string | null; s: string }>(
      `SELECT deleted_at AS deleted, encode(sha256,'hex') AS s FROM nodes WHERE vault_id = $1 AND id = $2`,
      [vaultId, file.node_id]);
    assert.equal(node!.deleted, null);
    assert.equal(node!.s, original.sha256, 'the old content is back');

    const versions = (await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() })).json();
    assert.equal(versions.length, 2, 'going back is something that happened, not something that unhappened');
    assert.equal(versions[0].sha256, original.sha256);
    assert.ok(versions[0].rev > original.rev);
  });

  it('lifts the ancestor chain, because a file inside a deleted folder cannot be materialised (#59)', async () => {
    const folder = await createNode('box', rootId, 'folder');
    const file = await createNode('inside.md', folder.node_id);
    const version = (await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() })).json()[0];

    // Delete the child first — the schema will not let a folder go while a live child is in it.
    await del(file.node_id, file.rev);
    const folderNow = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, folder.node_id]);
    await del(folder.node_id, Number(folderNow!.rev));

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/restore`, headers: auth(),
      payload: { node_id: file.node_id, rev: version.rev },
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().lifted, [folder.node_id], 'the folder came back with it');

    const back = await db.one<{ deleted: string | null }>(
      `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, folder.node_id]);
    assert.equal(back!.deleted, null);
  });

  it('refuses a name taken since, and names what is in the way (#36)', async () => {
    const file = await createNode('contested.md', rootId);
    const version = (await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() })).json()[0];
    await del(file.node_id, file.rev);

    // Somebody creates a new file under the same name while the old one is in the trash.
    const replacement = await createNode('contested.md', rootId);

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/restore`, headers: auth(),
      payload: { node_id: file.node_id, rev: version.rev },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'name_taken');
    assert.equal(r.json().blocked_by, replacement.node_id,
      'no automatic suffix: a file silently named "Note (1).md" is one the user cannot account for');
  });

  it('refuses a version that does not exist', async () => {
    const file = await createNode('once.md', rootId);
    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/restore`, headers: auth(),
      payload: { node_id: file.node_id, rev: 999999 },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'no_such_version');
  });

  it('refuses while the account is frozen — restoring grows usage (SH-20)', async () => {
    const file = await createNode('frozen-out.md', rootId);
    const version = (await app.inject({ method: 'GET', url: `/vaults/${vaultId}/versions/${file.node_id}`, headers: auth() })).json()[0];
    await del(file.node_id, file.rev);

    await db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [userId]);
    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/restore`, headers: auth(),
      payload: { node_id: file.node_id, rev: version.rev },
    });
    await db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [userId]);

    assert.equal(r.statusCode, 413);
    assert.equal(r.json().error, 'frozen');
  });
});

describe('emptying the trash — the only way usage goes down', () => {
  const usageOf = async () => {
    const row = await db.one<{ used: string }>(
      `SELECT COALESCE(SUM(b.size), 0)::text AS used
         FROM user_blobs ub JOIN blobs b ON b.sha256 = ub.sha256
        WHERE ub.user_id = $1`,
      [userId],
    );
    return BigInt(row!.used);
  };

  const purge = (nodeId?: string) =>
    app.inject({
      method: 'DELETE',
      url: nodeId ? `/vaults/${vaultId}/trash/${nodeId}` : `/vaults/${vaultId}/trash`,
      headers: auth(),
    });

  it('discards the node, its versions and the claim on its bytes', async () => {
    const file = await createNode(`discarded-${randomUUID()}.md`, rootId);
    const before = await usageOf();
    await del(file.node_id, file.rev);

    // Deleting is soft, so nothing has been freed yet — which is the whole reason this
    // endpoint exists.
    assert.equal(await usageOf(), before, 'a soft delete frees nothing');

    const r = await purge(file.node_id);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().purged, 1);

    const left = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, file.node_id]);
    assert.equal(left!.n, '0', 'the row is gone, not merely flagged again');
    const versions = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM versions WHERE vault_id = $1 AND node_id = $2`, [vaultId, file.node_id]);
    assert.equal(versions!.n, '0', 'and its history went with it, by cascade');
    assert.ok(await usageOf() < before, 'usage falls, which nothing else in this product does');
  });

  it('lets a frozen account free space and come back — SH-20, made true', async () => {
    // The scenario M4 exists for. Deleting has to stay available to a frozen account: it is
    // the only way out, so a freeze that blocked it would be a deadlock.
    const file = await createNode(`way-out-${randomUUID()}.md`, rootId);
    await del(file.node_id, file.rev);
    await db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [userId]);

    const r = await purge(file.node_id);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().thawed, true, 'the freeze lifts in the same transaction that freed the space');

    const still = await db.one<{ frozen: string | null }>(
      `SELECT frozen_at AS frozen FROM users WHERE id = $1`, [userId]);
    assert.equal(still!.frozen, null);
  });

  it('takes a folder and everything under it, deepest first', async () => {
    // `parent_id` is ON DELETE RESTRICT, so a parent removed before its children errors out.
    const folder = await createNode(`box-${randomUUID()}`, rootId, 'folder');
    const inner = await createNode(`inner-${randomUUID()}`, folder.node_id, 'folder');
    const leaf = await createNode(`leaf-${randomUUID()}.md`, inner.node_id);

    await del(leaf.node_id, leaf.rev);
    const innerRev = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, inner.node_id]);
    await del(inner.node_id, Number(innerRev!.rev));
    const folderRev = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, folder.node_id]);
    await del(folder.node_id, Number(folderRev!.rev));

    const r = await purge(folder.node_id);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().purged, 3, 'the folder, the folder inside it, and the file');
  });

  it('refuses a trashed folder that still holds something alive', async () => {
    // Deleting a folder does not delete what is in it, so a purge that removed the folder
    // would orphan a live file — which the foreign key refuses, in a sentence about a
    // constraint the caller cannot see. This says the thing itself.
    const folder = await createNode(`half-${randomUUID()}`, rootId, 'folder');
    await createNode(`alive-${randomUUID()}.md`, folder.node_id);
    const rev = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, folder.node_id]);
    await del(folder.node_id, Number(rev!.rev));

    const r = await purge(folder.node_id);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /not deleted/);
  });

  it('refuses a node that is not in the trash at all', async () => {
    const file = await createNode(`alive-${randomUUID()}.md`, rootId);
    const r = await purge(file.node_id);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /not in the trash/);
  });

  it('empties the whole trash, and skips what it may not take', async () => {
    const doomed = await createNode(`sweep-${randomUUID()}.md`, rootId);
    await del(doomed.node_id, doomed.rev);
    const keeper = await createNode(`keeper-${randomUUID()}`, rootId, 'folder');
    await createNode(`still-here-${randomUUID()}.md`, keeper.node_id);
    const rev = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, keeper.node_id]);
    await del(keeper.node_id, Number(rev!.rev));

    const r = await purge();
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(r.json().purged >= 1);

    const gone = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, doomed.node_id]);
    assert.equal(gone!.n, '0');
    const kept = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, keeper.node_id]);
    assert.equal(kept!.n, '1', 'a folder holding something alive is left where it is, not failed over');
  });
});
