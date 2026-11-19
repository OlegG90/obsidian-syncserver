/**
 * Who a test acts as: the seeded administrator claimed, a vault account, a device, and the token it
 * calls with (issue #485).
 *
 * One fixture rather than a copy per suite, because none of these shapes is a choice a test makes. The
 * vault account is what `keys_match_state` insists one has (D-115); the administrator is the row
 * `schema.sql` plants (D-107). A copy that drifts from either fails as a constraint in a test about
 * something else entirely. A suite whose subject IS one of these rows — `auth.test.ts` and the seeded
 * administrator, a revoked device, a token signed with options of its own — writes that row itself.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../src/db.js';

/**
 * The seeded administrator's id: the row `schema.sql` plants with no password (D-107).
 *
 * One constant rather than twenty literals, because the one thing every operator suite
 * agrees on is which row that is — and a suite that named a different one would test a
 * server whose first run had already happened somewhere else.
 */
export const SEEDED_ADMIN_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Claim the seeded administrator: active, with a password hash no password satisfies.
 *
 * The hash is a placeholder, not a credential — nothing signs in as the administrator with
 * a password in these suites; every call carries a token minted for a device instead. What
 * the claim is for is the first-run guard: an unclaimed server answers everything but its
 * own creation with `bootstrap_pending`, which is a different test's subject (auth.test.ts
 * sets its own passwords because setting them is what it proves).
 */
export const claimSeededAdmin = async (db: Db): Promise<void> => {
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = '${SEEDED_ADMIN_ID}' AND state = 'provisioned'`,
  );
};

/**
 * A device row for an account, and nothing else.
 *
 * The columns here are not choices a test makes: a device is a name, a platform and an
 * optional vault, and a suite that needs more — a revocation, a refresh token — writes its
 * own row, because that row is what the suite is about.
 */
export const aDevice = async (
  db: Db,
  userId: string,
  opts: { name?: string; platform?: string; vaultId?: string | null } = {},
): Promise<string> => {
  const { name = 'test', platform = 'linux', vaultId = null } = opts;
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform, vault_id) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [userId, name, platform, vaultId],
  );
  return device!.id;
};

/** A token for a device to call with — the only credential these suites spend. */
export const deviceToken = (app: FastifyInstance, userId: string, deviceId: string): string =>
  app.jwt.sign({ sub: userId, device: deviceId });

/**
 * The `auth_secret` every vault account here is made with, and its hash is what the fixtures store.
 *
 * Needed since removing a vault asks for it (D-140). The fixtures used to store `'h'`, the hash of nothing,
 * which was fine while no route ever compared it.
 */
export const TEST_AUTH_SECRET = 'a test auth secret';

/** Its hash, for a suite that writes its own `users` row. */
export const TEST_AUTH_SECRET_HASH = '3e8db92a13a09e5a54a22c439aaf033842dffbad80af58297b9cefb451f9d3a3';

export const aVaultAccount = async (
  db: Db,
  login = `account-${randomUUID().slice(0, 8)}`,
): Promise<{ id: string; login: string }> => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, login, state, role, auth_secret_hash, account_salt, kdf_params, pubkey,
                        enc_privkey, kek_verifier_hash, wrapped_seed, quota_bytes)
     VALUES ($1, $2, 'active', 'user', $3, decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 104857600)`,
    [id, login, TEST_AUTH_SECRET_HASH],
  );
  return { id, login };
};
