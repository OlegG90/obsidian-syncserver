/**
 * Writing into somebody else's copy of a shared folder.
 *
 * Two things arrive at another participant's vault, and they arrive for different reasons: a
 * **write** propagates the moment somebody makes it, and a **catch-up** walks a replica that
 * was frozen out and delivers what it missed. Different triggers, one act — find the node
 * that corresponds, or create it, and tell that vault's own devices it changed.
 *
 * It was written twice, once per trigger, and the copies each computed `ancestry` themselves.
 * That is the quiet kind: an ancestry chain that disagrees does not fail, it bends the tree
 * for one participant and shows up as a folder in the wrong place, weeks later, for one
 * person.
 *
 * **Correspondence is `share_item_id`** — the identity of an item *inside* the share, which
 * is the same in every copy. No two vaults agree on node ids, and neither side can read the
 * other's names.
 */
import type { PoolClient } from 'pg';
import { nextRev } from '../revision.js';

/** A node of a replica, as the two operations here need to know it. */
export interface Counterpart {
  id: string;
  /** The chain above it, root first, own id excluded — the child's chain is this plus `id`. */
  ancestry: string[];
}

/**
 * The node carrying this share item in that vault, or nothing if the replica lacks it.
 *
 * `FOR UPDATE`, because everything that follows writes to it and the fan-out is synchronous:
 * two writers reaching one replica must queue rather than interleave.
 */
export const counterpartOf = async (
  c: PoolClient,
  vaultId: string,
  shareItemId: string,
  { includeDeleted = false } = {},
): Promise<Counterpart | undefined> => {
  const res = await c.query<Counterpart>(
    `SELECT id, ancestry FROM nodes
      WHERE vault_id = $1 AND share_item_id = $2 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        FOR UPDATE`,
    [vaultId, shareItemId],
  );
  return res.rows[0];
};

/**
 * Record the change in that vault's own journal, so its devices see it as a change.
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
  prevParent?: string,
): Promise<unknown> =>
  c.query(
    `INSERT INTO journal (vault_id, rev, node_id, prev_parent_id, op, node_rev)
     VALUES ($1, $2, $3, $4, $5::journal_op, $2)`,
    [vaultId, rev, nodeId, prevParent ?? null, op],
  );

/** One node of the source, in the spelling both operations already speak. */
export interface ReplicaItem {
  shareItemId: string;
  type: string;
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
  sha256: string | null;
  size: number | null;
  mtime: string;
}

/**
 * Create the corresponding node under a parent that is already there, and journal it.
 *
 * The ancestry is derived here rather than passed, which is the whole point of the function:
 * it is the parent's chain plus the parent, and every caller that computed it separately was
 * one edit away from computing it differently.
 *
 * Content is **not** claimed and **no version is written** here, because the two callers owe
 * different things: a propagated write records one version immediately, while a catch-up
 * delivers a whole history afterwards and would otherwise write the head twice.
 */
export const createCounterpart = async (
  c: PoolClient,
  target: { vaultId: string; shareId: string; parent: Counterpart },
  item: ReplicaItem,
): Promise<{ node: Counterpart; rev: number }> => {
  const rev = await nextRev(c, target.vaultId);
  const ancestry = [...target.parent.ancestry, target.parent.id];

  const created = await c.query<{ id: string }>(
    `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type,
                        sha256, size, mtime, rev, ancestry, share_id, share_item_id)
     VALUES ($1, $2, decode($3,'base64'), decode($4,'hex'), $5, $6::node_type,
             CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7,'hex') END, $8, $9, $10, $11, $12, $13)
  RETURNING id`,
    [
      target.vaultId,
      target.parent.id,
      item.nameEnc,
      item.nameHmac,
      item.nameKeyId,
      item.type,
      item.sha256,
      item.size,
      item.mtime,
      rev,
      ancestry,
      target.shareId,
      item.shareItemId,
    ],
  );

  const id = created.rows[0]!.id;
  await journalEntry(c, target.vaultId, rev, id, 'put');
  return { node: { id, ancestry }, rev };
};
