/**
 * Where a revision is born. One place, because the alternative is two.
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
