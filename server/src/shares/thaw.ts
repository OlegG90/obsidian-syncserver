/**
 * Settling a freeze, and what has to happen in the same breath (SH-20, SH-21).
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
import { isFrozen } from '../account.js';
import { freezeIfOverQuota, headroom } from '../quota.js';
import { catchUpMember, type CaughtUp } from './catchup.js';

/** Where settling left the account, and the catch-up it owed if it thawed. */
export interface Settled {
  /** Frozen now — after the catch-up, which can put an account straight back over its limit. */
  frozen: boolean;
  /** Present only if this call lifted a freeze: what each share had to be brought forward by. */
  thawed?: CaughtUp[];
}

/**
 * Make the freeze agree with the account's usage and limit, whichever of the two just moved.
 *
 * Being frozen depends on two numbers, and it used to be re-evaluated when only one of them
 * changed (#333): every way of freeing space called a thaw, added by hand as each was found,
 * and raising the limit — the other way out docs/05 names — was never one of them. An
 * administrator raised a frozen account's quota above what it stored and it stayed frozen
 * until its owner happened to empty a trash. So this is not a thaw any more but "one of the
 * two numbers changed": called wherever usage falls and wherever the limit is set, it freezes
 * an account over its limit and thaws one under it.
 *
 * Usage **rising** is not a caller: that is `freezeIfOverQuota`, where somebody else's write
 * crosses the line (SH-20), and growth never thaws.
 *
 * **Thawing is not the end of it.** Propagation skipped this account for the whole freeze, so
 * lifting it leaves every shared folder behind by exactly that interval and nothing will ever
 * mention those writes again. The catch-up runs here, in the same transaction, because a
 * thawed account that is level with nobody is a worse state than a frozen one: it looks
 * current and is not.
 */
export const settleFreeze = async (c: PoolClient, userId: string): Promise<Settled> => {
  const room = await headroom(oneFrom(c), userId);
  if (room === undefined) return { frozen: false };
  if (room < 0n) return { frozen: await freezeIfOverQuota(c, userId) };

  const lifted = await c.query(
    `UPDATE users SET frozen_at = NULL WHERE id = $1 AND frozen_at IS NOT NULL`,
    [userId],
  );
  if (!lifted.rowCount) return { frozen: false };

  const thawed = await catchUpMember(c, userId);
  return { frozen: await isFrozen(oneFrom(c), userId), thawed };
};
