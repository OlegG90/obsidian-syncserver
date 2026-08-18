/**
 * Deleting an account, which is a **procedure and not a statement** (#55).
 *
 * A `DELETE FROM users` cannot work, and the schema is what says so rather than a policy:
 * `versions.author_id` is `NOT NULL` with `ON DELETE RESTRICT`, because a share participant
 * routinely writes into somebody else's history (SH-19) and a `CASCADE` would erase that
 * person's record of their own file. So authorship has to *go* somewhere first — the
 * tombstone, seeded by `schema.sql` for exactly this, keeping "written by an account that is
 * gone" distinct from "written by nobody".
 *
 * And a share cannot simply vanish either. `nodes.share_id` references `shares` with
 * `RESTRICT`, so every other participant's replica has to be converted back to private
 * before the shares this account initiated can go — and only their own client can do that,
 * since the server holds no key of theirs (SH-29). That is the wait this models, and it is
 * why deletion is a **state** with progress rather than a button that either works or times
 * out.
 *
 * Three steps, and the middle one belongs to other people:
 *
 * 1. **begin** — the account enters `deleting`, its sessions are revoked, the shares it
 *    initiated are ended and the ones it joined are left. Every participant starts
 *    finalizing.
 * 2. **wait** — for each of them to finish. Nothing here can hurry it.
 * 3. **finish** — authorship moves to the tombstone, the tree is removed bottom-up, and the
 *    row goes, taking its vaults, devices and claims with it by cascade.
 *
 * `advance` runs 3 when 2 is done and reports what is outstanding when it is not, so calling
 * it repeatedly is how the procedure moves — an operator retrying, or a console polling.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db.js';
import { removeNodesByDepth, DEPTH } from '../nodes/remove.js';
import { txGuarded, type Refusal } from '../refusal.js';
import { departMember } from '../shares/service.js';
import { record, type Actor } from './audit.js';
import { PRESENT } from '../shares/membership.js';

/** The reserved account authorship is reassigned to. Seeded by `schema.sql` (#55). */
const TOMBSTONE = '00000000-0000-0000-0000-000000000000';

export interface DeletionProgress {
  state: string;
  /** Participants still converting a copy of a folder this account shared. */
  awaiting: { shareId: string; login: string }[];
  /** True once the account and everything it held are gone. */
  finished: boolean;
}

/**
 * Start the procedure, or push it along if it has started.
 *
 * Idempotent on purpose: the operator's only handle on a wait is to ask again, and a second
 * "begin" that refused because the first succeeded would make the honest thing to do look
 * like a mistake.
 */
export const deleteAccount = async (
  db: Db,
  actor: Actor,
  userId: string,
): Promise<DeletionProgress | Refusal> =>
  txGuarded(db, async (c) => {
    const target = await c.query<{ login: string; state: string }>(
      `SELECT login, state::text AS state FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (target.rowCount === 0) return { kind: 'not_found' } as Refusal;
    const { login, state } = target.rows[0]!;

    if (state === 'provisioned') {
      return { kind: 'invalid_write', detail: 'an unclaimed invitation is revoked, not deleted' } as Refusal;
    }
    if (state === 'tombstone') {
      return { kind: 'invalid_write', detail: 'the tombstone is permanent' } as Refusal;
    }

    if (state !== 'deleting') {
      await begin(c, { id: userId, login });
      await record(c, { actor, action: 'account.delete.begin', target: { id: userId, login }, details: { from: state } });
    }

    const awaiting = await outstanding(c, userId);
    if (awaiting.length > 0) return { state: 'deleting', awaiting, finished: false };

    await finish(c, userId);
    await record(c, { actor, action: 'account.delete.finish', target: { id: userId, login } });
    return { state: 'deleted', awaiting: [], finished: true };
  });

/** Read the procedure's progress without moving it — a poll must not be a write. */
export const deletionProgress = async (db: Db, userId: string): Promise<DeletionProgress | Refusal> => {
  const row = await db.one<{ state: string }>(`SELECT state::text AS state FROM users WHERE id = $1`, [userId]);
  if (!row) return { kind: 'not_found' };
  return {
    state: row.state,
    awaiting: await db.query<Awaited_>(OUTSTANDING, [userId]),
    finished: false,
  };
};

/**
 * Enter `deleting`, stop the sessions, and dissolve every share this account is part of.
 *
 * The shares it **initiated** end for everybody (SH-07), and the ones it **joined** it
 * leaves — both through the departure the sharing module already owns, because a second
 * implementation of "who is left, and does this end it" is how two answers to one question
 * start. Ending is what makes each participant begin finalizing; nothing here can do it for
 * them.
 */
const begin = async (c: PoolClient, user: Actor): Promise<void> => {
  // Sessions first, while the account is still active: a `deleting` account may still be
  // written to by the procedure, but nobody should be syncing into what is being taken apart.
  await c.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  await c.query(`UPDATE users SET state = 'deleting' WHERE id = $1`, [user.id]);

  const involved = await c.query<{ shareId: string; initiator: string }>(
    `SELECT s.id AS "shareId", s.initiator_id AS initiator
       FROM shares s
       JOIN share_members m ON m.share_id = s.id AND m.user_id = $1 AND ${PRESENT}
      WHERE s.state <> 'ended' AND s.state <> 'cancelled'
      ORDER BY s.id`,
    [user.id],
  );
  for (const share of involved.rows) {
    await departMember(c, share.shareId, user.id, share.initiator);
  }
};

/**
 * Who has not finished converting their copy yet.
 *
 * Only the shares this account **initiated** matter here. A folder it merely joined is
 * somebody else's, and its ending — if the departure ended it at all — is their business to
 * finish; what blocks this deletion is the `RESTRICT` from other people's nodes to shares
 * this account owns.
 */
const OUTSTANDING = `SELECT m.share_id AS "shareId", u.login
       FROM shares s
       JOIN share_members m ON m.share_id = s.id AND m.user_id <> s.initiator_id AND ${PRESENT}
       JOIN users u ON u.id = m.user_id
      WHERE s.initiator_id = $1
      ORDER BY u.login`;

type Awaited_ = { shareId: string; login: string };

const outstanding = async (c: PoolClient, userId: string): Promise<Awaited_[]> =>
  (await c.query<Awaited_>(OUTSTANDING, [userId])).rows;

/**
 * Anonymise the authorship, remove the tree, and let the row go.
 *
 * **Authorship moves first**, because the foreign key that makes this a procedure is the one
 * that would otherwise refuse the final statement — and it reaches into other people's
 * vaults, which is the whole reason the tombstone is a shared singleton rather than a
 * per-account marker.
 *
 * Then the nodes, in the order `removeNodesByDepth` demands — a vault cannot be emptied
 * top-down, and vaults themselves refuse to go while they hold anything (the `CASCADE` from
 * `users` reaches them, not through them). Once the tree is gone the single `DELETE FROM
 * users` carries the vaults, devices, claims and memberships with it.
 */
const finish = async (c: PoolClient, userId: string): Promise<void> => {
  await c.query(
    `UPDATE versions v SET author_id = $2
      WHERE v.author_id = $1`,
    [userId, TOMBSTONE],
  );

  const doomed = await c.query<{ id: string; vaultId: string; depth: number }>(
    `SELECT n.id, n.vault_id AS "vaultId", ${DEPTH} AS depth
       FROM nodes n JOIN vaults va ON va.id = n.vault_id
      WHERE va.user_id = $1`,
    [userId],
  );
  await removeNodesByDepth(c, doomed.rows);

  await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
};
