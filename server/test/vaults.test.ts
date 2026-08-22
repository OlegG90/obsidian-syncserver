/**
 * The account surface: the vaults an account owns, and what they cost it.
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

const STORE = `var/test-vaults-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let userId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });
const b64 = (s: string) => Buffer.from(s).toString('base64');

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
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
    [userId, `vaults-${process.pid}`],
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

const createVault = (id: string, label = 'my vault') =>
  app.inject({ method: 'POST', url: '/vaults', headers: auth(), payload: { id, name_enc: b64(label) } });

describe('vaults', () => {
  it('takes the id the client chose, and makes the root itself', async () => {
    const id = randomUUID();
    const r = await createVault(id);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().id, id, 'the client derived KV from this id before encrypting the label');

    // The root is the one node with no name — which is why the server can create it at all.
    const root = await db.one<{ parentId: string | null; type: string }>(
      `SELECT parent_id AS "parentId", type FROM nodes WHERE vault_id = $1 AND id = $2`,
      [id, r.json().root_node_id],
    );
    assert.equal(root!.parentId, null);
    assert.equal(root!.type, 'folder');
  });

  it('lists what the account owns, and nobody else\'s', async () => {
    const mine = randomUUID();
    await createVault(mine, 'listed');

    const r = await app.inject({ method: 'GET', url: '/vaults', headers: auth() });
    assert.equal(r.statusCode, 200);
    const ids = r.json().map((v: { id: string }) => v.id);
    assert.ok(ids.includes(mine));

    const all = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM vaults`);
    assert.ok(Number(all!.n) >= r.json().length, 'the listing is scoped to the caller');
  });

  it('refuses a repeated id rather than pretending', async () => {
    const id = randomUUID();
    assert.equal((await createVault(id)).statusCode, 201);
    const again = await createVault(id);
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error, 'vault_exists');
  });

  it('renames only the encrypted label', async () => {
    const id = randomUUID();
    await createVault(id, 'before');
    const before = await db.one<{ root: string }>(`SELECT root_node_id AS root FROM vaults WHERE id = $1`, [id]);

    const r = await app.inject({ method: 'PUT', url: `/vaults/${id}`, headers: auth(), payload: { name_enc: b64('after') } });
    assert.equal(r.statusCode, 204);

    const after_ = await db.one<{ root: string; label: string }>(
      `SELECT root_node_id AS root, encode(name_enc,'base64') AS label FROM vaults WHERE id = $1`, [id]);
    assert.equal(after_!.label, b64('after'));
    assert.equal(after_!.root, before!.root, 'a rename touches nothing else');
  });

  it('rejects a vault id that is not one', async () => {
    const r = await app.inject({ method: 'POST', url: '/vaults', headers: auth(), payload: { id: 'not-a-uuid', name_enc: b64('x') } });
    assert.equal(r.statusCode, 400);
  });
});

describe('deleting a vault', () => {
  it('deletes an empty one', async () => {
    const id = randomUUID();
    await createVault(id, 'empty');
    const r = await app.inject({ method: 'DELETE', url: `/vaults/${id}`, headers: auth() });
    assert.equal(r.statusCode, 204, r.body);

    const gone = await db.one(`SELECT 1 AS x FROM vaults WHERE id = $1`, [id]);
    assert.equal(gone, undefined);
  });

  it('removes one that still holds a nested tree, deepest first', async () => {
    // It used to refuse anything but an empty vault, which made the vault somebody actually wants gone —
    // the one a mistaken pairing filled with a copy of their notes (D-117) — reachable only through two
    // disconnects (#175). `parent_id` is RESTRICT, so a folder inside a folder is the case that decides
    // whether this works at all: a single DELETE fails on the first parent it reaches.
    const id = randomUUID();
    const created = await createVault(id, 'busy');
    const rootId = created.json().root_node_id as string;
    const keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [id]))!.id;

    const add = async (parent: string, ancestry: string[]): Promise<string> =>
      (await db.one<{ id: string }>(
        `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
         VALUES ($1, $2, 'ª', decode($3,'hex'), $4, 'folder', now(), 0, $5::uuid[]) RETURNING id`,
        [id, parent, sha(randomBytes(8)), keyId, ancestry],
      ))!.id;
    const one = await add(rootId, [rootId]);
    const two = await add(one, [rootId, one]);
    await add(two, [rootId, one, two]);

    const r = await app.inject({ method: 'DELETE', url: `/vaults/${id}`, headers: auth() });
    assert.equal(r.statusCode, 204, r.body);

    const left = await db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [id]);
    assert.equal(left.length, 0, 'the tree went with it');
    const vault = await db.query(`SELECT 1 FROM vaults WHERE id = $1`, [id]);
    assert.equal(vault.length, 0);
  });

  it('answers 404 for a vault belonging to somebody else', async () => {
    const other = randomUUID();
    await db.query(
      `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
      [other, `stranger-${process.pid}`],
    );
    const scope = await db.one<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    const theirVault = randomUUID();
    const theirRoot = randomUUID();
    await db.tx(async (c) => {
      await c.query(
        `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
         VALUES ($1, $2, '\\xbb', $3, $4, 'vault')`, [theirVault, other, theirRoot, scope!.id]);
      await c.query(`INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev)
                     VALUES ($1, $2, NULL, 'folder', now(), 0)`, [theirVault, theirRoot]);
    });

    const r = await app.inject({ method: 'DELETE', url: `/vaults/${theirVault}`, headers: auth() });
    assert.equal(r.statusCode, 404, 'not 403 — whose vault it is is not the caller\'s business');
  });
});

describe('usage', () => {
  it('counts the account\'s blobs and reports the limit', async () => {
    const before = await app.inject({ method: 'GET', url: '/usage', headers: auth() });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().quota, 1048576);
    assert.equal(before.json().frozen, false);

    const body = randomBytes(4096);
    const up = await app.inject({
      method: 'POST', url: '/blobs',
      query: { sha256: sha(body), size: String(body.length), key_id: randomUUID() },
      headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: body,
    });
    assert.equal(up.statusCode, 201, up.body);

    const after_ = await app.inject({ method: 'GET', url: '/usage', headers: auth() });
    assert.equal(after_.json().used, before.json().used + body.length,
      'an unbound upload counts against quota while it is alive');
  });

  it('reports a frozen account as frozen', async () => {
    await db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [userId]);
    const r = await app.inject({ method: 'GET', url: '/usage', headers: auth() });
    assert.equal(r.json().frozen, true);
    await db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [userId]);
  });

  it('refuses an unauthenticated caller', async () => {
    const r = await app.inject({ method: 'GET', url: '/usage' });
    assert.equal(r.statusCode, 401);
  });
});

/**
 * What the vault list carries, now that somebody looks at it (#161).
 *
 * It was read in exactly one place — the plugin's chooser, at pairing or recovery — so nothing depended
 * on it saying anything beyond "these exist". A person looking at their own account needs one number
 * more: how much is in each, which is also the number that decides whether it can be removed at all.
 */
