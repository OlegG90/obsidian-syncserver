/**
 * The restore half of the backup surface: the epoch, and the guard that makes it honest.
 *
 * Restoring a database sends every client back in time — revision numbers get reused for
 * different content, and a client that believes it is current diverges silently. The
 * `restore_epoch` in `server_meta` is the cure: it travels inside the opaque cursor, a
 * cursor from a foreign epoch gets `410 restore`, and the client resyncs WITHOUT applying
 * deletions (docs/08).
 *
 * The hard part is knowing what to raise it TO. The epoch in the restored database is
 * whatever it was when the copy was taken, which may be several restores behind; `+ 1` on
 * that value can re-issue an epoch the server has already issued cursors under, and those
 * cursors then look current again. So the rule is `max(state file, restored database) + 1`
 * — and the state file has to survive the restore, which is why it lives OUTSIDE both the
 * database dump and the blob store.
 *
 * The same state file is what lets the server know a restore happened at all: on every
 * successful start it compares the file against the database, and if the database is
 * behind, a restore happened and nobody confirmed it. The server then halts — serves
 * nothing but the confirm endpoint — because the alternative is the silent divergence the
 * epoch exists to prevent.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from './db.js';
import { record, type Actor } from './admin/audit.js';
import type { RestoreStatus } from '@syncserver/shared';

/** The newest epoch this server ever ran with, from its state file. */
export const readFileEpoch = async (stateFile: string): Promise<number | null> => {
  try {
    const n = Number((await readFile(stateFile, 'utf8')).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
};

const readDbEpoch = async (db: Db): Promise<number> => {
  const row = await db.one<{ epoch: string }>(`SELECT restore_epoch::text AS epoch FROM server_meta`);
  return Number(row!.epoch);
};

/**
 * Write the epoch to the state file, creating its directory first.
 *
 * The file has to survive a restore, so it lives outside the dump and the blob store — a
 * path that may not exist yet, and a first start has no reason to have created it.
 */
export const writeEpochFile = async (stateFile: string, epoch: number): Promise<void> => {
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, String(epoch), 'utf8');
};

/**
 * Whether this server is halted by an unconfirmed restore.
 *
 * In memory, and read by the hook that turns every request away — the same trade
 * `backupInProgress` makes next door, for a state that changes even less often. It was a
 * database round-trip **plus a `readFile`, on every request**, to learn something that changes
 * once: when an operator confirms.
 *
 * **It can only become true at a start.** A restore replaces the database under a stopped
 * server; there is no sequence in which a running one watches its own epoch go backwards. So
 * reading it per request was not buying freshness, it was buying nothing — which is why this
 * is a caching change and not a policy one.
 *
 * `buildApp` establishes it, rather than leaving it to whoever remembers: an app carrying the
 * halt hook is the app that must know whether it is halted, and a flag defaulting to "fine"
 * that nobody set is a halt that silently never happens.
 */
let halted = false;

export const restoreHalted = (): boolean => halted;

/**
 * Read the restore state and remember it — the one place `halted` is raised.
 *
 * Separate from `restoreStatus` because the two have different callers: the console asks for
 * the numbers and must see them as they are now, while the hook asks a yes/no that was settled
 * at boot. Sharing one function would mean either the console reads a stale answer or the hook
 * pays for a fresh one.
 */
export const checkRestoreState = async (db: Db, stateFile: string): Promise<RestoreStatus> => {
  const status = await restoreStatus(db, stateFile);
  halted = status.pending;
  return status;
};

/** Whether a restore is pending, and both numbers that decide it. */
export const restoreStatus = async (db: Db, stateFile: string): Promise<RestoreStatus> => {
  const dbEpoch = await readDbEpoch(db);
  const fileEpoch = await readFileEpoch(stateFile);
  return {
    dbEpoch,
    fileEpoch,
    pending: fileEpoch !== null && dbEpoch < fileEpoch,
  };
};

/**
 * Confirm a restore: raise the epoch above anything this server has issued, and say so.
 *
 * The new value is `max(dbEpoch, fileEpoch) + 1`, never `dbEpoch + 1`: the restored
 * database may be several restores behind, and re-issuing an epoch the server has already
 * handed out makes stale cursors look current again. The file is updated to the new value,
 * so the guard knows the confirmation happened and does not halt again on the next start.
 *
 * @returns the new epoch.
 */
export const confirmRestore = async (db: Db, actor: Actor, stateFile: string): Promise<{ epoch: number }> => {
  const status = await restoreStatus(db, stateFile);
  const next = Math.max(status.dbEpoch, status.fileEpoch ?? 0) + 1;

  // One transaction: the epoch and its audit row commit together, or neither does.
  await db.tx(async (c) => {
    await c.query(
      `UPDATE server_meta SET restore_epoch = $1, restored_at = now()`,
      [next],
    );
    await record(c, {
      actor,
      action: 'restore.confirm',
      details: { from: status.dbEpoch, to: next, file: status.fileEpoch },
    });
  });
  // The file is outside the transaction's reach (it is not in the database, on purpose),
  // so it is written after. A crash between the two leaves the epoch raised and the file
  // stale — the guard then sees pending=false and brings the file up at the next start,
  // which is the honest reading: the restore WAS confirmed.
  await writeEpochFile(stateFile, next);
  // The halt is over, and it has to end here rather than at the next start: this endpoint is
  // one of the few the halt leaves open, so a server that stayed halted after confirming would
  // need a bounce to be usable — from a screen whose whole promise is that it is the way out.
  halted = false;
  return { epoch: next };
};
