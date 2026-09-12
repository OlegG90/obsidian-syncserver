/**
 * A device is a vault connected on a machine (#364, D-139, revising AC-13).
 *
 * The server learns which vault a device syncs the first time the device opens one, never moves it
 * afterwards, and revokes the devices of a vault when the vault is removed. Needs the development
 * database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { testStore } from './support/store.js';

const STORE = testStore('device-vaults');
const cfg = { ...loadConfig(), blobStorePath: STORE };

let db: Db;
let app: FastifyInstance;

/** A vault account with no vault yet. */
const anAccount = async (): Promise<string> => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, role, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'user', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 104857600)`,
    [id, `vaults-${randomUUID().slice(0, 8)}`],
  );
  return id;
};

/** A device of that account, and a token for it. */
const aDevice = async (userId: string, name: string): Promise<{ id: string; auth: { authorization: string } }> => {
  const row = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, 'desktop') RETURNING id`,
    [userId, name],
  );
  return { id: row!.id, auth: { authorization: `Bearer ${app.jwt.sign({ sub: userId, device: row!.id })}` } };
};

const aVault = async (auth: { authorization: string }): Promise<string> => {
  const id = randomUUID();
  const out = await app.inject({ method: 'POST', url: '/vaults', headers: auth, payload: { id, name_enc: 'AAAA' } });
  assert.equal(out.statusCode, 201, out.body);
  return id;
};

const vaultOf = async (deviceId: string): Promise<string | null> =>
  (await db.one<{ vault: string | null }>(`SELECT vault_id::text AS vault FROM devices WHERE id = $1`, [deviceId]))!.vault;

before(async () => {
  db = connect(cfg.databaseUrl);
  app = await buildApp(db, cfg);
  // Claimed so the first-run guard does not answer every request the same way.
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '00000000-0000-0000-0000-000000000001' AND state = 'provisioned'`,
  );
});

after(async () => {
  await app.close();
  await db.close();
  await rm(STORE, { recursive: true, force: true });
});

describe('the vault a device syncs', () => {
  it('is learned the first time the device opens a vault, and listed with it', async () => {
    const user = await anAccount();
    const laptop = await aDevice(user, 'laptop');
    const notes = await aVault(laptop.auth);
    assert.equal(await vaultOf(laptop.id), null, 'creating a vault is not syncing it');

    assert.equal((await app.inject({ method: 'GET', url: `/vaults/${notes}`, headers: laptop.auth })).statusCode, 200);
    assert.equal(await vaultOf(laptop.id), notes);

    const listed = await app.inject({ method: 'GET', url: '/auth/devices', headers: laptop.auth });
    assert.equal((listed.json().devices as { id: string; vault_id: string | null }[]).find((d) => d.id === laptop.id)?.vault_id, notes);
  });

  it('does not move afterwards, whatever the device opens next', async () => {
    const user = await anAccount();
    const laptop = await aDevice(user, 'laptop');
    const notes = await aVault(laptop.auth);
    const other = await aVault(laptop.auth);

    await app.inject({ method: 'GET', url: `/vaults/${notes}`, headers: laptop.auth });
    await app.inject({ method: 'GET', url: `/vaults/${other}`, headers: laptop.auth });
    assert.equal(await vaultOf(laptop.id), notes, 'the first vault is the one it syncs');
  });

  it('is never taken from a vault the account does not own', async () => {
    const owner = await anAccount();
    const theirs = await aVault((await aDevice(owner, 'theirs')).auth);
    const stranger = await aDevice(await anAccount(), 'stranger');

    assert.equal((await app.inject({ method: 'GET', url: `/vaults/${theirs}`, headers: stranger.auth })).statusCode, 404);
    assert.equal(await vaultOf(stranger.id), null);
  });
});

describe('removing a vault', () => {
  it('revokes the devices that synced it, and says how many', async () => {
    const user = await anAccount();
    const laptop = await aDevice(user, 'laptop');
    const phone = await aDevice(user, 'phone');
    const kept = await aVault(laptop.auth);
    const doomed = await aVault(laptop.auth);
    await app.inject({ method: 'GET', url: `/vaults/${kept}`, headers: laptop.auth });
    await app.inject({ method: 'GET', url: `/vaults/${doomed}`, headers: phone.auth });

    const out = await app.inject({ method: 'DELETE', url: `/vaults/${doomed}`, headers: laptop.auth });
    assert.equal(out.statusCode, 200, out.body);
    assert.equal(out.json().revoked, 1);

    const rows = await db.query<{ id: string; revoked: boolean; vault: string | null }>(
      `SELECT id::text AS id, revoked_at IS NOT NULL AS revoked, vault_id::text AS vault FROM devices WHERE id = ANY($1)`,
      [[laptop.id, phone.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.deepEqual(byId.get(phone.id), { id: phone.id, revoked: true, vault: null }, 'revoked, and its link cleared');
    assert.deepEqual(byId.get(laptop.id), { id: laptop.id, revoked: false, vault: kept }, 'a device of another vault is untouched');
  });
});
