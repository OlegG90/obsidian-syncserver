/**
 * Removing a backup's copy from disk (#136).
 *
 * **"Delete a backup" is two acts wearing one word**, and only one of them is wanted. Forgetting
 * the RUN — dropping the row — leaves the files behind, unreferenced, so an operator watching
 * free space disappear has nothing left that explains where it went. Removing the COPY is what
 * people mean, and it is the one where a server recursively deletes a filesystem path it read
 * out of its own database.
 *
 * So the row survives every removal here, and `destination` becomes NULL: the history keeps
 * saying a backup ran, and the null says its copy is no longer on disk. That is also what makes
 * the backup list skip it, since it already asks for `destination IS NOT NULL`.
 *
 * **What is refused, and why each one:**
 *
 * - a path that is not **inside the configured destination**, or not a direct child of it named
 *   the way a run directory is named. `destination` is a text column: a value from a restored
 *   dump, another deployment, or a hand edit would otherwise become `rm -rf` of whatever that
 *   path names on THIS host;
 * - the **newest successful** copy. It is what a restore would use, and a server that will not leave itself without a backup is worth more than one
 *   that does exactly as it is told;
 * - a **running** one, which has no finished copy to remove and a writer still inside it.
 */
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Db } from './db.js';

export type Refused = 'not_found' | 'outside_destination' | 'newest_copy' | 'still_running' | 'already_gone';

/** A run directory is what `backupRunDir` makes: a direct child of the destination, named so. */
const RUN_DIR = /^backup-[0-9TZ:.\-]+$/;

/**
 * Is this a path the server may delete — a run directory of THIS deployment's destination?
 *
 * Exported because it is the whole safety argument, and an argument that cannot be tested is
 * an assertion. Both sides are resolved first: `..` inside a stored value must not walk out of
 * the destination and still look like a child of it.
 */
export const insideDestination = (root: string, path: string): boolean => {
  const base = resolve(root);
  const full = resolve(path);
  if (!full.startsWith(base + sep)) return false;
  const rest = full.slice(base.length + 1);
  return !rest.includes(sep) && RUN_DIR.test(rest);
};

/** Which run holds the newest copy a restore would use — the one that may not be removed. */
export const newestCopy = async (db: Db): Promise<string | undefined> => {
  const row = await db.one<{ id: string }>(
    `SELECT id::text AS id FROM backup_runs
      WHERE status = 'ok' AND destination IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`,
  );
  return row?.id;
};

/**
 * Remove one run's copy, leaving the run in the history.
 *
 * Returns what it refused, or nothing when the copy is gone. The directory is removed before
 * the row is updated: a row still naming a directory that is already deleted is a lie the next
 * verify would report as a fault, while a row naming a directory that is still there is merely
 * a copy that failed to be removed — the safe order is the one whose failure is recoverable.
 */
export const removeBackupCopy = async (
  db: Db,
  root: string,
  id: string,
): Promise<Refused | undefined> => {
  const row = await db.one<{ destination: string | null; status: string }>(
    `SELECT destination, status::text AS status FROM backup_runs WHERE id = $1`,
    [id],
  );
  if (!row) return 'not_found';
  if (row.status === 'running') return 'still_running';
  if (!row.destination) return 'already_gone';
  if (!insideDestination(root, row.destination)) return 'outside_destination';
  if ((await newestCopy(db)) === id) return 'newest_copy';

  await rm(row.destination, { recursive: true, force: true });
  await db.query(`UPDATE backup_runs SET destination = NULL WHERE id = $1`, [id]);
  return undefined;
};

