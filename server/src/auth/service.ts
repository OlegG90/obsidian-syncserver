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
import { hashPassword, passwordMatches } from './password.js';
import type { Db } from '../db.js';

export interface RedeemInput {
  invitationToken: string;
  /**
   * The login the person typed, which the server **checks** rather than stores.
   *
   * The account's name belongs to the invitation — an administrator sets it when issuing one
   * — so redeeming cannot choose it. But the client binds `kek_verifier` to the name it was
   * given and writes that name into its connection record, both before it could learn the
   * real one. A silent mismatch therefore produces a device that syncs until its first
   * relock and then cannot log in, and an account whose recovery proof is bound to a name
   * nobody has. Found on a live walk, exactly that way round.
   */
  login: string;
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
 * The first run: give the seeded administrator a password, which is what brings it to life.
 *
 * `schema.sql` seeds a **console account with none** (#107, #115). Setting one is what
 * *creates* it — there is no default to change, so there is no state in which a default
 * works, which a seeded password would have left behind for anybody who never got round to
 * it. While it is unset the server answers nothing else, so the window is the first run.
 *
 * **It names the administrator too** (#123). The schema seeds the row as `admin`, and that
 * meant every installation of this server shipped with the login of its most privileged
 * account already known — written in `schema.sql`, repeated in the docs, and identical
 * everywhere. Half a credential, given away. `attempts.check` rate-limits by login, so a
 * fixed one is also the half an attacker never has to guess. #107 already says that setting
 * the password is what CREATES the administrator; naming it is part of creating it.
 *
 * The seeded `admin` stays as the default the console offers, because most operators will
 * take it and a forced choice on the first screen of a fresh server is a decision nobody
 * asked to make.
 *
 * The `state = 'provisioned'` in the `WHERE` is the whole of the once-only guarantee: the
 * same statement that sets the password moves the row out of the state it matches on, so a
 * second call finds nothing. No separate check, and no window between checking and writing.
 * A concurrent second call blocks on the row and then re-reads it as `active`, so the
 * guarantee survives being wrapped in a transaction — which it now is (#88).
 *
 * **One transaction: the password and its audit row commit together, or neither does.** They
 * were two, and the audit entry was wrapped in a `db.tx` of its own — the one shape that looks
 * careful and is not. A crash in between left an administrator existing with nothing saying it
 * had been created, on the single account whose creation is the most interesting line the log
 * will ever hold. `confirmRestore` had already written the rule down for exactly this case.
 *
 * **Hashed before the transaction opens, deliberately.** Argon2id at the 64 MiB floor (#62)
 * takes real time, and computing it inside would pin a pool connection for the whole
 * derivation — on the one request a fresh server is certain to receive.
 */
export const setFirstPassword = async (
  db: Db,
  login: string,
  password: string,
): Promise<{ userId: string; login: string } | 'login_taken' | undefined> => {
  const hash = hashPassword(password);

  return db.tx(async (c) => {
    const done = await c.query<{ id: string; login: string }>(
      `UPDATE users SET state = 'active', password_hash = $1, login = $2
        WHERE id = '00000000-0000-0000-0000-000000000001'
          AND role = 'admin' AND state = 'provisioned'
        RETURNING id, login`,
      [hash, login],
    ).catch((e: unknown) => {
      // `login` is UNIQUE, and a fresh server already holds one other row: the tombstone
      // (`deleted`). Picking that name is the one collision possible here, and it has to
      // answer with what is wrong rather than a 500 on a constraint nobody can see.
      if (e instanceof Error && /users_login_key|unique/i.test(e.message)) return undefined;
      throw e;
    });
    if (!done) return 'login_taken';
    const row = done.rows[0];
    if (!row) return undefined;

    await record(c, {
      actor: { id: row.id, login: row.login },
      action: 'account.bootstrap',
      target: { id: row.id, login: row.login },
    });
    return { userId: row.id, login: row.login };
  });
};

/**
 * Sign in a console account, and give it a device to be signed out from.
 *
 * A **password** rather than an `auth_secret`, because a console account has no seed to
 * derive one from — that is the whole of #115. It is checked with Argon2id here, since no
 * client-side KDF can stand in: the browser is not trusted to have run one.
 *
 * **A device row, for a browser.** The access token names an account *and* a device (#90),
 * so a caller can be throttled and a session can be ended one place at a time. A browser is
 * not a device in the way a phone is, but it is a session somebody may want to end, and
 * inventing a second shape of token to avoid a row would cost more than the row.
 *
 * The refusal is the same for an unknown login, a vault account and a wrong password.
 * Anything else would say which logins administer this server, to anybody who asks.
 */
export const consoleSignIn = async (
  db: Db,
  login: string,
  password: string,
  deviceName: string,
): Promise<{ userId: string; deviceId: string } | undefined> => {
  const row = await db.one<{ id: string; hash: string }>(
    `SELECT id, password_hash AS hash FROM users
      WHERE lower(login) = lower($1) AND state = 'active' AND role = 'admin'
        AND password_hash IS NOT NULL`,
    [login],
  );
  if (!row || !passwordMatches(password, row.hash)) return undefined;

  // One console device per account, reused. A device row exists so a session can be revoked
  // one at a time (#90) — it is a thing somebody installed and can point at. A browser is not
  // that: it signs in, closes, signs in again, and a row per sign-in is a list of devices
  // nobody owns, growing for ever, that makes the real ones harder to find.
  //
  // The consequence is stated rather than hidden: signing in to the console from a second
  // browser takes the session from the first, because they share the one refresh token.
  // Acceptable here in a way it would not be for a vault — an administrator has one console
  // session by design, and the sign-in is a password prompt away.
  const existing = await db.one<{ id: string }>(
    `SELECT id FROM devices
      WHERE user_id = $1 AND platform = 'console' AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
    [row.id],
  );
  if (existing) {
    await db.query(`UPDATE devices SET name = $2, last_seen_at = now() WHERE id = $1`, [existing.id, deviceName]);
    return { userId: row.id, deviceId: existing.id };
  }

  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, 'console') RETURNING id`,
    [row.id, deviceName],
  );
  return { userId: row.id, deviceId: device!.id };
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

    // A typo in the login is a typo, and it fails here, in a sentence, rather than a week
    // later as "that passphrase does not open this account".
    if (row.login.toLowerCase() !== input.login.trim().toLowerCase()) {
      return { mismatch: row.login } as const;
    }

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

/**
 * Give this account a recovery code, or replace the one it has (M7).
 *
 * **The two columns move together or not at all** — `recovery_code_is_whole` in the schema
 * refuses a half pair, and this is the statement that would otherwise write one. The envelope
 * is bytes the server cannot read and does not try to: it holds the same seed as
 * `wrapped_seed`, wrapped under a key derived from a code that never arrives here.
 *
 * **Replacing invalidates the previous code, and that is the point** rather than a side
 * effect. The whole risk of this feature is a slip of paper from three years ago that still
 * opens the account, so there is no way to hold two.
 *
 * Authenticated calling is proof enough, exactly as for `kek_verifier`: reaching here took
 * `auth_secret`, which comes from the seed, which is what the new envelope wraps. An account
 * that cannot open itself cannot file a code for itself.
 */
export const setRecoveryCode = async (
  db: Db,
  userId: string,
  input: { recoveryKey: Buffer; recoveryCodeHash: string },
): Promise<{ replaced: boolean } | undefined> =>
  db.tx(async (c) => {
    const found = await c.query<{ login: string; had: boolean }>(
      `SELECT login, (recovery_code_hash IS NOT NULL) AS had
         FROM users WHERE id = $1 AND state = 'active' FOR UPDATE`,
      [userId],
    );
    const user = found.rows[0];
    if (!user) return undefined;

    await c.query(`UPDATE users SET recovery_key = $2, recovery_code_hash = $3 WHERE id = $1`, [
      userId,
      input.recoveryKey,
      input.recoveryCodeHash,
    ]);

    // Recorded because it changes what can open the account, which is the class of event this
    // log exists for. `replaced` and not the code, obviously — and not the hash either: it is
    // a verifier, and a log is read by more people than a users table.
    await record(c, {
      actor: { id: userId, login: user.login },
      action: 'account.recovery_code',
      target: { id: userId, login: user.login },
      details: { replaced: user.had },
    });

    return { replaced: user.had };
  });

/**
 * Put this account behind a different passphrase: a new `wrapped_seed` and the verifier that
 * proves it, written together.
 *
 * **Built for recovery by code** (#34), which cannot work without it. Somebody who recovers
 * with a code does not know the passphrase — that is why they used the code — so they must set
 * one, and the account's envelope has to become the one that new passphrase opens. Leaving the
 * server's copy under the forgotten phrase would mean an account recoverable only by its code,
 * for ever, which is not what "recovered" means to anybody.
 *
 * **The pair moves together or not at all.** `wrapped_seed` and `kek_verifier_hash` describe
 * the same KEK from two sides; writing one without the other leaves the endpoint answering
 * with an envelope the accepted proof does not open — a state no constraint can catch, because
 * both columns are individually valid.
 *
 * **`account_salt` is deliberately NOT touched.** Rolling it would be ordinary hygiene and here
 * it is a trap: the salt is an input to the recovery code's KDF (M7), so a new salt silently
 * turns a written-down code into a string that opens nothing. The client cannot re-wrap that
 * envelope — it does not hold the code — so the salt stays for the life of the account.
 *
 * The seed itself never changes, which is why this is cheap and why nothing is re-encrypted:
 * every vault key is `HKDF(seed, vault_id)` and none of them moves (docs/06).
 */
export const setPassphrase = async (
  db: Db,
  userId: string,
  input: { wrappedSeed: Buffer; kekVerifier: string },
): Promise<boolean> =>
  db.tx(async (c) => {
    const found = await c.query<{ login: string }>(
      `SELECT login FROM users WHERE id = $1 AND state = 'active' FOR UPDATE`,
      [userId],
    );
    const user = found.rows[0];
    if (!user) return false;

    await c.query(`UPDATE users SET wrapped_seed = $2, kek_verifier_hash = $3 WHERE id = $1`, [
      userId,
      input.wrappedSeed,
      hashToken(input.kekVerifier),
    ]);

    await record(c, {
      actor: { id: userId, login: user.login },
      action: 'account.passphrase',
      target: { id: userId, login: user.login },
    });
    return true;
  });

/** Whether this account has a code at all — the one thing a screen needs to know before offering one. */
export const hasRecoveryCode = async (db: Db, userId: string): Promise<boolean> => {
  const row = await db.one<{ present: boolean }>(
    `SELECT (recovery_code_hash IS NOT NULL) AS present FROM users WHERE id = $1 AND state = 'active'`,
    [userId],
  );
  return row?.present ?? false;
};

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
