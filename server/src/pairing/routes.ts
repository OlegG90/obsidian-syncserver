/**
 * `POST /auth/pairings`, `…/approve`, `…/claim` — the second-device bootstrap (docs/04).
 *
 * Two of the three are **unauthenticated**, and that is the design rather than an omission:
 * a device with no seed has no `auth_secret` and therefore nothing to authenticate with. The
 * pairing secret is the credential on those two, and it is proved against a stored hash.
 *
 * Approval is the exception and is authenticated: only a device that already holds the seed
 * can seal it, so only such a device may approve.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { approvePairing, beginPairing, claimPairing, lookupPairing } from './service.js';

/** X25519 public keys are 32 bytes; nothing else is a public key here. */
const PUBKEY_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

export const registerPairingRoutes = (app: FastifyInstance, db: Db, cfg: Config): void => {
  const limits = { ttlSeconds: cfg.limits.pairingTtlSeconds };

  /**
   * Start a pairing: the new device registers where to send the seed, and a hash of the
   * secret the human is about to carry.
   *
   * The secret itself is **not** sent here (D-110). The server stores a hash, and a hash of
   * something it generated would prove nothing about who is asking later.
   */
  app.post<{ Body: { device_pubkey?: string; pairing_token_hash?: string } }>(
    '/auth/pairings',
    async (req, reply) => {
      const pubkey = req.body?.device_pubkey;
      const hash = req.body?.pairing_token_hash;
      if (!pubkey) return reply.code(400).send({ error: 'device_pubkey_required' });
      if (!hash || !HEX64.test(hash)) return reply.code(400).send({ error: 'bad_pairing_token_hash' });

      const raw = Buffer.from(pubkey, 'base64');
      if (raw.length !== PUBKEY_BYTES) return reply.code(400).send({ error: 'bad_device_pubkey' });

      const out = await beginPairing(db, limits, { devicePubkey: raw, pairingTokenHash: hash });
      return reply.code(201).send({ pairing_id: out.pairingId });
    },
  );

  /**
   * What to seal to. Sealing needs the waiting device's key, so this necessarily precedes
   * approval — see the service for the substitution limitation this admits.
   */
  app.post<{ Body: { pairing_secret?: string } }>(
    '/auth/pairings/lookup',
    { preHandler: requireAuth },
    async (req, reply) => {
      const secret = req.body?.pairing_secret;
      if (!secret) return reply.code(400).send({ error: 'pairing_secret_required' });

      const out = await lookupPairing(db, { pairingSecret: secret });
      if ('kind' in out) return refuse(reply, out);
      return { device_pubkey: out.devicePubkey.toString('base64') };
    },
  );

  /**
   * An authorised device leaves the sealed seed, addressed by the **secret alone**.
   *
   * No id in the path, because the human carries the secret and nothing else (docs/06);
   * making them also carry a UUID would buy nothing — the secret is unique and identifies
   * the pairing exactly.
   *
   * The account bound is the **caller's own**, taken from the token and never from the
   * body: a device approves into the account it belongs to, and letting a request name a
   * different one would be an invitation to bind somebody else's.
   */
  app.post<{ Body: { pairing_secret?: string; seed_envelope?: string } }>(
    '/auth/pairings/approve',
    { preHandler: requireAuth },
    async (req, reply) => {
      const secret = req.body?.pairing_secret;
      const envelope = req.body?.seed_envelope;
      if (!secret) return reply.code(400).send({ error: 'pairing_secret_required' });
      if (!envelope) return reply.code(400).send({ error: 'seed_envelope_required' });

      const out = await approvePairing(db, {
        pairingSecret: secret,
        seedEnvelope: Buffer.from(envelope, 'base64'),
        userId: req.caller!.userId,
      });
      if ('kind' in out) return refuse(reply, out);

      // Echoed so the approver can check what it sealed to against what it sealed for. The
      // server could have handed it any key; this lets the client notice.
      return { device_pubkey: out.devicePubkey.toString('base64') };
    },
  );

  /**
   * The new device takes the envelope, once, and becomes a device of the account.
   *
   * `409 not_approved` is the polling answer — the pairing is real and nobody has approved
   * it yet, so the caller should keep asking rather than start over.
   */
  app.post<{ Params: { id: string }; Body: { pairing_secret?: string; name?: string; platform?: string } }>(
    '/auth/pairings/:id/claim',
    async (req, reply) => {
      const secret = req.body?.pairing_secret;
      if (!secret) return reply.code(400).send({ error: 'pairing_secret_required' });

      const out = await claimPairing(db, {
        pairingId: req.params.id,
        pairingSecret: secret,
        name: req.body?.name ?? 'obsidian',
        platform: req.body?.platform ?? 'unknown',
      });
      if ('kind' in out) return refuse(reply, out);

      return {
        seed_envelope: out.seedEnvelope,
        enc_privkey: out.encPrivkey,
        account_salt: out.accountSalt,
        kdf_params: out.kdfParams,
        device_id: out.deviceId,
        user_id: out.userId,
      };
    },
  );
};
