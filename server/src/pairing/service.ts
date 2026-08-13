/**
 * Device pairing: the relay that lets a second device obtain the seed without the server
 * ever holding it (docs/06, docs/07).
 *
 * A second device cannot start with `/auth/login` — `auth_secret` comes from the seed it
 * does not yet have — so it bootstraps here. The new device makes an ephemeral X25519
 * keypair and a pairing secret; an already authorised device seals the seed **to that public
 * key** and hands the server an opaque envelope; the new device claims it once, and in
 * claiming becomes a registered device of that account.
 *
 * **This module is a relay and nothing else.** `seed_envelope` is bytes it never inspects,
 * because inspecting it would mean being able to, which is the property the whole design
 * exists to keep. The interesting rules here are lifecycle rules — who may write what, once
 * — and most of them are enforced by `device_pairings_check_lifecycle` in the schema rather
 * than restated here (docs/03).
 *
 * **The pairing secret is made by the new device, not by the server** (#110). The server
 * stores only `pairing_token_hash`, and storing a hash of a value the server itself generated
 * and returned would be theatre: it would know the secret from the start. Made on the device,
 * the secret reaches the server only when it is presented — which is the moment it must be
 * anyway, and never before.
 */
import type { Db } from '../db.js';
import { hashToken } from '../crypto.js';
import type { Refusal } from '../refuse.js';

export interface PairingLimits {
  /** docs/04: how long a pairing may sit unclaimed. A human carries a code between two devices. */
  ttlSeconds: number;
}

/**
 * Start a pairing. Anonymous by necessity: the caller has no account yet, which is the
 * whole point.
 *
 * The ephemeral public key is stored as given. It is the address the seed will be sealed
 * to, and the schema makes it immutable once approved — so an approver's envelope cannot
 * be re-pointed at a different device afterwards.
 */
export const beginPairing = async (
  db: Db,
  limits: PairingLimits,
  input: { devicePubkey: Buffer; pairingTokenHash: string },
): Promise<{ pairingId: string }> => {
  const row = await db.one<{ id: string }>(
    `INSERT INTO device_pairings (pairing_token_hash, device_pubkey, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     RETURNING id`,
    [input.pairingTokenHash, input.devicePubkey, limits.ttlSeconds],
  );
  return { pairingId: row!.id };
};

/**
 * An authorised device seals the seed to the waiting public key and leaves the envelope.
 *
 * Two conditions, and they are separate on purpose. The **caller** must be an authorised
 * device of the account being bound — checked by the route, from the token. The **secret**
 * must match, which is what proves the human is looking at the new device's screen rather
 * than approving a pairing somebody else started.
 *
 * Returns the public key it approved against, so the caller can see what it sealed to
 * rather than trusting that the id it was given still means what it meant.
 */
/**
 * What key to seal to — the step that has to come before approval, because sealing needs
 * the key and the key is what the waiting device registered.
 *
 * Authenticated for the same reason approval is: only a device that already holds the seed
 * has any business asking. Knowing the secret is still the credential; the token only says
 * the asker is somebody's device rather than the whole internet.
 *
 * **A malicious server could answer with a key of its own** and read the seed the approver
 * then seals. That is the standing limitation of relaying a bootstrap through the server at
 * all, and it is stated rather than papered over: the mitigations are that the human
 * approving has just read the code off the device that generated the key, and that the
 * pairing lives ten minutes. Removing it needs the public key to travel the human channel
 * too, which is a longer code than a person will type.
 */
export const lookupPairing = async (
  db: Db,
  input: { pairingSecret: string },
): Promise<{ devicePubkey: Buffer } | Refusal> => {
  const row = await db.one<{ pubkey: Buffer; approved: string | null; expired: boolean }>(
    `SELECT device_pubkey AS pubkey, approved_user_id AS approved, (expires_at <= now()) AS expired
       FROM device_pairings WHERE pairing_token_hash = $1`,
    [hashToken(input.pairingSecret)],
  );
  if (!row || row.expired) return { kind: 'not_found' };
  if (row.approved) return { kind: 'already_settled' };
  return { devicePubkey: row.pubkey };
};

