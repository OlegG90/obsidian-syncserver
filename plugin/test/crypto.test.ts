/**
 * The key model of docs/06, asserted rather than assumed.
 *
 * These need no server and no Obsidian: the whole point of the hierarchy is that it is
 * decided on the device, so it can be checked there too.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  DEFAULT_KDF_PARAMS,
  assertKdfFloor,
  authSecret,
  createAccount,
  deriveKek,
  newSeed,
  openAccount,
  recoveryCodeHash,
  unwrapWithRecovery,
  vaultKey,
  wrapForRecovery,
} from '../src/crypto/account.js';
import { newHumanCode } from '../src/crypto/human-code.js';
import { openBlob, sealBlob } from '../src/crypto/blob.js';
import { MARKER_BYTES, WRAP_VERSION, open, seal } from '../src/crypto/sealed.js';
import { fromBase64, randomBytes, toBase64, toHex, utf8 } from '../src/crypto/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  ALG_XCHACHA20_POLY1305,
  HEADER_BYTES,
  MAGIC,
  NONCE_BYTES,
  bytesToUuid,
  packHeader,
  parseHeader,
  uuidToBytes,
} from '../src/crypto/format.js';
import { decryptName, dedupTag, dedupTagFromHash, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../src/crypto/scope.js';

// Argon2id at 64 MiB is deliberately slow; these params keep the suite usable while
// exercising the same code path. They are BELOW the server's floor on purpose, which is
// why these tests build an account by hand — `createAccount` refuses them, and that
// refusal is itself asserted below.
const FAST = { v: 19, m: 256, t: 1, p: 1 };

/** What `createAccount` does, minus the floor check, so the suite can afford to run. */
const fastAccount = (passphrase: string) => {
  const accountSalt = randomBytes(16);
  const seed = newSeed();
  return {
    seed,
    accountSalt,
    kdfParams: FAST,
    wrappedSeed: seal(deriveKek(passphrase, accountSalt, FAST), seed),
  };
};

/** Corrupt one byte in place — the shortest way to ask an AEAD whether it is paying attention. */
const flipBit = (bytes: Uint8Array, at: number): void => {
  bytes[at] = (bytes[at] ?? 0) ^ 1;
};

describe('the account hierarchy', () => {
  it('wraps the seed rather than deriving it, so a passphrase change re-encrypts nothing', () => {
    const account = fastAccount('correct horse');

    // The whole claim in one assertion: re-wrap under a new passphrase, and every key the
    // vault content depends on is unchanged.
    const rewrapped = seal(deriveKek('a different passphrase', account.accountSalt, FAST), account.seed);
    const reopened = openAccount('a different passphrase', account.accountSalt, FAST, rewrapped);

    assert.deepEqual(reopened.seed, account.seed, 'the seed survives a passphrase change');
    assert.equal(authSecret(reopened.seed), authSecret(account.seed), 'and so does auth_secret');
    assert.deepEqual(
      vaultKey(reopened.seed, '11111111-1111-4111-8111-111111111111'),
      vaultKey(account.seed, '11111111-1111-4111-8111-111111111111'),
      'and so does every vault key',
    );
    assert.notEqual(rewrapped, account.wrappedSeed, 'only the envelope changed');
  });

  it('refuses the wrong passphrase instead of returning rubbish', () => {
    const account = fastAccount('correct horse');
    assert.throws(() => openAccount('wrong horse', account.accountSalt, FAST, account.wrappedSeed));
  });

  it('gives two vaults of one account different keys (AC-09)', () => {
    const { seed } = fastAccount('p');
    const a = vaultKey(seed, '11111111-1111-4111-8111-111111111111');
    const b = vaultKey(seed, '22222222-2222-4222-8222-222222222222');
    assert.notDeepEqual(a, b, 'different vault_id, different KV — which is why they never dedup together');
    assert.equal(a.length, 32);
  });

  it('separates the auth branch from every vault key, by refusing an id that is not a UUID', () => {
    const { seed } = fastAccount('p');
    // Both branches are HKDF(seed, info), so `vaultKey(seed, "auth")` WOULD equal the
    // auth_secret that goes to the server — a vault key handed over on every login. Nothing
    // but "vault ids are UUIDs" prevents it, so the code says so out loud.
    assert.throws(() => vaultKey(seed, 'auth'), /must be a UUID/);
    assert.doesNotThrow(() => vaultKey(seed, '11111111-1111-4111-8111-111111111111'));
  });

  it('derives the same KEK from the same inputs and a different one from a different salt', () => {
    const salt = randomBytes(16);
    assert.deepEqual(deriveKek('p', salt, FAST), deriveKek('p', salt, FAST));
    assert.notDeepEqual(deriveKek('p', salt, FAST), deriveKek('p', randomBytes(16), FAST));
  });

  it('normalises the passphrase, so the same characters typed on two platforms agree', () => {
    const salt = randomBytes(16);
    // "e" as one code point (NFC, what Windows and Linux hand back) and as e + combining
    // acute (NFD, what macOS filesystems do). The same passphrase to the person who typed
    // it, and two different keys without normalisation. The `notEqual` below is not padding:
    // an editor that normalised this file would collapse the two spellings into one, and
    // without it this test would then pass while asserting nothing at all.
    const nfc = 'café';
    const nfd = 'café';
    assert.notEqual(nfc, nfd, 'the two spellings really are different strings');
    assert.deepEqual(deriveKek(nfc, salt, FAST), deriveKek(nfd, salt, FAST));
  });

  it("refuses to create an account below the server's KDF floor (D-62)", () => {
    // Registering with weak parameters is refused by a CHECK constraint inside a
    // transaction, so the client that chose them learns least. It fails here instead.
    assert.throws(() => createAccount('p', FAST), /below the server/);
    assert.doesNotThrow(() => assertKdfFloor(DEFAULT_KDF_PARAMS));
    assert.equal(DEFAULT_KDF_PARAMS.m, 65536, 'the default IS the floor: 64 MiB');
  });
});

