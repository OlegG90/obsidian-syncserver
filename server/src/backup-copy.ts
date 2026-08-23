/**
 * Where the two halves of a backup copy live, said once.
 *
 * A copy is a directory holding `database.dump` beside `blobs/`. The writer spelled that layout, and
 * then **every reader spelled it again** — the restore, the console's verify, and more besides, each
 * with its own `join(dir, 'blobs')`. Several spellings of one fact, across several files.
 *
 * That is the shape which already cost this project a shipped defect. `restore-argv.ts` exists because
 * the argv contract "was written down nowhere, and the two callers read it two different ways" — and a
 * restore that could not restore reached a release. The argv half of that lesson was learned; this is
 * the other half of the same layout, and nothing had made it a module yet.
 *
 * **It answers where, and whether.** `whatIsMissing` belongs here rather than beside the restore
 * because "is this directory a backup" is a question about the layout, and the layout is what this
 * knows. A caller that has to ask two modules to find out has learned the layout after all.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** One run's copy on disk: the directory, and each half of it. */
export interface BackupCopy {
  dir: string;
  /** The custom-format archive `pg_dump` wrote and `pg_restore` reads. */
  dump: string;
  /** The blob store as it stood inside the same refusal window (D-114). */
  blobs: string;
}

/** The copy in this directory — the value every reader and the writer share. */
export const copyAt = (dir: string): BackupCopy => ({
  dir,
  dump: join(dir, 'database.dump'),
  blobs: join(dir, 'blobs'),
});

/**
 * Both halves have to be there before anything is touched: half a copy is not a copy.
 *
 * @returns the sentence naming what is absent, or `undefined` when the copy is whole enough to open.
 *   A sentence rather than a boolean because the caller's job is to say which half is missing, and a
 *   boolean would have every caller rebuild that from the paths.
 */
export const whatIsMissing = async (copy: BackupCopy): Promise<string | undefined> => {
  const found = async (path: string, what: 'file' | 'directory'): Promise<boolean> => {
    const s = await stat(path).catch(() => undefined);
    return s !== undefined && (what === 'file' ? s.isFile() : s.isDirectory());
  };
  if (!(await found(copy.dump, 'file'))) return `${copy.dump} is missing — that directory is not a backup`;
  if (!(await found(copy.blobs, 'directory'))) return `${copy.blobs} is missing — that directory is not a backup`;
  return undefined;
};
