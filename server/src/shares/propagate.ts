/**
 * Fan-out: a write inside a shared folder reaching every other participant's copy.
 *
 * **All of them or none of them** (docs/04). Every replica is written in the same
 * transaction as the original, so there is no window in which one participant has the
 * change and another does not, and no queue to drain. This is an application-level
 * atomicity contract rather than something the schema can prove — no constraint can span
 * "the same item in eight vaults" — which is why the checklist demands a test that injects
 * a failing replica write and shows that none advanced.
 *
 * Synchronous fan-out is affordable only because a share holds at most eight participants
 * (SH-11), and that ceiling exists for this reason rather than as a product limit.
 *
 * **`share_item_id` is the whole mechanism.** No participant can see another's node ids —
 * each replica has its own — so every operation here is expressed as "the node carrying
 * this item id, in that vault". It is the identity `join` was careful to copy.
 *
 * **What is not fanned out.** Material is scope-keyed, not user-keyed: an envelope under
 * `KS` opens for everyone who holds `KS`, so it is written once by the originating write
 * and needs no copy. Quota is the opposite — every participant pays for their own copy
 * (SH-03) — so each recipient takes a `user_blobs` claim of their own.
 */
import type { PoolClient } from 'pg';
import { claimBlob, recordVersion } from '../holdings.js';
import { freezeIfOverQuota } from '../quota.js';
import { nextRev } from '../revision.js';

/** A participant a write must reach: their account, and the vault their replica lives in. */
export type Target = { userId: string; vaultId: string };

/**
 * The fan-out set, computed at execution time rather than remembered (docs/04): joined,
 * not finalizing, not gone, and whose **account** is not frozen.
 *
 * Frozen accounts are excluded in both directions (SH-20) — they receive no inbound
 * propagation and their own writes do not travel — because the freeze is about the account
 * having no room, and delivering more would be the one thing it cannot absorb. Their copy
 * catches up on thaw.
 *
 * @param exceptVaultId the vault the write already happened in.
 */
export const fanoutTargets = async (c: PoolClient, shareId: string, exceptVaultId: string): Promise<Target[]> => {
  const res = await c.query<{ userId: string; vaultId: string }>(
    `SELECT m.user_id AS "userId", m.vault_id AS "vaultId"
       FROM share_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.share_id = $1
        AND m.joined_at IS NOT NULL
        AND m.finalization_started_at IS NULL
        AND m.left_at IS NULL
        AND u.frozen_at IS NULL
        AND m.vault_id <> $2
      ORDER BY m.user_id
        FOR UPDATE OF m`,
    [shareId, exceptVaultId],
  );
  return res.rows;
};

