/**
 * The delta cursor: what it collapses, what it pins, and every way it can be refused.
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
import { encodeCursor } from '../src/delta/cursor.js';

const STORE = `var/test-delta-${process.pid}`;
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;
let access: string;
let userId: string;
let vaultId: string;
let rootId: string;
let vaultKeyId: string;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const auth = () => ({ authorization: `Bearer ${access}` });

const putBlob = async (body: Buffer) => {
  const hex = sha(body);
  await app.inject({
    method: 'POST', url: '/blobs',
    query: { sha256: hex, size: String(body.length), key_id: vaultKeyId },
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    payload: body,
  });
  return hex;
};

const createFile = async (name: string) => {
  const body = randomBytes(48);
  const hex = await putBlob(body);
  const r = await app.inject({
    method: 'POST', url: `/vaults/${vaultId}/nodes`, headers: auth(),
    payload: {
      parent_id: rootId, type: 'file', sha256: hex, size: body.length,
      mtime: new Date().toISOString(),
      name_enc: Buffer.from(name).toString('base64'),
      name_hmac: sha(Buffer.from(name)), name_key_id: vaultKeyId,
      blob_envelopes: [{ sha256: hex, scope_id: vaultKeyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
      dedup_tags: [{ sha256: hex, scope_id: vaultKeyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }],
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { ...r.json(), sha256: hex } as { node_id: string; rev: number; sha256: string };
};

const delta = (cursor?: string, limit?: number) =>
  app.inject({
    method: 'GET', url: `/vaults/${vaultId}/delta`, headers: auth(),
    query: { ...(cursor ? { cursor } : {}), ...(limit ? { limit: String(limit) } : {}) },
  });

const cursorAt = (rev: number, epoch: { restore: number; reset: number }) =>
  encodeCursor(cfg.serverSecret, { v: 1, uid: userId, vid: vaultId, epoch, rev });

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
    [userId, `delta-${process.pid}`],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [userId]);
  access = app.jwt.sign({ sub: userId, device: device!.id });

  const scope = await db.one<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
  vaultKeyId = scope!.id;
  vaultId = randomUUID();
  rootId = randomUUID();
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\xaa', $3, $4, 'vault')`, [vaultId, userId, rootId, vaultKeyId]);
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev) VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [vaultId, rootId]);
  });
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('reading the delta', () => {
  it('starts from nothing when there is no cursor, and returns what is there', async () => {
    const file = await createFile('one.md');
    const r = await delta();
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.has_more, false);
    assert.ok(body.changes.some((c: { node_id: string }) => c.node_id === file.node_id));
    assert.ok(body.next_cursor.includes('.'), 'payload and tag');
  });

  it('collapses a node touched many times into one change', async () => {
    const file = await createFile('busy.md');
    const before = await delta();
    const cursor = before.json().next_cursor;

    for (let i = 0; i < 4; i++) {
      const body = randomBytes(16 + i);
      const hex = await putBlob(body);
      const cur = await db.one<{ sha: string }>(
        `SELECT encode(sha256,'hex') AS sha FROM nodes WHERE vault_id = $1 AND id = $2`, [vaultId, file.node_id]);
      const w = await app.inject({
        method: 'PUT', url: `/vaults/${vaultId}/nodes/${file.node_id}`, headers: auth(),
        payload: { sha256: hex, size: body.length, mtime: new Date().toISOString(), base_sha256: cur!.sha,
                   blob_envelopes: [{ sha256: hex, scope_id: vaultKeyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }],
                   dedup_tags: [{ sha256: hex, scope_id: vaultKeyId, content_tag: sha(Buffer.from(`tag:${hex}`)) }] },
      });
      assert.equal(w.statusCode, 200, w.body);
    }

    const r = await delta(cursor);
    const forThisNode = r.json().changes.filter((c: { node_id: string }) => c.node_id === file.node_id);
    assert.equal(forThisNode.length, 1, 'four revisions, one change: the state it is in now');
  });

  it('pins a snapshot, so a change made mid-walk is neither lost nor applied twice (#24)', async () => {
    await createFile('page-a.md');
    await createFile('page-b.md');

    const first = await delta(undefined, 1);
    assert.equal(first.json().has_more, true);
    const mid = first.json().next_cursor;

    // Something happens between pages. It must not appear in this series.
    const late = await createFile('arrived-mid-walk.md');

    let cursor = mid;
    const seen: string[] = [];
    for (let guard = 0; guard < 20; guard++) {
      const page = await delta(cursor, 1);
      const body = page.json();
      for (const c of body.changes) seen.push(c.node_id);
      cursor = body.next_cursor;
      if (!body.has_more) break;
    }
    assert.ok(!seen.includes(late.node_id), 'the pinned bound excludes it');

    // And it is not lost: the next series starts at the bound and picks it up.
    const nextSeries = await delta(cursor);
    assert.ok(nextSeries.json().changes.some((c: { node_id: string }) => c.node_id === late.node_id));
  });
});

describe('a cursor that cannot be answered', () => {
  it('rejects a forged tag with 400, not 410 — malformed is not stale (#100)', async () => {
    const good = (await delta()).json().next_cursor as string;
    const forged = `${good.slice(0, good.indexOf('.'))}.${Buffer.from('nope').toString('base64url')}`;

    const r = await delta(forged);
    assert.equal(r.statusCode, 400, 'answering 410 would turn a mangled byte into a free full resync');
    assert.equal(r.json().error, 'cursor_unverifiable');
  });

  it('refuses a cursor minted for another vault, even with a valid tag', async () => {
    const otherVault = encodeCursor(cfg.serverSecret, {
      v: 1, uid: userId, vid: randomUUID(), epoch: { restore: 1, reset: 1 }, rev: 0,
    });
    const r = await delta(otherVault);
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'cursor_wrong_subject');
  });

  it('answers a reset epoch with 410 reset — deletions apply', async () => {
    const at = await db.one<{ restore: string; reset: string }>(
      `SELECT m.restore_epoch::text AS restore, v.reset_epoch::text AS reset
         FROM vaults v CROSS JOIN server_meta m WHERE v.id = $1`, [vaultId]);
    const stale = cursorAt(0, { restore: Number(at!.restore), reset: Number(at!.reset) + 1 });

    const r = await delta(stale);
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().reason, 'reset');
  });

  it('answers a restore epoch with 410 restore — deletions do NOT apply', async () => {
    const at = await db.one<{ restore: string; reset: string }>(
      `SELECT m.restore_epoch::text AS restore, v.reset_epoch::text AS reset
         FROM vaults v CROSS JOIN server_meta m WHERE v.id = $1`, [vaultId]);
    const stale = cursorAt(0, { restore: Number(at!.restore) + 1, reset: Number(at!.reset) });

    const r = await delta(stale);
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().reason, 'restore');
  });

  it('answers RESTORE when both epochs are stale: the protective instruction wins (#70)', async () => {
    const at = await db.one<{ restore: string; reset: string }>(
      `SELECT m.restore_epoch::text AS restore, v.reset_epoch::text AS reset
         FROM vaults v CROSS JOIN server_meta m WHERE v.id = $1`, [vaultId]);
    const both = cursorAt(0, { restore: Number(at!.restore) + 1, reset: Number(at!.reset) + 1 });

    const r = await delta(both);
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().reason, 'restore',
      'applying deletions after a rollback destroys work that exists nowhere else');
  });

  it('answers 410 journal_ttl when the entries it needed have been pruned', async () => {
    const at = await db.one<{ restore: string; reset: string }>(
      `SELECT m.restore_epoch::text AS restore, v.reset_epoch::text AS reset
         FROM vaults v CROSS JOIN server_meta m WHERE v.id = $1`, [vaultId]);
    // The TTL sweep is the worker's job; its effect on a cursor is what matters here.
    await db.query(`DELETE FROM journal WHERE vault_id = $1 AND rev <= 3`, [vaultId]);

    const old = cursorAt(0, { restore: Number(at!.restore), reset: Number(at!.reset) });
    const r = await delta(old);
    assert.equal(r.statusCode, 410);
    assert.equal(r.json().reason, 'journal_ttl');
  });
});

describe('the full walk', () => {
  it('lists the tree and hands back a snapshot usable as a cursor', async () => {
    const r = await app.inject({ method: 'GET', url: `/vaults/${vaultId}/list`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.ok(body.nodes.length > 0);
    assert.ok(body.nodes.every((n: { name_enc: string | null }) => n.name_enc !== undefined));

    const resumed = await delta(body.snapshot);
    assert.equal(resumed.statusCode, 200, 'the snapshot is a cursor, so the walk has a position to continue from');
    assert.equal(resumed.json().changes.length, 0, 'nothing has happened since it was taken');
  });
});
