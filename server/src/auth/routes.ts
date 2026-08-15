import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { fakeAccountSalt } from '../crypto.js';
import type { Db } from '../db.js';
import {
  findActiveAccount,
  findDeviceByRefresh,
  issueRefreshToken,
  recoverAccount,
  redeemInvitation,
  verifyAuthSecret,
} from './service.js';
import { inProcessAttemptLimiter, type AttemptLimiter } from './attempts.js';
import type { KdfParams } from '@syncserver/shared';

const b64 = (s: string): Buffer => Buffer.from(s, 'base64');

export const registerAuthRoutes = (
  app: FastifyInstance,
  db: Db,
  cfg: Config,
  // Injected so a test can drive the clock instead of waiting a minute for a lockout to
  // expire, and so one limiter is shared by every route that needs it.
  attempts: AttemptLimiter = inProcessAttemptLimiter(),
): void => {
  /**
   * Answers before authentication, so an unknown login must not be distinguishable.
   * It gets a deterministic fake salt (#73) — never a 404, and never a random value,
   * which would differ between two calls and give the answer away more plainly.
   */
  app.get<{ Querystring: { login?: string } }>('/auth/kdf', async (req, reply) => {
    const login = req.query.login;
    if (!login) return reply.code(400).send({ error: 'login_required' });

    const found = await db.one<{ accountSalt: Buffer; kdfParams: KdfParams }>(
      `SELECT account_salt AS "accountSalt", kdf_params AS "kdfParams"
         FROM users WHERE lower(login) = lower($1) AND state = 'active'`,
      [login],
    );

    // The floor from #62, handed out with the fake salt so the shapes match too.
    const fallback: KdfParams = { v: 19, m: 65536, t: 3, p: 1 };
    return {
      account_salt: (found?.accountSalt ?? fakeAccountSalt(cfg.serverSecret, login)).toString('base64'),
      kdf_params: found?.kdfParams ?? fallback,
    };
  });

  app.post<{
    Body: {
      invitation_token: string;
      auth_secret: string;
      account_salt: string;
      kdf_params: KdfParams;
      pubkey: string;
      enc_privkey: string;
      wrapped_seed: string;
      kek_verifier: string;
      recovery_key?: string;
      recovery_code_hash?: string;
      initial_vault_id: string;
      initial_vault_name_enc: string;
      device_name?: string;
      device_platform?: string;
    };
  }>('/auth/redeem', async (req, reply) => {
    const b = req.body;

    // Checked here as well as in the schema, for the reason a 500 is not an answer.
    //
    // `is_valid_kdf` enforces the 64 MiB floor (#62), and a client that registers below it
    // hits a CHECK constraint — which surfaces as "Internal Server Error" and tells the one
    // person who can fix it nothing at all. The floor is a rule about the caller's input, so
    // it gets the status that says so, and names the parameter.
    const kdf = b.kdf_params;
    if (
      !kdf ||
      kdf.v !== 19 ||
      !Number.isInteger(kdf.m) ||
      !Number.isInteger(kdf.t) ||
      !Number.isInteger(kdf.p) ||
      kdf.m < 65536 ||
      kdf.t < 3 ||
      kdf.p < 1
    ) {
      // The numbers are `is_valid_kdf`'s, repeated rather than inferred: two places state
      // this floor, and if they ever disagree the CHECK wins and this becomes a 500 again.
      return reply.code(400).send({
        error: 'weak_kdf_params',
        required: { v: 19, m: '>= 65536 (64 MiB)', t: '>= 3', p: '>= 1' },
      });
    }

    // Without it the account could never be recovered from the passphrase, and nothing later
    // can add one: the KEK is the client's and only exists while it holds the phrase.
    if (!b.kek_verifier) return reply.code(400).send({ error: 'kek_verifier_required' });
    if ((b.recovery_key === undefined) !== (b.recovery_code_hash === undefined)) {
      return reply.code(400).send({ error: 'recovery_pair_incomplete' });
    }

    const out = await redeemInvitation(db, {
      invitationToken: b.invitation_token,
      authSecret: b.auth_secret,
      accountSalt: b64(b.account_salt),
      kdfParams: b.kdf_params,
      pubkey: b64(b.pubkey),
      encPrivkey: b64(b.enc_privkey),
      wrappedSeed: b64(b.wrapped_seed),
      kekVerifier: b.kek_verifier,
      // Sent together or not at all; the schema refuses half a pair, and refusing it here
      // names the caller's mistake instead of surfacing a constraint as a 500.
      recoveryKey: b.recovery_key === undefined ? undefined : b64(b.recovery_key),
      recoveryCodeHash: b.recovery_code_hash,
      initialVaultId: b.initial_vault_id,
      initialVaultNameEnc: b64(b.initial_vault_name_enc),
      deviceName: b.device_name ?? 'first device',
      devicePlatform: b.device_platform ?? 'unknown',
    });

    // One answer for "no such token", "already redeemed" and "expired". Which of the
    // three it was is not the caller's business, and saying would leak whether a token
    // ever existed.
    if (!out) return reply.code(404).send({ error: 'invitation_not_redeemable' });

    return {
      access: app.jwt.sign({ sub: out.userId, device: out.deviceId }, { expiresIn: cfg.accessTokenTtlSeconds }),
      refresh: out.refresh,
      device_id: out.deviceId,
      vault_id: out.vaultId,
      root_node_id: out.rootNodeId,
      // The account id, for the same reason login reports it: an invitation's envelope is
      // bound to it, so a device that will ever receive a share needs to know it.
      user_id: out.userId,
    };
  });

  app.post<{ Body: { login: string; auth_secret: string; device_id?: string } }>(
    '/auth/login',
    async (req, reply) => {
      const account = await findActiveAccount(db, req.body.login);
      // Same answer whether the login is unknown or the secret is wrong — the pair is the
      // credential, and telling them apart is the enumeration oracle #73 closes elsewhere.
      if (!account || !verifyAuthSecret(account.authSecretHash, req.body.auth_secret)) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const deviceId = req.body.device_id;
      if (!deviceId) return reply.code(400).send({ error: 'device_id_required' });

      const device = await db.one<{ id: string }>(
        `SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [deviceId, account.id],
      );
      if (!device) return reply.code(401).send({ error: 'invalid_credentials' });

      // The account's identity travels with the session, because receiving a share needs
      // it: an invitation is an HPKE envelope sealed to this account's public key, bound to
      // its id (docs/06). Neither half is a secret — `enc_privkey` is worthless without the
      // seed, which is exactly why the server may hold it and hand it back.
      const identity = await db.one<{ encPrivkey: string }>(
        `SELECT encode(enc_privkey, 'base64') AS "encPrivkey" FROM users WHERE id = $1`,
        [account.id],
      );

      return {
        access: app.jwt.sign({ sub: account.id, device: deviceId }, { expiresIn: cfg.accessTokenTtlSeconds }),
        refresh: await issueRefreshToken(db, deviceId),
        user_id: account.id,
        enc_privkey: identity!.encPrivkey,
      };
    },
  );

  /**
   * Return an account to a device that has nothing (#112).
   *
   * The proof comes first and the envelope second, which is the whole difference between
   * this and handing out seed envelopes by login name. Everything that can distinguish an
   * account from a non-account is deliberately flattened: an unknown login, an account with
   * no recovery code, a wrong verifier and a wrong code are one refusal (#73), and the
   * attempt limit is counted before any of them is evaluated.
   */
  app.post<{
    Body: {
      login: string;
      kek_verifier?: string;
      recovery_code?: string;
      device_name?: string;
      device_platform?: string;
    };
  }>('/auth/recover', async (req, reply) => {
    const b = req.body ?? ({} as Record<string, string>);
    if (!b.login) return reply.code(400).send({ error: 'login_required' });
    // Exactly one proof. Both would let a caller test two guesses per lockout slot; neither
    // is a request that could ever succeed.
    if ((b.kek_verifier === undefined) === (b.recovery_code === undefined)) {
      return reply.code(400).send({ error: 'one_proof_required' });
    }

    // Two keys, because either alone is bypassable: one login from a thousand addresses, or
    // a thousand logins from one.
    const keys = [`login:${b.login.toLowerCase()}`, `src:${req.ip}`];
    for (const key of keys) {
      const allowed = attempts.check(key);
      if (!allowed.ok) {
        return reply
          .code(429)
          .header('retry-after', String(allowed.retryAfterSeconds))
          .send({ error: 'rate_limited', retry_after: allowed.retryAfterSeconds });
      }
    }

    const out = await recoverAccount(db, {
      login: b.login,
      kekVerifier: b.kek_verifier,
      recoveryCode: b.recovery_code,
      name: b.device_name ?? 'recovered device',
      platform: b.device_platform ?? 'unknown',
    });

    if (!out) {
      for (const key of keys) attempts.fail(key);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    for (const key of keys) attempts.succeed(key);

    return {
      seed_envelope: out.seedEnvelope,
      opened_by: out.openedBy,
      enc_privkey: out.encPrivkey,
      account_salt: out.accountSalt,
      kdf_params: out.kdfParams,
      user_id: out.userId,
      device_id: out.deviceId,
    };
  });

  app.post<{ Body: { refresh: string } }>('/auth/refresh', async (req, reply) => {
    const device = await findDeviceByRefresh(db, req.body.refresh);
    if (!device) return reply.code(401).send({ error: 'invalid_refresh' });

    return {
      access: app.jwt.sign({ sub: device.userId, device: device.id }, { expiresIn: cfg.accessTokenTtlSeconds }),
    };
  });

  app.post<{ Body: { name: string; platform: string } }>('/auth/devices', async (req, reply) => {
    const claims = await req.jwtVerify<{ sub: string }>().catch(() => undefined);
    if (!claims) return reply.code(401).send({ error: 'unauthenticated' });

    const row = await db.one<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, $3) RETURNING id`,
      [claims.sub, req.body.name, req.body.platform],
    );
    return reply.code(201).send({ device_id: row!.id });
  });
};
