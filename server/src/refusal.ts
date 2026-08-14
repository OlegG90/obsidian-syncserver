/**
 * The refusal vocabulary: every way a write can be refused, named as a fact.
 *
 * Five route families used to each declare their own union and map it with their own switch
 * — the same status rule stated five times under five names. They share this one now, and a
 * new refusal is a new member rather than a new switch in a new route.
 *
 * **This module knows nothing about HTTP**, and that is the whole reason it is separate from
 * `refuse-http.ts`. Every service returns a `Refusal`, so every service imported whatever
 * declared it; while the union and the response mapping lived in one file, that meant five
 * services importing a Fastify type to describe a fact about a database write. A management
 * console or a CLI would have inherited the same dependency for the same non-reason.
 *
 * The union names the fact, not the wire: `kind` is the discriminant and the payload fields
 * are the service's own names (`currentSha256`, `retryAfterSeconds`, `blockedBy`). What each
 * one becomes on the wire is `refuse-http.ts` and nowhere else.
 */
import type { RefusalCode } from '@syncserver/shared';

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
  | { kind: 'not_approved' }
  /** A vault still holding nodes: emptying it is the caller's to do, not the server's. */
  | { kind: 'not_empty' }
  /** An ended share still names this vault, and will until the journal TTL prunes it (#44). */
  | { kind: 'named_by_a_share' }
  /** That vault id already exists for this account — the ordinary retry, not a fault. */
  | { kind: 'vault_exists' };

/**
 * Every `kind` above is a code `shared` declares, checked here rather than trusted.
 *
 * Without this the union could grow a member the client has no name for, which is exactly
 * the drift `shared` exists to prevent and exactly what happened to `restore.lifted`. The
 * assignment is never executed; it fails at compile time or not at all.
 */
const _everyKindIsDeclared: RefusalCode = null as unknown as Refusal['kind'];
void _everyKindIsDeclared;

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
