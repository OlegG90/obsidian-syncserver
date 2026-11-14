/**
 * The HTTP boundary: a body of the wrong shape is refused before a handler reads it (issue #468).
 *
 * One request per route family, each sending what a client could get wrong — no body where one is read,
 * or a field of the wrong type — and each asserting the `400` that names the field, where these used to
 * reach a handler as `undefined` and come back a `500`. Then the three things the boundary must not
 * disturb: a token is still judged first, a refusal of shape is still counted against the device that
 * sent it (D-134), and only the blob routes take a body that is not JSON.
 *
 * Sorts after `auth.test.ts`, which must meet a database nobody has claimed the administrator of
 * (AGENTS.md): this suite claims it. Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { aVaultAccount } from './support/accounts.js';

let db: Db;
let app: FastifyInstance;
let token: string;
let deviceId: string;
let adminToken: string;
let vaultId: string;
let rootId: string;
const adminId = '00000000-0000-0000-0000-000000000001';

before(async () => {
  db = connect(loadConfig().databaseUrl);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [adminId],
  );
  app = await buildApp(db, loadConfig());

  const account = await aVaultAccount(db);
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'laptop', 'linux') RETURNING id::text AS id`,
    [account.id],
  );
  deviceId = device!.id;
  token = app.jwt.sign({ sub: account.id, device: deviceId });

  const adminDevice = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'console', 'console') RETURNING id::text AS id`,
    [adminId],
  );
  adminToken = app.jwt.sign({ sub: adminId, device: adminDevice!.id });

  // The vault through the API, so the world is the one a client builds.
  vaultId = randomUUID();
  const created = await send('POST', '/vaults', { id: vaultId, name_enc: 'AA==' });
  assert.equal(created.statusCode, 201, created.body);
  rootId = created.json().root_node_id;
});

after(async () => {
  await app.close();
  await db.close();
});

function send(method: 'POST' | 'PUT', url: string, payload?: object, auth: string | null = token) {
  return app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
  });
}

/** A `400 invalid_request` whose detail names `field`. */
const refusedFor = (r: { statusCode: number; json: () => { error?: string; detail?: string } }, field: string) => {
  assert.equal(r.statusCode, 400, JSON.stringify(r.json()));
  assert.equal(r.json().error, 'invalid_request');
  assert.match(r.json().detail ?? '', new RegExp(field), 'the refusal names what was wrong');
};

describe('a body of the wrong shape is refused before a handler reads it', () => {
  it('nodes: no body at all', async () => {
    refusedFor(await send('POST', `/vaults/${vaultId}/nodes`), 'body must be object');
  });

  it('nodes: a size that is a string', async () => {
    const r = await send('PUT', `/vaults/${vaultId}/nodes/${randomUUID()}`, {
      sha256: 'a'.repeat(64), size: '3', mtime: new Date().toISOString(), base_sha256: null,
    });
    refusedFor(r, 'body/size');
  });

  it('nodes: a move without the name it moves to', async () => {
    const r = await send('POST', `/vaults/${vaultId}/nodes/${rootId}/move`, { parent_id: rootId });
    refusedFor(r, 'name_enc');
  });

  it('vaults: a name that is not a string', async () => {
    refusedFor(await send('PUT', `/vaults/${vaultId}`, { name_enc: 7 }), 'body/name_enc');
  });

  it('history: a revision that is not an integer', async () => {
    refusedFor(await send('POST', `/vaults/${vaultId}/restore`, { node_id: rootId, rev: '2' }), 'body/rev');
  });

  it('shares: an id that is not a string', async () => {
    refusedFor(await send('POST', '/shares', { vault_id: 5 }), 'body/vault_id');
  });

  it('pairing: a secret that is not a string', async () => {
    // Looked up by a device that is signed in: the one approving the pairing.
    refusedFor(await send('POST', '/auth/pairings/lookup', { pairing_secret: 5 }), 'body/pairing_secret');
  });

  it('auth: a refresh with no body', async () => {
    refusedFor(await send('POST', '/auth/refresh', undefined, null), 'body must be object');
  });

  it('auth: a login without its secret', async () => {
    refusedFor(await send('POST', '/auth/login', { login: 'somebody' }, null), 'auth_secret');
  });

  it('admin: a lifetime that is not an integer', async () => {
    const r = await send('POST', '/admin/invitations', { login: 'x', quota_bytes: '1', ttl_seconds: 'a week' }, adminToken);
    refusedFor(r, 'body/ttl_seconds');
  });

  it('keeps the refusals that already name a field: a vault id that is missing is still bad_vault_id', async () => {
    const r = await send('POST', '/vaults', { name_enc: 'AA==' });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'bad_vault_id');
    // And so does a request with no body at all, where the route asks whether there is one.
    const empty = await send('POST', '/vaults');
    assert.equal(empty.json().error, 'bad_vault_id');
  });
});

describe('what the boundary leaves as it was', () => {
  it('judges the token first: a malformed body without one is 401, not 400', async () => {
    const r = await send('POST', `/vaults/${vaultId}/nodes`, undefined, null);
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error, 'unauthenticated');
  });

  it('counts a refusal of shape against the device that sent it (D-134)', async () => {
    await send('PUT', `/vaults/${vaultId}`, { name_enc: 7 });
    const row = await db.one<{ detail: string | null }>(
      `SELECT detail FROM sync_problems WHERE device_id = $1 AND code = 'invalid_request' AND route = '/vaults/:vaultId'`,
      [deviceId],
    );
    assert.ok(row, 'the refusal is in the view, with the device behind it');
    assert.match(row!.detail ?? '', /name_enc/);
  });

  it('takes a body that is not JSON on the blob routes only', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/vaults/${vaultId}`,
      payload: 'not json',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    });
    assert.equal(r.statusCode, 415, 'a JSON route no longer receives a stream where it reads fields');
    assert.equal(r.json().error, 'unsupported_media_type', 'in the shape every other refusal has');

    // And the blob routes still do, in their own scope: refused for the address, not for the media type.
    const blob = await app.inject({
      method: 'POST',
      url: '/blobs',
      payload: Buffer.from('ciphertext'),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    });
    assert.notEqual(blob.statusCode, 415, blob.body);
    assert.notEqual(blob.statusCode, 500, blob.body);
  });

  it('answers JSON that does not parse in the shape every other refusal has', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: `/vaults/${vaultId}`,
      payload: '{"name_enc":',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'invalid_request');
  });
});
