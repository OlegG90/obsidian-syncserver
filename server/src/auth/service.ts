/**
 * Authentication, and the one rule that shapes all of it: the passphrase never reaches
 * the server (#61).
 *
 * What arrives is `auth_secret = HKDF(seed, "auth")` — a value derived from the account
 * seed on the device, hashed again on arrival. If login used the same material as
 * encryption, the server would receive a vault key on every login and E2EE would be
 * decorative.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashToken, newToken, tokenMatches } from '../crypto.js';
import type { Db } from '../db.js';

export interface KdfParams {
  v: number;
  m: number;
  t: number;
  p: number;
}

export interface RedeemInput {
  invitationToken: string;
  authSecret: string;
  accountSalt: Buffer;
  kdfParams: KdfParams;
  pubkey: Buffer;
  encPrivkey: Buffer;
  wrappedSeed: Buffer;
  recoveryKey: Buffer;
  recoveryCodeHash: string;
  initialVaultId: string;
  initialVaultNameEnc: Buffer;
  deviceName: string;
  devicePlatform: string;
}

// A type alias rather than an interface: only the former satisfies the `Row` constraint,
// because an interface has no implicit index signature.
export type Account = {
  id: string;
  login: string;
  role: string;
  state: string;
};

/**
 * Complete a seeded or administrator-issued invitation.
 *
 * Everything happens in one transaction, because a half-redeemed invitation is the state
 * `keys_match_state` exists to forbid: an account row that has a login and no keys and
 * could still own data.
 */
export const redeemInvitation = async (db: Db, input: RedeemInput) => {
  return db.tx(async (c: PoolClient) => {
    const user = await c.query<{ id: string; login: string }>(
      `SELECT id, login FROM users
        WHERE state = 'provisioned'
          AND invite_token_hash = $1
          AND invite_expires_at > now()
        FOR UPDATE`,
      [hashToken(input.invitationToken)],
    );
    const row = user.rows[0];
    if (!row) return undefined;

    await c.query(
      `UPDATE users
          SET state = 'active',
              auth_secret_hash = $2, account_salt = $3, kdf_params = $4,
              pubkey = $5, enc_privkey = $6, wrapped_seed = $7,
              recovery_key = $8, recovery_code_hash = $9,
              invite_token_hash = NULL, invite_expires_at = NULL
        WHERE id = $1`,
      [
        row.id,
        hashToken(input.authSecret),
        input.accountSalt,
        JSON.stringify(input.kdfParams),
        input.pubkey,
        input.encPrivkey,
        input.wrappedSeed,
        input.recoveryKey,
        input.recoveryCodeHash,
      ],
    );

    // The client chose the vault id before it derived KV and encrypted the label, so the
    // server takes the id rather than assigning one (docs/04). The key scope is the
    // server's to register: it is an identifier, not key material.
    const scope = await c.query<{ id: string }>(
      `INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`,
    );
    const vaultKeyId = scope.rows[0]!.id;

    // The vault row goes in BEFORE its root node, and the order is forced from both ends:
    // `owned_rows_require_active_user` resolves a node's owner through its vault, so a node
    // inserted first has no owner to check and is refused. The other direction is already
    // allowed for — vaults.root_node_id is a deferred FK precisely so a transaction may
    // name a root it has not created yet.
    const rootId = randomUUID();

    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, $3, $4, $5, 'vault')`,
      [input.initialVaultId, row.id, input.initialVaultNameEnc, rootId, vaultKeyId],
    );

    // The root is the one node with no name, so it needs no key material to create — which
    // is exactly why the server can create it at all.
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev)
       VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [input.initialVaultId, rootId],
    );

    const refresh = newToken();
    const device = await c.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform, refresh_token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [row.id, input.deviceName, input.devicePlatform, hashToken(refresh)],
    );

    await c.query(
      `INSERT INTO audit_log (actor_user_id, actor_login, action, target_user_id, target_login)
       VALUES ($1, $2, 'account.activate', $1, $2)`,
      [row.id, row.login],
    );

    return {
      userId: row.id,
      deviceId: device.rows[0]!.id,
      vaultId: input.initialVaultId,
      rootNodeId: rootId,
      refresh,
    };
  });
};

/**
 * A login is not enough to be let in: `disabled` and `deleting` accounts keep their data
 * and lose their sessions, and the tombstone was never a login at all.
 */
export const findActiveAccount = async (db: Db, login: string): Promise<(Account & { authSecretHash: string }) | undefined> =>
  db.one<Account & { authSecretHash: string }>(
    `SELECT id, login, role, state, auth_secret_hash AS "authSecretHash"
       FROM users WHERE lower(login) = lower($1) AND state = 'active'`,
    [login],
  );

export const verifyAuthSecret = (stored: string | null, presented: string): boolean =>
  stored !== null && tokenMatches(presented, stored);

/** One refresh token per device, so signing out one device is possible at all (#90). */
export const issueRefreshToken = async (db: Db, deviceId: string): Promise<string> => {
  const refresh = newToken();
  await db.query(
    `UPDATE devices SET refresh_token_hash = $2, last_seen_at = now()
      WHERE id = $1 AND revoked_at IS NULL`,
    [deviceId, hashToken(refresh)],
  );
  return refresh;
};

export const findDeviceByRefresh = async (db: Db, refresh: string) =>
  db.one<{ id: string; userId: string }>(
    `SELECT d.id, d.user_id AS "userId"
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.refresh_token_hash = $1 AND d.revoked_at IS NULL AND u.state = 'active'`,
    [hashToken(refresh)],
  );
