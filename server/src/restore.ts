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
import { readFile, writeFile } from 'node:fs/promises';
import type { Db } from './db.js';
import { record, type Actor } from './admin/audit.js';

/** Where a path to the state file is required, but a deployment may not have one configured. */
export interface RestoreConfig {
  stateFile: string;
}

/** What the server knows about a possible restore, read at startup and on demand. */
export interface RestoreStatus {
  /** The epoch the running database holds. */
  dbEpoch: number;
  /** The epoch this server has ever run with, from its state file. */
  fileEpoch: number | null;
  /**
   * True when the database is behind the state file — a restore happened and nobody
   * confirmed it. In that state the server serves only the confirm endpoint.
   */
  pending: boolean;
}

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
  await writeFile(stateFile, String(next), 'utf8');
  return { epoch: next };
};
