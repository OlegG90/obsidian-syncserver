/**
 * Reading the delta, and deciding when a cursor can no longer be answered.
 */
import type { Change, CursorPayload, CursorRejection } from '@syncserver/shared';
import type { Db } from '../db.js';

/**
 * The row as `pg` hands it back — bigint columns arrive as text, so the wire shape (numbers)
 * is restored after the query. The mapping below is the only place that conversion happens.
 * A type alias, not an interface: only the former satisfies the Row constraint (an
 * interface has no implicit index signature).
 */
type ChangeRow = Omit<Change, 'rev' | 'size'> & { rev: string; size: string | null };

/** Convert a row's text columns back to the wire shape. */
const toChange = (r: ChangeRow): Change => ({
  ...r,
  rev: Number(r.rev),
  size: r.size === null ? null : Number(r.size),
});

export interface VaultPosition {
  headRev: number;
  resetEpoch: number;
  restoreEpoch: number;
  oldestJournalRev: number | null;
}

export const readPosition = async (db: Db, vaultId: string): Promise<VaultPosition | undefined> => {
  const row = await db.one<{ head: string; reset: string; restore: string; oldest: string | null }>(
    `SELECT v.head_rev::text     AS head,
            v.reset_epoch::text  AS reset,
            m.restore_epoch::text AS restore,
            (SELECT min(rev)::text FROM journal WHERE vault_id = v.id) AS oldest
       FROM vaults v CROSS JOIN server_meta m
      WHERE v.id = $1`,
    [vaultId],
  );
  if (!row) return undefined;
  return {
    headRev: Number(row.head),
    resetEpoch: Number(row.reset),
    restoreEpoch: Number(row.restore),
    oldestJournalRev: row.oldest === null ? null : Number(row.oldest),
  };
};

/**
 * Why this cursor cannot be answered, if it cannot.
 *
 * Three reasons, two behaviours, and the difference is the direction the server moved. A
 * restore takes it **backwards**, so a node missing from the listing proves nothing and
 * deletions must not be applied. A reset and an expired journal leave it where it was or
 * ahead, so the listing is current and deletions are applied.
 */
export const rejectionFor = (cursor: CursorPayload, at: VaultPosition): CursorRejection | undefined => {
  const restored = cursor.epoch.restore !== at.restoreEpoch;
  const reset = cursor.epoch.reset !== at.resetEpoch;

  // Both stale at once: `restore` wins. The instructions contradict each other over the
  // same local files, and the mistakes are not the same size — applying deletions after a
  // rollback destroys work that exists nowhere else, while skipping them after a reset
  // costs the user one more deletion (D-70).
  if (restored) return 'restore';
  if (reset) return 'reset';

  // Entries the client still needs are those above its position. If the oldest surviving
  // row is further along than that, the ones in between were pruned by the 90-day TTL and
  // the gap cannot be described.
  if (at.oldestJournalRev !== null && at.oldestJournalRev > cursor.rev + 1) return 'journal_ttl';

  return undefined;
};

/**
 * One row per node, not one per revision.
 *
 * A node touched forty times while the client was away is forty journal rows and one
 * change: the state it is in now. Collapsing here rather than on the client is what keeps
 * a long absence from costing more than a short one.
 *
 * The upper bound is the **pinned snapshot**, never `now`: without it a resync of a large
 * vault will reliably either lose a change that happened mid-walk or apply it twice (D-24).
 */
export const readChanges = async (
  db: Db,
  vaultId: string,
  after: number,
  upTo: number,
  limit: number,
): Promise<Change[]> =>
  db.query<ChangeRow>(
    `SELECT DISTINCT ON (j.node_id)
            j.node_id,
            n.parent_id,
            encode(n.name_enc, 'base64')  AS name_enc,
            encode(n.name_hmac, 'hex')    AS name_hmac,
            n.name_key_id,
            j.op::text                    AS op,
            j.rev::text                   AS rev,
            encode(n.sha256, 'hex')       AS sha256,
            n.size::text                  AS size,
            n.mtime,
            n.share_id,
            (SELECT ve.author_id FROM versions ve
              WHERE ve.vault_id = j.vault_id AND ve.node_id = j.node_id AND ve.rev = j.node_rev)
                                          AS author_id
       FROM journal j
       JOIN nodes n ON n.vault_id = j.vault_id AND n.id = j.node_id
      WHERE j.vault_id = $1 AND j.rev > $2 AND j.rev <= $3
      ORDER BY j.node_id, j.rev DESC
      LIMIT $4`,
    [vaultId, after, upTo, limit],
  ).then((rows) =>
    // DISTINCT ON needs its own ordering; the client wants them in the order they happened.
    rows.map(toChange).sort((a, b) => a.rev - b.rev),
  );

export const listSubtree = async (
  db: Db,
  vaultId: string,
  under: string | undefined,
): Promise<Change[]> =>
  db.query<ChangeRow>(
    `SELECT n.id AS node_id, n.parent_id,
            encode(n.name_enc, 'base64') AS name_enc,
            encode(n.name_hmac, 'hex')   AS name_hmac,
            n.name_key_id,
            'put'::text                  AS op,
            n.rev::text                  AS rev,
            encode(n.sha256, 'hex')      AS sha256,
            n.size::text                 AS size,
            n.mtime, n.share_id,
            NULL::uuid                   AS author_id
       FROM nodes n
      WHERE n.vault_id = $1
        AND n.deleted_at IS NULL
        AND ($2::uuid IS NULL OR n.id = $2 OR n.ancestry @> ARRAY[$2::uuid])
      ORDER BY array_length(n.ancestry, 1) NULLS FIRST, n.id`,
    [vaultId, under ?? null],
  ).then((rows) => rows.map(toChange));