describe('the wrapping format', () => {
  const key = randomBytes(32);
  const plaintext = utf8('the seed');

  it('carries its version and algorithm at fixed offsets (D-109)', () => {
    const raw = fromBase64(seal(key, plaintext));
    assert.equal(raw[0], WRAP_VERSION, 'the version is byte 0, where a later version must also put it');
    assert.equal(raw[1], ALG_XCHACHA20_POLY1305);
    assert.equal(raw.length, MARKER_BYTES + NONCE_BYTES + plaintext.length + 16, 'marker + nonce + ciphertext + tag');
    assert.deepEqual(open(key, toBase64(raw)), plaintext);
  });

  it('authenticates the marker: the tag covers it, so a future field added there is bound', () => {
    // The property docs/06 claims, asserted where it can be seen: the same key, the same
    // nonce and the same ciphertext open only when the marker is supplied as the aad.
    const raw = fromBase64(seal(key, plaintext));
    const marker = raw.subarray(0, MARKER_BYTES);
    const nonce = raw.subarray(MARKER_BYTES, MARKER_BYTES + NONCE_BYTES);
    const ciphertext = raw.subarray(MARKER_BYTES + NONCE_BYTES);

    assert.deepEqual(xchacha20poly1305(key, nonce, marker).decrypt(ciphertext), plaintext);
    assert.throws(() => xchacha20poly1305(key, nonce).decrypt(ciphertext), 'the tag does not cover the marker');
  });

  it('names an unreadable version instead of blaming the passphrase', () => {
    // The reason the marker exists at all. Without it this case arrives as a tag failure —
    // the same thing a wrong passphrase produces, and unrecoverable advice for the person
    // holding the right one.
    const raw = fromBase64(seal(key, plaintext));
    raw[0] = 2;
    assert.throws(() => open(key, toBase64(raw)), /unknown wrapping version 2/);

    const other = fromBase64(seal(key, plaintext));
    other[1] = 2;
    assert.throws(() => open(key, toBase64(other)), /unknown algorithm 2/);
  });

  it('detects a tampered wrapped value rather than decrypting it', () => {
    // The wrapping format is base64, so the corruption goes through the bytes it stands
    // for: flipping a character would as likely produce something that is not base64 at
    // all, and the AEAD would never be asked the question this test is asking.
    const raw = fromBase64(seal(key, plaintext));
    flipBit(raw, raw.length - 1);
    assert.throws(() => open(key, toBase64(raw)));
  });

  it('refuses a value too short to hold a marker and a nonce', () => {
    // The one branch that is not the AEAD's own refusal: below a marker and a nonce there is
    // nothing to slice, and a wrong answer here would be an out-of-range read rather than a
    // rejection. Exactly at the boundary there is still no ciphertext, so it is too short too.
    assert.throws(() => open(key, toBase64(randomBytes(MARKER_BYTES + NONCE_BYTES))), /too short/);
  });
});

