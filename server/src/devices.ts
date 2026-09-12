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
import type { FastifyReply } from 'fastify';
import type { Db } from './db.js';
import type { DeviceRow } from '@syncserver/shared';

export const activeDevices = (db: Db, userId: string): Promise<DeviceRow[]> =>
  db.query<DeviceRow>(
    `SELECT id::text AS id, name, platform, last_seen_at, vault_id::text AS vault_id
       FROM devices
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST, name`,
    [userId],
  );

/**
 * Learn which vault a device syncs, the first time it opens one (#364, D-139).
 *
 * Only while the link is empty: the plugin opens the vault it syncs and no other, so the first vault a
 * device opens IS its vault, and nothing afterwards may quietly move it. That covers every way a device
 * arrives — pairing and recovery choose the vault on the client after registering — and every device
 * registered before the server asked. Called after ownership is checked, so the vault is the account's.
 */
export const learnDeviceVault = async (db: Pick<Db, 'query'>, deviceId: string, vaultId: string): Promise<void> => {
  await db.query(
    `UPDATE devices SET vault_id = $2 WHERE id = $1 AND vault_id IS NULL AND revoked_at IS NULL`,
    [deviceId, vaultId],
  );
};

/** The longest name a device may carry. The schema's `device_name_is_readable` says the same. */
export const DEVICE_NAME_MAX = 64;

/**
 * What is wrong with a device name, or nothing (#356).
 *
 * The schema refuses the same names; this says so first, because a CHECK reached from a route that does
 * not translate it is a 500 for a mistake the caller made. Nothing is trimmed here: a name is stored as
 * sent, so one with spaces around it is refused rather than quietly turned into a different one.
 */
export const deviceNameProblem = (name: unknown): string | undefined => {
  if (typeof name !== 'string') return 'a device name is text';
  if (name !== name.trim()) return 'a device name has no spaces at either end';
  if (name.length === 0) return 'a device name is not empty';
  if ([...name].length > DEVICE_NAME_MAX) return `a device name is at most ${DEVICE_NAME_MAX} characters`;
  if (/\p{Cc}/u.test(name)) return 'a device name has no control characters';
  return undefined;
};

/**
 * Answer `400 invalid_device_name` for a name the schema would refuse, or nothing when it may go on.
 *
 * One place for the answer's shape, because five routes take a name — the three that register a device,
 * and the owner's and the operator's rename — and a refusal spelled five times drifts.
 */
export const refusedDeviceName = (reply: FastifyReply, name: unknown): FastifyReply | undefined => {
  const problem = deviceNameProblem(name);
  return problem === undefined ? undefined : reply.code(400).send({ error: 'invalid_device_name', detail: problem });
};

/**
 * Rename one device of an account, answering the name it had — or nothing, when there was none to rename.
 *
 * Active devices only, and **never the console's**: a console sign-in writes its device's name every time
 * (`consoleSignIn`), so a name given here would last until the next sign-in and read as a bug.
 *
 * Shared by the owner's route and the operator's, which differ in who may ask and in the audit row, and
 * not in which rows a rename may touch.
 */
export const renameDevice = async (
  db: Pick<Db, 'one'>,
  userId: string,
  deviceId: string,
  name: string,
): Promise<{ from: string } | undefined> =>
  db.one<{ from: string }>(
    `UPDATE devices d SET name = $3
       FROM devices old
      WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL AND d.platform <> 'console'
        AND old.id = d.id
      RETURNING old.name AS "from"`,
    [deviceId, userId, name],
  );
