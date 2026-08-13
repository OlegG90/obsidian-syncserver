/**
 * The account surface: the vaults an account owns, and what they cost it.
 *
 * A successful login opens this, not a vault — the account is the unit of authentication
 * and quota, the vault the unit of synchronisation (AC-10). Which vaults a device syncs is
 * a client choice; vaults are not bound to devices (AC-13).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';

export type VaultRow = { id: string; nameEnc: string };

export const listVaults = (db: Db, userId: string): Promise<VaultRow[]> =>
  db.query<VaultRow>(
    `SELECT id, encode(name_enc, 'base64') AS "nameEnc" FROM vaults WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

/**
 * The client supplies the vault's id **before** it derives `KV` and encrypts the label, so
 * the server takes the id rather than assigning one: it never sees a name, and could not
 * hand back an id after the label was already made under it (AC-11).
 *
 * What is the server's to make is the key **scope** — an identifier, not key material —
 * and the root, which is the one node with no name and therefore needs no key at all.
 */
export const createVault = async (
  db: Db,
  userId: string,
  input: { id: string; nameEnc: string },
): Promise<{ id: string; rootNodeId: string }> =>
  db.tx(async (c) => {
    const scope = await c.query<{ id: string }>(`INSERT INTO key_scopes (kind) VALUES ('vault') RETURNING id`);
    const rootId = randomUUID();

    // Vault before root: a node's owner is resolved through its vault, so a node inserted
    // first has no owner to check and is refused. The other direction is allowed for —
    // vaults.root_node_id is deferred precisely so a transaction may name a root it has
    // not created yet.
    await c.query(
      `INSERT INTO vaults (id, user_id, name_enc, root_node_id, vault_key_id, vault_key_scope_kind)
       VALUES ($1, $2, decode($3,'base64'), $4, $5, 'vault')`,
      [input.id, userId, input.nameEnc, rootId, scope.rows[0]!.id],
    );
    await c.query(
      `INSERT INTO nodes (vault_id, id, parent_id, type, mtime, rev)
       VALUES ($1, $2, NULL, 'folder', now(), 0)`,
      [input.id, rootId],
    );

    return { id: input.id, rootNodeId: rootId };
  });

export const renameVault = async (db: Db, userId: string, vaultId: string, nameEnc: string): Promise<boolean> => {
  const rows = await db.query(
    `UPDATE vaults SET name_enc = decode($3,'base64') WHERE id = $1 AND user_id = $2 RETURNING id`,
    [vaultId, userId, nameEnc],
  );
  return rows.length > 0;
};

export type DeleteRefusal = 'not_found' | 'not_empty' | 'named_by_a_share';

/**
 * Deleting a vault waits for more than "it looks empty", and the second reason surprises
 * people: an **ended** share still names the vault it lived in until the collector takes
 * its row after the journal TTL. Ending a share is a state change rather than a delete
 * (#44), because participants who were offline must still learn of it from their delta —
 * so a vault that hosted a share stays undeletable for up to 90 days after it ends.
 *
 * The foreign keys would refuse it anyway; this refuses it with a reason.
 */
export const deleteVault = async (db: Db, userId: string, vaultId: string): Promise<DeleteRefusal | undefined> =>
  db.tx(async (c) => {
    const found = await c.query<{ rootNodeId: string }>(
      `SELECT root_node_id AS "rootNodeId" FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [vaultId, userId],
    );
    if (found.rowCount === 0) return 'not_found';

    const others = await c.query(
      `SELECT 1 FROM nodes WHERE vault_id = $1 AND id <> $2 LIMIT 1`,
      [vaultId, found.rows[0]!.rootNodeId],
    );
    if ((others.rowCount ?? 0) > 0) return 'not_empty';

    const named = await c.query(
      `SELECT 1 FROM shares WHERE initiator_vault_id = $1
        UNION ALL
       SELECT 1 FROM share_members WHERE vault_id = $1
        LIMIT 1`,
      [vaultId],
    );
    if ((named.rowCount ?? 0) > 0) return 'named_by_a_share';

    await c.query(`DELETE FROM nodes WHERE vault_id = $1`, [vaultId]);
    await c.query(`DELETE FROM vaults WHERE id = $1`, [vaultId]);
    return undefined;
  });

/**
 * Quota is `SUM(size)` over the account's `user_blobs` rows and nowhere else (AC-Q2).
 *
 * Because keys are per vault, the same file in two vaults is two blobs and is counted
 * twice — that is the price of vaults not deduplicating against each other (AC-09), and it
 * is a number the user should be able to see rather than deduce.
 */
export const readUsage = async (db: Db, userId: string) => {
  const row = await db.one<{ used: string; quota: string; frozen: boolean }>(
    `SELECT COALESCE(SUM(b.size), 0)::text AS used,
            max(u.quota_bytes)::text       AS quota,
            bool_or(u.frozen_at IS NOT NULL) AS frozen
       FROM users u
       LEFT JOIN user_blobs ub ON ub.user_id = u.id
       LEFT JOIN blobs b       ON b.sha256   = ub.sha256
      WHERE u.id = $1`,
    [userId],
  );
  return row ? { used: Number(row.used), quota: Number(row.quota), frozen: row.frozen } : undefined;
};
