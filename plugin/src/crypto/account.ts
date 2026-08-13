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
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concat, fromBase64, randomBytes, toBase64, utf8 } from './bytes.js';
import { KEY_BYTES, NONCE_BYTES } from './format.js';

/** docs/06: the ceiling of a mobile WebView, and the reason it is not higher. */
export const DEFAULT_KDF_PARAMS = { v: 19, m: 65536, t: 3, p: 1 } as const;

export interface KdfParams {
  v: number;
  m: number;
  t: number;
  p: number;
}

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

/**
 * Wrapping is the same AEAD as content, with the nonce carried in front of the ciphertext.
 *
 * No header and no `aad` here, unlike a blob: this is 32 bytes under a key derived from a
 * passphrase, with nothing else in scope for an attacker to swap it with. A blob's header
 * is authenticated because a blob has one — an address, a key id, a format version that a
 * later version must not be able to reinterpret.
 */
export const wrap = (kek: Uint8Array, plaintext: Uint8Array): Uint8Array => {
  const nonce = randomBytes(NONCE_BYTES);
  return concat(nonce, xchacha20poly1305(kek, nonce).encrypt(plaintext));
};

export const unwrap = (kek: Uint8Array, wrapped: Uint8Array): Uint8Array => {
  if (wrapped.length <= NONCE_BYTES) throw new Error('wrapped value is too short to hold a nonce');
  return xchacha20poly1305(kek, wrapped.subarray(0, NONCE_BYTES)).decrypt(wrapped.subarray(NONCE_BYTES));
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

export interface Account {
  seed: Uint8Array;
  accountSalt: Uint8Array;
  kdfParams: KdfParams;
  /** Base64, as stored on the server. */
  wrappedSeed: string;
}

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
  return {
    seed,
    accountSalt,
    kdfParams: params,
    wrappedSeed: toBase64(wrap(deriveKek(passphrase, accountSalt, params), seed)),
  };
};

/** The other direction: a device that has the passphrase and what the server stores. */
export const openAccount = (
  passphrase: string,
  accountSalt: Uint8Array,
  kdfParams: KdfParams,
  wrappedSeed: string,
): Account => {
  const seed = unwrap(deriveKek(passphrase, accountSalt, kdfParams), fromBase64(wrappedSeed));
  return { seed, accountSalt, kdfParams, wrappedSeed };
};
