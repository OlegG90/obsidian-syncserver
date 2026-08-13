/**
 * The blob wire format, byte for byte.
 *
 * docs/06 gives the shape — `magic ‖ format_version ‖ alg_id ‖ key_id ‖ nonce` — and this
 * file is where it becomes a number of bytes in an order. It is a **contract**, not an
 * implementation detail: the address is `sha256(header ‖ ciphertext)`, so any change to the
 * layout changes every address in every vault, and the header is the AEAD's `aad`, so a
 * change also invalidates every existing tag.
 *
 * Which is why `FORMAT_VERSION` is in it. A future layout gets a new number and old blobs
 * stay readable, because the version is at a fixed offset that no version may move.
 */
import { toHex } from './bytes.js';

/** `SYNC` in ASCII. Present so a blob found in a backup identifies itself. */
export const MAGIC = Uint8Array.from([0x53, 0x59, 0x4e, 0x43]);

export const FORMAT_VERSION = 1;

/** The only AEAD in the design (docs/06). An id rather than a name so the header stays fixed-width. */
export const ALG_XCHACHA20_POLY1305 = 1;

export const NONCE_BYTES = 24; // XChaCha20's extended nonce: random per blob, never a counter
export const KEY_BYTES = 32;
export const UUID_BYTES = 16;

export const HEADER_BYTES = MAGIC.length + 1 + 1 + UUID_BYTES + NONCE_BYTES; // 46

export interface Header {
  /** Names the CONTENT key, not a scope: a blob has one KC and any number of envelopes (docs/06). */
  keyId: string;
  nonce: Uint8Array;
}

export const uuidToBytes = (uuid: string): Uint8Array => {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== UUID_BYTES * 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  const out = new Uint8Array(UUID_BYTES);
  for (let i = 0; i < UUID_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytesToUuid = (b: Uint8Array): string => {
  if (b.length !== UUID_BYTES) throw new Error(`a uuid is ${UUID_BYTES} bytes, got ${b.length}`);
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const packHeader = ({ keyId, nonce }: Header): Uint8Array => {
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  const out = new Uint8Array(HEADER_BYTES);
  out.set(MAGIC, 0);
  out[MAGIC.length] = FORMAT_VERSION;
  out[MAGIC.length + 1] = ALG_XCHACHA20_POLY1305;
  out.set(uuidToBytes(keyId), MAGIC.length + 2);
  out.set(nonce, MAGIC.length + 2 + UUID_BYTES);
  return out;
};

/**
 * Rejects rather than guesses. A header that is not this format is not a blob this client
 * wrote, and treating it as one would mean handing arbitrary bytes to the AEAD as `aad`.
 */
export const parseHeader = (blob: Uint8Array): Header => {
  if (blob.length < HEADER_BYTES) throw new Error('too short to hold a header');
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw new Error('not a syncserver blob: bad magic');
  }
  const version = blob[MAGIC.length];
  if (version !== FORMAT_VERSION) throw new Error(`unknown format version ${version}`);
  const alg = blob[MAGIC.length + 1];
  if (alg !== ALG_XCHACHA20_POLY1305) throw new Error(`unknown algorithm ${alg}`);
  return {
    keyId: bytesToUuid(blob.subarray(MAGIC.length + 2, MAGIC.length + 2 + UUID_BYTES)),
    nonce: blob.subarray(MAGIC.length + 2 + UUID_BYTES, HEADER_BYTES),
  };
};
