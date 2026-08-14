/**
 * A share, from its creation to the point somebody can be invited into it.
 *
 * **Replication, not mounting** (docs/05): every participant ends up holding their own
 * copy, so leaving a share leaves you with your files. Nothing here moves or re-parents
 * anything the initiator already had.
 *
 * This module owns the part of the lifecycle that exists before anyone else is involved —
 * create, cancel, and the two lists a client reads. Invitation, preparation, activation,
 * joining and finalization are their own steps and are not here.
 *
 * **What the server never does.** It does not derive `KS`, encrypt a name, or seal an
 * envelope. `wrapped_key_initiator` and the scope id arrive opaque and are stored opaque
 * (docs/04): the server verifies scope, membership and completeness, and nothing else.
 *
 * Most of the rules this module appears to enforce are enforced by the schema instead —
 * `shares_check_root()` alone covers "a folder", "alive", "not already shared", "not inside
 * another share", and the composite foreign key pins the root to the initiator's own vault.
 * That is deliberate: the failure is then impossible rather than merely tested. What is
 * left here is the orchestration, and turning the schema's refusal into one a caller can
 * act on.
 */
import type { Db } from '../db.js';
import { refusalFromDatabase, type Refusal } from '../refusal.js';

/** PostgreSQL's `foreign_key_violation` — here, a vault or node that is not the caller's. */
const FOREIGN_KEY_VIOLATION = '23503';

export interface CreateShareInput {
  vaultId: string;
  nodeId: string;
  /**
   * The client's own identifier for the share key's scope, not the server's.
   *
   * Vaults work the other way round — there the server mints the scope — and the
   * difference is forced: `POST /shares` answers with a share id and nothing else, so a
   * scope the server invented could never be referenced by the client that has to write
   * `name_key_id` on every interior node it re-keys during preparation.
   */
  subtreeKeyId: string;
  /** `KS`, wrapped for the initiator. Opaque. */
  wrappedKeyInitiator: Buffer;
}

/**
 * Open a share over one of the caller's own folders. It begins in `preparing`: the
 * initiator may keep writing, but nobody can be invited until preparation is verified.
 */
