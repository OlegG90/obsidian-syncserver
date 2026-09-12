/**
 * Refusals to a device, counted where the operator can see them (#355, D-134).
 *
 * Two halves. **The hook's decisions** — what counts, what is expected, what an unrecordable refusal does
 * to the answer — against a bare Fastify and a fake database, because those are rules about requests and
 * need no schema. **What the real server keeps** — the row, the count, the template, the operator's view,
 * the account's badge, the pruning — against the development database, because those are rules about data.
 *
 * Needs the development database: `npm run db:reset` first. Named to sort after `auth.test.ts`, whose
 * first-run tests this file would otherwise take away by claiming the seeded administrator.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { EXPECTED_CODES, pruneProblems, refusalCode, registerProblemRecorder, type SeenProblem } from '../src/sync-problems.js';
import { testStore } from './support/store.js';

describe('which answers the hook writes down', () => {
  /** A bare server whose every request comes from one device, recording into a list instead of a table. */
  const bare = async (opts: { failWrites?: boolean } = {}) => {
    const written: SeenProblem[] = [];
    const logged: string[] = [];
    const app = Fastify();
    const db = {
      query: async (_sql: string, params?: unknown[]) => {
        if (opts.failWrites) throw new Error('the device row is gone');
        const [userId, deviceId, method, route, status, code] = params as [string, string, string, string, number, string];
        written.push({ userId, deviceId, method, route, status, code });
        return [];
      },
    };
    app.addHook('onRequest', async (req) => {
      if (req.headers['x-device'] !== 'none') req.caller = { userId: 'u1', deviceId: 'd1' } as never;
    });
    registerProblemRecorder(app, db as never, (m) => logged.push(m));
    app.post<{ Params: { id: string } }>('/things/:id/move', async (req, reply) =>
      reply.code(Number(req.headers['x-status'] ?? 200)).send({ error: req.headers['x-code'], detail: `node ${req.params.id}` }),
    );
    await app.ready();
    const ask = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: `/things/${randomUUID()}/move`, headers });
    return { app, ask, written, logged };
  };

  it('writes a refusal with the route template and the code, and nothing of the body', async () => {
    const { app, ask, written, logged } = await bare();
    const out = await ask({ 'x-status': '400', 'x-code': 'invalid_write' });
    assert.equal(out.statusCode, 400);
    assert.deepEqual(written, [
      { userId: 'u1', deviceId: 'd1', method: 'POST', route: '/things/:id/move', status: 400, code: 'invalid_write' },
    ]);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /refused POST \/things\/:id\/move → 400 invalid_write/);
    assert.doesNotMatch(logged[0]!, /node /, 'the detail, which can carry ids, is not logged');
    await app.close();
  });

  it('leaves out the ordinary course of syncing', async () => {
    const { app, ask, written } = await bare();
    for (const code of EXPECTED_CODES) await ask({ 'x-status': '409', 'x-code': code });
    await ask({ 'x-status': '200' });
    assert.deepEqual(written, [], 'conflicts, pairing polls, rate limits and successes are not problems');
    await app.close();
  });

  it('leaves out a request with no device behind it', async () => {
    // An expired token reaches here as exactly this, and refreshing is the client's normal answer to it.
    const { app, ask, written } = await bare();
    await ask({ 'x-device': 'none', 'x-status': '401', 'x-code': 'invalid_credentials' });
    assert.deepEqual(written, []);
    await app.close();
  });

  it('still answers when the refusal cannot be written down, and says so in the log', async () => {
    const { app, ask, logged } = await bare({ failWrites: true });
    const out = await ask({ 'x-status': '400', 'x-code': 'invalid_write' });
    assert.equal(out.statusCode, 400, 'the client is owed its answer either way');
    assert.equal(out.json().error, 'invalid_write');
    assert.match(logged.join('\n'), /could not record that refusal: the device row is gone/);
    await app.close();
  });

  it('reads a code only when it is a refusal’s name', () => {
    assert.equal(refusalCode('{"error":"share_boundary"}'), 'share_boundary');
    assert.equal(refusalCode('{"message":"Route not found"}'), 'unknown');
    assert.equal(refusalCode('not json'), 'unknown');
    assert.equal(refusalCode('{"error":"has spaces and CAPITALS"}'), 'unknown', 'never free text into a table');
    assert.equal(refusalCode(Buffer.from('{}')), 'unknown');
  });
});

