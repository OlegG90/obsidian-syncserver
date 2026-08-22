/**
 * Where the database name goes in a restore command (#171).
 *
 * `RESTORE_DB_COMMAND` ends at `-d`, and what follows it is the database and then the archive. That
 * contract was written down nowhere, and the two callers read it two different ways: the rehearsal
 * appended `-d <scratch> <dump>` and was right, while the restore appended the dump alone — handing
 * `pg_restore` the archive path where it expected a **database name**, and leaving it to read the
 * archive from an empty stdin. The restore this repository shipped could not restore, and every test
 * injected `true` in place of the binary, so nothing looked at the argv.
 *
 * So the shape stops being a convention two files remember and becomes one function both ask. A
 * trailing `-d` or `--dbname` is dropped and re-added, which means an operator's override behaves the
 * same whether it carries one or forgets it — the setting can no longer be right in a way that is
 * wrong here.
 */

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
