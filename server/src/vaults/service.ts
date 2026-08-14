/**
 * The account surface: the vaults an account owns, and what they cost it.
 *
 * A successful login opens this, not a vault — the account is the unit of authentication
 * and quota, the vault the unit of synchronisation (AC-10). Which vaults a device syncs is
 * a client choice; vaults are not bound to devices (AC-13).
 */
import { randomUUID } from 'node:crypto';
import { isFrozen } from '../account.js';
import type { Db } from '../db.js';
import { refusalFromDatabase, type Refusal } from '../refusal.js';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
import { usageOf } from '../quota.js';

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
): Promise<{ id: string; rootNodeId: string } | Refusal> => {
  try {
    return await db.tx(async (c) => {
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
  } catch (e) {
    // A repeated id is the ordinary retry, not a fault: the client generates the vault's
    // UUID before it encrypts the label (AC-11), so it is the one asking again with the id
    // it already chose. Owned here rather than in the route, where it was the third
    // different idiom this one surface used to refuse things.
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) return { kind: 'vault_exists' } as Refusal;
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};

export const renameVault = async (db: Db, userId: string, vaultId: string, nameEnc: string): Promise<boolean> => {
  const rows = await db.query(
    `UPDATE vaults SET name_enc = decode($3,'base64') WHERE id = $1 AND user_id = $2 RETURNING id`,
    [vaultId, userId, nameEnc],
  );
  return rows.length > 0;
};

/**
 * Deleting a vault waits for more than "it looks empty", and the second reason surprises
 * people: an **ended** share still names the vault it lived in until the collector takes
 * its row after the journal TTL. Ending a share is a state change rather than a delete
 * (#44), because participants who were offline must still learn of it from their delta —
 * so a vault that hosted a share stays undeletable for up to 90 days after it ends.
 *
 * The foreign keys would refuse it anyway; this refuses it with a reason.
 */
export const deleteVault = async (db: Db, userId: string, vaultId: string): Promise<Refusal | undefined> =>
  db.tx(async (c) => {
    const found = await c.query<{ rootNodeId: string }>(
      `SELECT root_node_id AS "rootNodeId" FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [vaultId, userId],
    );
    if (found.rowCount === 0) return { kind: 'not_found' } as Refusal;

    const others = await c.query(
      `SELECT 1 FROM nodes WHERE vault_id = $1 AND id <> $2 LIMIT 1`,
      [vaultId, found.rows[0]!.rootNodeId],
    );
    if ((others.rowCount ?? 0) > 0) return { kind: 'not_empty' } as Refusal;

    const named = await c.query(
      `SELECT 1 FROM shares WHERE initiator_vault_id = $1
        UNION ALL
       SELECT 1 FROM share_members WHERE vault_id = $1
        LIMIT 1`,
      [vaultId],
    );
    if ((named.rowCount ?? 0) > 0) return { kind: 'named_by_a_share' } as Refusal;

    await c.query(`DELETE FROM nodes WHERE vault_id = $1`, [vaultId]);
    await c.query(`DELETE FROM vaults WHERE id = $1`, [vaultId]);
    return undefined;
  });

/**
 * The account surface's three numbers, each from the module that owns it: the quota rule
 * from `quota.ts` (AC-Q2), the freeze from `account.ts` (SH-20).
 *
 * Two queries where there was one, and deliberately. Rolling the freeze back into the
 * usage query would give `frozen_at` a second reading alongside `isFrozen`, which is the
 * duplication the account-scope module exists to prevent — and `GET /usage` is answered
 * once a sync, so the round trip buys the separation at no price worth naming.
 *
 * `used` and `quota` narrow to `number` here because that is what the wire carries; the
 * comparison that decides whether a write fits stays in `bigint`, inside `quota.ts`.
 */
export const readUsage = async (db: Db, userId: string) => {
  const usage = await usageOf(db, userId);
  if (!usage) return undefined;
  return { used: Number(usage.used), quota: Number(usage.quota), frozen: await isFrozen(db, userId) };
};
