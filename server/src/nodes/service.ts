/**
 * Node writes: the one place a revision is born.
 *
 * Every write is **node + journal + version in one transaction** (#14), together with the
 * client-produced key material the node needs to be openable. All of it commits or none
 * does — a node without its envelope is a file nobody can decrypt, and a journal that
 * disagrees with the tree is a client that syncs the wrong thing for ever.
 *
 * Revision allocation is a call rather than a trigger on purpose — see `revision.ts`, which
 * is the only place it happens. Keeping it explicit is what makes the three-way write one
 * visible unit; a trigger would scatter the same fact across rows nobody reads together.
 */
import type { PoolClient } from 'pg';
import { bindBlob, recordVersion } from '../holdings.js';
import type { Db } from '../db.js';
import { oneFrom } from '../db.js';
import { ownerAndFrozen } from '../account.js';
import { txGuarded, type Refusal } from '../refusal.js';
import { randomUUID } from 'node:crypto';
import { writeMaterial, type Material } from '../material.js';
import { fanOut } from '../shares/propagate.js';
import { journalEntry, nextRev } from '../revision.js';

/**
 * Which of these content tags the vault's own key scope already knows, and what address
 * each currently maps to.
 *
 * This is what makes adoption "nearly free" (docs/07): before sealing and uploading a file —
 * or before accepting the server's copy of one that collides with it on a path — the client
 * asks whether this exact plaintext is already known in its own scope. If it is, a node can
 * be bound to the existing address with no fresh envelope or tag: `nodes_check_private_material`
 * checks only that the rows EXIST for (address, scope), not who wrote them or when.
 *
 * The authorisation here is deliberately NOT "the caller already holds a live reference" —
 * that would defeat the lookup's whole purpose, which is to find out BEFORE holding one. It
 * is vault ownership instead. A tag is `HMAC(scope key, sha256(plaintext))` (docs/06), so
 * only a holder of this vault's `KV` could ever have produced the tags sitting in its own
 * scope — querying them back is self-consistent, not a new oracle into anyone else's data.
 *
 * **Batched, by tag list**, for the reason `blob-keys` is: adoption compares every file in
 * the vault at once, and one request per file would make a large migration crawl.
 */
export const dedupLookup = async (
  db: Db,
  userId: string,
  vaultId: string,
  tags: Buffer[],
): Promise<{ contentTag: string; sha256: string }[]> =>
  db.query<{ contentTag: string; sha256: string }>(
    `SELECT encode(d.content_tag, 'hex') AS "contentTag",
            encode(d.sha256, 'hex')      AS sha256
       FROM dedup_index d
       JOIN vaults v ON v.id = $2 AND v.user_id = $1
      WHERE d.scope_id = v.vault_key_id
        AND d.content_tag = ANY($3::bytea[])`,
    [userId, vaultId, tags],
  );

const fail = (kind: Refusal['kind']): Refusal => ({ kind }) as Refusal;

export interface CreateInput {
  vaultId: string;
  parentId: string;
  type: 'file' | 'folder';
  sha256?: string | undefined;
  size?: number | undefined;
  mtime: string;
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
  material: Material;
}

