/**
 * History, trash and restore.
 *
 * There is **no separate trash entity**: a deleted node is a row with `deleted_at` whose
 * versions are still alive (invariant 6). The row is not removed because a client with an
 * old cursor must still see the deletion, and because the user must be able to undo it.
 * That one decision is why "the trash" is a query rather than a place.
 */
import type { PoolClient } from 'pg';
import { claimBlob, recordVersion } from '../holdings.js';
import type { RestoreResult } from '@syncserver/shared';
import type { Db } from '../db.js';
import { oneFrom } from '../db.js';
import { ownerAndFrozen } from '../account.js';
import { txGuarded, type Refusal } from '../refusal.js';
import { journalEntry, nextRev } from '../revision.js';

/** The schema's own refusals, returned rather than thrown — see `nodes/service.ts`. */
export type Version = { rev: number; sha256: string; size: number; at: string; author_id: string };

export const listVersions = (db: Db, vaultId: string, nodeId: string): Promise<Version[]> =>
  db.query<Version & { rev: string; size: string }>(
    `SELECT rev::text AS rev, encode(sha256,'hex') AS sha256, size::text AS size, at, author_id
       FROM versions WHERE vault_id = $1 AND node_id = $2 ORDER BY rev DESC`,
    [vaultId, nodeId],
  ).then((rows) => rows.map((r) => ({ ...r, rev: Number(r.rev), size: Number(r.size) })) as unknown as Version[]);

export type TrashEntry = {
  node_id: string;
  parent_id: string | null;
  name_enc: string | null;
  type: string;
  deleted_at: string;
  versions: number;
  /**
   * The scope the name is under. A trashed node of a share is still named under `KS`, so a
   * caller that means to read the name — or to convert it back when leaving — has to know
   * which key to reach for.
   */
  name_key_id: string | null;
  share_id: string | null;
};

/**
 * What can still be brought back: deleted nodes that **still have history**.
 *
 * A node whose versions have all been thinned away is past recovering, and the collector
 * removes it on the next pass; listing it would offer something that cannot be done.
 *
 * **Bounded, and the total comes with it.** The trash grows by itself — every delete lands
 * there and stays until the retention ladder takes its last version, which is a year by
 * default — so an unbounded listing is a listing that eventually decrypts thousands of names
 * to draw thousands of rows. The count is separate rather than inferred from the page,
 * because the one button that acts on the whole trash has to be able to say how much *the
 * whole trash* is; a page length in that sentence would be a lie the moment there was a
 * second page.
 */
