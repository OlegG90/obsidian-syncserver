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
 * authorship (SH-19), so a freeze leaves no hole in the record. They are numbered in the
 * member's own revision sequence, like everything else in that vault — one numbering per
 * vault, so "the latest version" means the same thing there as anywhere (#340).
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
import { claimBlob } from '../holdings.js';
import { counterpartOf, createCounterpart, moveCounterpart } from './replica.js';
import { journalEntry } from '../revision.js';
import { freezeIfOverQuota } from '../quota.js';
import { nextRev } from '../revision.js';
import { LIVE, LIVE_UNFROZEN } from './membership.js';
import { copyVersions } from './materialise.js';

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
  /** Moved or renamed — both are one write, the same one a local move makes. */
  moved: number;
  /** Brought back out of the trash. */
  restored: number;
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

/** One node of the catching-up replica, as the comparison with the source needs it. */
interface ReplicaNode {
  id: string;
  parentShareItemId: string | null;
  nameEnc: string;
  nameHmac: string;
  sha256: string | null;
  deleted: boolean;
}

/**
 * Everything the catching-up vault holds for this share, by the identity both sides share —
 * in the same spelling as `subtreeOf`, so a name or a parent compares as equal bytes.
 */
const replicaIndex = async (c: PoolClient, vaultId: string, shareId: string): Promise<Map<string, ReplicaNode>> => {
  const res = await c.query<ReplicaNode & { shareItemId: string }>(
    `SELECT n.share_item_id AS "shareItemId", n.id,
            p.share_item_id AS "parentShareItemId",
            encode(n.name_enc, 'base64') AS "nameEnc",
            encode(n.name_hmac, 'hex')   AS "nameHmac",
            encode(n.sha256, 'hex') AS sha256, (n.deleted_at IS NOT NULL) AS deleted
       FROM nodes n
       LEFT JOIN nodes p ON p.vault_id = n.vault_id AND p.id = n.parent_id
      WHERE n.vault_id = $1 AND n.share_id = $2
        FOR UPDATE OF n`,
    [vaultId, shareId],
  );
  return new Map(res.rows.map((r) => [r.shareItemId, r]));
};

/** A version the source holds and the catching-up replica does not. */
interface OwedVersion {
  shareItemId: string;
  sha256: string;
  size: number;
  authorId: string;
  at: string;
}

/**
 * The history each item is owed: the source's versions **after the last one this replica
 * already has**, oldest first (#340).
 *
 * "Already has" is the same content written at the same moment. A version that reached this
 * replica by propagation was recorded in the same transaction as the source's, so the two
 * share `now()` exactly; one an earlier catch-up or the join copied carries the source's moment
 * — to the millisecond, because it crossed through a JavaScript `Date` — hence the tolerance.
 * The content alone would not do: a file edited A → B → A has two versions with one hash.
 *
 * **After the last match, not "every one missing".** Retention thins each vault on its own
 * schedule, so either side may lack an old version the other kept. Filling those holes would
 * write old content above the current head — the version history would then call an old
 * version the latest, and retention would spare it as the head (`is_head = max(rev)`).
 */
const historyOwed = async (
  c: PoolClient,
  from: { vaultId: string },
  to: { vaultId: string },
  shareId: string,
  rootItemId: string | undefined,
): Promise<Map<string, OwedVersion[]>> => {
  const res = await c.query<OwedVersion>(
    `WITH theirs AS (
       SELECT n.share_item_id AS item, v.rev, v.sha256, v.size, v.author_id, v.at
         FROM versions v JOIN nodes n ON n.vault_id = v.vault_id AND n.id = v.node_id
        WHERE v.vault_id = $1 AND n.share_id = $3 AND n.share_item_id IS DISTINCT FROM $4
     ), mine AS (
       SELECT n.share_item_id AS item, v.sha256, v.at
         FROM versions v JOIN nodes n ON n.vault_id = v.vault_id AND n.id = v.node_id
        WHERE v.vault_id = $2 AND n.share_id = $3
     ), reached AS (
       SELECT t.item, max(t.rev) AS rev
         FROM theirs t
        WHERE EXISTS (SELECT 1 FROM mine m
                       WHERE m.item = t.item AND m.sha256 = t.sha256
                         AND abs(extract(epoch FROM m.at - t.at)) < 0.001)
        GROUP BY t.item
     )
     SELECT t.item AS "shareItemId", encode(t.sha256, 'hex') AS sha256, t.size,
            t.author_id AS "authorId", t.at::text AS at
       FROM theirs t LEFT JOIN reached r ON r.item = t.item
      WHERE t.rev > coalesce(r.rev, 0)
      ORDER BY t.rev`,
    [from.vaultId, to.vaultId, shareId, rootItemId ?? null],
  );
  const owed = new Map<string, OwedVersion[]>();
  for (const v of res.rows) {
    const list = owed.get(v.shareItemId) ?? [];
    list.push({ ...v, size: Number(v.size) });
    owed.set(v.shareItemId, list);
  }
  return owed;
};

/**
 * Bring one member's replica of one share level with a live copy of it.
 *
 * Returns what changed. A share whose every other member has gone is skipped rather than
 * failed: there is nothing to catch up **from**, and the member's copy is already the only
 * one there is.
 *
 * **Everything a node can go through, not only content** (#337). The source's copy is the
 * final state of the gap, and the replica must end in it: created, deleted, moved, renamed,
 * brought back from the trash. It used to compare content and deletion alone, so a file
 * renamed or moved while this member was frozen kept its old name and place here for good,
 * and one restored from the trash stayed in theirs.
 *
 * **Three passes, because sibling names are unique among live nodes** and a gap can reorder
 * them: a rename into a name another file gave up, a swap of two names, a file deleted and
 * another created under its name. Applied one node at a time in tree order, any of those
 * collides midway although the end state is sound. So deletions go first, then every live
 * node about to move steps aside under a placeholder name, and only then does the walk put
 * each node where the source has it. The placeholder never survives the transaction: a node
 * that stepped aside is always placed again, or trashed under its real name.
 */
export const catchUpShare = async (
  c: PoolClient,
  member: { userId: string; vaultId: string },
  shareId: string,
): Promise<CaughtUp> => {
  const done: CaughtUp = { shareId, created: 0, updated: 0, moved: 0, restored: 0, deleted: 0, versions: 0 };

  const source = await sourceOf(c, shareId, member.vaultId);
  if (!source) return done;

  // The root of each copy is its owner's own (SH-01) and is excluded from the comparison
  // entirely — including from the deletions below, where it would otherwise look like an
  // item the source no longer has.
  const rootItem = await c.query<{ rootItemId: string }>(
    `SELECT root_item_id AS "rootItemId" FROM shares WHERE id = $1`,
    [shareId],
  );
  const rootItemId = rootItem.rows[0]?.rootItemId;

  const mine = await replicaIndex(c, member.vaultId, shareId);
  const theirs = (await subtreeOf(c, source.vaultId, shareId)).filter((n) => n.shareItemId !== rootItemId);
  const owed = await historyOwed(c, source, member, shareId, rootItemId);

  const journal = (rev: number, nodeId: string, op: 'put' | 'del'): Promise<unknown> =>
    journalEntry(c, member.vaultId, rev, nodeId, op);

  // Parent and name are compared as the bytes both copies hold — names inside a share are
  // under `KS`, the same in every copy. The name is compared by ciphertext as well as by
  // HMAC, because a change of case keeps the HMAC (it is over the casefolded name).
  const placedElsewhere = (node: SourceNode, here: ReplicaNode): boolean =>
    here.parentShareItemId !== node.parentShareItemId ||
    here.nameEnc !== node.nameEnc ||
    here.nameHmac !== node.nameHmac;

  // 1. Deleted while this member was away. Soft, exactly as the original was — and first,
  //    so the names they held are free for whatever the source put there since.
  for (const node of theirs) {
    const here = mine.get(node.shareItemId);
    if (!node.deleted || !here || here.deleted) continue;
    const rev = await nextRev(c, member.vaultId);
    await c.query(`UPDATE nodes SET deleted_at = now(), rev = $3 WHERE vault_id = $1 AND id = $2`, [
      member.vaultId,
      here.id,
      rev,
    ]);
    await journal(rev, here.id, 'del');
    here.deleted = true;
    done.deleted++;
  }

  // 2. Every live node about to move or be renamed steps aside, so that no final place is
  //    still occupied when the walk reaches the node that belongs there. Not a revision and
  //    not journalled: pass 3 writes each of these again before the transaction ends.
  for (const node of theirs) {
    const here = mine.get(node.shareItemId);
    if (node.deleted || !here || here.deleted || !placedElsewhere(node, here)) continue;
    await c.query(
      `UPDATE nodes SET name_hmac = sha256(uuid_send(gen_random_uuid())) WHERE vault_id = $1 AND id = $2`,
      [member.vaultId, here.id],
    );
  }

  // 3. Parents before children, each node to where the source has it, with its history.
  for (const node of theirs) {
    const here = mine.get(node.shareItemId);
    if (!here && node.deleted) continue; // created and deleted inside the gap: nothing to deliver

    // Its parent here, asked fresh rather than remembered: a move earlier in this walk may
    // have changed the chain above it. The trash counts, because a deletion marks one node
    // and not its subtree — the source can hold a live node under a deleted folder, and this
    // copy has to hold it the same way.
    const placing = !node.deleted && (!here || here.deleted || placedElsewhere(node, here));
    const parent = placing
      ? await counterpartOf(c, member.vaultId, node.parentShareItemId!, { includeDeleted: true })
      : undefined;
    if (placing && !parent) {
      // Its folder never reached this copy: it was created and deleted inside the gap, so
      // from the source this node is inside the trash. Not delivered if it is new; trashed if
      // it was already here — under its real name, not the placeholder it stepped aside under.
      if (here && !here.deleted) {
        const rev = await nextRev(c, member.vaultId);
        await c.query(
          `UPDATE nodes SET deleted_at = now(), rev = $3, name_enc = decode($4,'base64'),
                            name_hmac = decode($5,'hex'), name_key_id = $6
            WHERE vault_id = $1 AND id = $2`,
          [member.vaultId, here.id, rev, node.nameEnc, node.nameHmac, node.nameKeyId],
        );
        await journal(rev, here.id, 'del');
        done.deleted++;
      }
      continue;
    }

    // The history owed, and whether its newest version is the content arriving now. That one
    // takes the revision of the write that delivers it; the rest take revisions reserved
    // BEFORE that write — so the head is the highest revision, as a join leaves it, and the
    // journal entry names the version it wrote (#340).
    const history = owed.get(node.shareItemId) ?? [];
    const arriving = !node.deleted && node.sha256 !== null && here?.sha256 !== node.sha256;
    const head = arriving && history.at(-1)?.sha256 === node.sha256 ? history.at(-1) : undefined;
    const past = head ? history.slice(0, -1) : history;
    const pastRevs: number[] = [];
    for (let i = 0; i < past.length; i++) pastRevs.push(await nextRev(c, member.vaultId));

    let nodeId: string;
    let headRev: number | undefined;
    if (!here) {
      // Created while this member was frozen, so propagation skipped them. The same write
      // propagation makes, for a different reason: it delivers an event, this delivers a gap.
      const { node: written, rev } = await createCounterpart(
        c,
        { vaultId: member.vaultId, shareId, parent: parent! },
        node,
      );
      nodeId = written.id;
      headRev = rev;
      done.created++;
    } else {
      nodeId = here.id;
      if (placing && placedElsewhere(node, here)) {
        // Moved or renamed while this member was away — and possibly brought back from the
        // trash too, which has to be the same write (see `moveCounterpart`).
        await moveCounterpart(c, member.vaultId, here.id, parent!, node, { undelete: here.deleted });
        done.moved++;
        if (here.deleted) done.restored++;
      } else if (placing) {
        // Brought back from the trash where it was. Its place is free: pass 2 cleared it.
        const rev = await nextRev(c, member.vaultId);
        await c.query(`UPDATE nodes SET deleted_at = NULL, rev = $3 WHERE vault_id = $1 AND id = $2`, [
          member.vaultId,
          here.id,
          rev,
        ]);
        await journal(rev, here.id, 'put');
        done.restored++;
      }

      if (arriving) {
        const rev = await nextRev(c, member.vaultId);
        await c.query(
          `UPDATE nodes SET sha256 = decode($3,'hex'), size = $4, mtime = $5, rev = $6
            WHERE vault_id = $1 AND id = $2`,
          [member.vaultId, here.id, node.sha256, node.size, node.mtime, rev],
        );
        await journal(rev, here.id, 'put');
        headRev = rev;
        done.updated++;
      }
    }

    // The history of the gap, which is the half that makes this a catch-up rather than a
    // re-copy: the versions this replica lacks, keeping the author each was written by
    // (SH-19) and the moment (SH-23), numbered in this vault's own sequence. Every version
    // row is one claim on its blob, the head's included — the node's reference to it is the
    // head version, not a second claim.
    done.versions += await copyVersions(c, {
      vaultId: member.vaultId,
      userId: member.userId,
      versions: [
        ...past.map((v, i) => ({ ...v, targetNodeId: nodeId, rev: pastRevs[i]! })),
        ...(head && headRev !== undefined ? [{ ...head, targetNodeId: nodeId, rev: headRev }] : []),
      ],
    });
    // Content that arrived with no version behind it cannot happen — a source's head is
    // always a version — but a node pointing at bytes its account never claimed would be
    // exactly the leak a claim exists to prevent.
    if (arriving && !head) await claimBlob(c, member.userId, node.sha256!);
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
    out.push(await catchUpShare(c, { userId, vaultId: s.vaultId }, s.shareId));
  }
  return out;
};