export const createNode = async (db: Db, input: CreateInput): Promise<{ nodeId: string; rev: number } | Refusal> =>
  txGuarded(db, async (c) => {
    const access = await ownerAndFrozen(oneFrom(c), input.vaultId);
    if (access.kind === 'not_found') return fail('not_found');
    if (access.kind === 'frozen') return fail('frozen');
    const owner = access.userId;

    const parent = await c.query<{ ancestry: string[]; shareId: string | null; shareItemId: string | null }>(
      `SELECT ancestry, share_id AS "shareId", share_item_id AS "shareItemId"
         FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.vaultId, input.parentId],
    );
    if (parent.rowCount === 0) return fail('not_found');
    const into = parent.rows[0]!;

    // A node inside a shared folder must carry a mark of its own — the schema refuses one
    // that does not (SH-26) — and the item id it gets here is the identity every other
    // replica will know it by.
    const shareItemId = into.shareId ? randomUUID() : null;

    // Material first: the node's own trigger checks for it, and putting it after would
    // make the order of two statements decide whether a legal write succeeds.
    await writeMaterial(c, input.material);

    const rev = await nextRev(c, input.vaultId);
    const ancestry = [...parent.rows[0]!.ancestry, input.parentId];

    const node = await c.query<{ id: string }>(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type,
                          sha256, size, mtime, rev, ancestry, share_id, share_item_id)
       VALUES ($1, $2, decode($3,'base64'), decode($4,'hex'), $5, $6,
               CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7,'hex') END, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        input.vaultId, input.parentId, input.nameEnc, input.nameHmac, input.nameKeyId, input.type,
        input.sha256 ?? null, input.size ?? null, input.mtime, rev, ancestry,
        into.shareId, shareItemId,
      ],
    );
    const nodeId = node.rows[0]!.id;

    await journalEntry(c, input.vaultId, rev, nodeId, 'put');

    if (input.sha256) {
      // The route refuses content without a size, so this is a defect on this side rather
      // than a bad request — and it says so loudly instead of skipping the version row,
      // which would leave a node pointing at bytes with no history and no claim.
      if (input.size === undefined) throw new Error('a node with content must have a size');
      await recordVersion(c, {
        vaultId: input.vaultId,
        nodeId,
        rev,
        sha256: input.sha256,
        size: input.size,
        authorId: owner,
      });
      await bindBlob(c, owner, input.sha256);
    }

    await fanOut(c, {
      kind: 'create',
      vaultId: input.vaultId,
      shareId: into.shareId,
      shareItemId,
      parentShareItemId: into.shareItemId,
      type: input.type,
      nameEnc: input.nameEnc,
      nameHmac: input.nameHmac,
      nameKeyId: input.nameKeyId,
      sha256: input.sha256 ?? null,
      size: input.size ?? null,
      mtime: input.mtime,
      authorId: owner,
    });

    return { nodeId, rev };
  });

/**
 * The precondition for a content write is **content**, not a revision number (#52).
 *
 * `nodes.rev` moves on any operation, `move` included, so using it here would turn the
 * everyday "renamed on the desktop, edited on the phone" into a conflict between two
 * changes that do not overlap at all.
 */
export const putContent = async (
  db: Db,
  input: { vaultId: string; nodeId: string; sha256: string; size: number; mtime: string; baseSha256: string | null; material: Material },
): Promise<{ rev: number } | Refusal> =>
  txGuarded(db, async (c) => {
    const access = await ownerAndFrozen(oneFrom(c), input.vaultId);
    if (access.kind === 'not_found') return fail('not_found');
    if (access.kind === 'frozen') return fail('frozen');
    const owner = access.userId;

    const cur = await c.query<{
      sha256: Buffer | null; rev: string; type: string; shareId: string | null; shareItemId: string | null;
    }>(
      `SELECT sha256, rev::text AS rev, type, share_id AS "shareId", share_item_id AS "shareItemId"
         FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.vaultId, input.nodeId],
    );
    const row = cur.rows[0];
    if (!row || row.type !== 'file') return fail('not_found');

    const currentHex = row.sha256 ? row.sha256.toString('hex') : null;
    if (currentHex !== input.baseSha256) {
      return { kind: 'base_mismatch', currentSha256: currentHex, rev: Number(row.rev) };
    }

    await writeMaterial(c, input.material);
    const rev = await nextRev(c, input.vaultId);

    await c.query(
      `UPDATE nodes SET sha256 = decode($3,'hex'), size = $4, mtime = $5, rev = $6
        WHERE vault_id = $1 AND id = $2`,
      [input.vaultId, input.nodeId, input.sha256, input.size, input.mtime, rev],
    );
    await journalEntry(c, input.vaultId, rev, input.nodeId, 'put');
    await recordVersion(c, {
      vaultId: input.vaultId,
      nodeId: input.nodeId,
      rev,
      sha256: input.sha256,
      size: input.size,
      authorId: owner,
    });

    await bindBlob(c, owner, input.sha256);
    // The previous content keeps its claim through the version row that still names it;
    // only history thinning releases that (docs/03, retention).

    await fanOut(c, {
      kind: 'put',
      vaultId: input.vaultId,
      shareId: row.shareId,
      shareItemId: row.shareItemId,
      sha256: input.sha256,
      size: input.size,
      mtime: input.mtime,
      authorId: owner,
    });

    return { rev };
  });

/**
 * Soft delete: the row **is** the trash entry.
 *
 * It is not removed, because a client with an old cursor must still see the deletion and
 * the user must be able to restore the file. The row lives as long as one of its versions
 * does (invariant 6).
 */
