/**
 * Node writes: the one place a revision is born.
 *
 * Every write is **node + journal + version in one transaction** (#14), together with the
 * client-produced key material the node needs to be openable. All of it commits or none
 * does — a node without its envelope is a file nobody can decrypt, and a journal that
 * disagrees with the tree is a client that syncs the wrong thing for ever.
 *
 * Revision allocation lives here rather than in a trigger on purpose: `head_rev` is bumped
 * under `SELECT … FOR UPDATE` inside this transaction, so the three-way write stays one
 * explicit unit.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';

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

export interface Material {
  /** `blob_keys`: the content key wrapped for a scope allowed to read it. */
  envelopes: { sha256: string; scopeId: string; wrappedKey: string }[];
  /** `dedup_index`: HMAC(scope key, plaintext hash) → address. */
  dedupTags: { sha256: string; scopeId: string; contentTag: string }[];
}

export type WriteFailure =
  | { kind: 'not_found' }
  | { kind: 'base_mismatch'; currentSha256: string | null; rev: number }
  | { kind: 'rev_mismatch'; rev: number }
  | { kind: 'share_boundary' }
  | { kind: 'frozen' }
  | { kind: 'over_quota' };

const fail = (kind: WriteFailure['kind']): WriteFailure => ({ kind }) as WriteFailure;

/** One integer per vault, allocated under a row lock so two writers cannot take the same. */
const nextRev = async (c: PoolClient, vaultId: string): Promise<number> => {
  const r = await c.query<{ head: string }>(
    `UPDATE vaults SET head_rev = head_rev + 1 WHERE id = $1 RETURNING head_rev::text AS head`,
    [vaultId],
  );
  return Number(r.rows[0]!.head);
};

const writeMaterial = async (c: PoolClient, m: Material): Promise<void> => {
  for (const e of m.envelopes) {
    await c.query(
      `INSERT INTO blob_keys (sha256, scope_id, wrapped_key) VALUES (decode($1,'hex'), $2, decode($3,'base64'))
       ON CONFLICT (sha256, scope_id) DO NOTHING`,
      [e.sha256, e.scopeId, e.wrappedKey],
    );
  }
  for (const t of m.dedupTags) {
    // `DO UPDATE`, not `DO NOTHING`, and the difference is a 500 the client cannot avoid.
    //
    // The tag names the PLAINTEXT — `HMAC(scope key, sha256(plaintext))` — while the address
    // names one encryption of it. `KC` is random, so sealing the same file twice yields the
    // same tag and a NEW address. `DO NOTHING` then leaves the tag pointing at the old
    // address, and `nodes_check_private_material` refuses the write because the new one has
    // no tag: the caller sent correct material and is told the material is missing.
    //
    // Repointing is the right resolution rather than a workaround. Both addresses decrypt to
    // the same plaintext, so either is a truthful answer to "where is this content"; the
    // newest is the one a node is about to reference, and the older is left for the
    // collector once nothing holds it.
    await c.query(
      `INSERT INTO dedup_index (scope_id, content_tag, sha256) VALUES ($1, decode($2,'hex'), decode($3,'hex'))
       ON CONFLICT (scope_id, content_tag) DO UPDATE SET sha256 = EXCLUDED.sha256`,
      [t.scopeId, t.contentTag, t.sha256],
    );
  }
};

/**
 * Binding a blob to a node moves the account's claim from pending to owned, in the same
 * transaction as the reference that caused it (invariant 8). There is no lazy half of the
 * accounting: a counter reconciled later is a counter that is wrong in between.
 */
const bindBlob = async (c: PoolClient, userId: string, sha256Hex: string): Promise<void> => {
  await c.query(
    `INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, decode($2,'hex'), 1)
     ON CONFLICT (user_id, sha256) DO UPDATE
        SET refs_own = user_blobs.refs_own + 1,
            refs_pending = GREATEST(user_blobs.refs_pending - 1, 0),
            pending_since = CASE WHEN GREATEST(user_blobs.refs_pending - 1, 0) = 0 THEN NULL
                                 ELSE user_blobs.pending_since END`,
    [userId, sha256Hex],
  );
};

const releaseBlob = async (c: PoolClient, userId: string, sha256Hex: string): Promise<void> => {
  // The row must not survive at zero — `row_must_be_referenced` forbids it, and a row that
  // claimed nothing would still be counted by the quota sum.
  await c.query(
    `UPDATE user_blobs SET refs_own = GREATEST(refs_own - 1, 0)
      WHERE user_id = $1 AND sha256 = decode($2,'hex')`,
    [userId, sha256Hex],
  );
  await c.query(
    `DELETE FROM user_blobs WHERE user_id = $1 AND sha256 = decode($2,'hex')
       AND refs_own = 0 AND refs_pending = 0`,
    [userId, sha256Hex],
  );
};

