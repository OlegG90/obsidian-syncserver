/**
 * The real backup legs: `pg_dump` and a directory copy.
 *
 * The window itself lives in `backup.ts` with the legs injected, because the window is a
 * rule while these are deployment facts — a binary that must match the server's PostgreSQL
 * major version, a blob directory that may be a mount of almost anything. This module is
 * the production wiring, and it is the one place those facts are written down.
 *
 * **The database leg is a dump to a file, not to a stream.** The window is taken here and
 * the run's `finally` closes it, so the dump has to complete before the window closes; a
 * stream that `pg_dump` feeds would have to be drained under the lock. Writing a file keeps
 * the two legs separate and the window honest.
 */
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';
import type { Legs } from './backup.js';

/** `pg_dump`, awaited, and rejected when it exits non-zero. */
const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });

/**
 * What `SELECT version()` says about the database this server is talking to, read once (#89).
 *
 * One fact, and it was two queries at two sites: `app.ts` baked it into the legs the admin
 * routes build, and `index.ts` asked again at boot for `assertPgDumpMatches`. Neither was
 * wrong and together they were a fact with no owner — the shape that lets two copies of an
 * answer drift while both look correct.
 *
 * Held for the life of the process, because that is how long it is true for. A PostgreSQL that
 * restarted into a different major underneath a running pool would invalidate it — and would
 * invalidate rather more than this, so the honest place for that worry is a restart, not a
 * cache line.
 *
 * Only ever asked when backups are configured. A deployment that takes none has no dump whose
 * major must match, so the query is not merely cheap, it is not run.
 */
let versionLine: string | undefined;

export const serverVersionLine = async (db: Db): Promise<string> => {
  versionLine ??= (await db.one<{ version: string }>('SELECT version() AS version'))?.version ?? '';
  return versionLine;
};

/**
 * The major version a `pg_dump` (or `pg_dump --version`, or `SELECT version()`) line reports.
 *
 * Both spellings it matches are `… PostgreSQL <major>.<minor> …`: `pg_dump --version` prints
 * "pg_dump (PostgreSQL) 18.4", and `SELECT version()` prints "PostgreSQL 18.4 on …". `undefined`
 * means the line did not carry a version this function can trust — which a caller must treat
 * as a refusal to guess, not as a version it can rely on.
 */
export const pgMajor = (versionLine: string): number | undefined => {
  const m = /PostgreSQL\)?\s+(\d+)/.exec(versionLine);
  return m ? Number(m[1]) : undefined;
};

/**
 * Refuse a backup whose dump binary cannot read the server's database.
 *
 * The dump's PostgreSQL major must match the server's — a dump taken with a different major
 * can fail mid-run or, worse, produce a file that looks like a backup. This is a pure check
 * so a test can pin it without invoking the binary.
 *
 * @throws with a message naming both versions when they disagree, or when either cannot be read.
 */
export const assertPgDumpMatches = (
  dumpVersionLine: string,
  serverVersionLine: string,
): void => {
  const dumpMajor = pgMajor(dumpVersionLine);
  const serverMajor = pgMajor(serverVersionLine);
  if (dumpMajor === undefined || serverMajor === undefined) {
    throw new Error(
      `cannot verify the pg_dump version matches the server's PostgreSQL — read ` +
        `"${dumpVersionLine.trim()}" from the dump and "${serverVersionLine.trim()}" from the server. ` +
        'Fix BACKUP_DB_COMMAND or the runtime image before backing up.',
    );
  }
  if (dumpMajor !== serverMajor) {
    throw new Error(
      `pg_dump is major ${dumpMajor} but the server's PostgreSQL is major ${serverMajor} — a dump taken ` +
        'with the wrong major can fail mid-run or produce a file that is not a backup. Fix BACKUP_DB_COMMAND ' +
        'or the runtime image before backing up.',
    );
  }
};

/** Run the dump binary's `--version` and return its line, or throw with the underlying error. */
export const pgDumpVersion = async (dumpCommand: string[]): Promise<string> => {
  const [cmd] = dumpCommand;
  if (!cmd) throw new Error('BACKUP_DB_COMMAND is empty — it must name the dump binary');
  return new Promise<string>((resolve, reject) => {
    execFile(cmd, ['--version'], (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
};

/**
 * The two legs a backup is made of, for one configured run.
 *
 * @param destination the directory this run's two halves land in.
 * @param dumpCommand `pg_dump` and its arguments; the file name is appended.
 * @param blobSource the blob store directory to copy.
 * @param runDir the per-run subdirectory, so two runs never write into each other.
 * @param serverVersionLine `SELECT version()`'s answer — what the dump must match (docs/10).
 */
export const backupLegs = (
  destination: string,
  dumpCommand: string[],
  blobSource: string,
  runDir: string,
  serverVersionLine: string,
): Legs => ({
  /**
   * The one thing that has to be true before a window is worth opening: this `pg_dump` can
   * read this server.
   *
   * It used to be the first line of `dumpDatabase`, which reads as "before the work" and is
   * not: by then `runBackup` had taken the collector's lock, inserted a `backup_runs` row and
   * set the server refusing writes. So a mismatched binary — the case #73 exists for —
   * announced itself with the window already open, which is the failure it was meant to
   * replace rather than relocate.
   */
  async assertReady() {
    assertPgDumpMatches(await pgDumpVersion(dumpCommand), serverVersionLine);
  },

  async dumpDatabase() {
    await mkdir(join(destination, runDir), { recursive: true });
    const [cmd, ...args] = dumpCommand;
    const file = join(destination, runDir, 'database.dump');
    if (!cmd) throw new Error('BACKUP_DB_COMMAND is empty — it must name the dump binary');
    await run(cmd, [...args, '-f', file]);
    const size = await stat(file);
    return { bytes: size.size };
  },

  async copyBlobs() {
    const target = blobDirOf(destination, runDir);
    await cp(blobSource, target, { recursive: true });
    let bytes = 0;
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          const s = await stat(full);
          bytes += s.size;
          count++;
        }
      }
    };
    await walk(target);
    return { bytes, count };
  },
});

/**
 * A per-run directory, named so an operator can tell one from another.
 *
 * The stamp is a timestamp rendered filesystem-safe (no `:` or `.`). This is the one rule
 * the whole layout leans on: the route names the run, the legs copy into it, and a verify
 * reopens it from the recorded destination — so a single spelling keeps all three honest.
 */
export const backupRunDir = (stamp: string): string => `backup-${stamp}`;

/** This run's own directory under the backup destination. */
export const runDirOf = (destination: string, runDir: string): string => join(destination, runDir);

/** Where the blob copy of a run lives, under the run's own destination. */
export const blobDirOf = (destination: string, runDir: string): string => join(destination, runDir, 'blobs');
