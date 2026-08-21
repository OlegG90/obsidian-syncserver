/**
 * The account key hierarchy from docs/06, and nothing else.
 *
 *     KEK          = Argon2id(passphrase, account_salt, m, t, p)
 *     seed         = 32 random bytes                       ← generated ONCE, never derived
 *     wrapped_seed = AEAD(KEK, seed)                       ← what the server stores
 *     auth_secret  = HKDF(seed, info = "auth")             ← the only branch that leaves
 *     KV           = HKDF(seed, info = vault_id)           ← one per vault, on demand
 *
 * The seed is **random and wrapped**, not derived from the passphrase. Derived, a passphrase
 * change would change every vault key and force re-encrypting everything the account owns.
 * Wrapped, a passphrase change re-wraps 32 bytes and re-encrypts nothing.
 */
import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KdfParams } from '@syncserver/shared';
import { randomBytes, toBase64, toHex, utf8 } from './bytes.js';
import { normaliseHumanCode } from './human-code.js';
import { KEY_BYTES } from './format.js';
import { newKeypair } from './hpke.js';
import { open, seal } from './sealed.js';

/** docs/06: the ceiling of a mobile WebView, and the reason it is not higher. */
export const DEFAULT_KDF_PARAMS = { v: 19, m: 65536, t: 3, p: 1 } as const;

/**
 * One expensive pass per account (AC-11). Everything else in this file is cheap, which is
 * the whole point of the hierarchy: the phone pays Argon2id once, then derives per vault.
 */
export const deriveKek = (passphrase: string, accountSalt: Uint8Array, params: KdfParams = DEFAULT_KDF_PARAMS): Uint8Array => {
  if (params.v !== 19) throw new Error(`unsupported Argon2 version ${params.v}`);
  return argon2id(utf8(passphrase.normalize('NFC')), accountSalt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: KEY_BYTES,
  });
};

export const newSeed = (): Uint8Array => randomBytes(KEY_BYTES);

const branch = (seed: Uint8Array, info: string): Uint8Array =>
  // No salt: the seed is already 32 bytes of CSPRNG output, and HKDF's salt exists to
  // extract entropy from input that lacks it. `info` is what separates the branches.
  hkdf(sha256, seed, undefined, utf8(info), KEY_BYTES);

/**
 * What the server receives as the account's password — and the only branch of the seed that
 * ever leaves the device. Base64 because it travels as a string and the server hashes the
 * string's UTF-8 bytes (docs/06, #108); the encoding is part of the contract.
 */
