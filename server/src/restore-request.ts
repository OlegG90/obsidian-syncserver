/**
 * A restore asked for from the console, carried out at the **next start** (D-92).
 *
 * The console used to refuse this outright, and the reason was sound: a server that can overwrite itself
 * from a web page is a new way to lose a vault. What the refusal left behind was a screen showing a
 * command to type — correct, and still the thing an operator forgot at three in the morning. So the
 * button exists (D-92), and what changed is *who types the command*, not who decides.
 *
 * **The button does not restore. It asks, and stops the server.** The restore itself happens on the way
 * back up, before anything is served and before the schema is even compared, which is the one moment
 * this is safe: `pg_restore --clean` drops and recreates what it restores, and doing that under a
 * running server is not a race to be careful about — it is open transactions against tables being
 * dropped. The old command needed `docker compose stop server` for exactly this reason. Booting *is*
 * that stop, so the precondition is met by construction rather than by an operator remembering it.
 *
 * **The container brings itself back** (`restart: unless-stopped`, docs/13). A deployment that has
 * turned that off gets a server that stays down until it is started — which is why the confirmation
 * says so before the press, rather than leaving somebody to discover it.
 *
 * **The request is cleared before the attempt, never after.** A marker that survived a failure would
 * make the next start try again, and again — a restart loop is a worse failure than a restore that did
 * not happen and said so in the log. Blobs go first, as always, so the half-applied state is the
 * harmless half (docs/08).
 *
 * **What it is not:** it is not the confirmation. The epoch guard still notices that the database went
 * backwards, still halts, and still waits for a person to confirm in the console — the half of the rule
 * that was load-bearing is untouched.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** What was asked for, and by whom — the log after the restart has to be able to say. */
export interface RestoreRequest {
  /** The `backup_runs` row this copy belongs to. */
  runId: string;
  /** The directory to restore from, as it was when the request was made. */
  destination: string;
  /** The console login that asked. */
  by: string;
  /** ISO, so "asked for at" survives the restart that carries it out. */
  at: string;
}

/** Beside the restore epoch, and for the same reason: it has to outlive the container that wrote it. */
export const requestFile = (stateFile: string): string => join(dirname(stateFile), 'restore-request.json');

export const readRestoreRequest = async (stateFile: string): Promise<RestoreRequest | undefined> => {
  const text = await readFile(requestFile(stateFile), 'utf8').catch(() => undefined);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as RestoreRequest;
    // A file somebody edited, or one half-written by a container that died mid-write. Refusing to read
    // it is the safe answer: the cost is a restore that has to be asked for again, and the alternative
    // is `rm -rf` of whatever a broken `destination` happens to name.
    return parsed.runId && parsed.destination && parsed.by && parsed.at ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export const writeRestoreRequest = async (stateFile: string, request: RestoreRequest): Promise<void> => {
  await mkdir(dirname(requestFile(stateFile)), { recursive: true });
  await writeFile(requestFile(stateFile), JSON.stringify(request), 'utf8');
};

export const clearRestoreRequest = async (stateFile: string): Promise<void> => {
  await rm(requestFile(stateFile), { force: true });
};
