/**
 * The delta cursor: one integer plus the two epochs, naming its vault.
 *
 * A participant reads one log — their own vault's — so a share adds no position to it and
 * nothing has to be stitched (AC-12). Everything the client needs to resume is that
 * vault's `rev`.
 *
 * It is **signed** (D-100), and it is worth being precise about what that buys. A client
 * that raises its own `rev` only skips its own changes in its own vault: self-harm, not an
 * attack. What the signature protects is the **epoch** — a client that could edit that
 * would apply deletions it must not, or fail to resync after a restore, and the epoch is
 * the whole recovery protocol.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CursorFault, CursorPayload } from '@syncserver/shared';

// The wire vocabulary, used by its own producer. There was a second one here — the same two
// cases under shorter names — with the route translating between them. Two names for one
// concept do not stay in step: the shared type had drifted to a single value while this file
// and the route had two, so a client written against the contract would not have known that
// `cursor_wrong_subject` could arrive at all.

const b64u = (b: Buffer): string => b.toString('base64url');

const sign = (secret: string, payload: string): string =>
  b64u(createHmac('sha256', secret).update(payload, 'utf8').digest());

export const encodeCursor = (secret: string, payload: CursorPayload): string => {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(secret, body)}`;
};

/**
 * A bad tag is **400, not 410**: a forged cursor is malformed, not stale, and answering
 * `410` would turn a mangled byte into a free full resync.
 *
 * The caller distinguishes `cursor_unverifiable` — "this is not a token I can check, start again
 * from nothing" — because without it a device offline across two key rotations is bricked:
 * its token verifies under no surviving key and it cannot ask for a new one. A tamper check
 * whose only outcome is a dead end fails closed on the wrong person.
 */
export const decodeCursor = (
  secret: string,
  token: string,
  expect: { userId: string; vaultId: string },
): CursorPayload | CursorFault => {
  const dot = token.indexOf('.');
  if (dot < 1) return 'cursor_unverifiable';

  const body = token.slice(0, dot);
  const tag = token.slice(dot + 1);
  const expected = sign(secret, body);

  const a = Buffer.from(tag);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'cursor_unverifiable';

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    return 'cursor_unverifiable';
  }
  if (payload.v !== 1) return 'cursor_unverifiable';

  // `uid` and `vid` live inside the payload so a token cannot be replayed against another
  // account, nor against another vault of the same account, even with a valid tag.
  if (payload.uid !== expect.userId || payload.vid !== expect.vaultId) return 'cursor_wrong_subject';

  return payload;
};
