import { Readable } from 'node:stream';
import type { Db } from '../db.js';
import { isFrozen } from '../account.js';
import type { Refusal } from '../refuse.js';
import type { Config } from '../config.js';
import { HashMismatch, PartsMissing, type BlobStore } from './store.js';
import type { RateLimiter } from './rate.js';

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

/**
 * A Range header, parsed. `undefined` for "no range"; `'unsatisfiable'` when the request
 * cannot be served (the route answers `416`).
 *
 * Exported rather than buried in the route because the edge cases are real: a suffix form
 * (`bytes=-N`), an open upper bound, `start >= total`, `start > end`. Each deserves a test,
 * and a pure function is the cheapest way to give it one.
 */
export const parseRange = (
  header: string | undefined,
  total: number,
): { start: number; end: number } | undefined | 'unsatisfiable' => {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'unsatisfiable';

  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;

  if (rawStart === '') {
    // "bytes=-N" — the last N bytes.
    const n = Number(rawEnd);
    if (!Number.isInteger(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= total) return 'unsatisfiable';
  return { start, end: Math.min(end, total - 1) };
};

/** Every way an upload can be refused — the shared refusal vocabulary, see refuse.ts. */
export type IntakeResult<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface AcceptWholeInput {
  userId: string;
  deviceId: string;
  sha256: Buffer;
  size: number;
  encAlg: string;
  keyId: string;
  body: Readable;
}

export interface AcceptPartInput {
  userId: string;
  deviceId: string;
  sha256: Buffer;
  index: number;
  total: number;
  size: number;
  body: Readable;
}

export interface CompleteInput {
  userId: string;
  deviceId: string;
  sha256: Buffer;
  size: number;
  encAlg: string;
  keyId: string;
}

/**
 * The blob intake: accept a whole blob, one part of a resumable upload, or assemble staged
 * parts and record the claim. This is the module docs/02 calls `BlobService` — the ordering
 * is its invariant, not the route's.
 *
 * The single rule the three operations share, in the order they must run: **admit first**
 * (a registered, un-revoked device; quota from the blob's WHOLE size; the per-upload ceiling),
 * then reserve rate, then write, then verify size, then discard on disagreement, then — and
 * only then — record the claim. A `user_blobs` row is a claim on content, and creating one
 * from a declared hash before the bytes prove it would let anyone who merely learned an
 * address claim a blob somebody else then uploads (docs/04).
 *
 * `parts_missing` is the one refusal that does NOT discard: a hole is what a resume is for.
 * Every other failure discards — the server cannot attribute a mismatch to a part, so
 * leaving the staging would let the client retry into the same wall for ever.
 */
export class BlobService {
  constructor(
    private readonly db: Db,
    private readonly store: BlobStore,
    private readonly rate: RateLimiter,
    private readonly limits: Config['limits'],
  ) {}

  async acceptWhole(input: AcceptWholeInput): Promise<IntakeResult<{ sha256: string; size: number }>> {
    const refused = await this.admit(input.userId, input.deviceId, input.sha256, input.size);
    if (refused) return { ok: false, refusal: refused };

    const rate = this.rate.reserve(input.userId, input.size);
    if (!rate.ok) return { ok: false, refusal: { kind: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds } };

    let stored;
    try {
      stored = await this.store.put(input.sha256.toString('hex'), input.body);
    } catch (e) {
      if (e instanceof HashMismatch) return { ok: false, refusal: { kind: 'address_mismatch' } };
      throw e;
    }

    if (stored.size !== input.size) {
      await this.store.remove(stored.storageKey);
      return { ok: false, refusal: { kind: 'size_mismatch' } };
    }

    await this.recordUpload(input.userId, input.deviceId, input.sha256, stored.size, stored.storageKey, input.encAlg, input.keyId);
    return { ok: true, value: { sha256: input.sha256.toString('hex'), size: stored.size } };
  }

  async acceptPart(input: AcceptPartInput): Promise<IntakeResult<{ sha256: string }>> {
    if (input.size > this.limits.uploadPartBytes) return { ok: false, refusal: { kind: 'part_too_large' } };

    const refused = await this.admit(input.userId, input.deviceId, input.sha256, input.total);
    if (refused) return { ok: false, refusal: refused };

    // The in-flight ceiling, measured from the staging area rather than from rows — parts
    // have no rows, so this directory is where "unfinished" is written down (docs/04).
    const inFlight = await this.store.stagedBytes(input.userId);
    if (inFlight + input.size > this.limits.unfinishedUploadBytes) {
      return { ok: false, refusal: { kind: 'too_many_unfinished' } };
    }

    const rate = this.rate.reserve(input.userId, input.size);
    if (!rate.ok) return { ok: false, refusal: { kind: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds } };

    const { size } = await this.store.stagePart(input.userId, input.sha256.toString('hex'), input.index, input.body);
    if (size !== input.size) {
      await this.store.discardPart(input.userId, input.sha256.toString('hex'), input.index);
      return { ok: false, refusal: { kind: 'size_mismatch' } };
    }

    return { ok: true, value: { sha256: input.sha256.toString('hex') } };
  }

  async complete(input: CompleteInput): Promise<IntakeResult<{ sha256: string; size: number }>> {
    const refused = await this.admit(input.userId, input.deviceId, input.sha256, input.size);
    if (refused) return { ok: false, refusal: refused };

    const hex = input.sha256.toString('hex');
    let stored;
    try {
      stored = await this.store.assemble(input.userId, hex);
    } catch (e) {
      if (e instanceof PartsMissing) {
        // The only refusal that does NOT discard: a hole is what a resume is for, and
        // throwing the upload away here would make an early `complete` destructive.
        return { ok: false, refusal: { kind: 'parts_missing', have: e.have } };
      }
      await this.store.discardStaging(input.userId, hex);
      if (e instanceof HashMismatch) return { ok: false, refusal: { kind: 'address_mismatch' } };
      throw e;
    }

    if (stored.size !== input.size) {
      await this.store.remove(stored.storageKey);
      await this.store.discardStaging(input.userId, hex);
      return { ok: false, refusal: { kind: 'size_mismatch' } };
    }

    await this.recordUpload(input.userId, input.deviceId, input.sha256, stored.size, stored.storageKey, input.encAlg, input.keyId);
    await this.store.discardStaging(input.userId, hex);
    return { ok: true, value: { sha256: hex, size: stored.size } };
  }

  /**
   * What both upload paths must clear before a byte is written (docs/04).
   *
   * "An authenticated session AND a registered device" (#33). The access token names a
   * device, but a token outlives the row: signing a device out has to mean something before
   * the token expires, or "sign out this device" is advice rather than an act (#90).
   *
   * Quota is answered from the blob's WHOLE size, not from what this request carries, so a
   * resumable upload that cannot fit is refused at its first part rather than at its last.
   */
  private async admit(userId: string, deviceId: string, sha256: Buffer, totalBytes: number): Promise<Refusal | undefined> {
    const device = await this.db.one<{ id: string }>(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [deviceId, userId],
    );
    if (!device) return { kind: 'device_revoked' };

    if (totalBytes > this.limits.unfinishedUploadBytes) return { kind: 'too_large' };

    const verdict = await this.mayAccept(userId, sha256, totalBytes);
    if (!verdict.ok) return verdict.reason === 'frozen' ? { kind: 'frozen' } : { kind: 'over_quota' };
    return undefined;
  }

  private async mayAccept(userId: string, sha256: Buffer, size: number): Promise<{ ok: true } | { ok: false; reason: 'frozen' | 'over_quota' }> {
    // A frozen account may not send anything that grows usage (SH-20). Reads and deletes
    // stay available — deleting is the only way out, so a freeze that blocked it would be a
    // deadlock. The frozen rule lives in account.ts, the same place every write checks it.
    if (await isFrozen(this.db, userId)) return { ok: false, reason: 'frozen' };

    const row = await this.db.one<{ quota: string; used: string; alreadyHeld: boolean }>(
      `SELECT u.quota_bytes::text           AS quota,
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

    // The blob already counts against the account, so this upload grows usage by zero.
    const growth = row.alreadyHeld ? 0n : BigInt(size);
    if (BigInt(row.used) + growth > BigInt(row.quota)) return { ok: false, reason: 'over_quota' };
    return { ok: true };
  }

  /**
   * Record an accepted blob and the account's claim on it, in one transaction.
   *
   * The claim starts as `refs_pending`: uploaded and not yet referenced by a node. That row
   * is the whole of the unbound state — the parts of a resumable upload are staging files,
   * not rows, which is why the schema has no `uploads` table. It counts against quota while
   * it lives and is swept on its TTL, so content cannot be parked on the server for free.
   */
  private async recordUpload(
    userId: string,
    deviceId: string,
    sha256: Buffer,
    size: number,
    storageKey: string,
    encAlg: string,
    keyId: string,
  ): Promise<void> {
    await this.db.tx(async (c) => {
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
        [sha256, size, storageKey, encAlg, keyId],
      );
      await c.query(
        `INSERT INTO user_blobs (user_id, sha256, refs_pending, pending_since, pending_device_id)
         VALUES ($1, $2, 1, now(), $3)
         ON CONFLICT (user_id, sha256)
         DO UPDATE SET refs_pending = user_blobs.refs_pending + 1,
                       pending_since = COALESCE(user_blobs.pending_since, now()),
                       pending_device_id = EXCLUDED.pending_device_id`,
        [userId, sha256, deviceId],
      );
    });
  }
}
