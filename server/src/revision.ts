/**
 * Where a revision is born, and where it is written down. One place each, because the
 * alternative is two — and for the journal it was six.
 *
 * `docs/02` says NodeService is "the only place a revision is born", and it was not: history
 * kept a byte-identical copy of this allocator, so the vault's revision counter had two
 * writers that merely happened to agree. Nothing warns when two copies of a rule stop
 * agreeing — and this counter is what the delta cursor is built on, so a divergence would
 * surface as a client that quietly missed a change, which is the worst way for it to show.
 *
 * The single `UPDATE … RETURNING` is the allocation AND the lock: PostgreSQL takes a row
 * lock for the update, so two concurrent writers to one vault serialise here and cannot be
 * handed the same number. That is why it is not `SELECT` then `UPDATE`, and why it must stay
 * inside the caller's transaction — the revision is only real if the write that used it
 * commits.
 */
import type { PoolClient } from 'pg';

export const nextRev = async (c: PoolClient, vaultId: string): Promise<number> => {
  const r = await c.query<{ head: string }>(
    `UPDATE vaults SET head_rev = head_rev + 1 WHERE id = $1 RETURNING head_rev::text AS head`,
    [vaultId],
  );
  return Number(r.rows[0]!.head);
};

/**
 * Record a change in a vault's journal, which is what its devices read as a delta.
 *
 * It belongs beside the allocator because it is the other half of the same act: a revision
 * that is never journalled is a number the delta cursor steps over, and `node_rev` is the
 * revision itself. Nothing here decides anything — and that is exactly why it had been
 * written out six times, in three modules, in three spellings of the same `INSERT`. Copies
 * this short never fail; they simply stop agreeing, and a column added to the journal would
 * have had to be remembered in every one of them.
 *
 * `prev_parent_id` belongs to a move and to nothing else: it is how a client learns where the
 * node came from. The other operations leave it null, which is not an omission — there is no
 * previous parent when a node is created, written or deleted in place.
 */
export const journalEntry = (
  c: PoolClient,
  vaultId: string,
  rev: number,
  nodeId: string,
  op: 'put' | 'del' | 'move',
  /** Nullable rather than merely optional: a node read back from `nodes` has it either way. */
  prevParent?: string | null,
): Promise<unknown> =>
  c.query(
    `INSERT INTO journal (vault_id, rev, node_id, prev_parent_id, op, node_rev)
     VALUES ($1, $2, $3, $4, $5::journal_op, $2)`,
    [vaultId, rev, nodeId, prevParent ?? null, op],
  );
