/**
 * The nightly half of garbage collection: what history is kept, and what stops being held.
 *
 * The TTL sweeps in `collector.ts` are about things that were never finished — an abandoned
 * upload part, a claim on bytes no node ever bound. These four statements are about things
 * that *were* finished and have aged out, which is the pass [03](docs/03-data-model.md)
 * specifies and which had no implementation at all: the retention ladder, the trash whose
 * history the ladder emptied, the claims that then reference nothing, and the mark that puts
 * a blob into quarantine.
 *
 * They live here rather than in `collector.ts` because they are the half with a **policy** in
 * it. A TTL is a number; a ladder is a decision about what a person gets to keep, and it is
 * spent against the same quota as their content — which is why its outer bound belongs to the
 * account and not to this file.
 *
 * **Order is load-bearing, and each step feeds the next.** Thinning must precede marking or a
 * version row outlives the blob it names; the trash can only be swept once its history is
 * gone; a claim can only be dropped once nothing points at it. Running them apart, or in the
 * other order, leaves a window in which the database contradicts itself.
 */
import type { PoolClient } from 'pg';

/**
 * Thin history down to the ladder (docs/03), with each account's own outer bound.
 *
 * | age | what survives |
 * |---|---|
 * | under 7 days | every version |
 * | 7–30 days | one a day |
 * | 30 days to `history_days` | one a week |
 * | beyond that | none |
 *
 * **The head of a live node is outside the policy entirely.** It is not history — it is the
 * file — and a ladder that could delete it would be a ladder that deletes notes. Held by
 * revision rather than by hash: the highest revision of a node is what its content is, and a
 * comparison against `nodes.sha256` would keep every *other* version that happens to hold the
 * same bytes, which is a different rule that looks identical until somebody reverts an edit.
 *
 * A deleted node's head is **not** exempt, and that is what eventually empties the trash: its
 * versions age out like any others, and when the last one goes the row itself can follow.
 */
export const thinVersions = async (c: PoolClient): Promise<number> => {
  const r = await c.query(
    `WITH ranked AS (
       SELECT v.vault_id, v.node_id, v.rev,
              u.history_days,
              now() - v.at AS age,
              (n.deleted_at IS NULL
               AND v.rev = max(v.rev) OVER (PARTITION BY v.vault_id, v.node_id)) AS is_head,
              row_number() OVER (PARTITION BY v.vault_id, v.node_id, date_trunc('day', v.at)
                                 ORDER BY v.rev DESC) AS in_day,
              row_number() OVER (PARTITION BY v.vault_id, v.node_id, date_trunc('week', v.at)
                                 ORDER BY v.rev DESC) AS in_week
         FROM versions v
         JOIN nodes  n  ON n.vault_id = v.vault_id AND n.id = v.node_id
         JOIN vaults va ON va.id = v.vault_id
         JOIN users  u  ON u.id = va.user_id)
     DELETE FROM versions t
      USING ranked r
      WHERE t.vault_id = r.vault_id AND t.node_id = r.node_id AND t.rev = r.rev
        AND NOT r.is_head
        AND r.age >= interval '7 days'
        AND NOT (r.age < interval '30 days' AND r.in_day = 1)
        AND NOT (r.age < make_interval(days => r.history_days) AND r.in_week = 1)`,
  );
  return r.rowCount ?? 0;
};

/**
 * Remove trashed nodes whose history has all been thinned away.
 *
 * A node in the trash is a row with `deleted_at` and versions still alive — that *is* the
 * trash entry (docs/03). Once the ladder has taken the last of them there is nothing left to
 * restore, and the row is a name and a parent pointer describing nothing.
 *
 * **Bottom-up, and only where nothing hangs below.** `parent_id` is `ON DELETE RESTRICT`
 * because an orphaned branch is worse than a failed delete, so a folder goes only after
 * everything inside it has, and a folder holding anything at all — deleted or alive — is left
 * for a later pass. Deepest first, one statement per level, for the same reason the purge
 * does it that way: a single `DELETE … WHERE id = ANY` offers no ordering to lean on.
 */