export const authSecret = (seed: Uint8Array): string => toBase64(branch(seed, 'auth'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `KV = HKDF(seed, vault_id)` (AC-11). Two vaults of one account therefore have different
 * keys, which is why they never deduplicate against each other (AC-09) — the property comes
 * from this line and nowhere else.
 *
 * The id is checked to be a UUID, and that check is load-bearing rather than tidiness. Both
 * branches of the seed are `HKDF(seed, info)`, so they are separated by exactly one thing:
 * no vault id can equal the literal `"auth"`. That holds because vault ids are UUIDs — but
 * it held silently, and what it guards is the difference between a vault key that never
 * leaves the device and the one branch that is sent to the server as a password.
 */
export const vaultKey = (seed: Uint8Array, vaultId: string): Uint8Array => {
  if (!UUID.test(vaultId)) throw new Error(`a vault id must be a UUID, got ${JSON.stringify(vaultId)}`);
  return branch(seed, vaultId);
};

/**
 * What unlocking gives back: the seed, and what was needed to reach it.
 *
 * The identity is deliberately absent. Unlocking works from the passphrase and what the
 * server already told this device, while `enc_privkey` is fetched separately — a device
 * that has just been paired receives it from the pairing, not from the passphrase.
 */
export interface OpenedAccount {
  seed: Uint8Array;
  accountSalt: Uint8Array;
  kdfParams: KdfParams;
  /** Base64, as stored on the server. */
  wrappedSeed: string;
  /**
   * The key-encryption key itself, kept because it was just computed.
   *
   * Argon2id at 64 MiB is the one expensive thing this design does, and the recovery
   * verifier needs the same value — recomputing it would charge a phone a second full pass
   * to produce a string it already had the ingredients for.
   */
  kek: Uint8Array;
}

/** A newly created account, which is the one moment the identity is made rather than read. */
export interface Account extends OpenedAccount {
  /** The account's X25519 identity: public half plain, private half wrapped (docs/06). */
  pubkey: string;
  encPrivkey: string;
}

/**
 * The account's X25519 identity — the one keypair here that encrypts nothing of its own.
 *
 * It exists so **other people** can send this account something: today the share key, in an
 * envelope only this account can open (docs/06). Every device of the account holds the same
 * one, because it identifies the account rather than the device — which is also why a paired
 * device is handed `enc_privkey` and not a new pair of its own.
 *
 * Generated rather than derived, as docs/06 states, and the private half wrapped under a
 * branch of the seed. Deriving it would have been simpler and is not what the model says:
 * a generated key can be replaced without replacing the seed, and a derived one could not.
 */
export const newIdentity = (): { secretKey: Uint8Array; publicKey: Uint8Array } => newKeypair();

/** The private half, sealed under an account key from the seed. */
export const wrapIdentity = (seed: Uint8Array, secretKey: Uint8Array): string =>
  seal(branch(seed, IDENTITY), secretKey);

/** The reverse, on any device that has the seed. */
export const unwrapIdentity = (seed: Uint8Array, encPrivkey: string): Uint8Array =>
  open(branch(seed, IDENTITY), encPrivkey);

/** The branch label. Separate from `auth`, so the two can never be each other. */
const IDENTITY = 'identity';

/**
 * The floor the server enforces (#62), checked here too.
 *
 * Not duplication for its own sake: registering below it is refused by a CHECK constraint
 * inside a transaction, so the client that got it wrong learns least. Failing before the
 * network means the message arrives where the parameters were chosen.
 */
export const assertKdfFloor = (p: KdfParams): void => {
  if (p.v !== 19 || p.m < 65536 || p.t < 3 || p.p < 1) {
    throw new Error(`Argon2id parameters below the server's floor: need v=19, m>=65536, t>=3, p>=1, got ${JSON.stringify(p)}`);
  }
};

/** A brand-new account: everything generated here, nothing derived from the passphrase but the KEK. */
export const createAccount = (passphrase: string, params: KdfParams = DEFAULT_KDF_PARAMS): Account => {
  assertKdfFloor(params);
  const accountSalt = randomBytes(16);
  const seed = newSeed();
  const identity = newIdentity();
  const kek = deriveKek(passphrase, accountSalt, params);
  return {
    seed,
    accountSalt,
    kdfParams: params,
    wrappedSeed: seal(kek, seed),
    kek,
    pubkey: toBase64(identity.publicKey),
    encPrivkey: wrapIdentity(seed, identity.secretKey),
  };
};

/**
 * Proof that whoever holds it can open `wrapped_seed` — without holding the seed (#112).
 *
 * This is what lets a device with nothing at all recover the account: the server compares it
 * against a stored hash and returns the envelope, having learned nothing it did not already
 * store. It is derived from the **KEK** rather than the seed on purpose, because at recovery
 * time the seed is precisely what the device does not have.
 *
 * Bound to the login and the salt so it cannot be replayed against another account, and so a
 * server that answered `/auth/kdf` with somebody else's salt gets a verifier that fits
 * nothing.
 */
export const kekVerifier = (kek: Uint8Array, login: string, accountSalt: Uint8Array): string => {
  const info = new Uint8Array([...utf8('recovery'), ...utf8(login), ...accountSalt]);
  return toBase64(hkdf(sha256, kek, undefined, info, KEY_BYTES));
};

/**
 * The recovery code's half of the key model (M7): a **second wrapping of the same seed**.
 *
 * Nothing is re-encrypted and no vault key changes — `recovery_key` sits beside
 * `wrapped_seed` exactly as `enc_privkey` sits beside both, and the two envelopes hold the
 * same 32 bytes under different keys. That is what makes a code cheap to create and cheap to
 * replace: replacing one re-wraps 32 bytes and re-encrypts nothing.
 *
 * **HKDF, not Argon2id, and the asymmetry is deliberate.** The passphrase gets a 64 MiB pass
 * because it is a human's choice and therefore guessable; the code is 128 bits of CSPRNG
 * (`human-code.ts`), and no work factor buys anything against that — it would only charge the
 * person recovering, at the one moment they are already having a bad day. This is the same
 * reasoning docs/06 gives for hashing the stored verifiers fast.
 *
 * Salted with `account_salt` and labelled, so a code cannot be carried to another account and
 * so this branch can never collide with the seed's own.
 */
const recoveryKek = (code: string, accountSalt: Uint8Array): Uint8Array =>
  hkdf(sha256, utf8(normaliseHumanCode(code)), accountSalt, utf8(RECOVERY), KEY_BYTES);

/** The branch label, distinct from `auth` and `identity` for the same reason they are. */
const RECOVERY = 'recovery-code';

/** `recovery_key` — the seed, wrapped under the code the person will keep. */
export const wrapForRecovery = (seed: Uint8Array, code: string, accountSalt: Uint8Array): string =>
  seal(recoveryKek(code, accountSalt), seed);

/** The other direction, on a device that has the code and nothing else (#34). */
export const unwrapWithRecovery = (
  recoveryKey: string,
  code: string,
  accountSalt: Uint8Array,
): Uint8Array => open(recoveryKek(code, accountSalt), recoveryKey);

/**
 * `recovery_code_hash` — what the server stores, and what it compares a presented code to.
 *
 * SHA-256 over the code's UTF-8 bytes, hex, exactly as every other stored verifier (docs/06,
 * #108). **Over the NORMALISED code**, because that is what the server will be handed at
 * recovery: the code crosses a human, arriving with or without dashes and with whatever they
 * made of a `0`. Hashing the displayed form here and the typed form there is the bug that
 * made pairing fail on real hardware, one layer down.
 */
export const recoveryCodeHash = (code: string): string =>
  toHex(sha256(utf8(normaliseHumanCode(code))));

/** The other direction: a device that has the passphrase and what the server stores. */
export const openAccount = (
  passphrase: string,
  accountSalt: Uint8Array,
  kdfParams: KdfParams,
  wrappedSeed: string,
): OpenedAccount => {
  const kek = deriveKek(passphrase, accountSalt, kdfParams);
  const seed = open(kek, wrappedSeed);
  return { seed, accountSalt, kdfParams, wrappedSeed, kek };
};
