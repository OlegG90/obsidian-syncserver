/**
 * HPKE against RFC 9180's own test vectors.
 *
 * This is the test that makes `hpke.ts` an implementation of a standard rather than a
 * composition that happens to round-trip. A seal/open pair proves only that the code agrees
 * with itself — it would pass with a wrong label, a wrong `suite_id`, or a KEM context in
 * the wrong order, and every one of those is a different, unexamined protocol.
 *
 * The vectors are Appendix **A.1**: `DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM`.
 * The KEM and the KDF are the ones this design uses; the appendix pairs them with AES-GCM,
 * so the AEAD is supplied as a parameter here — the same parameter production leaves at its
 * default. What the vectors therefore pin is everything shared: the labels, `suite_id`, the
 * KEM context, `ExtractAndExpand`, and the whole key schedule.
 *
 * What they do not pin is the two numbers that differ for ChaCha20-Poly1305 — id `0x0003`,
 * `Nk` 32 — read from the registry in §7.3 and asserted below, so a typo in either is a
 * failing test rather than a silently different suite.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gcm } from '@noble/ciphers/aes.js';

import { CHACHA20_POLY1305, forTests, newKeypair, openFrom, sealTo, type Aead } from '../src/crypto/hpke.js';
import { fromHex, toHex, utf8 } from '../src/crypto/bytes.js';

/** RFC 9180 §7.3: AES-128-GCM is `0x0001`, Nk 16, Nn 12. Test-only — production ships ChaCha. */
const AES_128_GCM: Aead = {
  id: 0x0001,
  nk: 16,
  nn: 12,
  seal: (key, nonce, aad, pt) => gcm(key, nonce, aad).encrypt(pt),
  open: (key, nonce, aad, ct) => gcm(key, nonce, aad).decrypt(ct),
};

/** Appendix A.1.1, Base Setup Information. */
const A1 = {
  info: '4f6465206f6e2061204772656369616e2055726e',
  skEm: '52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736',
  pkEm: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  pkRm: '3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d',
  skRm: '4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8',
  enc: '37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431',
  sharedSecret: 'fe0e18c9f024ce43799ae393c7e8fe8fce9d218875e8227b0187c04e7d2ea1fc',
  key: '4531685d41d65f03dc48f6b8302c05b0',
  baseNonce: '56d890e5accaaf011cff4b7d',
  // A.1.1.1, sequence number 0.
  pt: '4265617574792069732074727574682c20747275746820626561757479',
  aad: '436f756e742d30',
  ct: 'f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a',
};

describe('HPKE, RFC 9180 Appendix A.1', () => {
  it('encapsulates to the published shared secret and enc', () => {
    // If the KEM context were `pkR || enc` instead of `enc || pkR`, or the labels were
    // anything else, this is where it would show.
    const out = forTests.encap(fromHex(A1.pkRm), fromHex(A1.skEm));
    assert.equal(toHex(out.enc), A1.enc, 'the ephemeral public key');
    assert.equal(toHex(out.sharedSecret), A1.sharedSecret, 'the KEM shared secret');
  });

  it('derives the published key and base nonce', () => {
    const ks = forTests.keySchedule(AES_128_GCM, fromHex(A1.sharedSecret), fromHex(A1.info));
    assert.equal(toHex(ks.key), A1.key);
    assert.equal(toHex(ks.baseNonce), A1.baseNonce);
  });

  it('produces the published ciphertext, byte for byte', () => {
    const sealed = sealTo(
      fromHex(A1.pkRm),
      fromHex(A1.info),
      fromHex(A1.aad),
      fromHex(A1.pt),
      AES_128_GCM,
      fromHex(A1.skEm),
    );
    assert.equal(toHex(sealed.enc), A1.enc);
    assert.equal(toHex(sealed.ciphertext), A1.ct, 'the whole suite, end to end');
  });

  it('opens the published ciphertext with the published private key', () => {
    const plaintext = openFrom(
      fromHex(A1.skRm),
      { enc: fromHex(A1.enc), ciphertext: fromHex(A1.ct) },
      fromHex(A1.info),
      fromHex(A1.aad),
      AES_128_GCM,
    );
    assert.equal(toHex(plaintext), A1.pt);
  });
});

describe('the suite this design actually ships', () => {
  it('is ChaCha20-Poly1305 at the registry values (§7.3)', () => {
    assert.equal(CHACHA20_POLY1305.id, 0x0003);
    assert.equal(CHACHA20_POLY1305.nk, 32);
    assert.equal(CHACHA20_POLY1305.nn, 12, 'the IETF nonce, not XChaCha20’s 24');
  });

  it('round-trips a seed to a fresh ephemeral key', () => {
    const device = newKeypair();
    const seed = fromHex('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
    const info = utf8('syncserver/pairing/seed');

    const sealed = sealTo(device.publicKey, info, new Uint8Array(0), seed);
    assert.deepEqual(openFrom(device.secretKey, sealed, info, new Uint8Array(0)), seed);
  });

  it('refuses an envelope opened under different info or aad', () => {
    // The property the pairing flow leans on: an envelope made for one purpose cannot be
    // presented as another, because both bind into the tag.
    const device = newKeypair();
    const seed = fromHex('0011223344556677889900112233445566778899001122334455667788990011');
    const info = utf8('syncserver/pairing/seed');
    const aad = utf8('pairing-id');

    const sealed = sealTo(device.publicKey, info, aad, seed);

    assert.throws(() => openFrom(device.secretKey, sealed, utf8('something/else'), aad));
    assert.throws(() => openFrom(device.secretKey, sealed, info, utf8('another-pairing')));
  });

  it('refuses an envelope addressed to somebody else', () => {
    const device = newKeypair();
    const stranger = newKeypair();
    const info = utf8('syncserver/pairing/seed');
    const sealed = sealTo(device.publicKey, info, new Uint8Array(0), utf8('the seed'));

    assert.throws(() => openFrom(stranger.secretKey, sealed, info, new Uint8Array(0)));
  });
});