describe('what the server keeps', () => {
  const STORE = testStore('sync-problems');
  const cfg = { ...loadConfig(), blobStorePath: STORE };
  let db: Db;
  let app: FastifyInstance;
  let adminToken: string;
  let user: { id: string; login: string; deviceId: string; token: string };

  const rows = () =>
    db.query<{ route: string; status: number; code: string; count: string }>(
      `SELECT route, status, code, count::text AS count FROM sync_problems WHERE device_id = $1 ORDER BY route, code`,
      [user.deviceId],
    );

  /** A refusal the real server gives: a device name it will not store. */
  const badRename = () =>
    app.inject({
      method: 'PUT',
      url: `/auth/devices/${user.deviceId}`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: ' padded' },
    });

  before(async () => {
    db = connect(cfg.databaseUrl);
    app = await buildApp(db, cfg);
    await db.query(
      `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
        WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
    );
    const adminDevice = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ('00000000-0000-0000-0000-000000000001', 'test', 'console') RETURNING id`,
    );
    adminToken = app.jwt.sign({ sub: '00000000-0000-0000-0000-000000000001', device: adminDevice!.id });

    const id = randomUUID();
    const login = `problems-${process.pid}`;
    await db.query(
      `INSERT INTO users (id, login, state, role, auth_secret_hash, account_salt, kdf_params, pubkey,
                          enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
       VALUES ($1, $2, 'active', 'user', 'h', decode('00112233445566778899aabbccddeeff','hex'),
               '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 104857600)`,
      [id, login],
    );
    const device = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'a phone', 'mobile') RETURNING id`,
      [id],
    );
    user = { id, login, deviceId: device!.id, token: app.jwt.sign({ sub: id, device: device!.id }) };
  });

  after(async () => {
    await app.close();
    await db.close();
    await rm(STORE, { recursive: true, force: true });
  });

  it('counts a repeated refusal on one row, under the route template', async () => {
    assert.equal((await badRename()).statusCode, 400);
    assert.equal((await badRename()).statusCode, 400);
    assert.deepEqual(await rows(), [
      { route: '/auth/devices/:deviceId', status: 400, code: 'invalid_device_name', count: '2' },
    ]);
  });

  it('writes nothing for an answer that succeeded', async () => {
    const before_ = await rows();
    const ok = await app.inject({ method: 'GET', url: '/auth/devices', headers: { authorization: `Bearer ${user.token}` } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(await rows(), before_);
  });

  it('shows the operator which account and device, and marks the account', async () => {
    const list = await app.inject({ method: 'GET', url: '/admin/sync-problems', headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(list.statusCode, 200, list.body);
    const mine = (list.json().problems as { login: string; deviceName: string; code: string; count: string }[]).filter(
      (p) => p.login === user.login,
    );
    assert.deepEqual(
      mine.map((p) => ({ deviceName: p.deviceName, code: p.code, count: p.count })),
      [{ deviceName: 'a phone', code: 'invalid_device_name', count: '2' }],
    );

    const accounts = await app.inject({ method: 'GET', url: '/admin/accounts', headers: { authorization: `Bearer ${adminToken}` } });
    const row = (accounts.json().accounts as { login: string; recentProblems: number }[]).find((a) => a.login === user.login);
    assert.equal(row?.recentProblems, 2, 'the badge counts the refusals of the last seven days');
  });

  it('forgets a problem that stopped recurring, and keeps one that has not', async () => {
    await db.query(
      `INSERT INTO sync_problems (user_id, device_id, method, route, status, code, first_at, last_at)
       VALUES ($1, $2, 'POST', '/old', 500, 'unknown', now() - interval '40 days', now() - interval '31 days')`,
      [user.id, user.deviceId],
    );
    assert.ok((await pruneProblems(db)) >= 1);
    assert.deepEqual((await rows()).map((r) => r.route), ['/auth/devices/:deviceId'], 'the fresh one stays');
  });
});
