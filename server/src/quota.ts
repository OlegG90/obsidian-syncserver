/**
 * What an account is using, and whether more will fit.
 *
 * AC-Q2 states it in one sentence — usage is `SUM(size)` over the account's `user_blobs`
 * rows and **nowhere else** — and that sentence was written as SQL twice: once by the
 * account surface that reports the number, once by the blob intake that enforces it. Two
 * queries answering one question is the shape a rule takes shortly before the two stop
 * agreeing, and the disagreement would be invisible: the surface would keep showing a
 * figure the intake no longer used.
 *
 * There is **one** query here, and both entry points are it. `fits` passes an address and
 * gets `alreadyHeld` alongside the sum; `usageOf` passes none and the flag is false. That
 * is why the address is a parameter of the shared statement rather than a second statement.
 *
 * On the `Queryable` seam for the same reason `account.ts` is (docs/04): the routes hold a
 * `Db`, the write paths hold a `PoolClient` inside `db.tx`, and a rule that only one of them
 * can call gets restated by the other.
 *
 * **Not here: the reference counts themselves.** Binding a blob to a node, releasing it on
 * delete, and recounting the whole account after a reset all write `user_blobs` — but they
 * are three different operations that happen to touch one table, not three spellings of one
 * rule. What keeps them honest is `row_must_be_referenced` in the schema, which is where a
 * constraint belongs.
 */
import type { Queryable } from './db.js';

export interface Usage {
  /**
   * Bytes the account holds.
   *
   * `bigint`, because the comparison against the quota is the one place a rounding error
   * would silently let an account past its limit — `number` stops being exact above 2^53,
   * and a quota check is precisely a question about the last byte.
   */
  used: bigint;
  quota: bigint;
}

/**
 * The one statement. `alreadyHeld` is false when no address is given, so the two callers
 * differ by an argument rather than by a query.
 */
const read = (q: Queryable, userId: string, sha256: Buffer | null) =>
  q.one<{ used: string; quota: string; alreadyHeld: boolean }>(
    `SELECT COALESCE(SUM(b.size), 0)::text AS used,
            u.quota_bytes::text            AS quota,
            ($2::bytea IS NOT NULL AND EXISTS (
               SELECT 1 FROM user_blobs u2 WHERE u2.user_id = u.id AND u2.sha256 = $2
            )) AS "alreadyHeld"
       FROM users u
       LEFT JOIN user_blobs ub ON ub.user_id = u.id
       LEFT JOIN blobs b       ON b.sha256   = ub.sha256
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId, sha256],
  );

/**
 * What the account holds and what it is allowed, or `undefined` if there is no such account.
 *
 * Because keys are per vault, the same file in two vaults is two blobs and is counted twice
 * — the price of vaults not deduplicating against each other (AC-09), and a number the user
 * should be able to see rather than deduce.
 */
export const usageOf = async (q: Queryable, userId: string): Promise<Usage | undefined> => {
  const row = await read(q, userId, null);
  return row ? { used: BigInt(row.used), quota: BigInt(row.quota) } : undefined;
};

/**
 * Whether `size` more bytes fit, counting a blob the account already holds as **zero
 * growth** (#46).
 *
 * That exception is not an optimisation. The address is the content, so a second copy adds
 * nothing to the disk; charging for it would bill the same bytes twice at the very boundary
 * where being wrong refuses a write the account has room for.
 *
 * An account that does not exist does not fit anything — the caller is expected to have
 * authenticated, so this is the answer that fails closed rather than a case to report.
 */
export const fits = async (q: Queryable, userId: string, sha256: Buffer, size: number): Promise<boolean> => {
  const row = await read(q, userId, sha256);
  if (!row) return false;
  const growth = row.alreadyHeld ? 0n : BigInt(size);
  return BigInt(row.used) + growth <= BigInt(row.quota);
};

/**
 * How many more bytes this account may hold.
 *
 * A third caller, and the reason it belongs here rather than in the one that needed it:
 * joining a share adds MANY blobs at once, so `fits` — which asks about one address — does
 * not answer its question. What it must not do is ask the question a different way; the
 * `SUM` over `user_blobs` is this module's whole point.
 *
 * So the sum stays here and the caller supplies the growth. Which blobs are new is a fact
 * about a subtree, not about quota, and it is the caller that knows it.
 */
export const headroom = async (q: Queryable, userId: string): Promise<bigint | undefined> => {
  const row = await read(q, userId, null);
  if (!row) return undefined;
  return BigInt(row.quota) - BigInt(row.used);
};
