/**
 * Lifting a freeze, and what has to happen in the same breath (SH-20, SH-21).
 *
 * **Why this is not in `quota.ts`.** Quota answers one question — how much of the limit is
 * used, and whether more will fit — and it answers it for the blob intake, the account
 * surface and propagation alike. Deciding that a thaw must catch every shared folder up is
 * a statement about *shares*, and putting it there made the accounting module import the
 * share domain while the share domain imported it back: a cycle in which neither half could
 * be read, or tested, without the other.
 *
 * So the direction is settled here. `quota.ts` keeps the arithmetic and knows nothing about
 * shares; this module knows about both, which is exactly what an orchestration is.
 */
import type { PoolClient } from 'pg';
import { oneFrom } from '../db.js';
import { headroom } from '../quota.js';
import { catchUpMember, type CaughtUp } from './catchup.js';

/**
 * Lift the freeze once the account is back inside its limit, and catch its replicas up.
 *
 * The mirror of `freezeIfOverQuota`, and it has to be one: a freeze that only ever went on
 * is a state with no exit, and "delete something" — the advice SH-20 gives — would be advice
 * that changes nothing.
 *
 * **Thawing is not the end of it.** Propagation skipped this account for the whole freeze, so
 * lifting it leaves every shared folder behind by exactly that interval and nothing will ever
 * mention those writes again. The catch-up runs here, in the same transaction, because a
 * thawed account that is level with nobody is a worse state than a frozen one: it looks
 * current and is not.
 *
 * @returns what each share had to be brought forward by, or `undefined` if nothing thawed.
 */
export const thawIfUnderQuota = async (c: PoolClient, userId: string): Promise<CaughtUp[] | undefined> => {
  const room = await headroom(oneFrom(c), userId);
  if (room === undefined || room < 0n) return undefined;

  const thawed = await c.query(
    `UPDATE users SET frozen_at = NULL WHERE id = $1 AND frozen_at IS NOT NULL`,
    [userId],
  );
  if (!thawed.rowCount) return undefined;

  return catchUpMember(c, userId);
};
