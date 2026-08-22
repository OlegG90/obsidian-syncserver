/**
 * The share key, `KS`.
 *
 * **A transport key, not a branch of anything.** Every other key in this system is derived:
 * `KV = HKDF(seed, vault_id)`, the account seed unwrapped from a passphrase. `KS` is not,
 * and cannot be — it has to be readable by people who will never hold this account's seed,
 * so it is random bytes wrapped separately for each participant. That is also why leaving a
 * share costs nothing cryptographically: the leaver keeps the copy, converts the names back
 * to `KV`, and `KS` simply stops mattering to them.
 *
 * It is never rotated (D-10). A rotation would have to re-key every name in the subtree in
 * every replica at once, and it would buy nothing: anyone who ever held `KS` has already
 * seen the plaintext it protects.
 */
import { randomBytes } from './bytes.js';
import { open, seal } from './sealed.js';

/** 256 bits, matching every other key here. */
const KEY_BYTES = 32;

/** A fresh share key. Random, because it is shared with people the seed never reaches. */
export const newShareKey = (): Uint8Array => randomBytes(KEY_BYTES);

/**
 * The initiator's own copy of `KS`, wrapped under the vault key it lives beside.
 *
 * Their copy is a wrap rather than an HPKE envelope because they need no delivery: the key
 * is already on the device that made it. What they need is to find it again after a restart
 * without asking the server for anything it could withhold.
 */
export const wrapShareKey = (vaultKey: Uint8Array, shareKey: Uint8Array): string => seal(vaultKey, shareKey);

/** Recover `KS` from `wrapped_key_initiator`. */
export const unwrapShareKey = (vaultKey: Uint8Array, wrapped: string): Uint8Array => open(vaultKey, wrapped);