export const approvePairing = async (
  db: Db,
  input: { pairingSecret: string; seedEnvelope: Buffer; userId: string },
): Promise<{ devicePubkey: Buffer } | Refusal> =>
  db.tx(async (c) => {
    // Found by the SECRET, not by an id in the URL. The human carries the secret between
    // two devices (docs/06) and nothing else; requiring the pairing's id here would mean
    // carrying a UUID alongside it for no gain, since `pairing_token_hash` is unique and
    // the secret already identifies exactly one row. The id stays what it is — a handle
    // for the device that created the pairing and polls its claim.
    const found = await c.query<{ id: string; pubkey: Buffer; approved: string | null; expired: boolean }>(
      `SELECT id, device_pubkey AS pubkey, approved_user_id AS approved, (expires_at <= now()) AS expired
         FROM device_pairings WHERE pairing_token_hash = $1 FOR UPDATE`,
      [hashToken(input.pairingSecret)],
    );
    // A secret that matches nothing and one whose pairing has expired answer the same way.
    const row = found.rows[0];
    if (!row || row.expired) return { kind: 'not_found' } as Refusal;
    if (row.approved) return { kind: 'already_settled' } as Refusal;

    await c.query(
      `UPDATE device_pairings
          SET approved_user_id = $2, approved_at = now(), seed_envelope = $3
        WHERE id = $1`,
      [row.id, input.userId, input.seedEnvelope],
    );
    return { devicePubkey: row.pubkey };
  });

/**
 * The new device takes the envelope, exactly once, and becomes a device of the account.
 *
 * Creating the `devices` row here rather than earlier is what makes "claim is once"
 * meaningful: the row and the consumption of the pairing commit together, so a repeated
 * claim cannot mint a second device, and a failed claim leaves no device behind.
 *
 * `account_salt` and `kdf_params` ride along because the device needs them to derive the
 * KEK and has nowhere else to get them at this point; `enc_privkey` because a bootstrapped
 * device restores its account identity too, not only its vault keys (docs/04).
 */
export const claimPairing = async (
  db: Db,
  input: { pairingId: string; pairingSecret: string; name: string; platform: string },
): Promise<
  | {
      seedEnvelope: string;
      encPrivkey: string;
      accountSalt: string;
      kdfParams: unknown;
      deviceId: string;
    }
  | Refusal
> =>
  db.tx(async (c) => {
    const found = await c.query<{
      hash: string;
      approved: string | null;
      claimed: string | null;
      envelope: Buffer | null;
      expired: boolean;
    }>(
      `SELECT pairing_token_hash AS hash, approved_user_id AS approved, claimed_device_id AS claimed,
              seed_envelope AS envelope, (expires_at <= now()) AS expired
         FROM device_pairings WHERE id = $1 FOR UPDATE`,
      [input.pairingId],
    );
    const row = found.rows[0];
    if (!row || row.expired || hashToken(input.pairingSecret) !== row.hash) return { kind: 'not_found' } as Refusal;
    // Not yet approved is a state to wait in, not a failure: the new device polls.
    if (!row.approved) return { kind: 'not_approved' } as Refusal;
    if (row.claimed) return { kind: 'already_settled' } as Refusal;

    const account = await c.query<{ encPrivkey: string; accountSalt: string; kdfParams: unknown }>(
      `SELECT encode(enc_privkey, 'base64')  AS "encPrivkey",
              encode(account_salt, 'base64') AS "accountSalt",
              kdf_params                     AS "kdfParams"
         FROM users WHERE id = $1 AND state = 'active'`,
      [row.approved],
    );
    // The approving account stopped being active between approval and claim.
    if (account.rowCount === 0) return { kind: 'not_found' } as Refusal;

    const device = await c.query<{ id: string }>(
      `INSERT INTO devices (user_id, name, platform) VALUES ($1, $2, $3) RETURNING id`,
      [row.approved, input.name, input.platform],
    );
    const deviceId = device.rows[0]!.id;

    await c.query(
      `UPDATE device_pairings SET claimed_device_id = $2, claimed_at = now() WHERE id = $1`,
      [input.pairingId, deviceId],
    );

    return {
      seedEnvelope: row.envelope!.toString('base64'),
      encPrivkey: account.rows[0]!.encPrivkey,
      accountSalt: account.rows[0]!.accountSalt,
      kdfParams: account.rows[0]!.kdfParams,
      deviceId,
    };
  });
