/**
 * Catching a thawed participant's replicas up with the shares they were frozen out of
 * (SH-21).
 *
 * A freeze stops propagation in both directions: the account has no room, and delivering
 * more is the one thing it cannot absorb. So while it lasts, that member's copy of every
 * shared folder falls behind — and when the freeze lifts, **the gap has to be closed by
 * somebody**, because nothing else will ever mention those writes to them again. Propagation
 * is an event, and the events are over.
 *
 * **Not a re-copy** (SH-21). The current files would be far simpler and are explicitly not
 * what this delivers: the version rows of the frozen interval come too, with their original
 * authorship (SH-19), so a freeze leaves no hole in the record.
 *
 * **The source is another replica, not the journal.** `journal` is a 90-day transport buffer;
 * `versions` lives by the retention policy. A freeze that outlasts the TTL therefore still
 * catches up correctly — this walks the folder as it stands and the version rows behind it,
 * and never asks the journal anything.
 *
 * **Correspondence is `share_item_id`**, the identity of an item *within* the share, which is
 * the same in every participant's copy and is exactly what propagation uses. No two replicas
 * agree on node ids, and neither side can read the other's names.
 *
 * **The root is never touched.** Each member named their own copy's root under their own key
 * (SH-01), so its name is not the source's to hand over.
 */
import type { PoolClient } from 'pg';
import { claimBlob, recordVersion } from '../holdings.js';
import { counterpartOf, createCounterpart, type Counterpart } from './replica.js';
import { journalEntry } from '../revision.js';
import { freezeIfOverQuota } from '../quota.js';
import { nextRev } from '../revision.js';
import { LIVE, LIVE_UNFROZEN } from './membership.js';

/** One node of the source replica, in the order a reconciliation can apply it. */
interface SourceNode {
  shareItemId: string;
  parentShareItemId: string | null;
  type: string;
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
  sha256: string | null;
  size: number | null;
  mtime: string;
  deleted: boolean;
}

/** What a catch-up did, so a caller can say it happened rather than guess. */
export interface CaughtUp {
  shareId: string;
  created: number;
  updated: number;
  deleted: number;
  versions: number;
}

/**
 * Whose copy to catch up from.
 *
 * Any live member's will do — they are all the same folder — but the **initiator's** is
 * preferred because it is the one copy guaranteed to hold the whole history: an added
 * participant's own history was zeroed when they joined and starts at their entry horizon
 * (SH-22, SH-23), so a freeze that began before they joined would catch up short.
 *
 * **Frozen accounts are not sources.** The fan-out set excluded them, so their copy is
 * behind *by construction* — two members frozen at once, and the first to thaw would
 * otherwise be served the second's stale copy. Same test as fan-out's, and for the same
 * reason: what you would not deliver from is not what you should read from.
 */
const sourceOf = async (
  c: PoolClient,
  shareId: string,
  exceptVaultId: string,
): Promise<{ vaultId: string } | undefined> => {
  const res = await c.query<{ vaultId: string }>(
    `SELECT m.vault_id AS "vaultId"
       FROM share_members m
       JOIN shares s ON s.id = m.share_id
       JOIN users u ON u.id = m.user_id
      WHERE m.share_id = $1
        AND ${LIVE_UNFROZEN}
        AND m.vault_id IS DISTINCT FROM $2
      ORDER BY (m.user_id = s.initiator_id) DESC
      LIMIT 1`,
    [shareId, exceptVaultId],
  );
  return res.rows[0];
};

/** The source subtree, parents before children, so a create always has its parent already. */
const subtreeOf = async (c: PoolClient, vaultId: string, shareId: string): Promise<SourceNode[]> =>
  (
    await c.query<SourceNode>(
      `SELECT n.share_item_id AS "shareItemId",
              p.share_item_id AS "parentShareItemId",
              n.type::text AS type,
              encode(n.name_enc, 'base64') AS "nameEnc",
              encode(n.name_hmac, 'hex')   AS "nameHmac",
              n.name_key_id AS "nameKeyId",
              encode(n.sha256, 'hex') AS sha256,
              n.size, n.mtime,
              (n.deleted_at IS NOT NULL) AS deleted
         FROM nodes n
         LEFT JOIN nodes p ON p.vault_id = n.vault_id AND p.id = n.parent_id
        WHERE n.vault_id = $1 AND n.share_id = $2
        ORDER BY coalesce(array_length(n.ancestry, 1), 0), n.id`,
      [vaultId, shareId],
    )
  ).rows;

