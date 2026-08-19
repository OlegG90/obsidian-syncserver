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
import type { Legs } from './backup.js';

/** `pg_dump`, awaited, and rejected when it exits non-zero. */
const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err) => (err ? reject(err) : resolve()));
  });

/**
 * The two legs a backup is made of, for one configured run.
 *
 * @param destination the directory this run's two halves land in.
 * @param dumpCommand `pg_dump` and its arguments; the file name is appended.
 * @param blobSource the blob store directory to copy.
 * @param runDir the per-run subdirectory, so two runs never write into each other.
 */
export const backupLegs = (
  destination: string,
  dumpCommand: string[],
  blobSource: string,
  runDir: string,
): Legs => ({
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
