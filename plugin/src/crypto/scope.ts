/**
 * Everything keyed by a SCOPE key — the vault key `KV` today, a share key `KS` from M3.
 *
 * The four operations here are the whole of what a scope key does (docs/06): it encrypts
 * names, authenticates them for sibling uniqueness, wraps content keys, and tags content for
 * deduplication. Content itself is never encrypted with a scope key — that is `blob.ts`, and
 * the separation is what makes sharing a folder cost one envelope per blob instead of a
 * re-upload.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromUtf8, toHex, utf8 } from './bytes.js';
import { open, seal } from './sealed.js';

/** `nodes.name_enc`. One path segment, never a path: the server has no paths (docs/03). */
export const encryptName = (scopeKey: Uint8Array, name: string): string => seal(scopeKey, utf8(name));

export const decryptName = (scopeKey: Uint8Array, nameEnc: string): string => fromUtf8(open(scopeKey, nameEnc));

/**
 * `HMAC(scope key, casefold(NFC(name)))` — what sibling uniqueness is enforced over, since
 * the server cannot see a name to compare (docs/03).
 *
 * `toLowerCase` stands in for full Unicode case folding, which JavaScript does not offer.
 * The difference is confined to a handful of scripts and, more to the point, it is the
 * CLIENT that computes this hash and the client that must agree with itself across devices —
 * so what matters is that every device runs this same line.
 */
export const nameHmac = (scopeKey: Uint8Array, name: string): string =>
  toHex(hmac(sha256, scopeKey, utf8(name.normalize('NFC').toLowerCase())));

/** `blob_keys.wrapped_key`: the content key under this scope. Adding a scope is adding one of these. */
export const wrapContentKey = (scopeKey: Uint8Array, contentKey: Uint8Array): string => seal(scopeKey, contentKey);

export const unwrapContentKey = (scopeKey: Uint8Array, wrapped: string): Uint8Array => open(scopeKey, wrapped);

/**
 * `HMAC(scope key, sha256(plaintext))` — the deduplication tag (docs/06).
 *
 * Over the hash of the PLAINTEXT, deliberately: the ciphertext address cannot serve, because
 * `KC` is random and the same file encrypted twice lands at two addresses. Only a holder of
 * the scope key can compute a tag, so the index is not an oracle to anyone else — but
 * querying it is one to its holders, which is why the query carries the same authorisation
 * as a blob read.
 */
export const dedupTag = (scopeKey: Uint8Array, plaintext: Uint8Array): string =>
  toHex(hmac(sha256, scopeKey, sha256(plaintext)));
