/**
 * Writing into somebody else's copy of a shared folder.
 *
 * Two things arrive at another participant's vault, and they arrive for different reasons: a
 * **write** propagates the moment somebody makes it, and a **catch-up** walks a replica that
 * was frozen out and delivers what it missed. Different triggers, one act — find the node
 * that corresponds, create or move it, and tell that vault's own devices it changed.
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
import { journalEntry, nextRev } from '../revision.js';
import { rewriteSubtreeAncestry } from '../ancestry.js';

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

/** Where an item is named, in the spelling both callers already hold — `KS`, so the same bytes in every copy. */
export type ItemName = Pick<ReplicaItem, 'nameEnc' | 'nameHmac' | 'nameKeyId'>;

/**
 * Put a counterpart under a new parent and a new name, carry its subtree along, and journal it.
 *
 * The same two triggers as creating one: a move fanned out the moment it is made, and a move a
 * frozen member missed and catches up on (#337). Names inside a share are under `KS`, identical
 * in every copy, so the source's bytes are written verbatim.
 *
 * @param undelete also lift it out of the trash, in the same revision. A catch-up can owe both
 *   at once, and it cannot do them as two writes: restored where it was, the node could collide
 *   with whatever took its old name while it was gone.
 */
export const moveCounterpart = async (
  c: PoolClient,
  vaultId: string,
  nodeId: string,
  parent: Counterpart,
  name: ItemName,
  { undelete = false } = {},
): Promise<number> => {
  const rev = await nextRev(c, vaultId);
  const ancestry = [...parent.ancestry, parent.id];
  const prevParent = await c.query<{ parentId: string | null }>(
    `SELECT parent_id AS "parentId" FROM nodes WHERE vault_id = $1 AND id = $2`,
    [vaultId, nodeId],
  );

  await c.query(
    `UPDATE nodes SET parent_id = $3, name_enc = decode($4,'base64'), name_hmac = decode($5,'hex'),
                      name_key_id = $6, rev = $7, ancestry = $8${undelete ? ', deleted_at = NULL' : ''}
      WHERE vault_id = $1 AND id = $2`,
    [vaultId, nodeId, parent.id, name.nameEnc, name.nameHmac, name.nameKeyId, rev, ancestry],
  );
  // The subtree follows, exactly as it does for a local move: descendants keep the part of
  // their chain below the moved node and take the new chain above it.
  await rewriteSubtreeAncestry(c, vaultId, nodeId, ancestry);
  await journalEntry(c, vaultId, rev, nodeId, 'move', prevParent.rows[0]?.parentId);
  return rev;
};
