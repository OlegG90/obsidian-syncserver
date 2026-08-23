/**
 * How a restore command is shaped and run (#171, #182).
 *
 * `RESTORE_DB_COMMAND` ends at `-d`, and what follows it is the database and then the archive. That
 * contract was written down nowhere, and the two callers of the day read it two different ways: one
 * appended `-d <database> <dump>` and was right, while the restore appended the dump alone — handing
 * `pg_restore` the archive path where it expected a **database name**, and leaving it to read the
 * archive from an empty stdin. The restore this repository shipped could not restore, and every test
 * injected `true` in place of the binary, so nothing looked at the argv.
 *
 * So the shape stops being a convention two files remember and becomes one function both ask. A
 * trailing `-d` or `--dbname` is dropped and re-added, which means an operator's override behaves the
 * same whether it carries one or forgets it — the setting can no longer be right in a way that is
 * wrong here.
 */
import { execFile } from 'node:child_process';

/** The binary and the exact arguments it should see, database before archive. */
export const restoreArgv = (
  command: readonly string[],
  database: string,
  dump: string,
): { cmd: string; args: string[] } => {
  const [cmd, ...rest] = command;
  if (cmd === undefined) throw new Error('RESTORE_DB_COMMAND is empty: there is no restore binary to run');
  const last = rest.at(-1);
  const flags = last === '-d' || last === '--dbname' ? rest.slice(0, -1) : rest;
  return { cmd, args: [...flags, '-d', database, dump] };
};

/**
 * Run one of these and turn a non-zero exit into an error that carries the reason.
 *
 * Here rather than beside the caller because there were three copies of it, and they had already
 * drifted: two reported `stderr` differently, and the one that mattered was the one nobody read. `pg_restore` writes warnings to stderr on a perfectly
 * good restore, so only the exit code decides; the text goes into the error, because it is where the
 * reason lives.
 */
export const runCommand = (cmd: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve();
    });
  });
