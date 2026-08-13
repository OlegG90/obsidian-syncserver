/**
 * The wrapping format: `nonce ‖ XChaCha20-Poly1305(key, nonce, plaintext)`, base64.
 *
 * Everything the design encrypts that is **not file content** travels this way — the seed
 * under the KEK, a content key under a scope key, a name under a scope key (docs/06). They
 * were two copies of this expression, one in `account.ts` and one in `scope.ts`, differing
 * only in where the base64 happened; in practice not even that, since every caller of the
 * raw form encoded it on the next line.
 *
 * **No header and no `aad`, unlike a blob.** These are short values under a key that already
 * says what they are — there is nothing else in scope for an attacker to swap one with. A
 * blob's header is authenticated because a blob HAS one: an address, a key id, a format
 * version that a later version must not be able to reinterpret. That is `blob.ts`, and it is
 * a different format on purpose, not a third copy of this one.
 *
 * **There is no version byte here**, and that is a known asymmetry rather than an oversight
 * nobody noticed: `blob.ts` carries `format_version` and `alg_id` at fixed offsets so a
 * future layout can coexist with existing data, while a wrapped value carries nothing that
 * says which algorithm produced it. It is recorded here so that whoever changes the AEAD
 * finds the problem before the migration does.
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { fromBase64, randomBytes, toBase64 } from './bytes.js';
import { NONCE_BYTES } from './format.js';

export const seal = (key: Uint8Array, plaintext: Uint8Array): string => {
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, NONCE_BYTES);
  return toBase64(out);
};

export const open = (key: Uint8Array, sealed: string): Uint8Array => {
  const raw = fromBase64(sealed);
  if (raw.length <= NONCE_BYTES) throw new Error('sealed value is too short to hold a nonce');
  return xchacha20poly1305(key, raw.subarray(0, NONCE_BYTES)).decrypt(raw.subarray(NONCE_BYTES));
};