export const deleteNode = async (
  db: Db,
  input: { vaultId: string; nodeId: string; ifMatchRev: number },
): Promise<{ rev: number } | Refusal> =>
  txGuarded(db, async (c) => {
    const access = await ownerAndFrozen(oneFrom(c), input.vaultId);
    if (access.kind === 'not_found') return fail('not_found');

    const cur = await c.query<{ rev: string; shareId: string | null; shareItemId: string | null }>(
      `SELECT rev::text AS rev, share_id AS "shareId", share_item_id AS "shareItemId"
         FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.vaultId, input.nodeId],
    );
    const row = cur.rows[0];
    if (!row) return fail('not_found');
    if (Number(row.rev) !== input.ifMatchRev) return { kind: 'rev_mismatch', rev: Number(row.rev) };

    // Deleting stays available to a frozen account: it is the only way out of over-quota,
    // so a freeze that blocked it would be a deadlock (SH-20).
    const rev = await nextRev(c, input.vaultId);
    await c.query(
      `UPDATE nodes SET deleted_at = now(), rev = $3 WHERE vault_id = $1 AND id = $2`,
      [input.vaultId, input.nodeId, rev],
    );
    await journalEntry(c, input.vaultId, rev, input.nodeId, 'del');

    await fanOut(c, {
      kind: 'delete',
      vaultId: input.vaultId,
      shareId: row.shareId,
      shareItemId: row.shareItemId,
    });

    return { rev };
  });

/**
 * `move` changes placement, so **here** the revision is the right precondition: the subject
 * of the operation really is where the node sits.
 *
 * It rewrites `ancestry` for the whole subtree in the same transaction. A move that
 * updated only the moved node would leave its descendants claiming to live under their old
 * parent, and what that produces is not a broken listing but a subtree still inside a
 * folder it was moved out of.
 */
export const moveNode = async (
  db: Db,
  input: { vaultId: string; nodeId: string; parentId: string; nameEnc: string; nameHmac: string; nameKeyId: string; ifMatchRev: number },
): Promise<{ rev: number } | Refusal> =>
  txGuarded(db, async (c) => {
    const access = await ownerAndFrozen(oneFrom(c), input.vaultId);
    if (access.kind === 'not_found') return fail('not_found');
    if (access.kind === 'frozen') return fail('frozen');

    const cur = await c.query<{
      rev: string; parentId: string | null; ancestry: string[]; shareId: string | null; shareItemId: string | null;
    }>(
      `SELECT rev::text AS rev, parent_id AS "parentId", ancestry, share_id AS "shareId",
              share_item_id AS "shareItemId"
         FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.vaultId, input.nodeId],
    );
    const row = cur.rows[0];
    if (!row) return fail('not_found');
    if (Number(row.rev) !== input.ifMatchRev) return { kind: 'rev_mismatch', rev: Number(row.rev) };

    const dest = await c.query<{ ancestry: string[]; shareId: string | null; shareItemId: string | null }>(
      `SELECT ancestry, share_id AS "shareId", share_item_id AS "shareItemId" FROM nodes
        WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.vaultId, input.parentId],
    );
    if (dest.rowCount === 0) return fail('not_found');

    // A move may not enter or leave a shared folder: the two sides are different key
    // scopes, and a tree move must not quietly create half the cryptographic metadata.
    // The client copies into the destination scope and deletes the source instead.
    if ((row.shareId ?? null) !== (dest.rows[0]!.shareId ?? null)) return fail('share_boundary');

    const rev = await nextRev(c, input.vaultId);
    const newAncestry = [...dest.rows[0]!.ancestry, input.parentId];

    await c.query(
      `UPDATE nodes SET parent_id = $3, name_enc = decode($4,'base64'), name_hmac = decode($5,'hex'),
                        name_key_id = $6, rev = $7, ancestry = $8
        WHERE vault_id = $1 AND id = $2`,
      [input.vaultId, input.nodeId, input.parentId, input.nameEnc, input.nameHmac, input.nameKeyId, rev, newAncestry],
    );

    // The subtree follows in the same statement: everything that had the moved node in its
    // ancestry keeps the part below it and takes the new chain above.
    await c.query(
      `UPDATE nodes
          SET ancestry = $3::uuid[] || $2::uuid ||
                         ancestry[array_position(ancestry, $2::uuid) + 1 : array_length(ancestry, 1)]
        WHERE vault_id = $1 AND ancestry @> ARRAY[$2::uuid]`,
      [input.vaultId, input.nodeId, newAncestry],
    );

    await journalEntry(c, input.vaultId, rev, input.nodeId, 'move', row.parentId);

    await fanOut(c, {
      kind: 'move',
      vaultId: input.vaultId,
      shareId: row.shareId,
      shareItemId: row.shareItemId,
      parentShareItemId: dest.rows[0]!.shareItemId,
      nameEnc: input.nameEnc,
      nameHmac: input.nameHmac,
      nameKeyId: input.nameKeyId,
    });

    return { rev };
  });