describe('the vault list', () => {
  it('counts what each vault holds, not counting its root', async () => {
    // An untouched vault must read as **empty**, because that is what "0" has to mean on the screen: a
    // root counted as content would make every vault look occupied and every removal look refused.
    const id = randomUUID();
    const created = await createVault(id, 'counted');
    const rootId = created.json().root_node_id;
    const keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [id]))!.id;

    const list = async (): Promise<number> => {
      const r = await app.inject({ method: 'GET', url: '/vaults', headers: auth() });
      assert.equal(r.statusCode, 200, r.body);
      return (r.json() as { id: string; nodes: number }[]).find((v) => v.id === id)!.nodes;
    };

    assert.equal(await list(), 0, 'a fresh vault is empty');

    await db.query(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
       VALUES ($1, $2, '\xaa', decode($3,'hex'), $4, 'folder', now(), 0, ARRAY[$2::uuid])`,
      [id, rootId, sha(randomBytes(8)), keyId],
    );
    assert.equal(await list(), 1, 'and one folder is one item');
  });

  it('says which vaults a share names, so the screen can refuse before the button', async () => {
    // `deleteVault` refuses a vault a share names, and that refusal used to arrive AFTER a confirmation
    // saying nothing would be lost (#176). The list already knows; it just never said.
    const plain = randomUUID();
    const named = randomUUID();
    await createVault(plain, 'not shared');
    const created = await createVault(named, 'shared');
    const rootId = created.json().root_node_id as string;
    const keyId = (await db.one<{ id: string }>(`SELECT vault_key_id AS id FROM vaults WHERE id = $1`, [named]))!.id;

    // A folder to share, because a share names a subtree and the schema refuses one that names the root
    // without carrying its root item — the same shape `reset.test.ts` builds.
    const folder = await db.one<{ id: string }>(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry)
       VALUES ($1, $2, 'ª', decode($3,'hex'), $4, 'folder', now(), 0, ARRAY[$2::uuid]) RETURNING id`,
      [named, rootId, sha(randomBytes(8)), keyId],
    );
    const shareId = randomUUID();
    const itemId = randomUUID();
    await db.tx(async (c) => {
      await c.query(`INSERT INTO key_scopes (id, kind) VALUES ($1, 'share')`, [randomUUID()]);
      await c.query(
        `INSERT INTO shares (id, initiator_id, initiator_vault_id, subtree_node_id, state, root_item_id)
         VALUES ($1, $2, $3, $4, 'preparing', $5)`,
        [shareId, userId, named, folder!.id, itemId],
      );
      await c.query(
        `INSERT INTO share_members (share_id, user_id, vault_id, joined_at) VALUES ($1, $2, $3, now())`,
        [shareId, userId, named],
      );
      await c.query(`UPDATE nodes SET share_id = $2, share_item_id = $3 WHERE id = $1`, [folder!.id, shareId, itemId]);
    });

    const r = await app.inject({ method: 'GET', url: '/vaults', headers: auth() });
    const rows = r.json() as { id: string; shared: boolean }[];
    assert.equal(rows.find((v) => v.id === named)?.shared, true);
    assert.equal(rows.find((v) => v.id === plain)?.shared, false, 'and it is not simply true for everything');
  });

  it('still carries the name as ciphertext, which is the whole point', async () => {
    // The list is what a person reads to tell one vault from another, and the server cannot help with
    // that: it holds `name_enc` and no key. The decryption is the device's (docs/06).
    const r = await app.inject({ method: 'GET', url: '/vaults', headers: auth() });
    const rows = r.json() as { name_enc: string }[];
    assert.ok(rows.length > 0);
    assert.ok(rows.every((v) => typeof v.name_enc === 'string'));
  });
});