export const removeSpentTrash = async (c: PoolClient): Promise<number> => {
  const doomed = await c.query<{ id: string; vaultId: string; depth: number }>(
    `SELECT n.id, n.vault_id AS "vaultId", COALESCE(array_length(n.ancestry, 1), 0) AS depth
       FROM nodes n
      WHERE n.deleted_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM versions v
                         WHERE v.vault_id = n.vault_id AND v.node_id = n.id)
        AND NOT EXISTS (SELECT 1 FROM nodes child
                         WHERE child.vault_id = n.vault_id AND child.parent_id = n.id)
      ORDER BY depth DESC`,
  );

  let removed = 0;
  for (const level of byDepth(doomed.rows)) {
    const gone = await c.query(`DELETE FROM nodes WHERE (vault_id, id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`, [
      level.map((n) => n.vaultId),
      level.map((n) => n.id),
    ]);
    removed += gone.rowCount ?? 0;
  }
  return removed;
};

/**
 * Recompute what every account still holds, and drop the claims that survived nothing.
 *
 * The account-wide form of `dropUnreferenced` in `holdings.ts`, which the same statement
 * answers for one account when a departure or a purge asks. Here it is asked of everybody,
 * because thinning does not belong to any one account's action and nothing would otherwise
 * notice that the last version naming a blob has gone.
 *
 * `refcount` is reconciled rather than maintained live (docs/03): under concurrent writes a
 * running counter drifts, and an error towards zero is data loss rather than a wrong number.
 */
export const dropSpentClaims = async (c: PoolClient): Promise<number> => {
  const r = await c.query(
    `DELETE FROM user_blobs ub
      WHERE ub.refs_pending = 0
        AND NOT EXISTS (SELECT 1 FROM nodes n JOIN vaults va ON va.id = n.vault_id
                         WHERE va.user_id = ub.user_id AND n.sha256 = ub.sha256
                           AND n.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM versions v JOIN vaults va ON va.id = v.vault_id
                         WHERE va.user_id = ub.user_id AND v.sha256 = ub.sha256)`,
  );
  return r.rowCount ?? 0;
};

/**
 * Put unreferenced blobs into quarantine, and take back any that were claimed again.
 *
 * The mark is half of a rule whose other half is the sweep, and the gap between them is the
 * whole point: a blob loses its last reference the instant a claim is dropped, while an
 * upload of the same content writes its file *before* it commits its row. Deleting on the
 * spot means racing that gap, and losing it leaves a committed row pointing at no file.
 *
 * **Unmarking is not bookkeeping.** A blob bound between two passes must come back out, or a
 * file somebody is actively using is deleted on the strength of an observation made a week
 * ago. docs/03 says the binding clears the mark; doing it here as well is what makes that
 * true for a binding path that forgets to.
 *
 * A live `refs_pending` row counts as a reference exactly like a node does — an upload inside
 * its TTL is a reference the protocol already promises to honour.
 */
export const markUnreferenced = async (c: PoolClient): Promise<{ marked: number; unmarked: number }> => {
  const unmarked = await c.query(
    `UPDATE blobs b SET gc_marked_at = NULL
      WHERE b.gc_marked_at IS NOT NULL AND ${REFERENCED}`,
  );
  const marked = await c.query(
    `UPDATE blobs b SET gc_marked_at = now()
      WHERE b.gc_marked_at IS NULL AND NOT ${REFERENCED}`,
  );
  return { marked: marked.rowCount ?? 0, unmarked: unmarked.rowCount ?? 0 };
};

/**
 * Everything that counts as a reason to keep a blob's bytes.
 *
 * One expression, used by the mark, the unmark and the sweep, because three spellings of
 * "still referenced" is three chances to disagree about it — and the one that disagrees by
 * being too narrow deletes a file somebody is reading.
 */
const REFERENCED = `(EXISTS (SELECT 1 FROM user_blobs u WHERE u.sha256 = b.sha256)
                  OR EXISTS (SELECT 1 FROM nodes    n WHERE n.sha256 = b.sha256)
                  OR EXISTS (SELECT 1 FROM versions v WHERE v.sha256 = b.sha256))`;

/** The rows grouped by depth, deepest group first — the order the foreign key demands. */
const byDepth = <T extends { depth: number }>(rows: readonly T[]): T[][] => {
  const levels: T[][] = [];
  let depth: number | undefined;
  for (const row of rows) {
    if (row.depth !== depth) {
      levels.push([]);
      depth = row.depth;
    }
    levels[levels.length - 1]!.push(row);
  }
  return levels;
};

export { REFERENCED };