export const createShare = async (
  db: Db,
  userId: string,
  input: CreateShareInput,
): Promise<{ shareId: string; state: string } | Refusal> => {
  try {
    return await db.tx(async (c) => {
      // The scope row must exist before the share can reference it; both are one
      // transaction, so a share never names a scope that was never created.
      await c.query(`INSERT INTO key_scopes (id, kind) VALUES ($1, 'share')`, [input.subtreeKeyId]);

      const res = await c.query<{ id: string; state: string; rootItemId: string }>(
        `INSERT INTO shares (initiator_id, initiator_vault_id, subtree_node_id,
                             subtree_key_id, subtree_key_scope_kind, wrapped_key_initiator)
              VALUES ($1, $2, $3, $4, 'share', $5)
           RETURNING id, state::text AS state, root_item_id AS "rootItemId"`,
        [userId, input.vaultId, input.nodeId, input.subtreeKeyId, input.wrappedKeyInitiator],
      );

      const row = res.rows[0]!;

      // The initiator is a participant, not an owner standing outside — the whole model is
      // replication, and every copy including theirs belongs to a member. The schema is
      // where this stopped being a matter of taste: `nodes_check_share_membership` demands
      // that a share-marked node belong to a **live participant**, so without this row the
      // initiator's own folder could not carry the mark the next statement gives it. It is
      // also why the ceiling of eight counts them.
      await c.query(
        `INSERT INTO share_members (share_id, user_id, vault_id, joined_at)
              VALUES ($1, $2, $3, now())`,
        [row.id, userId, input.vaultId],
      );

      // The folder and the share point at each other. Deferred triggers allow either order
      // inside the transaction, but never a committed half: a node carrying `share_id`
      // without `share_item_id` is the shape the RESTRICT on `nodes_share_fkey` exists to
      // make impossible.
      await c.query(
        `UPDATE nodes SET share_id = $1, share_item_id = $2 WHERE vault_id = $3 AND id = $4`,
        [row.id, row.rootItemId, input.vaultId, input.nodeId],
      );

      return { shareId: row.id, state: row.state };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    // A vault or node that is not this caller's fails the composite foreign key. Answering
    // `not_found` rather than naming which half was wrong keeps it from reporting on
    // another account's tree (#20).
    if (code === FOREIGN_KEY_VIOLATION) return { kind: 'not_found' };
    // A folder that is already shared is refused by `shares_check_root()` before the
    // unique index is ever reached, and the trigger's own sentence says more than a code
    // of ours would — including the case a bare "already shared" would misdescribe, a
    // replica being re-shared. So it travels as `invalid_write`, like every other rule the
    // schema owns.
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};

/**
 * Cancel a share that nobody has joined.
 *
 * `preparing` may go only to `cancelled`, and only the initiator may do it — both are in
 * the schema's transition rules, so the `WHERE` here is what makes the answer specific
 * rather than what makes the rule true. No participant copy exists at this point, which is
 * why cancelling is a state change and not the finalization pass that ending a live share
 * requires.
 */
export const cancelShare = async (db: Db, userId: string, shareId: string): Promise<Refusal | undefined> => {
  try {
    return await db.tx(async (c) => {
      const res = await c.query<{ id: string; vaultId: string; nodeId: string }>(
        `SELECT id, initiator_vault_id AS "vaultId", subtree_node_id AS "nodeId"
           FROM shares
          WHERE id = $1 AND initiator_id = $2 AND state = 'preparing'
            FOR UPDATE`,
        [shareId, userId],
      );
      const share = res.rows[0];
      if (!share) return await explainCancelRefusal(c, userId, shareId);

      // The order below is forced, and each step is forbidden before the one above it —
      // three separate triggers, pulling in a ring that has exactly one way through:
      //
      //   1. the share must already be terminal, because the initiator may not leave a
      //      share that still lives ("end the share instead");
      //   2. the member must be finalizing, because a node may not be unmarked outside
      //      its member's finalization;
      //   3. only then may the marks go, and `left_at` record that the pass finished.
      //
      // The row is not deleted. Deletion is refused until finalization has completed and
      // the marks are clear, and once `left_at` is written there is nothing left to gain by
      // removing it: a membership row IS the evidence that finalization ran. Only an
      // invitation nobody answered is deleted outright, and that is the documented
      // exception rather than the rule (docs/05).
      //
      // What makes this legal is that the checks are DEFERRED: within the transaction the
      // share is briefly terminal while a participant is still attached, which is exactly
      // the state the ring forbids at commit. Cancelling is the degenerate departure —
      // the only member is the initiator, and no replica was ever handed out.
      await c.query(`UPDATE shares SET state = 'cancelled', terminal_at = now() WHERE id = $1`, [shareId]);
      await c.query(`UPDATE share_members SET finalization_started_at = now() WHERE share_id = $1`, [shareId]);
      await c.query(`UPDATE nodes SET share_id = NULL, share_item_id = NULL WHERE share_id = $1`, [shareId]);
      await c.query(`UPDATE share_members SET left_at = now() WHERE share_id = $1`, [shareId]);
      return undefined;
    });
  } catch (e) {
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};

/**
 * Why the cancel did not apply. Asked only after the fact, so the ordinary path costs one
 * statement rather than two.
 */
const explainCancelRefusal = async (
  c: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  userId: string,
  shareId: string,
): Promise<Refusal> => {
  const res = await c.query<{ state: string }>(
    `SELECT state::text AS state FROM shares WHERE id = $1 AND initiator_id = $2`,
    [shareId, userId],
  );
  const mine = res.rows[0];
  // A share belonging to somebody else stays invisible, exactly as it was before the call.
  return mine ? { kind: 'share_not_preparing', state: mine.state } : { kind: 'not_found' };
};

export type JoinedShare = {
  shareId: string;
  vaultId: string | null;
  isInitiator: boolean;
  state: string;
};

export type PendingInvitation = {
  shareId: string;
  initiatorLogin: string;
  invitedAt: string;
};

/**
 * What this account is in, and what is waiting for it.
 *
 * Two lists rather than one because they are answered differently by the client: a joined
 * share is somewhere its files already are, an invitation is a decision it has not made.
 * Nothing is pushed at anybody — the client opens this (docs/02).
 *
 * The initiator's own share appears in `joined` from the moment it is created, before any
 * `share_members` row exists, because they are in it: it is their folder.
 */
export const listShares = async (
  db: Db,
  userId: string,
): Promise<{ joined: JoinedShare[]; invitations: PendingInvitation[] }> => {
  // One branch, not two: the initiator holds an ordinary membership row from the moment
  // the share is created, so they are already in this result. `is_initiator` is a fact
  // about the share, not a role — there are none (SH-10).
  const joined = await db.query<JoinedShare>(
    `SELECT s.id AS "shareId", m.vault_id AS "vaultId",
            (s.initiator_id = m.user_id) AS "isInitiator", s.state::text AS state
       FROM share_members m JOIN shares s ON s.id = m.share_id
      WHERE m.user_id = $1 AND m.joined_at IS NOT NULL AND m.left_at IS NULL
        AND s.state IN ('preparing', 'active')
      ORDER BY s.created_at`,
    [userId],
  );

  // An invitation is a membership row that has not been answered. A declined or withdrawn
  // one is deleted outright, so absence is the whole record of it (docs/05).
  const invitations = await db.query<PendingInvitation>(
    `SELECT m.share_id AS "shareId", u.login AS "initiatorLogin",
            m.invited_at AS "invitedAt"
       FROM share_members m
       JOIN shares s ON s.id = m.share_id
       JOIN users  u ON u.id = s.initiator_id
      WHERE m.user_id = $1 AND m.joined_at IS NULL AND s.state = 'active'
      ORDER BY m.invited_at`,
    [userId],
  );

  return { joined, invitations };
};

export type MemberRow = {
  userId: string;
  login: string;
  isInitiator: boolean;
  invitedAt: string;
  joinedAt: string | null;
  finalizing: boolean;
};

/**
 * Who is in the share, and who has an outstanding invitation.
 *
 * Readable by **any live member**, not only the initiator (docs/04): a participant who
 * cannot see who else holds a copy of their folder cannot make an informed decision about
 * staying in it.
 *
 * It deliberately carries no freeze state. Being over quota is an account-level condition
 * (SH-20), and exposing it here would tell every other participant something about a
 * person's account that has nothing to do with this share.
 *
 * @returns the list, or `undefined` when the caller is not a live member — which is also
 *   the answer for a share that does not exist, and for the same reason.
 */
export const listMembers = async (db: Db, userId: string, shareId: string): Promise<MemberRow[] | undefined> => {
  const visible = await db.one<{ ok: boolean }>(
    `SELECT true AS ok FROM shares s
      WHERE s.id = $1
        AND (s.initiator_id = $2
             OR EXISTS (SELECT 1 FROM share_members m
                         WHERE m.share_id = s.id AND m.user_id = $2 AND m.left_at IS NULL))`,
    [shareId, userId],
  );
  if (!visible) return undefined;

  // Everyone in the share holds a row, the initiator included, so this is one query and
  // the initiator sorts first by being the initiator rather than by a special case.
  return db.query<MemberRow>(
    `SELECT m.user_id AS "userId", u.login,
            (s.initiator_id = m.user_id) AS "isInitiator",
            m.invited_at AS "invitedAt", m.joined_at AS "joinedAt",
            m.finalization_started_at IS NOT NULL AS finalizing
       FROM share_members m
       JOIN shares s ON s.id = m.share_id
       JOIN users  u ON u.id = m.user_id
      WHERE m.share_id = $1 AND m.left_at IS NULL
      ORDER BY "isInitiator" DESC, m.invited_at`,
    [shareId],
  );
};
