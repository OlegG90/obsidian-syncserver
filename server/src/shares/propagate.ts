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
 * **One interface, not four.** The write path describes what happened to one node and hands
 * it over; deciding whether that fans out, to whom, and in which shape is this
 * module's alone. It used to be four guards and four `fanoutTargets` calls spread across
 * `nodes/service.ts`, each restating by hand what a write must be for it to travel — and the
 * four disagreed in shape even where they agreed in intent.
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
import { counterpartOf, createCounterpart, moveCounterpart } from './replica.js';
import { journalEntry } from '../revision.js';
import { freezeIfOverQuota } from '../quota.js';
import { nextRev } from '../revision.js';
import { LIVE_UNFROZEN } from './membership.js';

/** A participant a write must reach: their account, and the vault their replica lives in. */
interface Target {
  userId: string;
  vaultId: string;
}

/**
 * What happened to one node, in a spelling the write path already holds.
 *
 * Every variant carries the share identity the guard needs, nullable because the same write
 * function serves shared and private folders alike — `fanOut` reads the nulls and answers
 * "nothing to fan out" when a write did not happen inside a share. The vault it happened in
 * travels too, because it is the one member the fan-out set must exclude.
 */
export type FanoutEvent =
  | {
      kind: 'create';
      vaultId: string;
      shareId: string | null;
      shareItemId: string | null;
      parentShareItemId: string | null;
      type: string;
      nameEnc: string;
      nameHmac: string;
      nameKeyId: string;
      sha256: string | null;
      size: number | null;
      mtime: string;
      authorId: string;
    }
  | {
      kind: 'put';
      vaultId: string;
      shareId: string | null;
      shareItemId: string | null;
      sha256: string;
      size: number;
      mtime: string;
      authorId: string;
    }
  | { kind: 'delete'; vaultId: string; shareId: string | null; shareItemId: string | null }
  | { kind: 'undelete'; vaultId: string; shareId: string | null; shareItemId: string | null }
  | {
      kind: 'move';
      vaultId: string;
      shareId: string | null;
      shareItemId: string | null;
      parentShareItemId: string | null;
      nameEnc: string;
      nameHmac: string;
      nameKeyId: string;
    };

/**
 * Fan a node write out to every other participant's copy.
 *
 * The one place the guard, the set, and the shape are decided. A write outside any share
 * fans out to nobody; the targets are computed here at execution time rather than
 * remembered (docs/04); and which shape applies falls out of the event.
 *
 * **Nothing here can throw for a reason the write path should absorb.** A replica that
 * lacks the item is skipped, because it can only mean the item was created while that
 * member was frozen and their catch-up is what repairs it — failing on one lagging copy
 * would block everybody's writes. A replica that *fails to accept* the write is the
 * atomicity contract: it propagates up and rolls the original write back with it.
 */
export const fanOut = async (c: PoolClient, event: FanoutEvent): Promise<void> => {
  // The guard, once. A create and a move additionally need the parent's item id — the
  // destination of the move, the containing folder of the create.
  if (!event.shareId || !event.shareItemId) return;
  if ((event.kind === 'create' || event.kind === 'move') && !event.parentShareItemId) return;

  const targets = await fanoutTargets(c, event.shareId, event.vaultId);
  switch (event.kind) {
    case 'create':
      // The guard above established the three identities; the internal shape needs them
      // as facts, so they are re-asserted here rather than re-checked in every loop body.
      await propagateCreate(c, targets, { ...event, shareId: event.shareId!, shareItemId: event.shareItemId!, parentShareItemId: event.parentShareItemId! });
      break;
    case 'put':
      await propagatePut(c, targets, { ...event, shareId: event.shareId!, shareItemId: event.shareItemId! });
      break;
    case 'delete':
      await propagateDelete(c, targets, event.shareItemId!);
      break;
    case 'undelete':
      await propagateUndelete(c, targets, event.shareItemId!);
      break;
    case 'move':
      await propagateMove(c, targets, { ...event, shareId: event.shareId!, shareItemId: event.shareItemId!, parentShareItemId: event.parentShareItemId! });
      break;
    default: {
      // A kind added to the union and not here is a compile error rather than a write that
      // silently reaches nobody — which is how a restore went unshared (#336).
      const unhandled: never = event;
      throw new Error(`fan-out has no shape for ${(unhandled as { kind: string }).kind}`);
    }
  }
};

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
const fanoutTargets = async (c: PoolClient, shareId: string, exceptVaultId: string): Promise<Target[]> => {
  const res = await c.query<{ userId: string; vaultId: string }>(
    `SELECT m.user_id AS "userId", m.vault_id AS "vaultId"
       FROM share_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.share_id = $1
        AND ${LIVE_UNFROZEN}
        AND m.vault_id <> $2
      ORDER BY m.user_id
        FOR UPDATE OF m`,
    [shareId, exceptVaultId],
  );
  return res.rows;
};

