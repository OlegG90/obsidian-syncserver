/**
 * Refuse to start when a directory this server must write is not one it can write.
 *
 * Three paths decide whether this process can do its job, and all three fail *late* when
 * they are wrong: the restore state file is written after the schema is applied, a backup
 * destination is not touched until somebody asks for a backup, and the blob store creates
 * directories per blob — so a store nobody can write into is discovered on the first
 * upload, by a person who was synchronising a vault and is now reading a 500.
 *
 * Each of those is the same mistake, and it is the ordinary one on a NAS: a bind mount
 * owned by a uid that is not `RUN_AS`. Asking at startup turns it into a sentence naming
 * the setting and the uid, printed before anything is served.
 *
 * **`mkdir` first, then `access`.** Creating the directory is half of what the server does
 * with these paths anyway, and it is the half that fails on a read-only or foreign-owned
 * parent; `access` then catches the case where the directory exists and belongs to someone
 * else. Neither alone covers both.
 */
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';

export interface WritablePath {
  /** What this directory is for, in a sentence: “the blob store”. */
  what: string;
  dir: string;
  /** The environment variable that moves it, so the message says what to change. */
  setting: string;
}

/**
 * @throws when any of them cannot be created or written, naming the first that failed.
 */
export const assertWritable = async (paths: WritablePath[]): Promise<void> => {
  for (const { what, dir, setting } of paths) {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
    } catch (e: unknown) {
      // `getuid` is absent on Windows, where this server is developed and not deployed. The
      // uid is the most useful half of the message where it exists and nothing where it does
      // not, so it is appended rather than interpolated into a sentence that would read oddly.
      const uid = typeof process.getuid === 'function' ? ` This process runs as uid ${process.getuid()}.` : '';
      throw new Error(
        `${what} is not writable: ${dir} (${e instanceof Error ? e.message : String(e)}).${uid} ` +
          `Point ${setting} at a path inside a writable mount, or give that mount to the uid this ` +
          `server runs as — RUN_AS in .env decides it.`,
      );
    }
  }
};
