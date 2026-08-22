/**
 * The small amount of cryptography the server does at all.
 *
 * It holds no key that opens anything: content and names are encrypted on the client and
 * stay that way (AC-08). What is here is verification — proving a presented secret matches
 * a stored hash — and deriving values that must look real without being real.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The stored form of the four verifiers (D-108): SHA-256 over the token's **UTF-8 bytes**,
 * hex. No salt, no pepper, no slow KDF — every input is at least 128 bits of CSPRNG
 * output, so a work factor would buy nothing and cost latency on every login.
 *
 * The encoding is named because "hash the string" is ambiguous until it is.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Compare a presented token against a stored hash without leaking where they diverge.
 *
 * Both sides are hashed first, so the comparison is always over two equal-length digests
 * — timingSafeEqual throws on a length mismatch, and reaching that throw would itself be
 * the leak.
 */
export const tokenMatches = (presented: string, storedHex: string): boolean => {
  const a = Buffer.from(hashToken(presented), 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

/** 256 bits from a CSPRNG — the entropy floor D-108 depends on, with room to spare. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/**
 * The salt an unknown login receives (D-73).
 *
 * `/auth/kdf` answers before authentication, so a 404 there would turn it into an account
 * enumeration oracle. A fake salt has to be indistinguishable from a real one **and stable
 * across requests** — a random one would differ between two calls and give the answer away
 * more plainly than a 404 would.
 */
export const fakeAccountSalt = (serverSecret: string, login: string): Buffer =>
  createHmac('sha256', serverSecret).update(`kdf-salt:${login.toLowerCase()}`, 'utf8').digest().subarray(0, 16);

/** The same trick for the key pair a share invitation asks about (D-73). */
export const fakeRecipient = (serverSecret: string, login: string): { userId: string; pubkey: Buffer } => {
  const d = createHmac('sha256', serverSecret).update(`recipient:${login.toLowerCase()}`, 'utf8').digest();
  const hex = d.subarray(0, 16).toString('hex');
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { userId, pubkey: d };
};