export const listTrash = async (
  db: Db,
  vaultId: string,
  under: string | undefined,
  limit: number,
): Promise<{ entries: TrashEntry[]; total: number }> => {
  const total = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM nodes n
      WHERE n.vault_id = $1 AND n.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM versions v WHERE v.vault_id = n.vault_id AND v.node_id = n.id)
        AND ($2::uuid IS NULL OR n.ancestry @> ARRAY[$2::uuid])`,
    [vaultId, under ?? null],
  );
  const entries = await db.query<TrashEntry & { versions: string }>(
    `SELECT n.id AS node_id, n.parent_id, encode(n.name_enc,'base64') AS name_enc,
            n.type::text AS type, n.deleted_at, n.name_key_id, n.share_id,
            (SELECT count(*) FROM versions v WHERE v.vault_id = n.vault_id AND v.node_id = n.id)::text AS versions
       FROM nodes n
      WHERE n.vault_id = $1
        AND n.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM versions v WHERE v.vault_id = n.vault_id AND v.node_id = n.id)
        AND ($2::uuid IS NULL OR n.ancestry @> ARRAY[$2::uuid])
      ORDER BY n.deleted_at DESC
      LIMIT $3`,
    [vaultId, under ?? null, limit],
  );
  return {
    entries: entries.map((r) => ({ ...r, versions: Number(r.versions) })) as unknown as TrashEntry[],
    total: Number(total?.n ?? 0),
  };
};

/** Is a live sibling already using this name under this parent? */
const blockingSibling = async (
  c: PoolClient,
  vaultId: string,
  parentId: string | null,
  nameHmac: Buffer | null,
  self: string,
): Promise<string | undefined> => {
  if (!nameHmac || !parentId) return undefined;
  const r = await c.query<{ id: string }>(
    `SELECT id FROM nodes
      WHERE vault_id = $1 AND parent_id = $2 AND name_hmac = $3 AND deleted_at IS NULL AND id <> $4
      LIMIT 1`,
    [vaultId, parentId, nameHmac, self],
  );
  return r.rows[0]?.id;
};

/**
 * Restore is an **ordinary write** — a put carrying an old hash, which produces a new
 * version rather than rewinding to one. History is append-only in that sense: going back
 * is something that happened, not something that unhappened.
 *
 * It works in groups (#59): restoring a file inside a deleted folder lifts the folder too,
 * because a file whose parent is in the trash is a file the client cannot materialise.
 * Every lifted node gets its own revision and journal entry, so other devices learn about
 * each one rather than inferring it.
 */
export const restoreNode = async (
  db: Db,
  input: { vaultId: string; nodeId: string; rev: number },
): Promise<RestoreResult | Refusal> =>
  // Guarded like the node writes: restore is a write, the schema enforces most of what it
  // may do, and an unhandled `check_violation` leaves as a 500 for something the caller
  // could fix. `nodes` had this and the other two write families did not.
  txGuarded(db, async (c) => {
    const access = await ownerAndFrozen(oneFrom(c), input.vaultId);
    if (access.kind === 'not_found') return { kind: 'not_found' } as Refusal;
    // Restoring brings content back into the live tree, so it grows usage — a frozen
    // account may not (SH-20). Deleting stays available; that is the way out.
    if (access.kind === 'frozen') return { kind: 'frozen' } as Refusal;
    const userId = access.userId;

    const node = await c.query<{ parentId: string | null; nameHmac: Buffer | null; ancestry: string[]; type: string }>(
      `SELECT parent_id AS "parentId", name_hmac AS "nameHmac", ancestry, type::text AS type
         FROM nodes WHERE vault_id = $1 AND id = $2 FOR UPDATE`,
      [input.vaultId, input.nodeId],
    );
    if (node.rowCount === 0) return { kind: 'not_found' } as Refusal;
    const n = node.rows[0]!;

    const version = await c.query<{ sha256: Buffer; size: string }>(
      `SELECT sha256, size::text AS size FROM versions WHERE vault_id = $1 AND node_id = $2 AND rev = $3`,
      [input.vaultId, input.nodeId, input.rev],
    );
    if (version.rowCount === 0) return { kind: 'no_such_version' } as Refusal;

    // The ancestors first, outermost in: a name collision anywhere in the chain stops the
    // whole restore, and finding out after half of it had been lifted would leave the tree
    // in a state nobody asked for.
    const deletedAncestors = await c.query<{ id: string; parentId: string | null; nameHmac: Buffer | null }>(
      `SELECT id, parent_id AS "parentId", name_hmac AS "nameHmac"
         FROM nodes
        WHERE vault_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NOT NULL
        ORDER BY array_length(ancestry, 1)`,
      [input.vaultId, n.ancestry],
    );

    for (const a of deletedAncestors.rows) {
      const blocked = await blockingSibling(c, input.vaultId, a.parentId, a.nameHmac, a.id);
      if (blocked) return { kind: 'name_taken', blockedBy: blocked } as Refusal;
    }
    const blocked = await blockingSibling(c, input.vaultId, n.parentId, n.nameHmac, input.nodeId);
    if (blocked) return { kind: 'name_taken', blockedBy: blocked } as Refusal;

    const lifted: string[] = [];
    for (const a of deletedAncestors.rows) {
      const rev = await nextRev(c, input.vaultId);
      await c.query(`UPDATE nodes SET deleted_at = NULL, rev = $3 WHERE vault_id = $1 AND id = $2`,
        [input.vaultId, a.id, rev]);
      await journalEntry(c, input.vaultId, rev, a.id, 'put');
      lifted.push(a.id);
    }

    const rev = await nextRev(c, input.vaultId);
    const sha = version.rows[0]!.sha256;
    const size = Number(version.rows[0]!.size);

    await c.query(
      `UPDATE nodes SET deleted_at = NULL, sha256 = $3, size = $4, rev = $5, mtime = now()
        WHERE vault_id = $1 AND id = $2`,
      [input.vaultId, input.nodeId, n.type === 'folder' ? null : sha, n.type === 'folder' ? null : size, rev],
    );
    await journalEntry(c, input.vaultId, rev, input.nodeId, 'put');

    if (n.type !== 'folder') {
      // The author is the person restoring, not whoever wrote the version being restored:
      // this revision is a new act, and the old one keeps its own row and its own name.
      await recordVersion(c, {
        vaultId: input.vaultId,
        nodeId: input.nodeId,
        rev,
        sha256: sha.toString('hex'),
        size,
        authorId: userId,
      });
      // The blob was held by the version rows all along, so this claim is not new bytes —
      // but it is a new reference, and it changes in the same transaction as the reference
      // that caused it (invariant 8).
      await claimBlob(c, userId, sha.toString('hex'));
    }

    return { rev, lifted };
  });
