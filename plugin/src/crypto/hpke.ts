/**
 * HPKE (RFC 9180), mode Base, `DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + ChaCha20-Poly1305`
 * — the design's one asymmetric primitive (docs/06).
 *
 * Two things use it: sealing the seed to a new device's ephemeral key during pairing
 * (docs/07), and sealing `KS` to a participant's public key when sharing (M3). docs/06
 * names this suite and gives the reason it is a standard rather than a composition:
 * "X25519 by itself wraps nothing — it agrees a shared secret — and composing HKDF and an
 * AEAD by hand where a standard exists has no justification."
 *
 * **This is an implementation of that standard, not a composition of our own**, and the
 * difference is only worth anything if it is checked: `hpke.test.ts` runs the official
 * RFC 9180 Appendix A.1 vectors through it — the same KEM and KDF this suite uses, with the
 * AEAD the appendix pairs them with. Every label, the `suite_id`, the KEM context and the
 * whole key schedule are pinned by those vectors. What A.1 does not cover is the two
 * numbers that differ for ChaCha20-Poly1305, and they are read straight from the registry
 * in §7.3: id `0x0003`, `Nk` 32, `Nn` 12.
 *
 * A note on which ChaCha: HPKE means the **IETF** construction with a 12-byte nonce, not
 * XChaCha20-Poly1305 with its 24-byte nonce, which is what `blob.ts` and `sealed.ts` use.
 * The two are not interchangeable and the suite id names which one is meant.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes.js';

/** DHKEM(X25519, HKDF-SHA256) and HKDF-SHA256 — the halves this design never varies. */
const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
/** The KEM's shared secret and the hash length, both 32 for this suite. */
const N_SECRET = 32;

const EMPTY = new Uint8Array(0);

/** `I2OSP(n, 2)` — two bytes, big-endian, as every id and length in RFC 9180 is encoded. */
const i2osp2 = (n: number): Uint8Array => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);

/**
 * The AEAD half of a suite. Kept a parameter rather than fixed so the official vectors can
 * be run against the very same code that ships — a test that exercised a copy would pin the
 * copy.
 */
export interface Aead {
  id: number;
  /** Key length. */
  nk: number;
  /** Nonce length. */
  nn: number;
  seal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}

/** RFC 9180 §7.3: `0x0003`, Nk 32, Nn 12. The IETF ChaCha20-Poly1305, 12-byte nonce. */
export const CHACHA20_POLY1305: Aead = {
  id: 0x0003,
  nk: 32,
  nn: 12,
  seal: (key, nonce, aad, plaintext) => chacha20poly1305(key, nonce, aad).encrypt(plaintext),
  open: (key, nonce, aad, ciphertext) => chacha20poly1305(key, nonce, aad).decrypt(ciphertext),
};

const suiteId = (aead: Aead): Uint8Array =>
  concat(utf8('HPKE'), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(aead.id));

/** `KEM` || kem_id — the KEM labels live in their own suite, not the ciphersuite's. */
const KEM_SUITE_ID = concat(utf8('KEM'), i2osp2(KEM_ID));

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array =>
  extract(sha256, concat(utf8('HPKE-v1'), suite, utf8(label), ikm), salt);

const labeledExpand = (
  suite: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array => expand(sha256, prk, concat(i2osp2(length), utf8('HPKE-v1'), suite, utf8(label), info), length);

/** The KEM's `ExtractAndExpand`: the raw DH output is never used as a key directly. */
const extractAndExpand = (dh: Uint8Array, kemContext: Uint8Array): Uint8Array => {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, 'shared_secret', kemContext, N_SECRET);
};

/**
 * The key schedule, mode Base: no pre-shared key, so `psk` and `psk_id` are empty and the
 * mode byte is `0x00`. Their hashes still enter the context — the schedule is the same
 * shape in every mode, and leaving them out would silently be a different one.
 */
const keySchedule = (
  aead: Aead,
  sharedSecret: Uint8Array,
  info: Uint8Array,
): { key: Uint8Array; baseNonce: Uint8Array } => {
  const suite = suiteId(aead);
  const pskIdHash = labeledExtract(suite, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(suite, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.from([0x00]), pskIdHash, infoHash);

  const secret = labeledExtract(suite, sharedSecret, 'secret', EMPTY);
  return {
    key: labeledExpand(suite, secret, 'key', context, aead.nk),
    baseNonce: labeledExpand(suite, secret, 'base_nonce', context, aead.nn),
  };
};

export interface Sealed {
  /** The ephemeral public key, which the recipient needs and nobody else can use. */
  enc: Uint8Array;
  ciphertext: Uint8Array;
}

const encap = (
  recipientPublic: Uint8Array,
  ephemeralSecret: Uint8Array,
): { sharedSecret: Uint8Array; enc: Uint8Array } => {
  const enc = x25519.getPublicKey(ephemeralSecret);
  // noble rejects low-order peer keys here, which is the check that stops a chosen public
  // key from forcing a shared secret both sides can predict.
  const dh = x25519.getSharedSecret(ephemeralSecret, recipientPublic);
  return { sharedSecret: extractAndExpand(dh, concat(enc, recipientPublic)), enc };
};

/**
 * Seal `plaintext` to a public key. Single-shot: sequence number 0, so the nonce is the
 * base nonce and there is no counter to get wrong.
 *
 * `info` binds the envelope to its purpose and `aad` to its context; both must be presented
 * unchanged to open it, which is how an envelope made for one thing cannot be replayed as
 * another.
 */
export const sealTo = (
  recipientPublic: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  plaintext: Uint8Array,
  aead: Aead = CHACHA20_POLY1305,
  ephemeralSecret: Uint8Array = x25519.keygen().secretKey,
): Sealed => {
  const { sharedSecret, enc } = encap(recipientPublic, ephemeralSecret);
  const { key, baseNonce } = keySchedule(aead, sharedSecret, info);
  return { enc, ciphertext: aead.seal(key, baseNonce, aad, plaintext) };
};

/** The reverse, for the holder of the private half. */
export const openFrom = (
  recipientSecret: Uint8Array,
  sealed: Sealed,
  info: Uint8Array,
  aad: Uint8Array,
  aead: Aead = CHACHA20_POLY1305,
): Uint8Array => {
  const recipientPublic = x25519.getPublicKey(recipientSecret);
  const dh = x25519.getSharedSecret(recipientSecret, sealed.enc);
  const sharedSecret = extractAndExpand(dh, concat(sealed.enc, recipientPublic));
  const { key, baseNonce } = keySchedule(aead, sharedSecret, info);
  return aead.open(key, baseNonce, aad, sealed.ciphertext);
};

/** A fresh X25519 keypair — what a device about to be paired makes for itself. */
export const newKeypair = (): { secretKey: Uint8Array; publicKey: Uint8Array } => {
  const secretKey = x25519.keygen().secretKey;
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

/**
 * The internals the RFC's vectors address, exposed for the one test that runs them.
 *
 * Production never picks an ephemeral key or an AEAD: `sealTo` defaults both, so pinning
 * either requires calling this deliberately — visible in review, impossible by accident,
 * the same separation the session module's derivation seam has.
 */
export const forTests = { keySchedule, encap, suiteId, labeledExtract, labeledExpand };
