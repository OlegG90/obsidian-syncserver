/**
 * The account-scope predicates: "whose is this vault", shared by every route family.
 *
 * The rule behind them is "404, never 403" (#20) — the boolean is the answer, the routes
 * decide the status. This test pins the predicate itself, so the shared module cannot drift
 * without its own proof.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { ownsVault, ownerOf } from '../src/account.js';

let db: Db;
const createdUsers: string[] = [];
const accounts: Acct[] = [];

interface Acct {
  userId: string;
  vaultId: string;
}

const makeAccount = async (login: string): Promise<Acct> => {
  const userId = randomUUID();
  createdUsers.push(userId);
  await db.query(
    `INSERT INTO users (id, login, state, auth_secret_hash, account_salt, kdf_params,
                        pubkey, enc_privkey, recovery_key, recovery_code_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'h', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', '\\x03', 'rh', '\\x04', 1048576)`,
    [userId, login],
  );
  const vaultId = randomUUID();
  await db.tx(async (c) => {
    const scope = await c.query<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    const rootId = randomUUID();
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, '\\xaa', $3, $4, 'vault')`,
      [vaultId, userId, rootId, scope.rows[0]!.id],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev) VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [vaultId, rootId],
    );
  });
  const acct = { userId, vaultId };
  accounts.push(acct);
  return acct;
};

before(async () => {
  db = connect(loadConfig().databaseUrl);
});

after(async () => {
  // This suite shares the development database with every other test file, and `auth.test.ts`
  // cleans up before itself by assuming no other test left a vault behind. Cleanup order
  // matters: the vault-delete trigger refuses while any node exists, and `vaults_root_node_fkey`
  // (deferred) ties the vault to its root — so nodes and vault must go in one transaction,
  // and only then can the user, whose deletion the account trigger guards.
  for (const a of accounts) {
    await db.tx(async (c) => {
      await c.query(`DELETE FROM nodes WHERE vault_id = $1`, [a.vaultId]);
      await c.query(`DELETE FROM vaults WHERE id = $1`, [a.vaultId]);
    });
  }
  for (const u of createdUsers) {
    // The account-deletion procedure requires the `deleting` state before a delete.
    await db.query(`UPDATE users SET state = 'deleting' WHERE id = $1`, [u]);
    await db.query(`DELETE FROM users WHERE id = $1`, [u]);
  }
  await db.close();
});

describe('ownsVault', () => {
  it('says yes for the owner and no for a stranger, and no for a vault that does not exist', async () => {
    const a = await makeAccount(`owns-a-${process.pid}`);
    const b = await makeAccount(`owns-b-${process.pid}`);

    assert.equal(await ownsVault(db, a.userId, a.vaultId), true, 'the owner holds it');
    assert.equal(await ownsVault(db, b.userId, a.vaultId), false, 'a stranger does not');
    assert.equal(await ownsVault(db, a.userId, randomUUID()), false, 'a missing vault is no one\'s');
  });
});

describe('ownerOf', () => {
  it('names the owner and the journal head for a fan-out', async () => {
    const a = await makeAccount(`owner-a-${process.pid}`);

    const owned = await ownerOf(db, a.vaultId);
    assert.ok(owned);
    assert.equal(owned!.userId, a.userId);
    assert.equal(typeof owned!.headRev, 'number');
  });

  it('returns undefined for a vault that does not exist', async () => {
    assert.equal(await ownerOf(db, randomUUID()), undefined);
  });
});