/** The node carrying this share item in that vault, or nothing if the replica lacks it. */
const counterpart = async (
  c: PoolClient,
  vaultId: string,
  shareItemId: string,
): Promise<{ id: string; ancestry: string[] } | undefined> => {
  const res = await c.query<{ id: string; ancestry: string[] }>(
    `SELECT id, ancestry FROM nodes
      WHERE vault_id = $1 AND share_item_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
    [vaultId, shareItemId],
  );
  return res.rows[0];
};

/** Record the change in the recipient's own journal, so their devices see it as a change. */
const journal = (c: PoolClient, vaultId: string, rev: number, nodeId: string, op: string, prevParent?: string) =>
  c.query(
    `INSERT INTO journal (vault_id, rev, node_id, prev_parent_id, op, node_rev)
     VALUES ($1, $2, $3, $4, $5::journal_op, $2)`,
    [vaultId, rev, nodeId, prevParent ?? null, op],
  );

/** New content for an item that exists in every replica. */
export const propagatePut = async (
  c: PoolClient,
  targets: Target[],
  item: { shareItemId: string; sha256: string; size: number; mtime: string; authorId: string },
): Promise<void> => {
  for (const t of targets) {
    const node = await counterpart(c, t.vaultId, item.shareItemId);
    // A replica that does not hold the item is not an error to fail the write over: it can
    // only mean the item was created while this member was frozen, and their catch-up is
    // what repairs it. Failing here would let one lagging copy block everybody's writes.
    if (!node) continue;

    const rev = await nextRev(c, t.vaultId);
    await c.query(
      `UPDATE nodes SET sha256 = decode($3,'hex'), size = $4, mtime = $5, rev = $6
        WHERE vault_id = $1 AND id = $2`,
      [t.vaultId, node.id, item.sha256, item.size, item.mtime, rev],
    );
    await journal(c, t.vaultId, rev, node.id, 'put');
    await recordVersion(c, {
      vaultId: t.vaultId,
      nodeId: node.id,
      rev,
      sha256: item.sha256,
      size: item.size,
      authorId: item.authorId,
    });
    await claimBlob(c, t.userId, item.sha256);
    await freezeIfOverQuota(c, t.userId);
  }
};

/** A new item inside the shared folder, which every replica must gain. */
export const propagateCreate = async (
  c: PoolClient,
  targets: Target[],
  item: {
    shareId: string;
    shareItemId: string;
    parentShareItemId: string;
    type: string;
    nameEnc: string;
    nameHmac: string;
    nameKeyId: string;
    sha256: string | null;
    size: number | null;
    mtime: string;
    authorId: string;
  },
): Promise<void> => {
  for (const t of targets) {
    const parent = await counterpart(c, t.vaultId, item.parentShareItemId);
    if (!parent) continue;

    const rev = await nextRev(c, t.vaultId);
    const created = await c.query<{ id: string }>(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type,
                          sha256, size, mtime, rev, ancestry, share_id, share_item_id)
       VALUES ($1, $2, decode($3,'base64'), decode($4,'hex'), $5, $6::node_type,
               CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7,'hex') END, $8, $9, $10, $11, $12, $13)
    RETURNING id`,
      [
        t.vaultId,
        parent.id,
        item.nameEnc,
        item.nameHmac,
        item.nameKeyId,
        item.type,
        item.sha256,
        item.size,
        item.mtime,
        rev,
        [...parent.ancestry, parent.id],
        item.shareId,
        item.shareItemId,
      ],
    );
    const nodeId = created.rows[0]!.id;
    await journal(c, t.vaultId, rev, nodeId, 'put');

    // Both or neither: a node with content has a size, and the pair travels together. Read
    // as one condition so the type says what the data already guarantees.
    if (item.sha256 !== null && item.size !== null) {
      await recordVersion(c, {
        vaultId: t.vaultId,
        nodeId,
        rev,
        sha256: item.sha256,
        size: item.size,
        authorId: item.authorId,
      });
      await claimBlob(c, t.userId, item.sha256);
      await freezeIfOverQuota(c, t.userId);
    }
  }
};

/** A deletion, which is a soft delete in every replica exactly as in the original. */
export const propagateDelete = async (c: PoolClient, targets: Target[], shareItemId: string): Promise<void> => {
  for (const t of targets) {
    const node = await counterpart(c, t.vaultId, shareItemId);
    if (!node) continue;

    const rev = await nextRev(c, t.vaultId);
    await c.query(`UPDATE nodes SET deleted_at = now(), rev = $3 WHERE vault_id = $1 AND id = $2`, [
      t.vaultId,
      node.id,
      rev,
    ]);
    await journal(c, t.vaultId, rev, node.id, 'del');
  }
};

/**
 * A move **within** the share. Crossing its boundary is refused before this is reached: the
 * two sides are different key scopes, and a tree move must not quietly produce half the
 * cryptographic metadata.
 */
export const propagateMove = async (
  c: PoolClient,
  targets: Target[],
  item: { shareItemId: string; parentShareItemId: string; nameEnc: string; nameHmac: string; nameKeyId: string },
): Promise<void> => {
  for (const t of targets) {
    const node = await counterpart(c, t.vaultId, item.shareItemId);
    const parent = await counterpart(c, t.vaultId, item.parentShareItemId);
    if (!node || !parent) continue;

    const rev = await nextRev(c, t.vaultId);
    const ancestry = [...parent.ancestry, parent.id];
    const prevParent = await c.query<{ parentId: string | null }>(
      `SELECT parent_id AS "parentId" FROM nodes WHERE vault_id = $1 AND id = $2`,
      [t.vaultId, node.id],
    );

    await c.query(
      `UPDATE nodes SET parent_id = $3, name_enc = decode($4,'base64'), name_hmac = decode($5,'hex'),
                        name_key_id = $6, rev = $7, ancestry = $8
        WHERE vault_id = $1 AND id = $2`,
      [t.vaultId, node.id, parent.id, item.nameEnc, item.nameHmac, item.nameKeyId, rev, ancestry],
    );
    // The subtree follows, exactly as it does for a local move: descendants keep the part
    // of their chain below the moved node and take the new chain above it.
    await c.query(
      `UPDATE nodes
          SET ancestry = $3::uuid[] || $2::uuid ||
                         ancestry[array_position(ancestry, $2::uuid) + 1 : array_length(ancestry, 1)]
        WHERE vault_id = $1 AND ancestry @> ARRAY[$2::uuid]`,
      [t.vaultId, node.id, ancestry],
    );
    await journal(c, t.vaultId, rev, node.id, 'move', prevParent.rows[0]?.parentId ?? undefined);
  }
};
