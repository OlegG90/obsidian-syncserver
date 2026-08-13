/**
 * The refusal vocabulary: every "this write was refused" outcome, and the one place
 * that turns it into an HTTP response.
 *
 * Three route families used to each declare their own refusal union — nodes' `WriteFailure`,
 * blobs' `BlobRefusal`, history's `RestoreFailure` — and map it with their own switch: the
 * same status rule ("404, never 403", "frozen → 413") stated three times under three names,
 * and M3's share refusals would have been the fourth. The services now return this one
 * union; this module is the one switch, and a new refusal is a new member, not a new switch
 * in a new route.
 *
 * The union names the fact, not the wire: `kind` is the discriminant and the payload fields
 * are the service's own names (`currentSha256`, `retryAfterSeconds`, `blockedBy`). `refuse`
 * is the only place that maps them to the response body.
 */
import type { FastifyReply } from 'fastify';

export type Refusal =
  | { kind: 'not_found' }
  | { kind: 'no_such_version' }
  | { kind: 'device_revoked' }
  | { kind: 'frozen' }
  | { kind: 'over_quota' }
  | { kind: 'too_large' }
  | { kind: 'part_too_large' }
  | { kind: 'too_many_unfinished' }
  | { kind: 'address_mismatch' }
  | { kind: 'size_mismatch' }
  | { kind: 'share_boundary' }
  /** The content precondition failed: someone else wrote first (#52). */
  | { kind: 'base_mismatch'; currentSha256: string | null; rev: number }
  /** The revision precondition failed: placement moved on, and it is the subject of the write. */
  | { kind: 'rev_mismatch'; rev: number }
  /** Restoring into a name that has since been taken; no automatic renaming (#36). */
  | { kind: 'name_taken'; blockedBy: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  /** The staged parts are not a contiguous run from 1 — a hole a resume fills. */
  | { kind: 'parts_missing'; have: number[] }
  /**
   * The schema refused the write, and `detail` is what it said (see `refusalFromDatabase`).
   */
  | { kind: 'invalid_write'; detail: string }
  /** A pairing was approved or claimed already; both are once-only (docs/06). */
  | { kind: 'already_settled' }
  /** A pairing exists and nobody has approved it yet — a state to wait in, not a fault. */
  | { kind: 'not_approved' };

/** One place decides what a refusal looks like, so every route family answers the same way. */
export const refuse = (reply: FastifyReply, refusal: Refusal): FastifyReply => {
  switch (refusal.kind) {
    case 'not_found':
    case 'no_such_version':
      return reply.code(404).send({ error: refusal.kind });
    case 'device_revoked':
      return reply.code(401).send({ error: 'device_revoked' });
    case 'frozen':
    case 'over_quota':
    case 'too_large':
    case 'part_too_large':
    case 'too_many_unfinished':
      return reply.code(413).send({ error: refusal.kind });
    case 'address_mismatch':
    case 'size_mismatch':
      return reply.code(400).send({ error: refusal.kind });
    case 'share_boundary':
      return reply.code(409).send({ error: 'share_boundary' });
    case 'base_mismatch':
      // The caller is told what the content actually is, because that is what lets the
      // client decide between "same text reached independently" and a real conflict.
      return reply
        .code(409)
        .send({ error: 'base_mismatch', sha256: refusal.currentSha256, rev: refusal.rev });
    case 'rev_mismatch':
      return reply.code(409).send({ error: 'rev_mismatch', rev: refusal.rev });
    case 'name_taken':
      // The blocking node is named because the client has to offer the user a choice, and
      // "something is in the way" is not a choice.
      return reply.code(409).send({ error: 'name_taken', blocked_by: refusal.blockedBy });
    case 'rate_limited':
      return reply
        .code(429)
        .header('retry-after', String(refusal.retryAfterSeconds))
        .send({ error: 'rate_limited', retry_after: refusal.retryAfterSeconds });
    case 'parts_missing':
      return reply.code(409).send({ error: 'parts_missing', have: refusal.have });
    case 'invalid_write':
      return reply.code(400).send({ error: 'invalid_write', detail: refusal.detail });
    case 'already_settled':
      return reply.code(409).send({ error: 'already_settled' });
    case 'not_approved':
      // 409 rather than 404: the caller holds a valid pairing and the answer is "not yet",
      // which is what it should keep asking about. A 404 would tell it to give up.
      return reply.code(409).send({ error: 'not_approved' });
  }
};

/** PostgreSQL's `check_violation` — a CHECK constraint or a trigger's `RAISE`. */
const CHECK_VIOLATION = '23514';

/**
 * A schema refusal, turned into one the caller can act on.
 *
 * The schema is the enforcer of most write rules here, and every trigger in it raises
 * `check_violation` (see AGENTS.md). Unhandled, that arrives as a `500` — which is wrong by
 * this codebase's own rule that a `500` for something the caller could fix is a defect, and
 * wrong in a way that misdirects: the message is usually excellent ("private node … name
 * must use its vault key") and the status says the server broke.
 *
 * The message is passed through rather than replaced. It is the most specific statement
 * available of what was wrong, it was written to be read, and the caller has already been
 * authorised for the vault it names — a second, vaguer sentence composed here would only
 * make the reader guess which of several conditions failed.
 *
 * **Only `check_violation` is translated.** A unique violation, a foreign key or a
 * serialization failure mean something else and often mean a defect on this side; mapping
 * them all to `400` would file the server's own bugs under the caller's name.
 */
export const refusalFromDatabase = (e: unknown): Refusal | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  if (code !== CHECK_VIOLATION) return undefined;
  const detail = (e as { message?: unknown }).message;
  return { kind: 'invalid_write', detail: typeof detail === 'string' ? detail : 'the write violates a schema rule' };
};
