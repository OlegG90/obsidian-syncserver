/**
 * The devices that can reach one account (#156, #182).
 *
 * Two screens ask this and they are different screens: an operator looking at somebody else's account
 * (`admin/service.ts`), and a person looking at their own (`GET /auth/devices`). The **question** is the
 * same, though, and it was written out twice — same columns, same order, same silent choice about what a
 * device row is. That is two places to remember when the answer changes, and D-118 had just changed it:
 * `last_seen_at` now moves on every refresh rather than only at sign-in, and a note saying so was owed to
 * both copies.
 *
 * **Active ones only.** A revoked row can do nothing, so it is history rather than state, and both screens
 * answer "what can reach this account". Disconnecting revokes and reconnecting creates a new row, so
 * listing the dead would turn an ordinary reinstall into a graveyard nobody can tell apart.
 *
 * **Newest first, then by name**, with the never-seen last: the row an operator is looking for is either
 * the one that was used a moment ago or the one that has not been used in months, and both ends of that
 * order are easier to find than the middle.
 *
 * No keys and no cursors, on either screen. An administrator holds nothing that opens a vault (D-115), and
 * a device row is not where that would start.
 */
import type { Db } from './db.js';

/**
 * What a device row carries. `lastSeenAt` is as fresh as the access token's lifetime — see D-118.
 *
 * An alias and not an interface: `db.query` constrains its rows to `Record<string, unknown>`, which an
 * interface does not satisfy because it has no index signature.
 */
export type DeviceRow = {
  id: string;
  name: string;
  platform: string;
  lastSeenAt: string | null;
};

export const activeDevices = (db: Db, userId: string): Promise<DeviceRow[]> =>
  db.query<DeviceRow>(
    `SELECT id::text AS id, name, platform, last_seen_at AS "lastSeenAt"
       FROM devices
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST, name`,
    [userId],
  );
