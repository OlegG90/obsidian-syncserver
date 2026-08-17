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
import type { KdfParams } from '@syncserver/shared';
import { hashToken, newToken, tokenMatches } from '../crypto.js';
import { record } from '../admin/audit.js';
import type { Db } from '../db.js';

export interface RedeemInput {
  invitationToken: string;
  authSecret: string;
  accountSalt: Buffer;
  kdfParams: KdfParams;
  pubkey: Buffer;
  encPrivkey: Buffer;
  wrappedSeed: Buffer;
  /** Proof the account can later be recovered from the passphrase alone (#112). Required. */
  kekVerifier: string;
  /**
   * The recovery code's envelope and verifier, or neither.
   *
   * Optional together: they answer a forgotten passphrase, which not every account insures
   * against. Absent is written as NULL and means exactly that — the placeholder this
   * replaced made an account claim a way back it did not have.
   */
  recoveryKey?: Buffer | undefined;
  recoveryCodeHash?: string | undefined;
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
              kek_verifier_hash = $8,
              recovery_key = $9, recovery_code_hash = $10,
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
        hashToken(input.kekVerifier),
        input.recoveryKey ?? null,
        input.recoveryCodeHash ?? null,
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

    // Through the one statement, like every other record: this is an account acting on
    // itself, which is the only kind the log holds that no administrator caused.
    await record(c, {
      actor: { id: row.id, login: row.login },
      action: 'account.activate',
      target: { id: row.id, login: row.login },
    });

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

/** What recovery gives back: the envelope the proof unlocks, and a device to use it from. */
export interface Recovered {
  seedEnvelope: string;
  openedBy: 'passphrase' | 'recovery_code';
  encPrivkey: string;
  accountSalt: string;
  kdfParams: KdfParams;
  userId: string;
  deviceId: string;
}

/**
 * Return an account to a device that holds nothing, against proof it can open the envelope.
 *
 * The one bootstrap that needs no second device (#112). Two proofs reach it, because two
 * different things get lost: the passphrase answers a lost device, the recovery code answers
 * a forgotten passphrase — and each is answered with **only** the envelope it opens. Handing
 * back both would give whoever guessed one a second target for free.
 *
 * `undefined` for every failure, deliberately undifferentiated: an unknown login, an account
 * with no recovery code, and a wrong proof are one answer, or the endpoint becomes the
 * enumeration oracle #73 closes everywhere else.
 */
export const recoverAccount = async (
  db: Db,
  input: {
    login: string;
    kekVerifier?: string | undefined;
    recoveryCode?: string | undefined;
    name: string;
    platform: string;
  },
): Promise<Recovered | undefined> =>
  db.tx(async (c: PoolClient) => {
    const found = await c.query<{
      id: string;
      login: string;
      wrappedSeed: string;
      recoveryKey: string | null;
      kekVerifierHash: string | null;
      recoveryCodeHash: string | null;
      encPrivkey: string;
      accountSalt: string;
      kdfParams: KdfParams;
    }>(
      `SELECT id, login,
              encode(wrapped_seed, 'base64')  AS "wrappedSeed",
              encode(recovery_key, 'base64')  AS "recoveryKey",
              kek_verifier_hash               AS "kekVerifierHash",
              recovery_code_hash              AS "recoveryCodeHash",
              encode(enc_privkey, 'base64')   AS "encPrivkey",
              encode(account_salt, 'base64')  AS "accountSalt",
              kdf_params                      AS "kdfParams"
         FROM users WHERE lower(login) = lower($1) AND state = 'active'`,
      [input.login],
    );
    const user = found.rows[0];
    if (!user) return undefined;

    const opened = ((): { envelope: string; by: Recovered['openedBy'] } | undefined => {
      if (input.kekVerifier !== undefined) {
        if (!user.kekVerifierHash || !tokenMatches(input.kekVerifier, user.kekVerifierHash)) return undefined;
        return { envelope: user.wrappedSeed, by: 'passphrase' };
      }
      if (input.recoveryCode !== undefined) {
        // An account may hold no recovery code at all, which is a null pair and not a fault.
        if (!user.recoveryCodeHash || !user.recoveryKey) return undefined;
        if (!tokenMatches(input.recoveryCode, user.recoveryCodeHash)) return undefined;
        return { envelope: user.recoveryKey, by: 'recovery_code' };
      }
      return undefined;
    })();
    if (!opened) return undefined;

    // Created exactly as pairing's claim creates one: recovery is a door, not a mode, and
    // past it this is an ordinary freshly-bootstrapped device.
    const device = await c.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, $3) RETURNING id`,
      [user.id, input.name, input.platform],
    );

    // The account recovering itself is both actor and target. Recorded because a recovery is
    // the one event that gives a new device everything without anyone approving it.
    await record(c, {
      actor: { id: user.id, login: user.login },
      action: 'account.recover',
      target: { id: user.id, login: user.login },
      details: { opened_by: opened.by, device: input.platform },
    });

    return {
      seedEnvelope: opened.envelope,
      openedBy: opened.by,
      encPrivkey: user.encPrivkey,
      accountSalt: user.accountSalt,
      kdfParams: user.kdfParams,
      userId: user.id,
      deviceId: device.rows[0]!.id,
    };
  });
