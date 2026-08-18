/**
 * Removing a set of nodes, in the order `parent_id`'s `RESTRICT` demands.
 *
 * Four callers remove whole sets of nodes — the retention sweep empties the trash, the
 * purge discards a subtree, account deletion clears every vault of a user, and a reset
 * replaces a vault's tree — and each used to re-discover the same schema fact on its own,
 * in its own voice. `parent_id` is `ON DELETE RESTRICT`, and RESTRICT is checked per row
 * without noticing that the child is being removed by the same statement, so a single
 * `DELETE` over the whole set fails on the first parent it reaches. The restriction is
 * deliberate: an orphaned branch is worse than a failed delete.
 *
 * This module is where that fact lives now. The caller names the doomed set — its own
 * `SELECT`, with its own predicate for *what* is doomed — and hands the rows over; the
 * ordering the foreign key demands is this module's invariant, not something each caller
 * restates. A second RESTRICT edge on `nodes` is one edit here instead of four.
 */
import type { PoolClient } from 'pg';

/** The depth expression every doomed-set query needs — `array_length` over the ancestry. */
export const DEPTH = `COALESCE(array_length(n.ancestry, 1), 0)`;

/** One row of a doomed set: where the node lives, and how deep it sits. */
export interface Doomed {
  id: string;
  vaultId: string;
  depth: number;
}

/** The rows grouped by depth, deepest group first — the order the foreign key demands. */
export const byDepth = <T extends { depth: number }>(rows: readonly T[]): T[][] => {
  const sorted = [...rows].sort((a, b) => b.depth - a.depth);
  const levels: T[][] = [];
  let depth: number | undefined;
  for (const row of sorted) {
    if (row.depth !== depth) {
      levels.push([]);
      depth = row.depth;
    }
    levels[levels.length - 1]!.push(row);
  }
  return levels;
};

/**
 * Remove a set of nodes, deepest-first, one statement per depth level.
 *
 * The caller says *which* nodes; this decides *when* each goes. A level's rows are deleted
 * together because they cannot be ancestors of each other — two rows at the same depth have
 * no parent-child relation, so no ordering within the level matters. The version rows go
 * with each node by cascade.
 *
 * @returns how many node rows went.
 */
export const removeNodesByDepth = async (c: PoolClient, doomed: readonly Doomed[]): Promise<number> => {
  let removed = 0;
  for (const level of byDepth(doomed)) {
    const gone = await c.query(`DELETE FROM nodes WHERE (vault_id, id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))`, [
      level.map((n) => n.vaultId),
      level.map((n) => n.id),
    ]);
    removed += gone.rowCount ?? 0;
  }
  return removed;
};
