/**
 * Account-scope predicates: answers to "whose is this", shared by every route family that
 * guards a vault by ownership.
 *
 * docs/04 names the reason this is one module: "Separate checks per endpoint are precisely
 * where one eventually falls behind the rest." The ownership predicate was copy-pasted
 * across delta, history and nodes, and the change-notification hub added a fourth shape
 * that also read `head_rev`. One module, one formulation of the rule.
 *
 * The rule behind the boolean is "404, never 403" (#20): a caller that does not own the
 * vault must not learn whether it exists. That mapping stays in the routes — the predicate
 * answers the question, the route decides the status.
 */
import type { Db } from './db.js';

/** Whether `userId` owns `vaultId`. The single formulation of the ownership test. */
export const ownsVault = async (db: Db, userId: string, vaultId: string): Promise<boolean> => {
  const row = await db.one<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM vaults WHERE id = $1 AND user_id = $2) AS ok`,
    [vaultId, userId],
  );
  return row?.ok ?? false;
};

/** Who owns a vault and where its journal stands, for a fan-out that needs both. */
export const ownerOf = async (
  db: Db,
  vaultId: string,
): Promise<{ userId: string; headRev: number } | undefined> => {
  const row = await db.one<{ userId: string; head: string }>(
    `SELECT user_id AS "userId", head_rev::text AS head FROM vaults WHERE id = $1`,
    [vaultId],
  );
  if (!row) return undefined;
  return { userId: row.userId, headRev: Number(row.head) };
};
