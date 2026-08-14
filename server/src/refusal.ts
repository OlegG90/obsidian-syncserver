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
import type { PoolClient } from 'pg';

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
  | { kind: 'vault_exists' }
  /**
   * The share is past `preparing`, so cancelling it is no longer the right operation —
   * a share somebody may already hold a copy of is ended by finalization, not by a state
   * change. `state` is carried because it decides which operation *is* right.
   */
  | { kind: 'share_not_preparing'; state: string }
  /** Invite and join need an activated share; `state` says how far it actually got. */
  | { kind: 'share_not_active'; state: string }
  /**
   * Activation refused: interior nodes still carry material a participant could not use.
   * The gaps travel with it — the initiator's client has to know WHICH nodes to prepare,
   * and a bare "not prepared" would send it to re-scan the whole subtree.
   */
  | { kind: 'share_not_prepared'; gaps: { nodeId: string; missing: string }[] }
  /**
   * An invitation did not apply, and deliberately does not say why: no such account and
   * already a member answer identically, because distinguishing them would turn this into
   * the login oracle #73 closed on /auth/kdf.
   */
  | { kind: 'invite_failed' }
  /** Removing the initiator is not a removal — it ends the share, which is its own act. */
  | { kind: 'initiator_cannot_be_removed' }
  /**
   * A finalization pass that did not cover the whole replica. The missing node ids travel
   * with it: a half-converted folder is one whose files the owner can no longer open, and
   * the client is the only party that can finish the job.
   */
  | { kind: 'finalization_incomplete'; missing: string[] };

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

/**
 * A transaction whose schema refusals come back as answers instead of as `500`s.
 *
 * The rule is AGENTS.md's — a `500` for something the caller could fix is a defect — and it
 * had been written eight times: twice as a helper in two service files, and six more inline
 * in the sharing module, which needed it most and had it least. Every write family that
 * arrives next would have copied it again.
 *
 * The `db` parameter is structural rather than the `Db` type, and the `PoolClient` import is
 * type-only, so this file keeps the property that made it worth splitting from
 * `refuse-http`: it pulls in nothing at runtime. A fact about a database write should not
 * drag a driver, let alone a web framework, into everything that names it.
 *
 * Anything that is not a `check_violation` still throws. A unique violation or a
 * serialization failure usually means a defect on this side, and mapping them all to `400`
 * would file the server's own bugs under the caller's name.
 */
export const txGuarded = async <T>(
  db: { tx<R>(fn: (c: PoolClient) => Promise<R>): Promise<R> },
  fn: (c: PoolClient) => Promise<T>,
): Promise<T | Refusal> => {
  try {
    return await db.tx(fn);
  } catch (e) {
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};
