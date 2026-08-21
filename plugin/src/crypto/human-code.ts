/**
 * The secrets in this system a **human carries**, and the only reason they are not simply
 * 32 random bytes in base64.
 *
 * Two of them now: a **pairing secret**, read off one screen and typed into another, and a
 * **recovery code** (M7), written down somewhere and typed back months later. Their
 * lifetimes could hardly differ more, and their encoding problem is identical — which is why
 * this module was renamed out of `pairing-code.ts` rather than copied: a recovery code
 * produced by a function called `newPairingCode` would be mislabelled for as long as it
 * existed.
 *
 * The encoding is a usability decision with a security floor under it. The floor wins:
 * **128 bits of CSPRNG**, the same entropy #108 requires of every stored verifier. For a
 * pairing that is because the server does no rate limiting on approval or claim and a
 * pairing lives ten minutes; for a recovery code it is because the code wraps a second copy
 * of the seed, and an attacker holding a database dump can attack that copy offline for
 * years. Neither is brute-forceable at 128 bits, which is the point.
 *
 * **Crockford's base32, not RFC 4648's.** Both encode five bits per character; the
 * difference is that Crockford's alphabet omits `I`, `L`, `O` and `U`, which is what makes
 * normalisation possible at all. RFC 4648 contains `I`, `L` and `O`, so "the user probably
 * meant a one" is a guess that would corrupt a code that was typed correctly. Removing the
 * confusable letters from the alphabet turns that guess into a fact: a `O` in a typed code
 * cannot be anything but a misread `0`.
 *
 * 16 bytes become 26 characters, shown in groups of four.
 */
import { randomBytes } from './bytes.js';

/** Crockford base32: digits, then A–Z without `I`, `L`, `O`, `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The floor, in bytes: 16 × 8 = 128 bits (#108). */
const SECRET_BYTES = 16;

const encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 128 bits is not a multiple of 5, so the last character carries the remaining 3 bits.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

/** A fresh code, grouped for reading aloud and for typing without losing one's place. */
export const newHumanCode = (): string => {
  const raw = encode(randomBytes(SECRET_BYTES));
  return (raw.match(/.{1,4}/g) ?? []).join('-');
};

/**
 * What both devices must agree the code *is*, before either hashes it.
 *
 * The code crosses a human, so it arrives with the dashes typed or not, in either case, and
 * with the confusable letters however they were read. Each substitution below is safe only
 * because the alphabet excludes its target: there is no `I`, `L`, `O` or `U` to destroy.
 *
 * A code that has been normalised on one device and on the other must produce the same
 * bytes, or the failure is "wrong code" for a code that was read correctly — which is the
 * kind of fault a person cannot act on.
 */
export const normaliseHumanCode = (typed: string): string =>
  typed
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    // Crockford excludes `U` to avoid an accidental obscenity; nothing legitimate types one,
    // and treating it as `V` is friendlier than refusing a code over one character.
    .replace(/U/g, 'V');
