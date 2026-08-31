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
import { dropUnreferenced } from '../holdings.js';
import { DEPTH, removeNodesByDepth } from '../nodes/remove.js';
import { refusalFromDatabase, type Refusal } from '../refusal.js';

/** PostgreSQL's `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
import { usageOf } from '../quota.js';
import { thawIfUnderQuota } from '../shares/thaw.js';

/**
 * A vault as its owner's client sees it: the id, the name it cannot read, and how much is in it.
 *
 * `nodes` counts everything **except the root**, so an untouched vault is `0` — which is the number that
 * decides whether it can be removed at all (`deleteVault` refuses a vault with anything in it), and the
 * one a person needs to tell a vault made by mistake from the one holding their notes (#161, #157).
 *
 * The name stays ciphertext here and is decrypted on the device, because that is the whole model: the
 * server holds `name_enc` and no key to open it.
 */
export type VaultRow = { id: string; nameEnc: string; nodes: number; bytes: string; shared: boolean };

/**
 * `bytes` is what the vault is **using**, which is what #161 asked for and a node count is not (#178). It
 * is answerable per vault only because keys are per vault: the same file in two vaults is two different
 * blobs (AC-09), so nothing is shared between them and these numbers do not double-count each other.
 *
 * **They do not add up to `/usage`, and should not.** An upload that no node references yet is charged to
 * the account and belongs to no vault, which is the whole point of the unbound-blob TTL — so the account
 * total is the vault totals plus whatever is still in flight.
 *
 * `shared` is here so a screen can say the refusal **before** the act rather than after it (#176).
 *
 * `deleteVault` refuses a vault a share names, and that refusal used to arrive as `named_by_a_share`
 * after somebody had already read a confirmation saying nothing would be lost. The same query the list
 * already runs can answer it, so the row that offers removal is the row that knows whether removal is
 * possible — exactly as `nodes` already works for the emptiness rule.
 */
export const listVaults = (db: Db, userId: string): Promise<VaultRow[]> =>
  db.query<VaultRow>(
    `SELECT v.id, encode(v.name_enc, 'base64') AS "nameEnc",
            (SELECT count(*) FROM nodes n WHERE n.vault_id = v.id AND n.id <> v.root_node_id)::int AS nodes,
            (SELECT COALESCE(SUM(b.size), 0) FROM blobs b
              WHERE b.sha256 IN (
                SELECT n.sha256 FROM nodes n
                 WHERE n.vault_id = v.id AND n.sha256 IS NOT NULL AND n.deleted_at IS NULL
                 UNION
                SELECT ver.sha256 FROM versions ver WHERE ver.vault_id = v.id))::text AS bytes,
            (EXISTS (SELECT 1 FROM shares s WHERE s.initiator_vault_id = v.id)
             OR EXISTS (SELECT 1 FROM share_members m WHERE m.vault_id = v.id)) AS shared
       FROM vaults v
      WHERE v.user_id = $1
      ORDER BY v.created_at`,
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
 * Remove a vault **and whatever it holds** (#175).
 *
 * It used to refuse anything but an empty one, which read as caution and was closer to a dead end: the
 * vault somebody wants gone is the one a mistaken pairing filled with a copy of their notes (issue #117), and
 * emptying it meant connecting to it, deleting every note, emptying the trash, disconnecting, connecting
 * to the right vault, and only then pressing Remove. Two disconnects, and no screen said so.
 *
 * **This deletes server-side data and nothing else.** Files on the device stay where they are; a device
 * that later opens a vault this removed finds it gone and says so, which is the honest end of the story
 * rather than a silent resync.
 *
 * **The one refusal that stays** is a share, and the reason surprises people: an **ended** share still
 * names the vault it lived in until the collector takes its row after the journal TTL. Ending a share is
 * a state change rather than a delete (D-44), because participants who were offline must still learn of it
 * from their delta — so a vault that hosted a share stays undeletable for up to 90 days after it ends.
 * What a share holds is other people's access, which is not this account's to tidy away (SH-27).
 *
 * **Not this device's own vault**, and that is refused where the connection lives — on the device
 * (`session.ts`). The server cannot know which vault a caller is syncing.
 */
export const deleteVault = async (
  db: Db,
  userId: string,
  vaultId: string,
): Promise<Refusal | { thawed: boolean }> =>
  db.tx(async (c) => {
    const found = await c.query(
      `SELECT 1 FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [vaultId, userId],
    );
    if (found.rowCount === 0) return { kind: 'not_found' } as Refusal;

    const named = await c.query(
      `SELECT 1 FROM shares WHERE initiator_vault_id = $1
        UNION ALL
       SELECT 1 FROM share_members WHERE vault_id = $1
        LIMIT 1`,
      [vaultId],
    );
    if ((named.rowCount ?? 0) > 0) return { kind: 'named_by_a_share' } as Refusal;

    // Deepest-first, because `parent_id` is RESTRICT and a single DELETE fails on the first parent it
    // reaches — the schema fact `nodes/remove.ts` owns, and the fourth caller to need it.
    const doomed = await c.query<{ id: string; vaultId: string; depth: number }>(
      `SELECT n.id, n.vault_id AS "vaultId", ${DEPTH} AS depth FROM nodes n WHERE n.vault_id = $1`,
      [vaultId],
    );
    await removeNodesByDepth(c, doomed.rows);
    await c.query(`DELETE FROM vaults WHERE id = $1`, [vaultId]);
    // The versions went with the nodes, so blobs this vault was the last to reference are now held by
    // nothing. Recomputed here rather than left to the sweep: an account that deleted a vault to make
    // room would otherwise still read as full.
    await dropUnreferenced(c, userId);

    // **And if that was enough, the freeze lifts here** (issue #236). SH-20's advice to a frozen
    // account is "delete something", and removing a vault is the largest deletion this product offers —
    // it was also the only one that freed the space and left the freeze on, because `thawIfUnderQuota`
    // was called by the trash purge and the vault reset and not by this. The person did exactly what
    // they were told, watched the usage fall, and was still refused every write until they went and
    // emptied a trash somewhere unrelated.
    //
    // **After `dropUnreferenced`, and that ordering is the whole of it**: the thaw asks `headroom`, so
    // the bytes have to have stopped counting before it looks, or it decides the account is still over
    // and does nothing.
    //
    // The catch-up SH-21 requires runs with it, in this transaction. That is not a contradiction of the
    // refusal above — a vault a share names cannot be removed, but the account may hold OTHER vaults
    // inside shares, and those are exactly the replicas whose propagation was skipped for the length of
    // the freeze.
    // **Reported, not dropped** (issue #247). The trash purge has returned `thawed` since it gained the
    // same call, and for the same reason: a person who has just deleted something to get back in wants
    // to know whether it worked, and the only surface that can say so at that moment is the one they
    // pressed. What it costs is a `204` becoming a `200`, which is why this waited for a minor.
    return { thawed: (await thawIfUnderQuota(c, userId)) !== undefined };
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
