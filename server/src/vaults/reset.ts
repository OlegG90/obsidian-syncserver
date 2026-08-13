/**
 * "My client is the source of truth" (AC-14).
 *
 * Adoption overwrites nothing, which is exactly why it sometimes does not fit: after a
 * messy migration or a divergence the user often **knows** which side is right and does not
 * want to sort through hundreds of conflict files. This is the operation that says so.
 *
 * It **hard-destroys** the vault's own nodes rather than soft-deleting them: space held by
 * nodes and their history is freed at once, with no leftover trash occupying quota and no
 * separate "purge permanently" step. A blob with an outstanding pending claim is the one
 * exception, released on the unbound TTL instead — see `recountQuota`, which is where the
 * reason lives. The cost is that a mistaken reset cannot be undone from the server — only
 * re-uploaded from a client that still holds the data. Other devices are protected
 * separately: they receive `410 reset` and quarantine rather than delete (#80).
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';

/**
 * Everything a reset must leave alone.
 *
 * The share exclusion (SH-27) is the one that matters: a replica **is** the participant's
 * own nodes in their own vault, so a reset that swept "everything of mine" would take the
 * replicas with it, and each of those deletions would propagate — one person reinstalling
 * Obsidian and choosing "my client wins" would empty the shared folders of up to seven
 * other people.
 *
 * The ancestor clause is what makes that exclusion actually work. A replica root hangs
 * under an ordinary private folder the participant chose at join time, and `parent_id` is
 * `ON DELETE RESTRICT` — so a delete set that kept the replica but not the folder it sits
 * in would simply fail, and the whole reset with it.
 */
const KEEP = `
  n.parent_id IS NULL
  OR n.share_id IS NOT NULL
  OR EXISTS (SELECT 1 FROM nodes m
              WHERE m.vault_id = n.vault_id
                AND m.share_id IS NOT NULL
                AND m.ancestry @> ARRAY[n.id])`;

/**
 * Deleted deepest-first, one depth at a time.
 *
 * `parent_id` is `ON DELETE RESTRICT`, and RESTRICT is checked per row without noticing
 * that the child is being removed by the same statement — so a single `DELETE` over the
 * whole set fails on the first parent it reaches. The restriction is deliberate: an
 * orphaned branch is worse than a failed delete.
 */
const deleteOwnTree = async (c: PoolClient, vaultId: string): Promise<number> => {
  const depths = await c.query<{ depth: number | null }>(
    `SELECT DISTINCT array_length(n.ancestry, 1) AS depth
       FROM nodes n WHERE n.vault_id = $1 AND NOT (${KEEP})
      ORDER BY depth DESC NULLS LAST`,
    [vaultId],
  );

  let removed = 0;
  for (const { depth } of depths.rows) {
    const r = await c.query(
      `DELETE FROM nodes n
        WHERE n.vault_id = $1
          AND array_length(n.ancestry, 1) IS NOT DISTINCT FROM $2::int
          AND NOT (${KEEP})`,
      [vaultId, depth],
    );
    removed += r.rowCount ?? 0;
  }
  return removed;
};

/**
 * Quota is recomputed rather than adjusted.
 *
 * A mass delete has no single "reference that caused it" to decrement alongside, and an
 * increment-per-row loop over a whole vault is a long way to arrive at a number one query
 * already knows. The invariant that matters is upheld either way: the accounting is right
 * when this transaction commits, not at some later reconciliation.
 */
const HELD = `
  SELECT sha256, count(*) AS n FROM (
    SELECT n.sha256 FROM nodes n JOIN vaults v ON v.id = n.vault_id
     WHERE v.user_id = $1 AND n.sha256 IS NOT NULL
    UNION ALL
    SELECT ve.sha256 FROM versions ve JOIN vaults v ON v.id = ve.vault_id
     WHERE v.user_id = $1
  ) refs GROUP BY sha256`;

const recountQuota = async (c: PoolClient, userId: string): Promise<void> => {
  // Rows that now claim nothing are DELETED FIRST, not updated to zero: a zero row cannot
  // exist even for the length of a statement — `row_must_be_referenced` rejects it, and
  // rightly, since it would still be counted by the quota sum.
  //
  // `refs_pending = 0` is why a reset does not always take usage to zero, and it is not an
  // oversight. A pending claim may be an upload in flight *right now*, and this cannot tell
  // that apart from one abandoned an hour ago — only elapsed time can, which is the
  // collector's job (`unboundBlobTtlSeconds`). Sweeping here would leave the account
  // charged nothing for bytes sitting on the disk. So the survivors drop to `refs_own = 0`
  // and expire on the TTL. Most visible after a re-upload of already-held content, which
  // leaves a surplus pending claim that no binding ever consumes.
  await c.query(
    `WITH held AS (${HELD})
     DELETE FROM user_blobs ub
      WHERE ub.user_id = $1
        AND ub.refs_pending = 0
        AND COALESCE((SELECT n FROM held WHERE held.sha256 = ub.sha256), 0) = 0`,
    [userId],
  );
  await c.query(
    `WITH held AS (${HELD})
     UPDATE user_blobs ub
        SET refs_own = COALESCE((SELECT n FROM held WHERE held.sha256 = ub.sha256), 0)
      WHERE ub.user_id = $1`,
    [userId],
  );
};

export type ResetResult = { resetEpoch: number; rootNodeId: string; removed: number };

export const resetVault = async (db: Db, userId: string, vaultId: string): Promise<ResetResult | undefined> =>
  db.tx(async (c) => {
    const vault = await c.query<{ rootNodeId: string }>(
      `SELECT root_node_id AS "rootNodeId" FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [vaultId, userId],
    );
    if (vault.rowCount === 0) return undefined;

    const removed = await deleteOwnTree(c, vaultId);
    await recountQuota(c, userId);

    // The epoch is what tells every other device this happened, and which of the two
    // opposite reactions is correct: apply the deletions rather than upload the local
    // extras back (#79). It may only increase, enforced by a trigger.
    const epoch = await c.query<{ epoch: string }>(
      `UPDATE vaults SET reset_epoch = reset_epoch + 1 WHERE id = $1 RETURNING reset_epoch::text AS epoch`,
      [vaultId],
    );

    // The journal is left alone deliberately: its rows outlive the nodes they name (they
    // carry no foreign key), and every cursor that could still read them is about to be
    // answered `410 reset` anyway.
    return {
      resetEpoch: Number(epoch.rows[0]!.epoch),
      rootNodeId: vault.rows[0]!.rootNodeId,
      removed,
    };
  });
