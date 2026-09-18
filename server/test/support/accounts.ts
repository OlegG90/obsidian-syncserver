/**
 * A vault account for a test to act as: active, carrying the key material the schema requires, and no vault.
 *
 * One fixture rather than a copy per suite, because the column list is not a choice a test makes: it is the
 * shape `keys_match_state` insists a vault account has (D-115), and a copy that drifts from it fails as a
 * constraint in a test about something else entirely.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db.js';

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
     VALUES ($1, $2, 'active', 'user', '3e8db92a13a09e5a54a22c439aaf033842dffbad80af58297b9cefb451f9d3a3', decode('00112233445566778899aabbccddeeff','hex'),
             '{"v":19,"m":65536,"t":3,"p":1}', '\\x01', '\\x02', 'kv', '\\x04', 104857600)`,
    [id, login],
  );
  return { id, login };
};
