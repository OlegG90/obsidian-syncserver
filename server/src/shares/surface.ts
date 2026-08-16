/**
 * What the share domain shows to the rest of the server.
 *
 * Two answers that other route families need and that only the sharing tables can give: the
 * key scopes a caller may read a vault with, and the account states a delta carries. Both
 * are **reads**, both are recomputed from what is true now, and neither has anything to do
 * with the lifecycle a share goes through.
 *
 * They live apart from that lifecycle for a reason a dependency graph makes plain: without
 * this file, answering `GET /vaults/{id}/delta` meant importing create, invite, join,
 * prepare, activate, leave and finalize — eleven hundred lines of state machine to compute
 * two lists. A module is not deep because it is large; it is deep when what a caller must
 * know to use it is small, and a delta request should not have to know a share can be
 * cancelled.
 */
import type { DeltaEvent } from '@syncserver/shared';
import type { Db } from '../db.js';

/** A key scope this vault's nodes may be named under, and how the caller opens it. */
export type ShareScope = {
  shareId: string;
  keyId: string;
  wrappedKey: string;
  /**
   * `vault` — wrapped under `KV`, which is how the initiator keeps their own copy;
   * `account` — an HPKE envelope to the account's public key, which is how a participant
   * received theirs. The client cannot guess: the two are opened with different keys.
   */
  wrapping: 'vault' | 'account';
};

/**
 * The share keys this caller needs to read this vault.
 *
 * Without these a client that restarts can see shared nodes and cannot name them: the
 * interior of a share is under `KS`, and `KS` reaches a device only in a wrapped form the
 * server stores but cannot open. It is returned when a vault is opened rather than through
 * an endpoint of its own because that is the moment the answer is needed — a sync that
 * begins without it fails on the first shared name.
 *
 * Both directions of ownership in one query, and they are genuinely different rows: the
 * initiator's copy lives on `shares`, a participant's on their membership.
 *
 * **The condition is `left_at IS NULL`, not the share's state**, and the difference is a
 * deadlock. An ended share still has a replica named under `KS` until its owner runs the
 * finalization pass — and that pass needs the very key being asked for here. Withholding it
 * because the share is over locks the vault out of BOTH: it cannot read the names, so it
 * cannot sync, and it cannot convert them back, so it never will. Found by ending a live
 * share and watching the vault stop syncing.
 *
 * The key stops being offered when `left_at` records that the pass ran, which is the same
 * moment the `share_ended` event stops being raised — one condition, two places that must
 * agree about when a share is finished with somebody.
 */
export const shareScopesFor = (db: Db, userId: string, vaultId: string): Promise<ShareScope[]> =>
  db.query<ShareScope>(
    `SELECT s.id AS "shareId", s.subtree_key_id AS "keyId",
            encode(s.wrapped_key_initiator, 'base64') AS "wrappedKey", 'vault' AS wrapping
       FROM shares s
       JOIN share_members m ON m.share_id = s.id AND m.user_id = s.initiator_id
      WHERE s.initiator_id = $1 AND s.initiator_vault_id = $2
        AND m.left_at IS NULL
        AND s.subtree_key_id IS NOT NULL
      UNION ALL
     SELECT s.id, s.subtree_key_id, encode(m.wrapped_key, 'base64'), 'account'
       FROM share_members m JOIN shares s ON s.id = m.share_id
      WHERE m.user_id = $1 AND m.vault_id = $2 AND m.user_id <> s.initiator_id
        AND m.joined_at IS NOT NULL AND m.left_at IS NULL
        AND m.wrapped_key IS NOT NULL AND s.subtree_key_id IS NOT NULL`,
    [userId, vaultId],
  );

/**
 * The states this caller must be shown, recomputed rather than remembered.
 *
 * Both are true-now questions, so they are asked on every delta: a client that missed one
 * is told again, and one that has caught up stops being told. That is the same shape
 * docs/02 gives everything else — the server holds states, the client renders them, and
 * nothing waits for an answer. An event log would need a cursor of its own and a rule for
 * pruning it, to say something the current row already says.
 *
 * `share_ended` is offered while the member still holds a replica to finalize: it is the
 * only prompt that the pass is owed, and it stops when `left_at` records that it ran.
 *
 * The freeze names no share, because being over quota is an account state (SH-20).
 */
export const deltaEventsFor = async (db: Db, userId: string, vaultId: string): Promise<DeltaEvent[]> => {
  const rows = await db.query<{ kind: string; shareId: string | null; at: string }>(
    `SELECT 'share_ended' AS kind, s.id AS "shareId", s.terminal_at AS at
       FROM share_members m JOIN shares s ON s.id = m.share_id
      WHERE m.user_id = $1 AND m.vault_id = $2
        AND s.state = 'ended' AND m.left_at IS NULL AND s.terminal_at IS NOT NULL
      UNION ALL
     SELECT 'account_frozen', NULL, u.frozen_at
       FROM users u WHERE u.id = $1 AND u.frozen_at IS NOT NULL`,
    [userId, vaultId],
  );

  return rows.map((r) =>
    r.kind === 'share_ended'
      ? ({ type: 'share_ended', share_id: r.shareId!, at: r.at } as const)
      : ({ type: 'account_frozen', at: r.at } as const),
  );
};