/** New content for an item that exists in every replica. */
type PutItem = Extract<FanoutEvent, { kind: 'put' }> & { shareId: string; shareItemId: string };
const propagatePut = async (c: PoolClient, targets: Target[], item: PutItem): Promise<void> => {
  for (const t of targets) {
    const node = await counterpartOf(c, t.vaultId, item.shareItemId);
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
    await journalEntry(c, t.vaultId, rev, node.id, 'put');
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
type CreateItem = Extract<FanoutEvent, { kind: 'create' }> & { shareId: string; shareItemId: string; parentShareItemId: string };
const propagateCreate = async (c: PoolClient, targets: Target[], item: CreateItem): Promise<void> => {
  for (const t of targets) {
    const parent = await counterpartOf(c, t.vaultId, item.parentShareItemId);
    if (!parent) continue;

    const { node, rev } = await createCounterpart(c, { vaultId: t.vaultId, shareId: item.shareId, parent }, item);
    const nodeId = node.id;

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
const propagateDelete = async (c: PoolClient, targets: Target[], shareItemId: string): Promise<void> => {
  for (const t of targets) {
    const node = await counterpartOf(c, t.vaultId, shareItemId);
    if (!node) continue;

    const rev = await nextRev(c, t.vaultId);
    await c.query(`UPDATE nodes SET deleted_at = now(), rev = $3 WHERE vault_id = $1 AND id = $2`, [
      t.vaultId,
      node.id,
      rev,
    ]);
    await journalEntry(c, t.vaultId, rev, node.id, 'del');
  }
};

/**
 * A move **within** the share. Crossing its boundary is refused before this is reached: the
 * two sides are different key scopes, and a tree move must not quietly produce half the
 * cryptographic metadata.
 */
type MoveItem = Extract<FanoutEvent, { kind: 'move' }> & { shareId: string; shareItemId: string; parentShareItemId: string };
const propagateMove = async (c: PoolClient, targets: Target[], item: MoveItem): Promise<void> => {
  for (const t of targets) {
    const node = await counterpartOf(c, t.vaultId, item.shareItemId);
    const parent = await counterpartOf(c, t.vaultId, item.parentShareItemId);
    if (!node || !parent) continue;
    await moveCounterpart(c, t.vaultId, node.id, parent, item);
  }
};

/**
 * A node brought back out of the trash (#336): by a restore of the node itself, or lifted as
 * the deleted ancestor of one.
 *
 * Only the deletion is undone here. A restored file's content travels separately, as the
 * ordinary put it is (docs/04: "a new put with an old hash"), which reaches only live copies
 * — so this has to come first, or the put would find nothing to write to.
 */
const propagateUndelete = async (c: PoolClient, targets: Target[], shareItemId: string): Promise<void> => {
  for (const t of targets) {
    // Only a copy that is in the trash. One already live has nothing to lift, and a revision
    // it did not need is a change every one of that member's devices would come and fetch.
    const trashed = await c.query<{ id: string }>(
      `SELECT id FROM nodes
        WHERE vault_id = $1 AND share_item_id = $2 AND deleted_at IS NOT NULL
          FOR UPDATE`,
      [t.vaultId, shareItemId],
    );
    const node = trashed.rows[0];
    if (!node) continue;

    const rev = await nextRev(c, t.vaultId);
    await c.query(`UPDATE nodes SET deleted_at = NULL, rev = $3 WHERE vault_id = $1 AND id = $2`, [
      t.vaultId,
      node.id,
      rev,
    ]);
    await journalEntry(c, t.vaultId, rev, node.id, 'put');
  }
};
