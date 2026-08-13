import type { Db } from '../db.js';

/**
 * > A hash is not a capability.
 *
 * Deduplication means the same address is visible to many accounts (#42). If a read
 * checked only *existence*, anyone who learned an address — from their own copy of the
 * file, from a log — could read somebody else's content.
 *
 * So both `HEAD` and `GET` require a **live reference belonging to the caller**, and under
 * replication that is a single condition: `user_blobs.refs_own > 0`, the blob is held by
 * one of their own nodes or their own history (#20). A share grants no access that
 * ownership does not already describe, which is why there is no second branch.
 */
export const callerHoldsBlob = async (db: Db, userId: string, sha256: Buffer): Promise<boolean> => {
  const row = await db.one<{ held: boolean }>(
    `SELECT (refs_own > 0) AS held FROM user_blobs WHERE user_id = $1 AND sha256 = $2`,
    [userId, sha256],
  );
  return row?.held ?? false;
};

/**
 * The envelopes a caller can actually open, for blobs they actually hold.
 *
 * Without this a client can download a blob and not read it: the delta describes the node,
 * `GET /blobs` returns ciphertext, and the content key lives wrapped in `blob_keys` with no
 * way to ask for it. M0 never noticed, because nothing read anything back.
 *
 * Two conditions, and both are the same rule stated once each way. The caller must hold a
 * **live reference** to the blob — the identical test `GET /blobs` applies (#20), because an
 * envelope is worth exactly as much as the bytes it opens. And the envelope must be in a
 * scope the caller holds, which for now is their own vault's key scope; a share adds more
 * (docs/06), and this query is written so that adding them is a wider `IN`, not a rewrite.
 */
export const envelopesFor = async (
  db: Db,
  userId: string,
  vaultId: string,
  addresses: Buffer[],
): Promise<{ sha256: string; scopeId: string; wrappedKey: string }[]> =>
  db.query<{ sha256: string; scopeId: string; wrappedKey: string }>(
    `SELECT encode(bk.sha256, 'hex') AS sha256,
            bk.scope_id               AS "scopeId",
            encode(bk.wrapped_key, 'base64') AS "wrappedKey"
       FROM blob_keys bk
       JOIN vaults v      ON v.id = $2 AND v.user_id = $1
       JOIN user_blobs ub ON ub.sha256 = bk.sha256 AND ub.user_id = $1 AND ub.refs_own > 0
      WHERE bk.sha256 = ANY($3::bytea[])
        AND bk.scope_id IN (v.vault_key_id)`,
    [userId, vaultId, addresses],
  );

export const storageKeyOf = async (db: Db, sha256: Buffer): Promise<string | undefined> => {
  const row = await db.one<{ storageKey: string }>(
    `SELECT storage_key AS "storageKey" FROM blobs WHERE sha256 = $1`,
    [sha256],
  );
  return row?.storageKey;
};

export interface QuotaVerdict {
  ok: boolean;
  reason?: 'frozen' | 'over_quota';
}

/**
 * Quota is reserved **before** the upload starts, not checked after — otherwise it is
 * checked when the bytes are already on the disk it was meant to protect (#33).
 *
 * Usage is `SUM(size)` over the account's `user_blobs` and nowhere else (AC-Q2), so a
 * blob the account already holds costs nothing to send again (#46): its size is already
 * inside `used`, and the address is the content, so a second copy changes nothing.
 * Charging it again would bill the same bytes twice at the quota boundary.
 */
export const mayAccept = async (db: Db, userId: string, sha256: Buffer, size: number): Promise<QuotaVerdict> => {
  const row = await db.one<{ frozen: boolean; quota: string; used: string; alreadyHeld: boolean }>(
    `SELECT u.frozen_at IS NOT NULL       AS frozen,
            u.quota_bytes::text           AS quota,
            COALESCE(SUM(b.size), 0)::text AS used,
            EXISTS (SELECT 1 FROM user_blobs u2
                     WHERE u2.user_id = u.id AND u2.sha256 = $2) AS "alreadyHeld"
       FROM users u
       LEFT JOIN user_blobs ub ON ub.user_id = u.id
       LEFT JOIN blobs b       ON b.sha256   = ub.sha256
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId, sha256],
  );
  if (!row) return { ok: false, reason: 'over_quota' };

  // A frozen account may not send anything that grows usage (SH-20). Reads and deletes
  // stay available — deleting is the only way out, so a freeze that blocked it would be a
  // deadlock.
  if (row.frozen) return { ok: false, reason: 'frozen' };

  // The blob already counts against the account, so this upload grows usage by zero.
  const growth = row.alreadyHeld ? 0n : BigInt(size);
  if (BigInt(row.used) + growth > BigInt(row.quota)) return { ok: false, reason: 'over_quota' };
  return { ok: true };
};

/**
 * Record an accepted blob and the account's claim on it, in one transaction.
 *
 * The claim starts as `refs_pending`: uploaded and not yet referenced by a node. That row
 * is the whole of the unbound state — the parts of a resumable upload are staging files,
 * not rows, which is why the schema has no `uploads` table. It counts against quota while
 * it lives and is swept on its TTL, so content cannot be parked on the server for free.
 */
export const recordUpload = async (
  db: Db,
  args: { userId: string; deviceId: string; sha256: Buffer; size: number; storageKey: string; encAlg: string; keyId: string },
): Promise<void> => {
  await db.tx(async (c) => {
    // The address IS the content, so a second upload of the same bytes is not a conflict:
    // the row already there is correct by construction (#19).
    //
    // `DO UPDATE`, not `DO NOTHING`, and the update is deliberately a no-op: what is wanted
    // is the **row lock** the update branch takes. `DO NOTHING` takes none, which leaves a
    // window where the collector removes this blob as an orphan between this statement and
    // the next one — and the next one is an FK child of it, so the upload dies on a
    // constraint violation. Holding the lock makes that DELETE wait for this transaction
    // and then re-check its references, which is exactly what the collector's re-checking
    // DELETE is documented to do.
    //
    // The assignment is to `gc_marked_at` rather than to any identity column so that
    // `blobs_identity_immutable` — which fires only on the columns it names — is not
    // involved at all. A no-op write should not have to be forgiven by a guard.
    await c.query(
      `INSERT INTO blobs (sha256, size, storage_key, enc_alg, key_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha256) DO UPDATE SET gc_marked_at = blobs.gc_marked_at`,
      [args.sha256, args.size, args.storageKey, args.encAlg, args.keyId],
    );
    await c.query(
      `INSERT INTO user_blobs (user_id, sha256, refs_pending, pending_since, pending_device_id)
       VALUES ($1, $2, 1, now(), $3)
       ON CONFLICT (user_id, sha256)
       DO UPDATE SET refs_pending = user_blobs.refs_pending + 1,
                     pending_since = COALESCE(user_blobs.pending_since, now()),
                     pending_device_id = EXCLUDED.pending_device_id`,
      [args.userId, args.sha256, args.deviceId],
    );
  });
};
