/**
 * The one secret on this server that a **person** chose, and therefore the one that needs a
 * slow hash (#108, #115).
 *
 * Every other stored verifier — `auth_secret_hash`, `kek_verifier_hash`, the invitation and
 * refresh tokens — is at least 128 bits of CSPRNG output, and #108 rests that decision on
 * exactly that: a work factor buys nothing against an input nobody can guess, and costs
 * latency on every request. A console password is the opposite input, and no client-side KDF
 * can stand in for the work: the browser is not trusted to have run one, and a server that
 * accepted "I already hashed it" would be accepting a password it never saw slowed down.
 *
 * **Argon2id, with the parameters recorded in the hash itself.** They will move — the floor
 * of today is the joke of a decade from now — and a stored hash that did not say which cost
 * produced it could never be re-hashed on a later login without locking everyone out.
 *
 * The memory cost is deliberately below the client's 64 MiB floor (#62). That floor guards a
 * key derived once per unlock on one person's machine; this runs on a shared server, on a
 * NAS, and once per sign-in — a cost chosen for a laptop would be a denial-of-service surface
 * here. Guessing is bounded by the attempt limiter instead, which is where a password's real
 * defence lives.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

/** `m` in KiB, `t` passes, `p` lanes — recorded in every hash this produces. */
const COST = { m: 19 * 1024, t: 2, p: 1 } as const;
const SALT_BYTES = 16;

const encode = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const decode = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));

/**
 * Hash a password for storage: `$argon2id$m=..,t=..,p=..$salt$hash`.
 *
 * Shaped like the PHC string everything else in the world uses, so a later move to a library
 * that reads them is a parser change rather than a migration of everybody's password.
 */
export const hashPassword = (password: string): string => {
  const salt = randomBytes(SALT_BYTES);
  const hash = argon2id(password, salt, { ...COST, dkLen: 32 });
  return `$argon2id$m=${COST.m},t=${COST.t},p=${COST.p}$${encode(salt)}$${encode(hash)}`;
};

/**
 * Check a password against a stored hash, in constant time.
 *
 * Any malformed stored value answers `false` rather than throwing: a row that cannot be
 * parsed is a row nobody can sign in as, which is the safe reading of it, and an exception
 * here would separate "wrong password" from "broken record" for whoever is guessing.
 */
export const passwordMatches = (password: string, stored: string): boolean => {
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[1] !== 'argon2id') return false;

  const cost = Object.fromEntries(
    (parts[2] ?? '').split(',').map((kv) => {
      const [k, v] = kv.split('=');
      return [k ?? '', Number(v)];
    }),
  ) as { m?: number; t?: number; p?: number };
  if (!cost.m || !cost.t || !cost.p) return false;

  let expected: Uint8Array;
  let actual: Uint8Array;
  try {
    expected = decode(parts[4] ?? '');
    actual = argon2id(password, decode(parts[3] ?? ''), {
      m: cost.m,
      t: cost.t,
      p: cost.p,
      dkLen: expected.length,
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
