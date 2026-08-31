/**
 * Node writes: the three-way transaction, the content precondition, and what a move does
 * to a subtree.
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
import { removeNodesByDepth, DEPTH } from '../src/nodes/remove.js';
import { testStore } from './support/store.js';

const STORE = testStore('nodes');
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let vaultId: string;
let rootId: string;
let vaultKeyId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });

/** Material a real client would produce; opaque to the server, but the triggers demand it exists. */
const materialFor = (hex: string) => ({
  blob_envelopes: [{ sha256: hex, scope_id: vaultKeyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
  dedup_tags: [{ sha256: hex, scope_id: vaultKeyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
});

/** Upload bytes and return their address — a node may only reference a blob that exists. */
const putBlob = async (body: Buffer): Promise<string> => {
  const hex = sha(body);
  const r = await app.inject({
    method: 'POST',
    url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: vaultKeyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  assert.equal(r.statusCode, 201, r.body);
  return hex;
};

const createFile = async (parentId: string, name: string, body = randomBytes(64)) => {
  const hex = await putBlob(body);
  const r = await app.inject({
    method: 'POST',
    url: `/vaults/${vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: parentId, type: 'file', sha256: hex, size: body.length,
      mtime: new Date().toISOString(),
      name_enc: Buffer.from(name).toString('base64'),
      name_hmac: sha(Buffer.from(name)),
      name_key_id: vaultKeyId,
      ...materialFor(hex),
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { ...r.json(), sha256: hex } as { node_id: string; rev: number; sha256: string };
};

const createFolder = async (parentId: string, name: string) => {
  const r = await app.inject({
    method: 'POST',
    url: `/vaults/${vaultId}/nodes`,
    headers: auth(),
    payload: {
      parent_id: parentId, type: 'folder', mtime: new Date().toISOString(),
      name_enc: Buffer.from(name).toString('base64'),
      name_hmac: sha(Buffer.from(name)),
      name_key_id: vaultKeyId,
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json() as { node_id: string; rev: number };
};

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );

  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 104857600)`,
    [userId, `nodes-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [userId],
  );
  access = app.jwt.sign({ sub: userId, device: device!.id });

  const scope = await db.one<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
  vaultKeyId = scope!.id;
  vaultId = randomUUID();
  rootId = randomUUID();
  // One transaction: vaults.root_node_id is a DEFERRED foreign key so a vault may name a
  // root it has not created yet — but only within a transaction. Two autocommitted
  // statements make the deferred check fire at the end of the first.
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\xaa', $3, $4, 'vault')`,
      [vaultId, userId, rootId, vaultKeyId],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev) VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [vaultId, rootId],
    );
  });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('a write is node, journal and version together (D-14)', () => {
  it('writes all three, and moves the blob from pending to owned', async () => {
    const file = await createFile(rootId, 'note.md');

    const journal = await db.one<{ op: string }>(
      `SELECT op FROM journal WHERE vault_id = $1 AND node_id = $2`, [vaultId, file.node_id]);
    assert.equal(journal!.op, 'put');

    const version = await db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM versions WHERE vault_id = $1 AND node_id = $2`, [vaultId, file.node_id]);
    assert.equal(Number(version!.rev), file.rev);

    const head = await db.one<{ head: string }>(`SELECT head_rev::text AS head FROM vaults WHERE id = $1`, [vaultId]);
    assert.equal(Number(head!.head), file.rev, 'head_rev is bumped in the same transaction');

    const claim = await db.one<{ own: number; pending: number }>(
      `SELECT refs_own AS own, refs_pending AS pending FROM user_blobs WHERE sha256 = decode($1,'hex')`,
      [file.sha256]);
    assert.equal(claim!.own, 1);
    assert.equal(claim!.pending, 0, 'binding moves the claim, in the same transaction as the reference');
  });

  it('leaves nothing behind when the write is refused', async () => {
    const body = randomBytes(32);
    const hex = await putBlob(body);
    const before = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM journal WHERE vault_id = $1`, [vaultId]);

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
      payload: {
        parent_id: randomUUID(), type: 'file', sha256: hex, size: body.length,
        mtime: new Date().toISOString(), name_enc: 'eA==', name_hmac: sha(Buffer.from('x')),
        name_key_id: vaultKeyId, ...materialFor(hex),
      },
    });
    assert.equal(r.statusCode, 404, 'no such parent');

    const after = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM journal WHERE vault_id = $1`, [vaultId]);
    assert.equal(after!.n, before!.n, 'a refused write appends no revision');
  });
});

describe('the precondition for content is content (D-52)', () => {
  it('accepts a write whose base matches, and rejects one whose base does not', async () => {
    const file = await createFile(rootId, 'edit-me.md');
    const next = randomBytes(80);
    const nextHex = await putBlob(next);

    const stale = await app.inject({
      method: 'PUT', url: `/vaults/${vaultId}/nodes/${file.node_id}`, headers: auth(),
      payload: { sha256: nextHex, size: next.length, mtime: new Date().toISOString(),
                 base_sha256: sha(randomBytes(8)), ...materialFor(nextHex) },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'base_mismatch');
    assert.equal(stale.json().sha256, file.sha256, 'the caller is told what the content actually is');

    const ok = await app.inject({
      method: 'PUT', url: `/vaults/${vaultId}/nodes/${file.node_id}`, headers: auth(),
      payload: { sha256: nextHex, size: next.length, mtime: new Date().toISOString(),
                 base_sha256: file.sha256, ...materialFor(nextHex) },
    });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('does not turn a rename into a content conflict', async () => {
    const file = await createFile(rootId, 'renamed.md');
    const folder = await createFolder(rootId, 'folder-for-rename');

    const moved = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes/${file.node_id}/move`,
      headers: { ...auth(), 'if-match': String(file.rev) },
      payload: { parent_id: folder.node_id, name_enc: Buffer.from('renamed.md').toString('base64'),
                 name_hmac: sha(Buffer.from('renamed.md')), name_key_id: vaultKeyId },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    // The node's rev moved, but the content did not — so the edit still applies.
    const body = randomBytes(40);
    const hex = await putBlob(body);
    const edit = await app.inject({
      method: 'PUT', url: `/vaults/${vaultId}/nodes/${file.node_id}`, headers: auth(),
      payload: { sha256: hex, size: body.length, mtime: new Date().toISOString(),
                 base_sha256: file.sha256, ...materialFor(hex) },
    });
    assert.equal(edit.statusCode, 200, 'rename then edit is not a conflict');
  });
});

describe('move', () => {
  it('rewrites ancestry for the whole subtree', async () => {
    const outer = await createFolder(rootId, 'outer');
    const inner = await createFolder(outer.node_id, 'inner');
    const leaf = await createFile(inner.node_id, 'leaf.md');
    const dest = await createFolder(rootId, 'dest');

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes/${outer.node_id}/move`,
      headers: { ...auth(), 'if-match': String(outer.rev) },
      payload: { parent_id: dest.node_id, name_enc: Buffer.from('outer').toString('base64'),
                 name_hmac: sha(Buffer.from('outer-moved')), name_key_id: vaultKeyId },
    });
    assert.equal(r.statusCode, 200, r.body);

    const row = await db.one<{ ancestry: string[] }>(
      `SELECT ancestry FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, leaf.node_id]);
    assert.deepEqual(row!.ancestry, [rootId, dest.node_id, outer.node_id, inner.node_id],
      'a descendant left claiming its old parent is a subtree in a folder it was moved out of');
  });

  it('requires the revision, because here placement is the subject', async () => {
    const f = await createFolder(rootId, 'if-match-check');
    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes/${f.node_id}/move`,
      headers: { ...auth(), 'if-match': String(f.rev + 99) },
      payload: { parent_id: rootId, name_enc: 'eA==', name_hmac: sha(Buffer.from('y')), name_key_id: vaultKeyId },
    });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'rev_mismatch');
  });
});

describe('a rule the schema enforces is still the caller\'s to fix', () => {
  it('answers 400 and says what was wrong, not 500', async () => {
    // Found on the live server: a node created under somebody else's key scope was refused
    // by a trigger, and the refusal left as an Internal Server Error. The message was
    // exact and the status said the server had broken — so a client reading the status,
    // which is what this protocol asks clients to do, learns the opposite of the truth.
    const r = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/nodes`,
      headers: auth(),
      payload: {
        parent_id: rootId, type: 'folder', mtime: new Date().toISOString(),
        name_enc: Buffer.from('wrong-scope').toString('base64'),
        name_hmac: sha(Buffer.from('wrong-scope')),
        name_key_id: randomUUID(), // not this vault's scope
      },
    });

    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, 'invalid_write');
    assert.match(r.json().detail, /vault key/, 'the schema said what was wrong, and it is passed through');
  });

  it('leaves a fault a fault: only check_violation is translated', async () => {
    // A parent that does not exist is not a constraint violation — it is looked up and
    // answered as `not_found`. The point is that the guard did not swallow the difference.
    const r = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/nodes`,
      headers: auth(),
      payload: {
        parent_id: randomUUID(), type: 'folder', mtime: new Date().toISOString(),
        name_enc: 'eA==', name_hmac: sha(Buffer.from('x')), name_key_id: vaultKeyId,
      },
    });
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'not_found');
  });
});

describe('delete', () => {
  it('soft-deletes: the row is the trash entry, and its history survives', async () => {
    const file = await createFile(rootId, 'to-delete.md');
    const r = await app.inject({
      method: 'DELETE', url: `/vaults/${vaultId}/nodes/${file.node_id}`,
      headers: { ...auth(), 'if-match': String(file.rev) },
    });
    assert.equal(r.statusCode, 200, r.body);

    const row = await db.one<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`,
      [vaultId, file.node_id]);
    assert.equal(row!.deleted, true, 'the row stays: an old cursor must still see the deletion');

    const versions = await db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM versions WHERE vault_id = $1 AND node_id = $2`,
      [vaultId, file.node_id]);
    assert.ok(Number(versions!.n) > 0, 'history outlives the file');

    const journal = await db.one<{ op: string }>(
      `SELECT op FROM journal WHERE vault_id = $1 AND node_id = $2 ORDER BY rev DESC LIMIT 1`,
      [vaultId, file.node_id]);
    assert.equal(journal!.op, 'del');
  });
});

describe('dedup lookup', () => {
  it('finds a tag this vault already knows, omits one it does not, and stays scoped to the vault', async () => {
    const body = randomBytes(48);
    const hex = await putBlob(body);
    const tag = sha(Buffer.from(`tag:${hex}`)); // matches materialFor's own tag derivation
    await createFile(rootId, 'dedup-source.md', body);

    const unknown = sha(randomBytes(32));
    const r = await app.inject({
      method: 'GET',
      url: `/vaults/${vaultId}/dedup?tags=${tag},${unknown}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().matches, [{ content_tag: tag, sha256: hex }], 'the unknown tag is omitted, not erred on');
  });

  it('refuses a batch bigger than a request line could carry, and the refusal is reachable', async () => {
    // The bound was 500 and could never fire (issue #230): at 65 bytes an item that is 32 KB of request
    // line, and Node answers `431` at 16 KB — so a caller who sent too many met an HTTP error naming
    // headers, not this sentence naming the limit. Two hundred is under the transport ceiling, which is
    // what makes this test possible at all: `app.inject()` has no such ceiling, so a bound written above
    // one would look reachable here and be unreachable in production.
    const many = (n: number): string =>
      Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0')).join(',');

    const over = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/dedup?tags=${many(201)}`, headers: auth() });
    assert.equal(over.statusCode, 400, over.body);
    assert.equal(over.json().error, 'too_many_tags');

    const at = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/dedup?tags=${many(200)}`, headers: auth() });
    assert.equal(at.statusCode, 200, 'two hundred is inside the bound, so the edge is where it says it is');

    // `blob-keys` here rather than in the blob suite, because this is one scenario across two routes:
    // they carry identifiers of the same length in the same place and had the same unreachable bound.
    const keys = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/blob-keys?sha256=${many(201)}`, headers: auth() });
    assert.equal(keys.statusCode, 400, keys.body);
    assert.equal(keys.json().error, 'too_many_addresses');
  });

  it('lets a second node bind to the same address with NO fresh material — the whole point of the lookup', async () => {
    const body = randomBytes(48);
    const hex = await putBlob(body);
    await createFile(rootId, 'first-copy.md', body);

    // No blob_envelopes, no dedup_tags: the trigger checks only that rows EXIST for
    // (address, scope), and the first upload already put them there.
    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
      payload: {
        parent_id: rootId, type: 'file', sha256: hex, size: body.length,
        mtime: new Date().toISOString(),
        name_enc: Buffer.from('second-copy.md').toString('base64'),
        name_hmac: sha(Buffer.from('second-copy.md')),
        name_key_id: vaultKeyId,
      },
    });
    assert.equal(r.statusCode, 201, r.body);

    const claim = await db.one<{ own: number }>(
      `SELECT refs_own AS own FROM user_blobs u JOIN vaults v ON v.user_id = u.user_id
        WHERE v.id = $1 AND u.sha256 = decode($2,'hex')`,
      [vaultId, hex],
    );
    assert.equal(claim!.own, 2, 'the account now holds it through two nodes, at the cost of zero bytes uploaded twice');
  });

  it('answers a stranger with nothing, silently, rather than describing this vault to them', async () => {
    const body = randomBytes(48);
    const hex = await putBlob(body);
    const tag = sha(Buffer.from(`tag:${hex}`));
    await createFile(rootId, 'private-to-owner.md', body);

    const stranger = randomUUID();
    await db.query(
      `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
      [stranger, `dedup-stranger-${process.pid}`],
    );
    const d = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, 't', 'linux') RETURNING id`, [stranger]);
    const token = app.jwt.sign({ sub: stranger, device: d!.id });

    const r = await app.inject({
      method: 'GET', url: `/vaults/${vaultId}/dedup?tags=${tag}`,
      headers: { authorization: `Bearer ${token}` },
    });
    // Consistent with blob-keys: an unowned vault is an empty result, not a 404 — the join
    // that scopes by ownership is what makes the row set empty, not a separate check.
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().matches, []);
  });

  it('validates its inputs before touching the database', async () => {
    const none = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/dedup`, headers: auth() });
    assert.equal(none.statusCode, 400);
    assert.equal(none.json().error, 'tags_required');

    const bad = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/dedup?tags=not-hex`, headers: auth() });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, 'bad_tag');
  });
});

describe('a vault of another account is not addressable', () => {
  it('answers 404 rather than 403', async () => {
    const stranger = randomUUID();
    await db.query(
      `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
      [stranger, `stranger-${process.pid}`],
    );
    const d = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, 't', 'linux') RETURNING id`, [stranger]);
    const token = app.jwt.sign({ sub: stranger, device: d!.id });

    const r = await app.inject({
      method: 'POST', url: `/vaults/${vaultId}/nodes`,
      headers: { authorization: `Bearer ${token}` },
      payload: { parent_id: rootId, type: 'folder', mtime: new Date().toISOString(),
                 name_enc: 'eA==', name_hmac: sha(Buffer.from('z')), name_key_id: vaultKeyId },
    });
    assert.equal(r.statusCode, 404);
  });
});

describe('a file write names its bytes and their size', () => {
  it('refuses content without a size, rather than letting the schema say it', async () => {
    // `versions.size` is NOT NULL, so this used to reach PostgreSQL and come back as a 500
    // for a request the caller could have been told how to fix.
    const r = await app.inject({
      method: 'POST',
      url: `/vaults/${vaultId}/nodes`,
      headers: auth(),
      payload: {
        parent_id: rootId,
        type: 'file',
        sha256: 'a'.repeat(64),
        mtime: new Date().toISOString(),
        name_enc: Buffer.from('sizeless.md').toString('base64'),
        name_hmac: 'b'.repeat(64),
        name_key_id: vaultKeyId,
      },
    });

    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, 'content_required');
  });
});

describe('removing a set of nodes, deepest-first', () => {
  it('deletes a whole subtree in one pass, in the order parent_id demands', async () => {
    const folder = await createFolder(rootId, 'to-doom');
    const inner = await createFolder(folder.node_id, 'to-doom-inner');
    const file = await createFile(inner.node_id, 'to-doom-leaf.md');

    // The doomed set, deliberately queried WITHOUT an order guarantee — the module, not
    // the caller, owns the ordering `parent_id`'s RESTRICT demands.
    const doomed = await db.query<{ id: string; vaultId: string; depth: number }>(
      `SELECT n.id, n.vault_id AS "vaultId", ${DEPTH} AS depth
         FROM nodes n WHERE n.vault_id = $1 AND n.id = ANY($2::uuid[])
         ORDER BY depth ASC`,
      [vaultId, [folder.node_id, inner.node_id, file.node_id]],
    );

    const removed = await db.tx((c) => removeNodesByDepth(c, doomed));
    assert.equal(removed, 3, 'all three rows went');

    const left = await db.one(`SELECT 1 AS x FROM nodes WHERE vault_id = $1 AND id = ANY($2::uuid[])`,
      [vaultId, [folder.node_id, inner.node_id, file.node_id]]);
    assert.equal(left, undefined, 'and nothing survived');
  });
});
