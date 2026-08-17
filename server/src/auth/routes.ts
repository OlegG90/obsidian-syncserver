import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { fakeAccountSalt, hashToken } from '../crypto.js';
import type { Db } from '../db.js';
import {
  findActiveAccount,
  findDeviceByRefresh,
  issueRefreshToken,
  recoverAccount,
  consoleSignIn,
  setFirstPassword,
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

  /**
   * The first run, and the only thing this server answers until it is done (#107, #115).
   *
   * A password is CREATED here rather than replaced: the seeded administrator has none, so
   * there is no default that keeps working for anybody who never got round to changing it.
   * The refusal afterwards is `409` and not `404` — the caller found the right endpoint, it
   * is simply no longer the first run, and saying so is what stops somebody hunting for a
   * typo in their request.
   */
  app.post<{ Body: { password: string } }>('/auth/bootstrap', async (req, reply) => {
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12) {
      return reply.code(400).send({
        error: 'password_too_short',
        detail: 'at least 12 characters — this one is not slowed down by a client-side KDF',
      });
    }

    const out = await setFirstPassword(db, password);
    if (!out) return reply.code(409).send({ error: 'already_bootstrapped' });
    return reply.code(201).send({ login: out.login });
  });

  app.post<{
    Body: {
      invitation_token: string;
      login: string;
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
      login: b.login ?? '',
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

    // Named, unlike the refusal above, and the difference is what the caller can do about
    // it. "No such token" must stay one answer for three cases or it becomes an oracle;
    // this one is a person holding a valid invitation who typed the wrong name for it, and
    // telling them which name it is gives away nothing they were not just handed.
    if ('mismatch' in out) {
      return reply.code(409).send({
        error: 'login_mismatch',
        detail: `this invitation is for "${out.mismatch}"`,
      });
    }

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

  /**
   * Sign in to the console (#115).
   *
   * Rate-limited on the same limiter as recovery, and for the same reason: this is the other
   * endpoint on this server where guessing pays, because the secret behind it is one a person
   * chose rather than 128 bits of CSPRNG.
   */
  app.post<{ Body: { login: string; password: string; device_name?: string } }>(
    '/auth/console',
    async (req, reply) => {
      const login = req.body?.login;
      const password = req.body?.password;
      if (typeof login !== 'string' || typeof password !== 'string') {
        return reply.code(400).send({ error: 'login_and_password_required' });
      }

      const allowed = attempts.check(login);
      if (!allowed.ok) {
        return reply
          .code(429)
          .send({ error: 'too_many_attempts', retry_after_seconds: allowed.retryAfterSeconds });
      }

      const out = await consoleSignIn(db, login, password, req.body.device_name ?? 'console');
      if (!out) {
        attempts.fail(login);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      attempts.succeed(login);

      return {
        access: app.jwt.sign({ sub: out.userId, device: out.deviceId }, { expiresIn: cfg.accessTokenTtlSeconds }),
        refresh: await issueRefreshToken(db, out.deviceId),
        user_id: out.userId,
      };
    },
  );

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
      const identity = await db.one<{ encPrivkey: string; needsKekVerifier: boolean }>(
        `SELECT encode(enc_privkey, 'base64') AS "encPrivkey",
                (kek_verifier_hash IS NULL) AS "needsKekVerifier"
           FROM users WHERE id = $1`,
        [account.id],
      );

      return {
        access: app.jwt.sign({ sub: account.id, device: deviceId }, { expiresIn: cfg.accessTokenTtlSeconds }),
        refresh: await issueRefreshToken(db, deviceId),
        user_id: account.id,
        enc_privkey: identity!.encPrivkey,
        // Said rather than assumed, because an account made before recovery existed has no
        // verifier and cannot produce one itself: only a client holding the passphrase can.
        // Without this flag such an account would stay unrecoverable forever, silently.
        needs_kek_verifier: identity!.needsKekVerifier,
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

  /**
   * Retire a device of the caller's own account — what disconnecting does on its way out.
   *
   * **Revoked, not deleted.** `versions.author_id` and the audit log point at devices'
   * accounts and a history that forgets who wrote what is worse than one naming a device
   * that no longer syncs. Revocation also does the one thing that matters: the refresh token
   * stops working, so a device that keeps running cannot mint another access token.
   *
   * Idempotent, and silent about devices that are not the caller's — a 404 for someone
   * else's id would confirm it exists.
   */
  /**
   * Set this account's recovery verifier — the one thing only a client with the passphrase
   * can compute (#112).
   *
   * Two callers, one shape: an account that predates recovery, backfilling on its first
   * unlock, and a passphrase change, which must move the verifier with the KEK or leave it
   * pointing at a phrase nobody uses.
   *
   * Authenticated, and that is proof enough: reaching here at all took `auth_secret`, which
   * comes from the seed, which comes from the envelope this verifier guards.
   */
  app.put<{ Body: { kek_verifier: string } }>('/auth/kek-verifier', async (req, reply) => {
    const claims = await req.jwtVerify<{ sub: string }>().catch(() => undefined);
    if (!claims) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.body?.kek_verifier) return reply.code(400).send({ error: 'kek_verifier_required' });

    await db.query(`UPDATE users SET kek_verifier_hash = $2 WHERE id = $1 AND state = 'active'`, [
      claims.sub,
      hashToken(req.body.kek_verifier),
    ]);
    return reply.code(204).send();
  });

  app.delete<{ Params: { deviceId: string } }>('/auth/devices/:deviceId', async (req, reply) => {
    const claims = await req.jwtVerify<{ sub: string }>().catch(() => undefined);
    if (!claims) return reply.code(401).send({ error: 'unauthenticated' });

    await db.query(
      `UPDATE devices SET revoked_at = now(), refresh_token_hash = NULL
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [req.params.deviceId, claims.sub],
    );
    return reply.code(204).send();
  });
};
