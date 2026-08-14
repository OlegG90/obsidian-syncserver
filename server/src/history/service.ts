/**
 * History, trash and restore.
 *
 * There is **no separate trash entity**: a deleted node is a row with `deleted_at` whose
 * versions are still alive (invariant 6). The row is not removed because a client with an
 * old cursor must still see the deletion, and because the user must be able to undo it.
 * That one decision is why "the trash" is a query rather than a place.
 */
import type { PoolClient } from 'pg';
import type { RestoreResult } from '@syncserver/shared';
import type { Db } from '../db.js';
import { oneFrom } from '../db.js';
import { ownerAndFrozen } from '../account.js';
import { refusalFromDatabase, type Refusal } from '../refusal.js';
import { nextRev } from '../revision.js';

/** The schema's own refusals, returned rather than thrown — see `nodes/service.ts`. */
const txGuarded = async <T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T | Refusal> => {
  try {
    return await db.tx(fn);
  } catch (e) {
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};

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
};

/**
 * What can still be brought back: deleted nodes that **still have history**.
 *
 * A node whose versions have all been thinned away is past recovering, and the collector
 * removes it on the next pass; listing it would offer something that cannot be done.
 */
export const listTrash = (db: Db, vaultId: string, under: string | undefined): Promise<TrashEntry[]> =>
  db.query<TrashEntry & { versions: string }>(
    `SELECT n.id AS node_id, n.parent_id, encode(n.name_enc,'base64') AS name_enc,
            n.type::text AS type, n.deleted_at,
            (SELECT count(*) FROM versions v WHERE v.vault_id = n.vault_id AND v.node_id = n.id)::text AS versions
       FROM nodes n
      WHERE n.vault_id = $1
        AND n.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM versions v WHERE v.vault_id = n.vault_id AND v.node_id = n.id)
        AND ($2::uuid IS NULL OR n.ancestry @> ARRAY[$2::uuid])
      ORDER BY n.deleted_at DESC`,
    [vaultId, under ?? null],
  ).then((rows) => rows.map((r) => ({ ...r, versions: Number(r.versions) })) as unknown as TrashEntry[]);

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
      await c.query(`INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, $2, $3, 'put', $2)`,
        [input.vaultId, rev, a.id]);
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
    await c.query(`INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, $2, $3, 'put', $2)`,
      [input.vaultId, rev, input.nodeId]);

    if (n.type !== 'folder') {
      await c.query(
        `INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [input.vaultId, input.nodeId, rev, sha, size, userId],
      );
      // The blob was held by the version rows all along, so this claim is not new bytes —
      // but it is a new reference, and it changes in the same transaction as the reference
      // that caused it (invariant 8).
      await c.query(
        `INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, sha256) DO UPDATE SET refs_own = user_blobs.refs_own + 1`,
        [userId, sha],
      );
    }

    return { rev, lifted };
  });
