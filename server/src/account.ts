/**
 * Account-scope predicates: answers to "whose is this" and "is this account frozen",
 * shared by every route family that guards a vault by ownership.
 *
 * docs/04 names the reason this is one module: "Separate checks per endpoint are precisely
 * where one eventually falls behind the rest." The ownership predicate was copy-pasted
 * across delta, history and nodes, and the change-notification hub added a fourth shape
 * that also read `head_rev`. One module, one formulation of the rule — and the write paths
 * that run inside `db.tx` use the same functions the routes use, through the `Queryable`
 * seam, instead of restating the fact as a second query shape.
 *
 * The rule behind the boolean is "404, never 403" (D-20): a caller that does not own the
 * vault must not learn whether it exists. That mapping stays in the routes — the predicate
 * answers the question, the route decides the status. Whether a **frozen** account may
 * perform an operation is the caller's decision too: a delete must proceed through a
 * freeze, because it is the only way out of over-quota (SH-20).
 */
import type { Queryable } from './db.js';

/** Whether `userId` owns `vaultId`. The single formulation of the ownership test. */
export const ownsVault = async (q: Queryable, userId: string, vaultId: string): Promise<boolean> => {
  const row = await q.one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM vaults WHERE id = $1 AND user_id = $2) AS ok`,
    [vaultId, userId],
  );
  return row?.ok ?? false;
};

/** Who owns a vault and where its journal stands, for a fan-out that needs both. */
export const ownerOf = async (
  q: Queryable,
  vaultId: string,
): Promise<{ userId: string; headRev: number } | undefined> => {
  const row = await q.one<{ userId: string; head: string }>(
    `SELECT user_id AS "userId", head_rev::text AS head FROM vaults WHERE id = $1`,
    [vaultId],
  );
  if (!row) return undefined;
  return { userId: row.userId, headRev: Number(row.head) };
};

/** What a write to a vault is allowed to: the owner, and whether that account is frozen. */
export type OwnerAccess =
  | { kind: 'not_found' }
  | { kind: 'frozen'; userId: string }
  | { kind: 'ok'; userId: string };

/**
 * Who owns `vaultId` and whether that account is frozen — the write-path guard, one query.
 *
 * The write services used to run two (owner, then frozen); `userId` rides in the frozen
 * branch too, because a delete must still attribute the released blobs to the owner while
 * proceeding through a freeze.
 */
export const ownerAndFrozen = async (q: Queryable, vaultId: string): Promise<OwnerAccess> => {
  const row = await q.one<{ userId: string; frozen: boolean }>(
    `SELECT v.user_id AS "userId", (u.frozen_at IS NOT NULL) AS frozen
       FROM vaults v JOIN users u ON u.id = v.user_id
      WHERE v.id = $1`,
    [vaultId],
  );
  if (!row) return { kind: 'not_found' };
  if (row.frozen) return { kind: 'frozen', userId: row.userId };
  return { kind: 'ok', userId: row.userId };
};

/** Whether an account is frozen — the check the blob intake needs before it will grow usage (SH-20). */
export const isFrozen = async (q: Queryable, userId: string): Promise<boolean> => {
  const row = await q.one<{ frozen: boolean }>(
    `SELECT frozen_at IS NOT NULL AS frozen FROM users WHERE id = $1`,
    [userId],
  );
  return row?.frozen ?? false;
};
