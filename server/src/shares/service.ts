/**
 * A share's whole lifecycle: created, prepared, activated, joined, left, finished with.
 *
 * **Replication, not mounting** (docs/05): every participant ends up holding their own
 * copy, so leaving a share leaves you with your files. Nothing here moves or re-parents
 * anything the initiator already had.
 *
 * The header used to claim that invitation, preparation, activation, joining and
 * finalization "are their own steps and are not here" while every one of them was — written
 * when it was true and left alone as the file grew, so a reader looking for `joinShare` was
 * told to look elsewhere. They are all here, and they belong together: each is a transition
 * of one state machine, and the schema enforces the order between them.
 *
 * **What is NOT here, and why.** Two questions that other files ask, cut out because of who
 * asks them rather than because of size:
 *
 * - `surface.ts` — the key scopes a vault reports and the account states a delta carries.
 *   Both are read by a different route family, and answering them used to mean importing
 *   this entire state machine to compute two lists;
 * - `owed.ts` — which blobs still lack material under a scope, asked in both directions by
 *   preparation and by departure. One query, two callers here and one in the routes.
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
import type { DeltaEvent } from '@syncserver/shared';
import type { PoolClient } from 'pg';
import { oneFrom, type Db } from '../db.js';
import { writeMaterial, type Material } from '../material.js';
import { fakeRecipient } from '../crypto.js';
import { claimBlob, dropUnreferenced, recordVersion } from '../holdings.js';
import { createCounterpart } from './replica.js';
import { headroom } from '../quota.js';
import { preparationGaps } from './owed.js';
import { refusalFromDatabase, txGuarded, type Refusal } from '../refusal.js';
import { nextRev } from '../revision.js';

/** PostgreSQL's `foreign_key_violation` — here, a vault, node or account that is not there. */
const FOREIGN_KEY_VIOLATION = '23503';
/** PostgreSQL's `unique_violation` — here, an account already in the share. */
const UNIQUE_VIOLATION = '23505';

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
  // A vault or node that is not this caller's fails the composite foreign key, and
  // `txGuarded` deliberately does not translate that: everywhere else a foreign key
  // violation means a defect on this side. Here it means "not yours", and answering
  // `not_found` rather than naming which half was wrong keeps the endpoint from reporting
  // on another account's tree (#20).
  try {
    return await txGuarded(db, async (c) => {
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
    await c.query(`UPDATE nodes SET share_id = $1, share_item_id = $2 WHERE vault_id = $3 AND id = $4`, [
      row.id,
      row.rootItemId,
      input.vaultId,
      input.nodeId,
    ]);

    // And every node below it. `nodes_check_share_membership` refuses a node that sits
    // inside a shared folder without a mark of its own, so this is not housekeeping —
    // the root's mark is illegal until the subtree carries one too. An empty folder
    // hides it completely, which is why the first version of this passed its tests.
    //
    // Each descendant gets its **own** `share_item_id`, freshly generated: it is the
    // identity of that item *within the share*, which is what lets a participant's copy
    // of a file be recognised as the same item as the initiator's when neither can see
    // the other's node ids (docs/05, corresponding nodes). Only the root reuses the
    // share's `root_item_id`, because the share itself is that item.
    //
    // **The trash is marked too, and that is the schema's call rather than a choice here.**
    // `nodes_check_share_membership` refuses a node inside a shared folder whose child
    // carries a different mark or none — "the subtree is incompletely shared" — and makes no
    // exception for a deleted one. I tried excluding the trash and the schema said no.
    //
    // The consequence has to be lived with rather than hidden: a trashed node joins the
    // share **unprepared**, because preparation only re-keys what is live, so its name stays
    // under `KV`. Leaving is where that matters, and it knows — a node that was never
    // converted into the share needs its mark cleared and nothing else.
    await c.query(
      `UPDATE nodes SET share_id = $1, share_item_id = gen_random_uuid()
        WHERE vault_id = $2 AND ancestry @> ARRAY[$3]::uuid[]`,
      [row.id, input.vaultId, input.nodeId],
    );

    return { shareId: row.id, state: row.state };
    });
  } catch (e) {
    if ((e as { code?: string }).code === FOREIGN_KEY_VIOLATION) return { kind: 'not_found' };
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
  return txGuarded(db, async (c) => {
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
  /**
   * The share's root **in this member's own vault**, which is a different node for each of
   * them: the initiator's own folder, and every participant's separate replica root.
   *
   * Reported because a client cannot work it out. It resolves paths through node ids, and
   * the one thing tying the two vaults together — `share_item_id` — is the server's. Without
   * it a shared folder is indistinguishable from any other folder on disk, which is exactly
   * what a two-account walk found: writes reaching another person, with nothing on screen
   * to say so.
   */
  rootNodeId: string | null;
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
  // **Not filtered by state.** A share that has ended still owes its members the pass that
  // converts their replica back, and a list that hides it leaves them no way to run it —
  // the screen goes quiet while the marks stay put. `left_at` is what removes a share from
  // somebody's life, and it is written by the pass, not by the ending.
  const joined = await db.query<JoinedShare>(
    `SELECT s.id AS "shareId", m.vault_id AS "vaultId",
            (s.initiator_id = m.user_id) AS "isInitiator", s.state::text AS state,
            (SELECT n.id FROM nodes n
              WHERE n.vault_id = m.vault_id AND n.share_item_id = s.root_item_id) AS "rootNodeId"
       FROM share_members m JOIN shares s ON s.id = m.share_id
      WHERE m.user_id = $1 AND m.joined_at IS NOT NULL AND m.left_at IS NULL
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


/**
 * Verify preparation and open the share for invitations.
 *
 * `preparing → active` is the schema's transition; what the schema does **not** check is
 * whether anything was actually prepared, and it leaves that here on purpose (docs/05):
 * completeness is a statement about client-produced key material, which no constraint can
 * evaluate without the keys.
 */
export const activateShare = async (
  db: Db,
  userId: string,
  shareId: string,
): Promise<{ state: string } | Refusal> => {
  const share = await db.one<{ vaultId: string; keyId: string; rootItemId: string; state: string }>(
    `SELECT initiator_vault_id AS "vaultId", subtree_key_id AS "keyId",
            root_item_id AS "rootItemId", state::text AS state
       FROM shares WHERE id = $1 AND initiator_id = $2`,
    [shareId, userId],
  );
  if (!share) return { kind: 'not_found' };
  if (share.state !== 'preparing') return { kind: 'share_not_preparing', state: share.state };

  const gaps = await preparationGaps(db, share.vaultId, shareId, share.keyId, share.rootItemId);
  if (gaps.length > 0) return { kind: 'share_not_prepared', gaps };

  await db.query(`UPDATE shares SET state = 'active' WHERE id = $1`, [shareId]);
  return { state: 'active' };
};

/**
 * Invite an account into an active share.
 *
 * **A membership row is the invitation.** There is no separate table and no state column:
 * `joined_at IS NULL` is what "outstanding" means, and a deleted row is a decline. That is
 * why declining leaves no trace and frees its slot at once.
 *
 * The ceiling of eight, the initiator included, is the schema's (SH-11) — it is what keeps
 * synchronous fan-out bounded, so it belongs where it cannot be bypassed.
 *
 * **An unknown account fails generically** (docs/04). `/auth/kdf` answers a deterministic
 * fake rather than a 404 so it cannot be used to enumerate logins, and an invite that
 * said "no such account" would be the same oracle one call later.
 */
export const invite = async (
  db: Db,
  userId: string,
  shareId: string,
  input: { targetUserId: string; wrappedKey: Buffer },
): Promise<Refusal | undefined> => {
  const share = await db.one<{ state: string; initiator: string }>(
    `SELECT state::text AS state, initiator_id AS initiator FROM shares WHERE id = $1`,
    [shareId],
  );
  // Invisible to anyone but the initiator: a share somebody is not in should not become
  // visible through the error it returns.
  if (!share || share.initiator !== userId) return { kind: 'not_found' };
  if (share.state !== 'active') return { kind: 'share_not_active', state: share.state };

  try {
    await db.query(`INSERT INTO share_members (share_id, user_id, wrapped_key) VALUES ($1, $2, $3)`, [
      shareId,
      input.targetUserId,
      input.wrappedKey,
    ]);
    return undefined;
  } catch (e) {
    const code = (e as { code?: string }).code;
    // No such account, or one already in the share. Both answer the same way, and that is
    // the point: telling them apart would say whether a login exists.
    if (code === FOREIGN_KEY_VIOLATION || code === UNIQUE_VIOLATION) return { kind: 'invite_failed' };
    const refusal = refusalFromDatabase(e);
    if (refusal) return refusal;
    throw e;
  }
};

/**
 * Decline an invitation. The row is **deleted**, so the slot is free at once and nothing
 * durable records the refusal (docs/05) — absence from the member list is the whole account
 * of it.
 *
 * Only a row that never joined may be deleted, and that exemption is what stops an
 * unanswered invitation from occupying a slot for the life of the share: a row with no
 * `joined_at` can carry neither finalization nor `left_at`, so without it the row would be
 * unremovable.
 */
export const declineInvitation = async (db: Db, userId: string, shareId: string): Promise<Refusal | undefined> => {
  const gone = await db.one<{ shareId: string }>(
    `DELETE FROM share_members
      WHERE share_id = $1 AND user_id = $2 AND joined_at IS NULL
  RETURNING share_id AS "shareId"`,
    [shareId, userId],
  );
  return gone ? undefined : { kind: 'not_found' };
};

/**
 * The initiator removes somebody. One endpoint, two operations, told apart by whether they
 * ever joined (docs/04):
 *
 * - an outstanding **invitation** is withdrawn — the same deletion a decline performs, seen
 *   from the other side;
 * - a **joined** participant is revoked, which stops propagation now and leaves their copy
 *   to be finalized by their own client later. It cannot be finished here: only that client
 *   holds the `KV` and the plaintext names its replica has to be converted back to.
 */
export const removeMember = async (
  db: Db,
  userId: string,
  shareId: string,
  targetUserId: string,
): Promise<{ outcome: 'withdrawn' | 'revoked'; ended?: boolean } | Refusal> => {
  const share = await db.one<{ initiator: string }>(`SELECT initiator_id AS initiator FROM shares WHERE id = $1`, [
    shareId,
  ]);
  if (!share || share.initiator !== userId) return { kind: 'not_found' };
  // The initiator leaving is what ends a share, and that is a different operation with a
  // different meaning for everybody else.
  if (targetUserId === userId) return { kind: 'initiator_cannot_be_removed' };

  const member = await db.one<{ joined: string | null }>(
    `SELECT joined_at AS joined FROM share_members WHERE share_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [shareId, targetUserId],
  );
  if (!member) return { kind: 'not_found' };

  if (member.joined === null) {
    await db.query(`DELETE FROM share_members WHERE share_id = $1 AND user_id = $2`, [shareId, targetUserId]);
    return { outcome: 'withdrawn' };
  }

  // Revocation is a departure, so it ends the share on exactly the same condition leaving
  // does — the rule this used to state only once.
  const ended = await db.tx((c) => departMember(c, shareId, targetUserId, userId));
  return { outcome: 'revoked', ended };
};

/** One node's worth of preparation: its name under `KS`, and the material its bytes need. */
export type PrepareItem = {
  nodeId: string;
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
} & Material;

/**
 * Convert part of a share's interior to `KS`.
 *
 * This is the client half of what `activate` verifies, and the division is not arbitrary:
 * only the client can perform it. Re-keying a name means decrypting it under `KV` and
 * encrypting it under `KS`, and the server holds neither key — so what arrives here is
 * finished work, and the server's job is to check that it lands where it claims to.
 *
 * **Batches, and therefore resumable** (docs/04). A subtree can be larger than one request
 * and a phone can lose the connection halfway, so preparation is a sequence of independent
 * batches rather than one atomic conversion. Each batch is a transaction; a repeat of one
 * already applied is harmless, because writing the same name and the same envelope twice
 * changes nothing. Nothing tracks progress — `activate` recomputes what is still missing,
 * which is the same answer whether a batch was lost, repeated, or never sent.
 *
 * **Only while `preparing`.** Once the share is active a participant may hold a copy, and
 * a name changing under them is an ordinary write with a revision, not a silent conversion.
 */
export const prepareShare = async (
  db: Db,
  userId: string,
  shareId: string,
  items: PrepareItem[],
): Promise<Refusal | undefined> => {
  const share = await db.one<{ vaultId: string; nodeId: string; keyId: string; state: string }>(
    `SELECT initiator_vault_id AS "vaultId", subtree_node_id AS "nodeId",
            subtree_key_id AS "keyId", state::text AS state
       FROM shares WHERE id = $1 AND initiator_id = $2`,
    [shareId, userId],
  );
  if (!share) return { kind: 'not_found' };
  if (share.state !== 'preparing') return { kind: 'share_not_preparing', state: share.state };

  // The share's own key, not whatever the request names. A prepare that wrote some other
  // scope would produce names no participant could read, and `activate` would then refuse
  // the share for a reason the client had just caused.
  const wrong = items.find((i) => i.nameKeyId !== share.keyId);
  if (wrong) {
    return { kind: 'invalid_write', detail: `item ${wrong.nodeId} names a key scope that is not this share's` };
  }

  return txGuarded(db, async (c) => {
    for (const item of items) {
      // Interior only, and checked by the UPDATE rather than before it: `ancestry`
      // already says whether the node is under the share root, and asking separately
      // would be a second statement racing the first. The root is excluded on purpose —
      // its label stays under `KV` for the life of the share (SH-01, SH-25).
      const res = await c.query(
        `UPDATE nodes
            SET name_enc = decode($1,'base64'), name_hmac = decode($2,'hex'), name_key_id = $3
          WHERE vault_id = $4 AND id = $5 AND deleted_at IS NULL
            AND ancestry @> ARRAY[$6]::uuid[]`,
        [item.nameEnc, item.nameHmac, item.nameKeyId, share.vaultId, item.nodeId, share.nodeId],
      );

      if (res.rowCount === 0) {
        // Nothing matched: the node is deleted, in another vault, or outside this share.
        // Refusing the batch rather than skipping the item is the point — a silently
        // ignored item is one `activate` will later report as missing, sending the client
        // back to prepare something it believes it already prepared.
        return { kind: 'invalid_write', detail: `node ${item.nodeId} is not a live interior node of this share` } as Refusal;
      }

      await writeMaterial(c, { envelopes: item.envelopes ?? [], dedupTags: item.dedupTags ?? [] });
    }
    return undefined;
  });
};

export interface JoinInput {
  /** The vault the accepting client is running in — observed, never asked (AC-Q4). */
  vaultId: string;
  /** Where the replica root lands in that vault. */
  parentId: string;
  /** The joiner's own label for the root, under their own `KV`. */
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
}

/** One node of the source subtree, in the order a copy has to be made. */
type SourceNode = {
  id: string;
  parentId: string;
  type: string;
  nameEnc: string | null;
  nameHmac: string | null;
  nameKeyId: string | null;
  sha256: string | null;
  size: string | null;
  mtime: string;
  shareItemId: string;
  depth: number;
};

/**
 * Accept an invitation: materialise a full copy of the shared folder.
 *
 * **The vault is observed, not asked** (AC-Q4). An Obsidian plugin instance can only reach
 * the vault it runs in, so accepting an invitation *is* choosing where the folder lands.
 * There is no question to put to the user and no second choice to make later — accepting
 * the same invitation from another vault is not a different answer, it is a second
 * redemption, and an invitation is redeemed once.
 *
 * **Replication, which is the whole model.** Every node is copied into the joiner's own
 * vault: their own node ids, their own revisions, their own journal, so their other devices
 * learn about the folder through the same delta as any other change. What is NOT copied is
 * identity — each replica node keeps the source's `share_item_id`, and that is what lets two
 * participants recognise the same item without either seeing the other's node ids.
 *
 * Interior names are copied **verbatim**: they are already under `KS`, which the joiner can
 * now open with the envelope their invitation carried. Only the root is named freshly, by
 * the joiner, under their own `KV` — it lives among their private folders and is theirs to
 * call whatever they like.
 *
 * **Quota is the one point where joining is refused** (docs/05). Not invitation, not
 * activation: only here, because only here does the account actually take on the bytes.
 *
 * **History comes too** (SH-15, SH-23). A join delivers each file's retained versions, not
 * merely its head: a folder that arrives with no past is a folder whose "restore an earlier
 * version" does nothing, and the difference only shows up on the day somebody needs it.
 * The revisions are renumbered into the joiner's own sequence — a version's  orders
 * history within its node, and numbers from another vault's journal would interleave wrongly
 * with everything written after the join.
 */
export const joinShare = async (
  db: Db,
  userId: string,
  shareId: string,
  input: JoinInput,
): Promise<{ rootNodeId: string } | Refusal> => {
  return txGuarded(db, async (c) => {
    const shareRes = await c.query<{ state: string; vaultId: string; nodeId: string }>(
      `SELECT s.state::text AS state, s.initiator_vault_id AS "vaultId", s.subtree_node_id AS "nodeId"
         FROM shares s WHERE s.id = $1 FOR UPDATE`,
      [shareId],
    );
    const share = shareRes.rows[0];
    if (!share) return { kind: 'not_found' } as Refusal;
    if (share.state !== 'active') return { kind: 'share_not_active', state: share.state } as Refusal;

    // An outstanding invitation, and nothing else: a row already joined would make this a
    // second redemption, and no row at all means nobody asked them.
    const invite = await c.query(
      `SELECT 1 FROM share_members
        WHERE share_id = $1 AND user_id = $2 AND joined_at IS NULL AND left_at IS NULL
          FOR UPDATE`,
      [shareId, userId],
    );
    if (invite.rowCount === 0) return { kind: 'not_found' } as Refusal;

    // The destination must be the joiner's own live folder. Checked here rather than left
    // to a foreign key so that "not yours" and "not a folder" do not both arrive as a 500.
    const parent = await c.query<{ ancestry: string[] }>(
      `SELECT n.ancestry FROM nodes n
         JOIN vaults v ON v.id = n.vault_id AND v.user_id = $1
        WHERE n.vault_id = $2 AND n.id = $3 AND n.deleted_at IS NULL AND n.type = 'folder'`,
      [userId, input.vaultId, input.parentId],
    );
    if (parent.rowCount === 0) return { kind: 'not_found' } as Refusal;

    const source = await c.query<SourceNode>(
      `SELECT n.id, n.parent_id AS "parentId", n.type::text AS type,
              encode(n.name_enc, 'base64') AS "nameEnc", encode(n.name_hmac, 'hex') AS "nameHmac",
              n.name_key_id AS "nameKeyId", encode(n.sha256, 'hex') AS sha256,
              n.size::text AS size, n.mtime, n.share_item_id AS "shareItemId",
              array_length(n.ancestry, 1) AS depth
         FROM nodes n
        WHERE n.vault_id = $1 AND n.deleted_at IS NULL
          AND (n.id = $2 OR n.ancestry @> ARRAY[$2]::uuid[])
        ORDER BY array_length(n.ancestry, 1) NULLS FIRST, n.id`,
      [share.vaultId, share.nodeId],
    );

    // What the join will cost: every distinct blob the subtree references that this
    // account does not already hold. Blobs it holds are free — content is stored once and
    // `user_blobs` is a claim on it, not a copy of it.
    const sizes = new Map<string, bigint>();
    for (const n of source.rows) {
      if (n.sha256 && n.size !== null) sizes.set(n.sha256, BigInt(n.size));
    }
    // One question, one trip: which of these the account already holds. A row is a claim,
    // not a copy, so `user_blobs` saying yes is what "free" means — the same predicate the
    // growth accounting uses, not the `refs_own > 0` a READ is gated by.
    const hashes = [...sizes.keys()];
    const heldRows = hashes.length
      ? await c.query<{ sha256: string }>(
          `SELECT encode(b.sha256, 'hex') AS sha256
             FROM unnest($2::text[]) AS t(hex)
             JOIN user_blobs b ON b.sha256 = decode(t.hex, 'hex')
            WHERE b.user_id = $1`,
          [userId, hashes],
        )
      : { rows: [] };
    const held = new Set(heldRows.rows.map((r) => r.sha256));
    let growth = 0n;
    for (const [sha, size] of sizes) {
      if (!held.has(sha)) growth += size;
    }

    const room = await headroom(oneFrom(c), userId);
    if (room === undefined) return { kind: 'not_found' } as Refusal;
    if (growth > room) return { kind: 'over_quota' } as Refusal;

    // Membership before the nodes: `nodes_check_share_membership` demands that a
    // share-marked node belong to a LIVE participant, so the replica cannot legally exist
    // until this row says the joiner is one. The same ordering the initiator's own
    // creation needed, for the same reason.
    await c.query(
      `UPDATE share_members SET joined_at = now(), vault_id = $3
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, userId, input.vaultId],
    );

    // Copied one at a time, parents before children, mapping source ids to new ones. A
    // recursive statement would be shorter and would have to invent new ids inside its
    // own recursion — the mapping is the hard part, and it is clearer held in memory than
    // expressed as a CTE nobody can debug.
    const mapped = new Map<string, string>();
    /** Source node id -> the ancestry its COPY has, so a child can build its own. */
    const ancestryOf = new Map<string, string[]>();
    const baseAncestry = parent.rows[0]!.ancestry;
    let rootNodeId = '';

    for (const n of source.rows) {
      const isRoot = n.id === share.nodeId;
      const newParent = isRoot ? input.parentId : mapped.get(n.parentId);
      if (!newParent) {
        // Only reachable if the subtree query returned a child before its parent, which
        // the ordering forbids. Refusing beats writing a tree with a hole in it.
        return { kind: 'invalid_write', detail: `node ${n.id} has no copied parent` } as Refusal;
      }

      const ancestry = isRoot ? [...baseAncestry, input.parentId] : [...ancestryOf.get(n.parentId)!, newParent];

      // Every retained version of the source, oldest first, so the copy can be numbered
      // in the joiner's own sequence while keeping its order.
      const past = await c.query<{ sha256: string; size: string; authorId: string; at: string }>(
        `SELECT encode(v.sha256,'hex') AS sha256, v.size::text AS size,
                v.author_id AS "authorId", v.at
           FROM versions v WHERE v.vault_id = $1 AND v.node_id = $2
          ORDER BY v.rev`,
        [share.vaultId, n.id],
      );
      // Revisions for the history are taken BEFORE the node's own, so the head is the
      // highest and "latest version" means what it says.
      const pastRevs: number[] = [];
      for (let i = 0; i < past.rows.length - 1; i++) pastRevs.push(await nextRev(c, input.vaultId));

      // Only a vault's own root is nameless, and a share can never be rooted at one — so a
      // node without a name here means the subtree query reached outside the share. Refused
      // rather than cast away, beside the parent check above it, because the alternative is
      // an insert the schema rejects with a sentence about `name_enc`.
      const nameEnc = isRoot ? input.nameEnc : n.nameEnc;
      const nameHmac = isRoot ? input.nameHmac : n.nameHmac;
      const nameKeyId = isRoot ? input.nameKeyId : n.nameKeyId;
      if (nameEnc === null || nameHmac === null || nameKeyId === null) {
        return { kind: 'invalid_write', detail: `node ${n.id} inside a share has no name` } as Refusal;
      }

      // The same write propagation and the catch-up make: create the corresponding node under
      // a parent that is already here, and journal it. The revision it takes is the NEXT one,
      // which is why the history above reserved its own first — the head must be the highest.
      //
      // The root is the one node whose name is not copied: it lands among the joiner's own
      // folders and is theirs to call whatever they like (SH-01).
      const { node: createdNode, rev } = await createCounterpart(
        c,
        {
          vaultId: input.vaultId,
          shareId,
          // `ancestry` is the chain this walk already built, and `createCounterpart` derives
          // the child's from it — the parent of the replica root is an ordinary folder of the
          // joiner's vault rather than a share node, which is why it is passed rather than
          // looked up.
          parent: { id: newParent, ancestry: ancestry.slice(0, -1) },
        },
        {
          shareItemId: n.shareItemId,
          type: n.type,
          nameEnc,
          nameHmac,
          nameKeyId,
          sha256: n.sha256,
          size: n.size === null ? null : Number(n.size),
          mtime: n.mtime,
        },
      );

      const newId = createdNode.id;
      mapped.set(n.id, newId);
      ancestryOf.set(n.id, ancestry);
      if (isRoot) rootNodeId = newId;

      if (n.sha256) {
        // Every version row records the ORIGINAL writer, not the joiner (SH-19): this
        // content is somebody else's work arriving, and attributing it to whoever
        // received it would rewrite authorship on every join.
        for (let i = 0; i < pastRevs.length; i++) {
          const v = past.rows[i]!;
          await recordVersion(c, {
            vaultId: input.vaultId,
            nodeId: newId,
            rev: pastRevs[i]!,
            sha256: v.sha256,
            size: Number(v.size),
            authorId: v.authorId,
            // The original moment, because a past that all happened at the instant of
            // joining is not a past (SH-23).
            at: v.at,
          });
          await claimBlob(c, userId, v.sha256);
        }

        const head = past.rows[past.rows.length - 1];
        await recordVersion(c, {
          vaultId: input.vaultId,
          nodeId: newId,
          rev,
          sha256: n.sha256,
          // `size` arrives as text, because a bigint that crossed a JSON boundary would
          // round: the query casts it and this casts it back.
          size: Number(n.size),
          authorId: head?.authorId ?? userId,
        });
        await claimBlob(c, userId, n.sha256);
      }
    }

    return { rootNodeId };
  });
};

/**
 * Stop propagation and begin leaving.
 *
 * Leaving, revocation and dissolution are one operation seen from three sides (docs/05).
 * All three stop propagation immediately and hand the copy to the affected client, because
 * only it holds the `KV` and the plaintext names its replica must be converted back to.
 * The server cannot finish any of them.
 *
 * **A departure ends the share, never a head count.** Two departures do it:
 * the initiator's (SH-17) and the last joined participant's other than them (SH-07). A
 * share of one that nobody has left is alive and waiting — which is the ordinary state
 * while preparing, after activation before anybody accepts, and again after a decline.
 */
/**
 * One departure, whichever door it came through.
 *
 * Leaving and being revoked are the same state (SH-22): propagation stops, the copy stays,
 * and the client finalizes it later. So the question "did that end the share" has to be
 * asked identically by both — it was asked by `leave` alone, and revoking the last
 * participant therefore left a share `active` with nobody in it but the initiator, which
 * SH-07 does not allow.
 *
 * **A departure, never a head count.** The initiator's ends it (SH-17), and so does the
 * last joined participant's other than them (SH-07). The initiator does not count towards
 * "anybody left": a share is people sharing WITH somebody, and the initiator alone is
 * nobody. That is why a share of one survives its three ordinary moments — preparing,
 * activated before anyone accepts, and after a decline.
 *
 * @param leaving the member going, whether by their own act or the initiator's.
 * @returns whether this closed the share for everybody.
 */
/**
 * One member's departure, and whether it ends the share.
 *
 * Exported because deleting an account has to dissolve every share it is in (#55), and the
 * question "who is left, and does this end it" must have one answer: a second
 * implementation of it would decide differently the first time the rule moved.
 */
export const departMember = async (
  c: PoolClient,
  shareId: string,
  leaving: string,
  initiator: string,
): Promise<boolean> => {
  const remaining = await c.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM share_members
      WHERE share_id = $1 AND user_id <> $2 AND user_id <> $3
        AND joined_at IS NOT NULL AND finalization_started_at IS NULL AND left_at IS NULL`,
    [shareId, leaving, initiator],
  );
  const ends = leaving === initiator || Number(remaining.rows[0]!.n) === 0;

  if (ends) {
    // Which terminal state depends on where it got to, and the schema is strict about it:
    // `preparing` may go only to `cancelled`, `active` only to `ended`. Writing `ended`
    // unconditionally made leaving a share that was still preparing impossible — a
    // `restrict_violation` the caller could do nothing about, on a share nothing else could
    // remove either, since cancelling has no button.
    //
    // They are the same act seen from two distances: a share nobody could join yet is
    // cancelled, one that lived is ended. Both still hand the replica back to its owner's
    // client, which is what the pass after this does.
    //
    // Terminal first, then everybody starts finalizing — the ring cancel walks, for the
    // same reason: the initiator may not leave a share that still lives. A terminal share
    // MAY hold members who are finalizing; what it may not hold is one who has not begun.
    await c.query(
      `UPDATE shares SET state = CASE WHEN state = 'preparing' THEN 'cancelled' ELSE 'ended' END::share_state,
              terminal_at = now()
        WHERE id = $1`,
      [shareId],
    );
    await c.query(
      `UPDATE share_members SET finalization_started_at = now()
        WHERE share_id = $1 AND left_at IS NULL AND finalization_started_at IS NULL`,
      [shareId],
    );
  } else {
    await c.query(
      `UPDATE share_members SET finalization_started_at = now()
        WHERE share_id = $1 AND user_id = $2 AND finalization_started_at IS NULL`,
      [shareId, leaving],
    );
  }
  return ends;
};

export const leaveShare = async (
  db: Db,
  userId: string,
  shareId: string,
): Promise<{ ended: boolean } | Refusal> => {
  return txGuarded(db, async (c) => {
    const shareRes = await c.query<{ state: string; initiator: string }>(
      `SELECT state::text AS state, initiator_id AS initiator FROM shares WHERE id = $1 FOR UPDATE`,
      [shareId],
    );
    const share = shareRes.rows[0];
    if (!share) return { kind: 'not_found' } as Refusal;

    const mine = await c.query<{ started: string | null }>(
      `SELECT finalization_started_at AS started FROM share_members
        WHERE share_id = $1 AND user_id = $2 AND joined_at IS NOT NULL AND left_at IS NULL
          FOR UPDATE`,
      [shareId, userId],
    );
    if (mine.rowCount === 0) return { kind: 'not_found' } as Refusal;

    // Beginning a departure that has already begun is not an error — it is a client coming
    // back to finish. Refusing it was a trap: the pass that converts the replica is the
    // client's, so a device interrupted between the two steps could never reach the second
    // one, and its vault stayed unreadable for as long as it lived.
    if (mine.rows[0]!.started) return { ended: share.state === 'ended' };

    const ends = await departMember(c, shareId, userId, share.initiator);

    return { ended: ends };
  });
};

/** One node of a replica, converted back to the leaver's own vault key. */
export type FinalizeNode = {
  nodeId: string;
  nameEnc: string;
  nameHmac: string;
  nameKeyId: string;
} & Material;

/**
 * Complete a departure: the replica becomes ordinary private files.
 *
 * **Everyone keeps their copy** (SH-05) — that is the promise replication exists to make,
 * and it is why ending a share is a metadata pass rather than a deletion. What changes is
 * only the naming: interior names come back from `KS` to `KV`, so the folder keeps working
 * after the share key stops being shared.
 *
 * **Completeness is checked, not trusted.** A replica half-converted is a folder whose
 * files the owner can no longer open — the failure is silent, permanent, and belongs to
 * the person least able to diagnose it. So every live node still marked for this share must
 * be in the request, and a missing one refuses the whole pass.
 *
 * **History goes for an added participant, and stays for the initiator** (SH-22, SH-25).
 * Theirs was the folder before the share and remains so afterwards; a participant who
 * joined keeps the files without the past that arrived with them. Nothing is removed from
 * anybody ELSE's history — including this leaver's authorship of versions in other copies.
 */
export const finalizeLeave = async (
  db: Db,
  userId: string,
  shareId: string,
  nodes: FinalizeNode[],
): Promise<Refusal | undefined> => {
  return txGuarded(db, async (c) => {
    const memberRes = await c.query<{ vaultId: string; initiator: string }>(
      `SELECT m.vault_id AS "vaultId", s.initiator_id AS initiator
         FROM share_members m JOIN shares s ON s.id = m.share_id
        WHERE m.share_id = $1 AND m.user_id = $2
          AND m.finalization_started_at IS NOT NULL AND m.left_at IS NULL
          FOR UPDATE OF m`,
      [shareId, userId],
    );
    const member = memberRes.rows[0];
    if (!member) return { kind: 'not_found' } as Refusal;

    // **Every** marked node, the trash included. A deleted node keeps its name, and that
    // name is under `KS`; once the pass records that it ran, the key stops being offered and
    // anything still named under it can never be read again — so a file restored from the
    // trash afterwards would come back unopenable. The schema says the same thing from its
    // own side: a member may not leave while any node of theirs still carries the mark.
    const live = await c.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 FOR UPDATE`,
      [member.vaultId, shareId],
    );
    const supplied = new Set(nodes.map((n) => n.nodeId));
    const missing = live.rows.filter((r) => !supplied.has(r.id)).map((r) => r.id);
    if (missing.length > 0) {
      return { kind: 'finalization_incomplete', missing: missing.slice(0, 20) } as Refusal;
    }

    // The history goes FIRST, and all of it, for an added participant (SH-22). The schema
    // checks this at the moment a node is unmarked — "an added participant keeps the files
    // alone" — so deleting afterwards is too late; and deleting only the older revisions is
    // not enough, because what leaves with the share is the past, not the file. The file
    // itself survives on the node's own reference, which is what "you keep your copy" means.
    //
    // The initiator keeps everything (SH-25): theirs was the folder before the share and
    // remains so after it.
    if (userId !== member.initiator) {
      await c.query(`DELETE FROM versions WHERE vault_id = $1 AND node_id = ANY($2::uuid[])`, [
        member.vaultId,
        nodes.map((n) => n.nodeId),
      ]);
    }

    for (const n of nodes) {
      await writeMaterial(c, { envelopes: n.envelopes ?? [], dedupTags: n.dedupTags ?? [] });
      const res = await c.query(
        `UPDATE nodes
            SET name_enc = decode($1,'base64'), name_hmac = decode($2,'hex'), name_key_id = $3,
                share_id = NULL, share_item_id = NULL
          WHERE vault_id = $4 AND id = $5 AND share_id = $6`,
        [n.nameEnc, n.nameHmac, n.nameKeyId, member.vaultId, n.nodeId, shareId],
      );
      if (res.rowCount === 0) {
        return { kind: 'invalid_write', detail: `node ${n.nodeId} is not part of this share` } as Refusal;
      }
    }

    // The claims those versions were holding: a departing participant keeps the files and
    // loses the history (SH-22), so what nothing of theirs points at any more stops counting.
    if (userId !== member.initiator) await dropUnreferenced(c, userId);

    await c.query(`UPDATE share_members SET left_at = now() WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      userId,
    ]);
    return undefined;
  });
};


/**
 * The public key a share key must be sealed to, for a login the initiator names.
 *
 * **An unknown login gets a deterministic fake pair, never a 404** (#73) — the same rule
 * `/auth/kdf` follows, and for the same reason: this endpoint takes a login, so a distinct
 * answer for "no such account" is an enumeration oracle. The fake must also be *stable*, or
 * two calls would differ and give the answer away more plainly than a 404 would.
 *
 * The residual is named rather than claimed away (docs/04): a caller who follows a probe
 * through to an invite still learns the account does not exist, because the invitation
 * fails. That is weaker than `/auth/kdf`'s guarantee and proportionate for a different
 * reason — this sits behind authentication on a server where accounts exist only because an
 * administrator made one.
 *
 * Initiator only: nobody else has any business asking who could be invited here.
 */
export const recipientPubkey = async (
  db: Db,
  serverSecret: string,
  userId: string,
  shareId: string,
  login: string,
): Promise<{ userId: string; pubkey: string } | Refusal> => {
  const share = await db.one<{ initiator: string }>(`SELECT initiator_id AS initiator FROM shares WHERE id = $1`, [
    shareId,
  ]);
  if (!share || share.initiator !== userId) return { kind: 'not_found' };

  const found = await db.one<{ id: string; pubkey: string | null }>(
    `SELECT id, encode(pubkey, 'base64') AS pubkey
       FROM users WHERE lower(login) = lower($1) AND state = 'active'`,
    [login],
  );
  // A console account is `active` and has no `pubkey` at all (#115). Without this it fell
  // through as a recipient carrying a null key, and the failure surfaced two calls later as
  // an envelope sealed to nothing — the initiator being told their share is broken, about an
  // account that was never a possible participant.
  if (found && found.pubkey === null) return { kind: 'console_account' };
  if (found) return { userId: found.id, pubkey: found.pubkey! };

  const fake = fakeRecipient(serverSecret, login);
  return { userId: fake.userId, pubkey: fake.pubkey.toString('base64') };
};