const ownerOf = async (c: PoolClient, vaultId: string): Promise<string | undefined> => {
  const r = await c.query<{ userId: string }>(`SELECT user_id AS "userId" FROM vaults WHERE id = $1`, [vaultId]);
  return r.rows[0]?.userId;
};

const isFrozen = async (c: PoolClient, userId: string): Promise<boolean> => {
  const r = await c.query<{ frozen: boolean }>(
    `SELECT frozen_at IS NOT NULL AS frozen FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0]?.frozen ?? false;
};

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

export const createNode = async (db: Db, input: CreateInput): Promise<{ nodeId: string; rev: number } | WriteFailure> =>
  db.tx(async (c) => {
    const owner = await ownerOf(c, input.vaultId);
    if (!owner) return fail('not_found');
    if (await isFrozen(c, owner)) return fail('frozen');

    const parent = await c.query<{ ancestry: string[] }>(
      `SELECT ancestry FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.vaultId, input.parentId],
    );
    if (parent.rowCount === 0) return fail('not_found');

    // Material first: the node's own trigger checks for it, and putting it after would
    // make the order of two statements decide whether a legal write succeeds.
    await writeMaterial(c, input.material);

    const rev = await nextRev(c, input.vaultId);
    const ancestry = [...parent.rows[0]!.ancestry, input.parentId];

    const node = await c.query<{ id: string }>(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type,
                          sha256, size, mtime, rev, ancestry)
       VALUES ($1, $2, decode($3,'base64'), decode($4,'hex'), $5, $6,
               CASE WHEN $7::text IS NULL THEN NULL ELSE decode($7,'hex') END, $8, $9, $10, $11)
       RETURNING id`,
      [
        input.vaultId, input.parentId, input.nameEnc, input.nameHmac, input.nameKeyId, input.type,
        input.sha256 ?? null, input.size ?? null, input.mtime, rev, ancestry,
      ],
    );
    const nodeId = node.rows[0]!.id;

    await c.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, $2, $3, 'put', $2)`,
      [input.vaultId, rev, nodeId],
    );

    if (input.sha256) {
      await c.query(
        `INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
         VALUES ($1, $2, $3, decode($4,'hex'), $5, $6)`,
        [input.vaultId, nodeId, rev, input.sha256, input.size, owner],
      );
      await bindBlob(c, owner, input.sha256);
    }

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
): Promise<{ rev: number } | WriteFailure> =>
  db.tx(async (c) => {
    const owner = await ownerOf(c, input.vaultId);
    if (!owner) return fail('not_found');
    if (await isFrozen(c, owner)) return fail('frozen');

    const cur = await c.query<{ sha256: Buffer | null; rev: string; type: string }>(
      `SELECT sha256, rev::text AS rev, type FROM nodes
        WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
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
    await c.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, $2, $3, 'put', $2)`,
      [input.vaultId, rev, input.nodeId],
    );
    await c.query(
      `INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id)
       VALUES ($1, $2, $3, decode($4,'hex'), $5, $6)`,
      [input.vaultId, input.nodeId, rev, input.sha256, input.size, owner],
    );

    await bindBlob(c, owner, input.sha256);
    // The previous content keeps its claim through the version row that still names it;
    // only history thinning releases that (docs/03, retention).

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
): Promise<{ rev: number } | WriteFailure> =>
  db.tx(async (c) => {
    const owner = await ownerOf(c, input.vaultId);
    if (!owner) return fail('not_found');

    const cur = await c.query<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes
        WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
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
    await c.query(
      `INSERT INTO journal (vault_id, rev, node_id, op, node_rev) VALUES ($1, $2, $3, 'del', $2)`,
      [input.vaultId, rev, input.nodeId],
    );

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
): Promise<{ rev: number } | WriteFailure> =>
  db.tx(async (c) => {
    const owner = await ownerOf(c, input.vaultId);
    if (!owner) return fail('not_found');
    if (await isFrozen(c, owner)) return fail('frozen');

    const cur = await c.query<{ rev: string; parentId: string | null; ancestry: string[]; shareId: string | null }>(
      `SELECT rev::text AS rev, parent_id AS "parentId", ancestry, share_id AS "shareId"
         FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.vaultId, input.nodeId],
    );
    const row = cur.rows[0];
    if (!row) return fail('not_found');
    if (Number(row.rev) !== input.ifMatchRev) return { kind: 'rev_mismatch', rev: Number(row.rev) };

    const dest = await c.query<{ ancestry: string[]; shareId: string | null }>(
      `SELECT ancestry, share_id AS "shareId" FROM nodes
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

    await c.query(
      `INSERT INTO journal (vault_id, rev, node_id, prev_parent_id, op, node_rev)
       VALUES ($1, $2, $3, $4, 'move', $2)`,
      [input.vaultId, rev, input.nodeId, row.parentId],
    );

    return { rev };
  });
