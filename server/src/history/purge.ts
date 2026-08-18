/**
 * Emptying the trash — the only act in this product that makes usage go **down**.
 *
 * Everything else that looks like deletion is soft: the row *is* the trash entry (docs/03),
 * its versions stay alive, and the blobs behind them stay claimed. That is what made SH-20's
 * "deleting is the only way out" of an over-quota freeze a sentence with nothing behind it —
 * the only exits that existed were resetting a vault or deleting a whole one, both of which
 * cost far more than the space they free.
 *
 * **A frozen account may do this**, and that is the point rather than an exception. The
 * schema agrees: the trigger that refuses a frozen account's writes fires on `INSERT` and
 * `UPDATE`, never on `DELETE`, because a freeze that blocked the way out would be a deadlock.
 *
 * **Nothing is journalled.** A purged node was already deleted in every client that had it,
 * so an entry saying `del` would be announcing something that has already happened. The trash
 * is read from its own listing, not from the delta, and that listing is simply shorter
 * afterwards.
 *
 * **It does not propagate, and a replica is not excluded** (SH-30). Both halves of that are
 * deliberate and neither follows from the other: the item is already deleted in every copy,
 * so there is nothing to tell anybody about — and what is being discarded is this account's
 * own retention of it, which is per account exactly as its quota is. The cost is stated where
 * the decision is: having purged, this participant cannot restore that item, whoever else
 * still holds a copy.
 */
import type { Db } from '../db.js';
import { dropUnreferenced } from '../holdings.js';
import { removeNodesByDepth, DEPTH } from '../nodes/remove.js';
import { txGuarded, type Refusal } from '../refusal.js';
import { thawIfUnderQuota } from '../shares/thaw.js';

export interface PurgeResult {
  /** How many node rows went, their versions with them. */
  purged: number;
  /** True when this freed enough for the account to come back under its limit. */
  thawed: boolean;
}

/**
 * Discard trashed nodes for good: one subtree, or everything in the vault's trash.
 *
 * **A deleted folder that still holds something live is not purgeable**, and cannot be made
 * so by deleting harder. `parent_id` is `ON DELETE RESTRICT` precisely to refuse an orphaned
 * branch, so such a folder is left where it is: emptying the trash skips it, and asking for
 * it by name says why rather than failing on a foreign key the caller cannot see.
 *
 * @param nodeId a single subtree to discard, or `undefined` for the whole trash.
 */
export const purgeTrash = async (
  db: Db,
  input: { vaultId: string; nodeId?: string },
): Promise<PurgeResult | Refusal> =>
  txGuarded(db, async (c) => {
    const vault = await c.query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM vaults WHERE id = $1`,
      [input.vaultId],
    );
    if (vault.rowCount === 0) return { kind: 'not_found' } as Refusal;
    const userId = vault.rows[0]!.userId;

    if (input.nodeId) {
      const target = await c.query<{ deleted: boolean }>(
        `SELECT (deleted_at IS NOT NULL) AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`,
        [input.vaultId, input.nodeId],
      );
      if (target.rowCount === 0) return { kind: 'not_found' } as Refusal;
      if (!target.rows[0]!.deleted) {
        return {
          kind: 'invalid_write',
          detail: `node ${input.nodeId} is not in the trash; delete it before discarding it`,
        } as Refusal;
      }
    }

    // Deleted, and holding nothing that is alive. The second half is the whole of what makes
    // this set safe to remove: a node whose subtree is entirely deleted takes its descendants
    // with it, and one with a live descendant is refused by the foreign key rather than
    // orphaning it.
    const doomed = await c.query<{ id: string; vaultId: string; depth: number }>(
      `SELECT n.id, n.vault_id AS "vaultId", ${DEPTH} AS depth
         FROM nodes n
        WHERE n.vault_id = $1
          AND n.deleted_at IS NOT NULL
          AND ($2::uuid IS NULL OR n.id = $2 OR n.ancestry @> ARRAY[$2]::uuid[])
          AND NOT EXISTS (SELECT 1 FROM nodes live
                           WHERE live.vault_id = n.vault_id
                             AND live.ancestry @> ARRAY[n.id]::uuid[]
                             AND live.deleted_at IS NULL)`,
      [input.vaultId, input.nodeId ?? null],
    );

    if (input.nodeId && doomed.rowCount === 0) {
      return {
        kind: 'invalid_write',
        detail: `node ${input.nodeId} still holds files that are not deleted; empty it first`,
      } as Refusal;
    }

    // The version rows go with each node by cascade; they are the reason a purge frees
    // anything at all. The ordering is `removeNodesByDepth`'s.
    const purged = await removeNodesByDepth(c, doomed.rows);

    // The claim goes down here and nowhere else. `dropUnreferenced` asks the account-wide
    // question — does anything of mine still point at these bytes — which is the right one:
    // the same content may be held by another vault of the same account, and a per-blob
    // decrement would have to know that.
    await dropUnreferenced(c, userId);

    // And if that was enough, the freeze lifts in the same transaction, with the catch-up
    // SH-21 requires. A purge that freed the space and left the account frozen until some
    // later write happened to check would be the deadlock this exists to end.
    const thawed = await thawIfUnderQuota(c, userId);

    return { purged, thawed: thawed !== undefined };
  });
