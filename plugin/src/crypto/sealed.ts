/**
 * The wrapping format: `wrap_version ‖ alg_id ‖ nonce ‖ XChaCha20-Poly1305(key, nonce, plaintext,
 * aad = wrap_version ‖ alg_id)`, base64.
 *
 * Everything the design encrypts that is **not file content** travels this way — the seed
 * under the KEK, a content key under a scope key, a name under a scope key (docs/06). They
 * were two copies of this expression, one in `account.ts` and one in `scope.ts`, differing
 * only in where the base64 happened; in practice not even that, since every caller of the
 * raw form encoded it on the next line.
 *
 * **The two marker bytes are the whole header, and they are the `aad`** (D-109; docs/06 has the
 * reasoning and the offsets). A blob carries four more fields — magic, so bytes found in a
 * backup identify themselves, and a key id, because a blob has one `KC` and many envelopes.
 * Neither applies to a value that is never loose and never names a key the caller lacks.
 *
 * Two traps this file is where you would hit:
 *
 * - **`WRAP_VERSION` is not `format.ts`'s `FORMAT_VERSION`.** They are both `1` and describe
 *   unrelated layouts, so the resemblance invites exactly the wrong edit. Only the algorithm
 *   id is shared, because it names an AEAD in the design rather than a field of either format;
 * - **the marker is checked before the key is used**, so an unreadable version and a wrong
 *   passphrase are two sentences rather than one tag failure. That difference is the reason
 *   the marker exists: without it, the recovery from a changed AEAD is trial decryption, which
 *   at this layer cannot tell "old algorithm" from "not your passphrase".
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { fromBase64, randomBytes, toBase64 } from './bytes.js';
import { ALG_XCHACHA20_POLY1305, NONCE_BYTES } from './format.js';

/** This format's own version, independent of the blob's (see above). */
export const WRAP_VERSION = 1;

export const MARKER_BYTES = 2; // wrap_version ‖ alg_id

export const seal = (key: Uint8Array, plaintext: Uint8Array): string => {
  const marker = Uint8Array.from([WRAP_VERSION, ALG_XCHACHA20_POLY1305]);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(key, nonce, marker).encrypt(plaintext);
  const out = new Uint8Array(MARKER_BYTES + NONCE_BYTES + ciphertext.length);
  out.set(marker);
  out.set(nonce, MARKER_BYTES);
  out.set(ciphertext, MARKER_BYTES + NONCE_BYTES);
  return toBase64(out);
};

/**
 * Rejects an unknown marker before touching the key, so "this client cannot read that version"
 * and "that is not the passphrase" are two different sentences rather than one tag failure.
 */
export const open = (key: Uint8Array, sealed: string): Uint8Array => {
  const raw = fromBase64(sealed);
  if (raw.length <= MARKER_BYTES + NONCE_BYTES) throw new Error('sealed value is too short to hold a marker and a nonce');
  const version = raw[0];
  if (version !== WRAP_VERSION) throw new Error(`unknown wrapping version ${version}`);
  const alg = raw[1];
  if (alg !== ALG_XCHACHA20_POLY1305) throw new Error(`unknown algorithm ${alg}`);
  return xchacha20poly1305(
    key,
    raw.subarray(MARKER_BYTES, MARKER_BYTES + NONCE_BYTES),
    raw.subarray(0, MARKER_BYTES),
  ).decrypt(raw.subarray(MARKER_BYTES + NONCE_BYTES));
};