/** Everything the catching-up vault holds for this share, by the identity both sides share. */
const replicaIndex = async (
  c: PoolClient,
  vaultId: string,
  shareId: string,
): Promise<Map<string, { id: string; ancestry: string[]; sha256: string | null; deleted: boolean }>> => {
  const res = await c.query<{
    shareItemId: string;
    id: string;
    ancestry: string[];
    sha256: string | null;
    deleted: boolean;
  }>(
    `SELECT share_item_id AS "shareItemId", id, ancestry,
            encode(sha256, 'hex') AS sha256, (deleted_at IS NOT NULL) AS deleted
       FROM nodes WHERE vault_id = $1 AND share_id = $2 FOR UPDATE`,
    [vaultId, shareId],
  );
  return new Map(res.rows.map((r) => [r.shareItemId, r]));
};

/**
 * Bring one member's replica of one share level with a live copy of it.
 *
 * Returns what changed. A share whose every other member has gone is skipped rather than
 * failed: there is nothing to catch up **from**, and the member's copy is already the only
 * one there is.
 */
export const catchUpShare = async (
  c: PoolClient,
  member: { userId: string; vaultId: string },
  shareId: string,
): Promise<CaughtUp> => {
  const done: CaughtUp = { shareId, created: 0, updated: 0, deleted: 0, versions: 0 };

  const source = await sourceOf(c, shareId, member.vaultId);
  if (!source) return done;

  const mine = await replicaIndex(c, member.vaultId, shareId);
  const theirs = await subtreeOf(c, source.vaultId, shareId);

  // The root of each copy is its owner's own (SH-01) and is excluded from the comparison
  // entirely — including from the deletions below, where it would otherwise look like an
  // item the source no longer has.
  const rootItem = await c.query<{ rootItemId: string }>(
    `SELECT root_item_id AS "rootItemId" FROM shares WHERE id = $1`,
    [shareId],
  );
  const rootItemId = rootItem.rows[0]?.rootItemId;

  const claim = (sha256: string): Promise<void> => claimBlob(c, member.userId, sha256);

  const journal = (rev: number, nodeId: string, op: 'put' | 'del'): Promise<unknown> =>
    journalEntry(c, member.vaultId, rev, nodeId, op);

  for (const node of theirs) {
    if (node.shareItemId === rootItemId) continue;

    const here = mine.get(node.shareItemId);

    // Missing entirely: created while this member was frozen, so propagation skipped them.
    if (!here) {
      if (node.deleted) continue; // created and deleted inside the gap: nothing to deliver
      const parent = node.parentShareItemId === null ? undefined : mine.get(node.parentShareItemId);
      // The replica root is not in the index — it is skipped as each member's own (SH-01) —
      // so it is asked for directly, with the same question everything else is found by.
      const parentHere: Counterpart | undefined =
        node.parentShareItemId === rootItemId
          ? await counterpartOf(c, member.vaultId, rootItemId!)
          : parent;
      // A parent that is not here yet cannot happen — the source is walked parents first —
      // but a parent deleted in the meantime can, and its children go with it.
      if (!parentHere) continue;

      // The same write propagation makes, for a different reason: it delivers an event,
      // this delivers a gap. The version rows are NOT written here — the history phase below
      // brings the whole interval, and the head would otherwise be recorded twice.
      const { node: written } = await createCounterpart(
        c,
        { vaultId: member.vaultId, shareId, parent: parentHere },
        node,
      );
      mine.set(node.shareItemId, { ...written, sha256: node.sha256, deleted: false });
      if (node.sha256) await claim(node.sha256);
      done.created++;
      continue;
    }

    // Present on both sides: deliver the content if it moved on. Names inside a share are
    // under `KS` and identical in every copy, so nothing about them needs comparing.
    if (!node.deleted && here.sha256 !== node.sha256 && node.sha256) {
      const rev = await nextRev(c, member.vaultId);
      await c.query(
        `UPDATE nodes SET sha256 = decode($3,'hex'), size = $4, mtime = $5, rev = $6, deleted_at = NULL
          WHERE vault_id = $1 AND id = $2`,
        [member.vaultId, here.id, node.sha256, node.size, node.mtime, rev],
      );
      await journal(rev, here.id, 'put');
      await claim(node.sha256);
      done.updated++;
    }

    // Deleted while this member was away. Soft, exactly as the original was.
    if (node.deleted && !here.deleted) {
      const rev = await nextRev(c, member.vaultId);
      await c.query(`UPDATE nodes SET deleted_at = now(), rev = $3 WHERE vault_id = $1 AND id = $2`, [
        member.vaultId,
        here.id,
        rev,
      ]);
      await journal(rev, here.id, 'del');
      done.deleted++;
    }
  }

  // The history of the gap, which is the half that makes this a catch-up rather than a
  // re-copy: every version the source holds that this replica does not, attached to the
  // corresponding node and keeping the author it was written by (SH-19). Revisions are the
  // source's, not renumbered — `versions` is keyed by them, and the vault's own `rev`
  // sequence has already moved past them above.
  const itemOf = new Map([...mine.entries()].map(([item, n]) => [n.id, item]));
  const byItem = new Map([...mine.entries()].map(([item, n]) => [item, n.id]));
  const missing = await c.query<{ shareItemId: string; rev: string; sha256: string; size: number; authorId: string }>(
    `SELECT sn.share_item_id AS "shareItemId", v.rev::text AS rev,
            encode(v.sha256,'hex') AS sha256, v.size, v.author_id AS "authorId"
       FROM versions v
       JOIN nodes sn ON sn.vault_id = v.vault_id AND sn.id = v.node_id
      WHERE v.vault_id = $1 AND sn.share_id = $2 AND sn.share_item_id <> $3
      ORDER BY v.rev`,
    [source.vaultId, shareId, rootItemId],
  );

  for (const v of missing.rows) {
    const nodeId = byItem.get(v.shareItemId);
    if (!nodeId || !itemOf.has(nodeId)) continue;
    // Absorbing a collision, which only this pass may do: it walks a whole replica and may
    // meet versions an earlier pass already delivered.
    const { written } = await recordVersion(c, {
      vaultId: member.vaultId,
      nodeId,
      rev: Number(v.rev),
      sha256: v.sha256,
      size: v.size,
      authorId: v.authorId,
      ifAbsent: true,
    });
    if (written) done.versions++;
  }

  // Catching up is content arriving, so it can put the account straight back over the line —
  // which is the honest outcome, not a failure: they are frozen again, having received what
  // was owed rather than silently losing it.
  await freezeIfOverQuota(c, member.userId);
  return done;
};

/**
 * Catch every share this member is in up to the present.
 *
 * Called when a freeze lifts, and safe to call when nothing is behind: a replica already
 * level with its source produces no writes at all.
 */
export const catchUpMember = async (c: PoolClient, userId: string): Promise<CaughtUp[]> => {
  const shares = await c.query<{ shareId: string; vaultId: string }>(
    `SELECT m.share_id AS "shareId", m.vault_id AS "vaultId"
       FROM share_members m
       JOIN shares s ON s.id = m.share_id
      WHERE m.user_id = $1
        AND ${LIVE}
        AND s.state = 'active'
      ORDER BY m.share_id`,
    [userId],
  );

  const out: CaughtUp[] = [];
  for (const s of shares.rows) {
    if (!s.vaultId) continue;
    out.push(await catchUpShare(c, { userId, vaultId: s.vaultId }, s.shareId));
  }
  return out;
};