describe('the blob format', () => {
  it('round-trips a file through its own random key', () => {
    const plaintext = utf8('# A note\n\nWith some content.\n');
    const sealed = sealBlob(plaintext);
    assert.deepEqual(openBlob(sealed.contentKey, sealed.bytes), plaintext);
  });

  it('gives the same content two addresses, because KC is random (docs/06)', () => {
    const plaintext = utf8('identical content');
    const a = sealBlob(plaintext);
    const b = sealBlob(plaintext);
    assert.notEqual(a.sha256, b.sha256, 'a convergent scheme would hand the file to anyone who guessed it');
    assert.notDeepEqual(a.contentKey, b.contentKey);
  });

  it('addresses the bytes that are actually uploaded', () => {
    // The server re-hashes what it receives and refuses a mismatch, so this equality is the
    // client's half of that agreement.
    const sealed = sealBlob(utf8('hello'));
    assert.equal(sealed.bytes.length, HEADER_BYTES + 'hello'.length + 16, 'header + ciphertext + Poly1305 tag');
  });

  it('seals a payload of real size into one exact allocation, and opens it again', () => {
    // Every other case here is a handful of bytes, and the seal writes its ciphertext into
    // a buffer it sized itself: an off-by-something in that arithmetic is invisible at five
    // bytes and corrupts an attachment. A few kilobytes of incompressible, non-repeating
    // content is enough to catch a wrong length or a wrong offset.
    const plaintext = randomBytes(9000);
    const sealed = sealBlob(plaintext);

    assert.equal(sealed.bytes.length, HEADER_BYTES + plaintext.length + 16);
    assert.equal(sealed.bytes.byteOffset, 0, 'the blob is its own buffer, not a window onto a larger one');
    assert.deepEqual(openBlob(sealed.contentKey, sealed.bytes), plaintext);
  });

  it('carries the key id in the header, and it survives the round trip', () => {
    const sealed = sealBlob(utf8('x'));
    assert.equal(parseHeader(sealed.bytes).keyId, sealed.keyId);
  });

  it('authenticates the header: re-labelling a blob breaks it', () => {
    const sealed = sealBlob(utf8('x'));
    // Flip a bit inside the key id — the header is the aad, so the tag must refuse.
    flipBit(sealed.bytes, MAGIC.length + 3);
    assert.throws(() => openBlob(sealed.contentKey, sealed.bytes));
  });

  it('refuses bytes that are not a blob at all', () => {
    assert.throws(() => parseHeader(new Uint8Array(4)), /too short/);
    assert.throws(() => parseHeader(new Uint8Array(HEADER_BYTES)), /bad magic/);
    const wrongVersion = packHeader({ keyId: '11111111-1111-4111-8111-111111111111', nonce: new Uint8Array(24) });
    wrongVersion[MAGIC.length] = 99;
    assert.throws(() => parseHeader(wrongVersion), /unknown format version 99/);
  });

  it('round-trips a uuid through its 16 bytes', () => {
    const uuid = '3f2b1c9e-0000-4000-8000-000000000abc';
    assert.equal(bytesToUuid(uuidToBytes(uuid)), uuid);
    assert.throws(() => uuidToBytes('not-a-uuid'));
  });
});

describe('a scope key', () => {
  const key = randomBytes(32);
  const other = randomBytes(32);

  it('round-trips a name and hides it from another scope', () => {
    const enc = encryptName(key, 'Проєкти');
    assert.equal(decryptName(key, enc), 'Проєкти');
    assert.throws(() => decryptName(other, enc), 'another vault key cannot read it');
  });

  it('encrypts the same name to different ciphertext each time', () => {
    // A deterministic name_enc would let the server tell which nodes share a name.
    assert.notEqual(encryptName(key, 'note.md'), encryptName(key, 'note.md'));
  });

  it('hashes a name to something stable, case-folded and NFC-normalised', () => {
    assert.equal(nameHmac(key, 'Note.md'), nameHmac(key, 'note.md'), 'sibling uniqueness is case-insensitive');
    assert.equal(nameHmac(key, 'café.md'), nameHmac(key, 'café.md'), 'and normalisation-insensitive');
    assert.notEqual(nameHmac(key, 'note.md'), nameHmac(other, 'note.md'), 'and scoped to its key');
    assert.equal(nameHmac(key, 'note.md').length, 64, 'hex sha256');
  });

  it('wraps a content key so exactly the scope holders can open it', () => {
    const contentKey = randomBytes(32);
    const envelope = wrapContentKey(key, contentKey);
    assert.deepEqual(unwrapContentKey(key, envelope), contentKey);
    assert.throws(() => unwrapContentKey(other, envelope));
  });

  it('tags content deterministically within a scope and differently across scopes', () => {
    const content = utf8('the same file');
    assert.equal(dedupTag(key, content), dedupTag(key, content), 'deduplication needs this to be stable');
    assert.notEqual(dedupTag(key, content), dedupTag(other, content), 'two vaults never dedup against each other');
    assert.equal(dedupTag(key, content).length, 64);
  });

  it('derives the same tag from the plaintext hash as from the plaintext (issue #237)', () => {
    // The incremental pass skips reading a file whose timestamp and size are unchanged, so it has the
    // hash and not the bytes. If these two ever disagreed the pass would ask the server about tags no
    // vault has ever produced: no match, every skipped file re-uploaded as new content, and the
    // deduplication that makes adoption "nearly free" silently off. Two entry points, one derivation —
    // asserted here rather than trusted, because nothing else would notice them parting.
    const content = utf8('the same file');
    const hashHex = toHex(sha256(content));

    assert.equal(dedupTagFromHash(key, hashHex), dedupTag(key, content));
    assert.notEqual(dedupTagFromHash(key, hashHex), dedupTagFromHash(other, hashHex), 'still scoped');
  });
});

