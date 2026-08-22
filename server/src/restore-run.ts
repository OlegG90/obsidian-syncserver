/**
 * Restoring a backup — the act itself, which until now was three sentences of prose (#155).
 *
 * `pg_restore` appeared nowhere in this repository. Everything built around a restore was what happens
 * *afterwards*: the epoch file that notices a database has gone backwards, the halt that answers every
 * request `restore_pending`, the console's confirmation. The operator having the worst morning of their
 * year was handed a paragraph.
 *
 * **This is a command and not a button, deliberately.** A server that can overwrite itself from a web
 * console is a new way to lose a vault — so this runs as a one-off container, with the server stopped,
 * by somebody who typed it. What the code contributes is the part a person should not have to remember:
 * the order, the refusal, and the report.
 *
 * **Blobs first, then the database** — the opposite of a backup, and for the same reason the backup runs
 * the other way. A database restored ahead of its blobs references content that is not there yet; blobs
 * restored ahead of their database are content nothing references, which is harmless and is what the
 * collector sweeps. The window where a copy is half-applied should be the harmless half.
 */
import { execFile } from 'node:child_process';
import { cp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { missingBlobs } from './backup.js';
import type { Db } from './db.js';
import { restoreArgv } from './restore-argv.js';

/** What a restore found, said in the terms an operator acts on. */
export interface RestoreOutcome {
  /** Addresses the restored database references and the restored store does not have. */
  missing: string[];
  /** How many it walked, because "whole" is only meaningful against "all of them". */
  checked: number;
}

export type RestoreRefusal =
  | { kind: 'server_running'; connections: number }
  | { kind: 'not_a_backup'; detail: string };

/**
 * Refuse while anything else is connected to this database.
 *
 * `pg_restore --clean` drops and recreates what it restores. Doing that under a running server is not a
 * race to be careful about — it is a server holding open transactions against tables being dropped, and
 * the outcome is neither the old data nor the new. So the check is "am I alone", which is a question with
 * an exact answer, rather than "is the server stopped", which is a guess about another process.
 */
export const otherConnections = async (db: Db): Promise<number> => {
  const row = await db.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return Number(row?.n ?? 0);
};

/**
 * The database this restore will load into — **asked of the connection**, not configured (#171).
 *
 * `pg_restore -d` needs a name, and the only name that can be right is the one the server reads. Taking
 * it from `DATABASE_URL` would be a second place to say it (and that variable may be unset, leaving the
 * name to libpq), while a setting of its own could be pointed at a different database and report success
 * for restoring into the wrong one.
 */
export const currentDatabase = async (db: Db): Promise<string> => {
  const row = await db.one<{ name: string }>('SELECT current_database() AS name');
  if (!row?.name) throw new Error('this connection names no database, so there is nothing to restore into');
  return row.name;
};

/** Both halves have to be there before anything is touched: half a copy is not a copy. */
export const looksLikeABackup = async (dir: string): Promise<string | undefined> => {
  const dump = join(dir, 'database.dump');
  const blobs = join(dir, 'blobs');
  const found = async (path: string, what: 'file' | 'directory'): Promise<boolean> => {
    const s = await stat(path).catch(() => undefined);
    return s !== undefined && (what === 'file' ? s.isFile() : s.isDirectory());
  };
  if (!(await found(dump, 'file'))) return `${dump} is missing — that directory is not a backup`;
  if (!(await found(blobs, 'directory'))) return `${blobs} is missing — that directory is not a backup`;
  return undefined;
};

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      // `pg_restore` writes warnings to stderr on a perfectly good restore, so only the exit code
      // decides — but the text goes into the error, because it is where the reason lives.
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve();
    });
  });

/**
 * Put a backup back: the blobs, then the database, then the report.
 *
 * The legs are injected for the reason `backup.ts` gives about its own: what `pg_restore` is called on
 * this host and where the blobs live are deployment facts, while the order and the refusal are rules.
 */
export const restoreFrom = async (
  db: Db,
  dir: string,
  deps: {
    blobStorePath: string;
    restoreCommand: string[];
    /** The live store, to ask what the restored database now references and cannot find. */
    store: { size(storageKey: string): Promise<number | undefined> };
    log?: (message: string) => void;
  },
): Promise<RestoreOutcome | RestoreRefusal> => {
  const log = deps.log ?? console.log;
  // Settled before anything is touched: an empty `RESTORE_DB_COMMAND` is a misconfiguration rather than
  // a refusal an operator can act on mid-restore, and finding it after the blob copy would leave the
  // store written to by a restore that never ran (#171).
  const database = await currentDatabase(db);
  const dump = join(dir, 'database.dump');
  const { cmd, args } = restoreArgv(deps.restoreCommand, database, dump);

  const wrong = await looksLikeABackup(dir);
  if (wrong) return { kind: 'not_a_backup', detail: wrong };

  const others = await otherConnections(db);
  if (others > 0) return { kind: 'server_running', connections: others };

  // Copied INTO the live store rather than over it: a blob the store has and the copy does not is
  // unreferenced content, which the collector already knows how to remove. Deleting it here would be a
  // restore taking away something it was never asked about.
  log(`restoring blobs from ${join(dir, 'blobs')} → ${deps.blobStorePath}`);
  await cp(join(dir, 'blobs'), deps.blobStorePath, { recursive: true, force: true });

  log(`restoring the database from ${dump} into ${database}`);
  await run(cmd, args);

  // The report the decision in docs/08 promised and nothing produced. Asked of the LIVE store now that
  // both halves are back, which is the only moment the question means anything.
  const out = await missingBlobs(db, deps.store);
  if (out.missing.length === 0) {
    log(`restored: all ${out.checked} referenced files are present`);
  } else {
    log(
      `restored, with ${out.missing.length} of ${out.checked} referenced files NOT restored. ` +
        'Those notes exist and their content does not; the addresses are listed above so they can be ' +
        'named to whoever wrote them.',
    );
  }
  return out;
};
