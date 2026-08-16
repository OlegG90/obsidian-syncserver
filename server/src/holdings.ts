/**
 * The two rows that follow a vault holding bytes: the account's claim on them, and the
 * version that records who put them there.
 *
 * They travel together everywhere content arrives — a private write, a propagated one, a
 * joiner receiving history, a thawed replica catching up — and had been written out at each
 * of those, identically, in four modules. The statements are short enough that copying them
 * feels harmless, which is exactly what makes it the kind of duplication that lasts: nothing
 * ever fails, the copies simply stop agreeing.
 *
 * They are **not** the client's key material, which is `material.ts` and is written from what
 * the client sealed. These are the server's own bookkeeping: quota (AC-Q2) counts the claims,
 * and history is the version rows.
 */
import type { PoolClient } from 'pg';

/**
 * An account's claim on a blob it now references.
 *
 * `refs_own` is what quota counts, and the row must never sit at zero —
 * `row_must_be_referenced` in the schema refuses it, and a row claiming nothing would still
 * be summed.
 *
 * **Not the shape a private write needs.** Binding a blob the same device uploaded also
 * settles the pending reservation it made (`refs_pending`), and that path keeps its own
 * statement in `nodes/service.ts`: this one is for content that arrived from somebody else,
 * where there is no reservation to settle.
 */
export const claimBlob = async (c: PoolClient, userId: string, sha256Hex: string): Promise<void> => {
  await c.query(
    `INSERT INTO user_blobs (user_id, sha256, refs_own) VALUES ($1, decode($2,'hex'), 1)
     ON CONFLICT (user_id, sha256) DO UPDATE SET refs_own = user_blobs.refs_own + 1`,
    [userId, sha256Hex],
  );
};

/**
 * The same claim, for content this device uploaded itself.
 *
 * Binding a blob to a node also settles the reservation the upload made: `refs_pending` goes
 * down as `refs_own` goes up, in the same statement and the same transaction as the reference
 * that caused it (invariant 8). There is no lazy half of the accounting — a counter
 * reconciled later is a counter that is wrong in between.
 *
 * **Two shapes, and the difference is which story the bytes have.** Content that arrived from
 * somebody else — propagated, joined, caught up — never had a reservation here, so `claimBlob`
 * is the whole of it. Picking the wrong one is not a crash: it is a `refs_pending` that never
 * comes down, and a quota that quietly counts a reservation forever.
 */
export const bindBlob = async (c: PoolClient, userId: string, sha256Hex: string): Promise<void> => {
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

/**
 * Drop every claim this account no longer has any reason to hold.
 *
 * Set-based rather than per-blob, and that is the shape the design actually arrived at: a
 * departure discards a whole history at once (SH-22), and asking "does anything of mine still
 * point at these bytes" is one question about the account, not one per file.
 *
 * **Quota counts the row**, not the number on it (docs/03), so a blob this account references
 * nowhere must lose its row entirely or the leaver keeps paying for history they no longer
 * have. `refs_pending = 0` is what keeps an upload in flight from being swept out from under
 * itself.
 */
export const dropUnreferenced = async (c: PoolClient, userId: string): Promise<void> => {
  await c.query(
    `DELETE FROM user_blobs ub
      WHERE ub.user_id = $1
        AND NOT EXISTS (SELECT 1 FROM nodes n JOIN vaults va ON va.id = n.vault_id
                         WHERE va.user_id = $1 AND n.sha256 = ub.sha256 AND n.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM versions v JOIN vaults va ON va.id = v.vault_id
                         WHERE va.user_id = $1 AND v.sha256 = ub.sha256)
        AND ub.refs_pending = 0`,
    [userId],
  );
};

/**
 * **There is no per-blob release here, and that is the honest state of it.**
 *
 * Nothing in this product hard-deletes a node that holds content: a delete is soft, and the
 * row *is* the trash entry (docs/03). So the only paths that lower usage are a departure
 * (above), a vault reset, which recounts from scratch, and deleting an empty vault. A
 * per-blob decrement existed in `nodes/service.ts` for months with no caller — correct SQL,
 * unreachable, and reading like evidence that releasing was wired when it was not.
 *
 * It is removed rather than kept, for the same reason the placeholder recovery values were:
 * code that claims a capability nobody can reach is worse than its absence, because it stops
 * the question being asked. The question is on the roadmap — emptying the trash, with blob GC
 * in M4 — and when it is answered, the statement belongs **here**, beside the two that add.
 */

/** One version row: what the node pointed at, at which revision, written by whom. */
export interface VersionRow {
  vaultId: string;
  nodeId: string;
  rev: number;
  sha256: string;
  size: number;
  /**
   * The ORIGINAL author, never whoever received the write (SH-19).
   *
   * Attributing a propagated version to its recipient rewrites authorship in every copy, and
   * the mistake is invisible until somebody asks who changed a file.
   */
  authorId: string;
  /**
   * When it was written, for history that is being **copied** rather than made: a joiner
   * receives each file's past (SH-23), and a past that all happened at the moment of joining
   * is not a past. Omitted for a version being written now, which takes the default.
   */
  at?: string;
  /**
   * Tolerate a row that is already there.
   *
   * Only the catch-up needs it: it walks a whole replica and may meet versions a previous
   * pass delivered. Everywhere else a collision means two writers claimed one revision, and
   * that must fail rather than be absorbed.
   */
  ifAbsent?: boolean;
}

export const recordVersion = async (c: PoolClient, v: VersionRow): Promise<{ written: boolean }> => {
  const res = await c.query(
    `INSERT INTO versions (vault_id, node_id, rev, sha256, size, author_id${v.at ? ', at' : ''})
     VALUES ($1, $2, $3, decode($4,'hex'), $5, $6${v.at ? ', $7' : ''})
     ${v.ifAbsent ? 'ON CONFLICT (vault_id, node_id, rev) DO NOTHING' : ''}`,
    v.at
      ? [v.vaultId, v.nodeId, v.rev, v.sha256, v.size, v.authorId, v.at]
      : [v.vaultId, v.nodeId, v.rev, v.sha256, v.size, v.authorId],
  );
  return { written: res.rowCount === 1 };
};