describe('encoding', () => {
  it('survives every byte value through base64 and hex', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    assert.deepEqual(fromBase64(toBase64(all)), all);
    assert.equal(toHex(all).length, 512);
  });

  it('handles a payload larger than one chunk', () => {
    // The spread inside toBase64 is chunked because a whole file goes through it.
    const big = randomBytes(200_000);
    assert.deepEqual(fromBase64(toBase64(big)), big);
  });
});

/**
 * The recovery code's wrapping (M7): a second envelope over the same seed.
 *
 * The property that matters is not that it round-trips — it is that the code and the
 * passphrase reach the same 32 bytes by different routes, because a recovery code that
 * returned a DIFFERENT seed would produce an account whose vault keys no longer match
 * anything it holds, and it would do so silently.
 */
describe('the recovery code, wrapping the same seed a second time', () => {
  const salt = new Uint8Array(16).fill(7);

  it('gives back the very seed the passphrase gives back', () => {
    const account = createAccount('a chosen phrase');
    const code = newHumanCode();
    const envelope = wrapForRecovery(account.seed, code, account.accountSalt);

    assert.deepEqual(unwrapWithRecovery(envelope, code, account.accountSalt), account.seed);
  });

  it('refuses a code that is not the one, rather than returning rubbish', () => {
    const seed = newSeed();
    const envelope = wrapForRecovery(seed, newHumanCode(), salt);
    assert.throws(() => unwrapWithRecovery(envelope, newHumanCode(), salt));
  });

  it('accepts the code as a human hands it back — dashes, case, a misread O', () => {
    // The code is written down and typed months later. If the wrapping key depended on the
    // exact string, a correctly kept code would fail for its punctuation.
    const seed = newSeed();
    const code = newHumanCode();
    const envelope = wrapForRecovery(seed, code, salt);

    assert.deepEqual(unwrapWithRecovery(envelope, code.replace(/-/g, ''), salt), seed);
    assert.deepEqual(unwrapWithRecovery(envelope, code.toLowerCase(), salt), seed);
    assert.deepEqual(unwrapWithRecovery(envelope, ` ${code} `, salt), seed);
  });

  it('is bound to the account, so a code cannot be carried to another one', () => {
    const seed = newSeed();
    const code = newHumanCode();
    const envelope = wrapForRecovery(seed, code, salt);
    const elsewhere = new Uint8Array(16).fill(9);
    assert.throws(() => unwrapWithRecovery(envelope, code, elsewhere));
  });

  it('hashes what the server will be handed, not what the screen showed', () => {
    // The server hashes the string it receives at recovery, and that string has crossed a
    // human. Both sides must normalise first or a correctly kept code hashes to nothing.
    const code = newHumanCode();
    assert.equal(recoveryCodeHash(code), recoveryCodeHash(code.replace(/-/g, '').toLowerCase()));
    assert.match(recoveryCodeHash(code), /^[0-9a-f]{64}$/, 'sha-256, hex, like every other stored verifier');
  });

  it('gives two accounts with the same code different envelopes', () => {
    const seed = newSeed();
    const code = newHumanCode();
    const a = wrapForRecovery(seed, code, salt);
    const b = wrapForRecovery(seed, code, new Uint8Array(16).fill(3));
    assert.notEqual(a, b);
  });
});
