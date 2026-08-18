/**
 * Membership as a state: who is in a share, and what each asks of it.
 *
 * A membership row travels `invited → joined → finalizing → left`, and the queries that
 * need "the members who mean X" used to spell the columns out by hand — ten predicates,
 * five modules, and the differences were load-bearing and invisible. Two of them diverged
 * for real:
 *
 * - **who a catch-up may read from** forgot the frozen check that **who a write fans out to**
 *   carries, so a thawed member could be served the stale copy of a member still frozen —
 *   which is behind by construction, because fan-out skipped them;
 * - **which share scopes a blob-key envelope is offered under** matched the key-offer
 *   predicate only in a comment, and comments do not stay true.
 *
 * This module is the one place those columns are spelled. A caller asks for the population
 * it means by name — `LIVE`, `PRESENT`, `INVITED`, `FINALIZING` — and the fragment it gets
 * is the same string every other caller gets, so a rule that changes changes once.
 *
 * **The fragments assume `share_members` is aliased `m`.** `LIVE_UNFROZEN` additionally
 * assumes `users` is aliased `u` and joined, which is the price of deciding in one place
 * whether a frozen account counts: the frozen check is a statement about the *account*, and
 * only the callers that mean "can receive a write" pay for the join.
 */
export type MemberState =
  | 'invited' // a row with no joined_at: an invitation nobody answered (docs/05)
  | 'joined' // joined_at set, finalization not begun, left_at not set: a live participant
  | 'finalizing' // the departure pass started; the replica is being converted back
  | 'left'; // left_at set: the pass finished and this share is over for them

/**
 * Not left. The broadest "still in the share": includes outstanding invitations and members
 * mid-finalization, because both still hold a row the rest of the system has to respect.
 */
export const PRESENT = `m.left_at IS NULL`;

/** Joined and not left — a participant, whether or not their departure has begun. */
export const JOINED = `m.joined_at IS NOT NULL AND m.left_at IS NULL`;

/**
 * A live participant: joined, not finalizing, not left.
 *
 * The distinction from `JOINED` matters: propagation must reach only the *current* members,
 * while "who is a member" for listing and removal has to include someone mid-departure.
 */
export const LIVE = `m.joined_at IS NOT NULL AND m.finalization_started_at IS NULL AND m.left_at IS NULL`;

/**
 * A live participant whose account is not frozen.
 *
 * The one population that carries the frozen check, and the only query that ever needs it:
 * fan-out to a frozen account is delivering the one thing it cannot absorb (SH-20). A
 * catch-up SOURCE must meet the same test — a frozen member's copy is stale by construction,
 * so reading it back is how a thawed member inherits the gap instead of closing it.
 */
export const LIVE_UNFROZEN = `${LIVE} AND u.frozen_at IS NULL`;

/** An unanswered invitation: the row exists and nobody has joined on it (docs/05). */
export const INVITED = `m.joined_at IS NULL`;

/** A redeemable invitation: unanswered and not withdrawn. */
export const INVITATION = `m.joined_at IS NULL AND m.left_at IS NULL`;

/** The departure pass has begun and not finished — the only member who may finalize. */
export const FINALIZING = `m.finalization_started_at IS NOT NULL AND m.left_at IS NULL`;

/** Not left and not yet finalizing — who must BEGIN finalizing when a share ends. */
export const NOT_FINALIZING = `m.left_at IS NULL AND m.finalization_started_at IS NULL`;

/** Finalization not begun at all — the leaver's own precondition for starting it. */
export const NOT_STARTED = `m.finalization_started_at IS NULL`;
