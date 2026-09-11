/**
 * Moving a node moves its subtree's ancestry with it.
 *
 * `nodes.ancestry` is the chain of strict ancestors, root first, that the share boundary and every
 * subtree query read. When a node moves, it is not enough to rewrite its own chain: every node that
 * had it as an ancestor keeps the part of its chain BELOW the moved node and takes the new chain
 * above it. One statement does that for the whole subtree.
 *
 * It was written out three times — a local move, a move fanned out to other members, and (as of
 * #337) a move a frozen member catches up on after thawing. The statement is subtle enough that a
 * copy which drifted would corrupt every subtree query below the moved node without failing on
 * its own, so it lives here once.
 *
 * @param newAncestry the moved node's OWN new chain — its new parent's ancestry plus the parent —
 *   not including the node itself.
 */
import type { PoolClient } from 'pg';

export const rewriteSubtreeAncestry = async (
  c: PoolClient,
  vaultId: string,
  nodeId: string,
  newAncestry: string[],
): Promise<void> => {
  await c.query(
    `UPDATE nodes
        SET ancestry = $3::uuid[] || $2::uuid ||
                       ancestry[array_position(ancestry, $2::uuid) + 1 : array_length(ancestry, 1)]
      WHERE vault_id = $1 AND ancestry @> ARRAY[$2::uuid]`,
    [vaultId, nodeId, newAncestry],
  );
};
