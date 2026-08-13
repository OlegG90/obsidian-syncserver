/**
 * Sealing a file into a blob, and opening one.
 *
 *     KC         = 32 random bytes                       ← new for EVERY new blob
 *     nonce      = 24 random bytes
 *     header     = magic ‖ format_version ‖ alg_id ‖ key_id ‖ nonce
 *     ciphertext = XChaCha20-Poly1305(KC, nonce, plaintext, aad = header)
 *     address    = sha256(header ‖ ciphertext)
 *
 * `KC` is **random, never derived from the content** (docs/06), and that is not a
 * performance choice. A convergent key — `HMAC(public, sha256(plaintext))` — hands the file
 * itself to anyone who can guess it, and notes are guessable: templated, short, with
 * predictable `.obsidian` configs. Deduplication is a separate index keyed by
 * `HMAC(scope key, hash)`, where only a scope-key holder can compute the tag.
 *
 * The address is over `header ‖ ciphertext`, which is exactly what is uploaded, so the
 * server's own re-hash of the bytes it received agrees with the client's by construction.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concat, randomBytes, randomUuid, toHex } from './bytes.js';
import { KEY_BYTES, NONCE_BYTES, HEADER_BYTES, packHeader, parseHeader } from './format.js';

export interface SealedBlob {
  /** Exactly the bytes to upload: `header ‖ ciphertext`. */
  bytes: Uint8Array;
  /** `sha256(bytes)`, hex — the address, and what `POST /blobs?sha256=` declares. */
  sha256: string;
  /** The random per-blob content key, to be wrapped into an envelope per scope. */
  contentKey: Uint8Array;
  /** Names the content key in the header and in `blobs.key_id`. */
  keyId: string;
}

export const sealBlob = (plaintext: Uint8Array): SealedBlob => {
  const contentKey = randomBytes(KEY_BYTES);
  const keyId = randomUuid();
  const nonce = randomBytes(NONCE_BYTES);

  // The header is the aad, so it is authenticated without being secret: an attacker cannot
  // re-label a blob with a different key id or format version without breaking the tag.
  const header = packHeader({ keyId, nonce });
  const ciphertext = xchacha20poly1305(contentKey, nonce, header).encrypt(plaintext);
  const bytes = concat(header, ciphertext);

  return { bytes, sha256: toHex(sha256(bytes)), contentKey, keyId };
};

/**
 * The reverse, given the content key recovered from an envelope.
 *
 * The address is not re-checked here: the caller either fetched these bytes from an address
 * or produced them, and the AEAD tag already refuses anything altered. Re-hashing would cost
 * a second pass over every file to answer a question the tag has answered.
 */
export const openBlob = (contentKey: Uint8Array, bytes: Uint8Array): Uint8Array => {
  const header = parseHeader(bytes);
  return xchacha20poly1305(contentKey, header.nonce, bytes.subarray(0, HEADER_BYTES)).decrypt(
    bytes.subarray(HEADER_BYTES),
  );
};

export { parseHeader };
