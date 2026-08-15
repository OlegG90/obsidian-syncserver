/**
 * Change notifications: a revision wakes the right account's socket, and no one else's.
 *
 * Needs the development database. `npm run db:reset` first. Uses a real WebSocket client
 * (`ws`, also the server's own transport) and a real PostgreSQL `LISTEN` via the hub.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { openEventsHub } from '../src/events.js';

const cfg = loadConfig();

let db: Db;
let app: FastifyInstance;
let hub: ReturnType<typeof openEventsHub>;
let base: string;
let ownerToken: string;
let strangerToken: string;
let vaultId: string;

const makeAccount = async (login: string): Promise<string> => {
  const userId = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, kek_verifier_hash, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x03', 'rh', '\\x04', 1048576)`,
    [userId, login],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`,
    [userId],
  );
  return app.jwt.sign({ sub: userId, device: device!.id });
};

before(async () => {
  db = connect(cfg.databaseUrl);
  hub = openEventsHub(db);
  app = await buildApp(db, cfg, hub);
  await db.query(
    `UPDATE users SET state = 'active', role = 'admin',
            auth_secret_hash = 'h', account_salt = decode('00112233445566778899aabbccddeeff','hex'),
            kdf_params = '{"v":19,"m":65536,"t":3,"p":1}', pubkey = '\\x01', enc_privkey = '\\x02',
            kek_verifier_hash = 'kv',
            recovery_key = '\\x03', recovery_code_hash = 'rh', wrapped_seed = '\\x04',
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  assert.ok(addr && typeof addr !== 'string');
  base = `ws://127.0.0.1:${addr.port}`;

  ownerToken = await makeAccount(`owner-${process.pid}-${Date.now()}`);
  strangerToken = await makeAccount(`stranger-${process.pid}-${Date.now()}`);
  const ownerId = (app.jwt.decode(ownerToken) as { sub: string }).sub;
  vaultId = randomUUID();
  const rootId = randomUUID();
  // One transaction: vaults.root_node_id is a DEFERRED foreign key, so the vault and its
  // root node must land together. The root node carries rev 0, before any head_rev bump.
  await db.tx(async (c) => {
    const scope = await c.query<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\xaa', $3, $4, 'vault')`,
      [vaultId, ownerId, rootId, scope.rows[0]!.id],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev) VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [vaultId, rootId],
    );
  });
});

after(async () => {
  await hub.close();
  await app.close();
  await db.close();
});

const openSocket = (token: string): Promise<{ ws: WebSocket; messages: string[] }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/events`);
    const messages: string[] = [];
    ws.on('message', (d) => messages.push(d.toString()));
    ws.on('open', () => {
      ws.send(JSON.stringify({ token }));
    });
    ws.on('error', reject);
    // Auth settles fast; give it a beat so the hub subscription is live.
    setTimeout(() => resolve({ ws, messages }), 50);
  });

describe('change notifications', () => {
  it('wakes the owner of a vault when it gains a revision, with the new head', async () => {
    const { ws, messages } = await openSocket(ownerToken);

    // A write that bumps head_rev: create a node, which inserts a journal row.
    await db.query(
      `UPDATE vaults SET head_rev = head_rev + 1 WHERE id = $1`,
      [vaultId],
    );
    await db.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev)
       SELECT $1, head_rev, gen_random_uuid(), 'put', head_rev FROM vaults WHERE id = $1`,
      [vaultId],
    );

    await new Promise((r) => setTimeout(r, 200));
    const hit = messages.find((m) => m.includes(vaultId));
    assert.ok(hit, `owner saw a notification for its vault: ${messages.join(', ')}`);
    assert.ok(hit!.includes('head_rev'), 'the notification carries the head');
    ws.close();
  });

  it('does not wake an account that does not own the vault', async () => {
    const { ws, messages } = await openSocket(strangerToken);

    await db.query(
      `UPDATE vaults SET head_rev = head_rev + 1 WHERE id = $1`,
      [vaultId],
    );
    await db.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev)
       SELECT $1, head_rev, gen_random_uuid(), 'put', head_rev FROM vaults WHERE id = $1`,
      [vaultId],
    );

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!messages.some((m) => m.includes(vaultId)), `stranger saw nothing: ${messages.join(', ')}`);
    ws.close();
  });

  it('refuses a connection without a valid token', async () => {
    const ws = new WebSocket(`${base}/events`);
    const out: string[] = [];
    ws.on('message', (d) => out.push(d.toString()));
    ws.on('open', () => ws.send(JSON.stringify({ token: 'not-a-token' })));

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(out.some((m) => m.includes('refused')), `refused explicitly: ${out.join(', ')}`);
    ws.close();
  });

  it('refuses a token that names an account but no device', async () => {
    // The socket is held to the API's own policy: an access token names an account AND a
    // device (#90). A token the HTTP guard would refuse is refused here too.
    const ws = new WebSocket(`${base}/events`);
    const out: string[] = [];
    ws.on('message', (d) => out.push(d.toString()));
    const ownerId = (app.jwt.decode(ownerToken) as { sub: string }).sub;
    ws.on('open', () => ws.send(JSON.stringify({ token: app.jwt.sign({ sub: ownerId }) })));

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(out.some((m) => m.includes('refused')), `refused explicitly: ${out.join(', ')}`);
    ws.close();
  });

  it('reconnects when the notification connection dies, and keeps waking the owner', async () => {
    // The interface promises a dropped connection is re-established with a short backoff.
    // Reaching it against a real PostgreSQL means killing the listener's backend; prove
    // the promised behaviour rather than assuming it. The listener's own state machine is
    // pinned down deterministically in listen.test.ts; here the wiring survives a drop.
    const killed = await db.query<{ done: boolean }>(
      `SELECT pg_terminate_backend(pid) AS done FROM pg_stat_activity
       WHERE query LIKE 'LISTEN sync_vault'`,
    );
    assert.ok(killed[0]?.done, 'the notification backend was dropped');

    let reconnected = false;
    for (let i = 0; i < 30 && !reconnected; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const row = await db.one<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity WHERE query LIKE 'LISTEN sync_vault'`,
      );
      reconnected = Number(row?.n) >= 1;
    }
    assert.ok(reconnected, 'the listener re-subscribed to the channel');

    const { ws, messages } = await openSocket(ownerToken);
    await db.query(`UPDATE vaults SET head_rev = head_rev + 1 WHERE id = $1`, [vaultId]);
    await db.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev)
       SELECT $1, head_rev, gen_random_uuid(), 'put', head_rev FROM vaults WHERE id = $1`,
      [vaultId],
    );

    await new Promise((r) => setTimeout(r, 200));
    const hit = messages.find((m) => m.includes(vaultId));
    assert.ok(hit, `the owner woke after the reconnect: ${messages.join(', ')}`);
    ws.close();
  });
});
