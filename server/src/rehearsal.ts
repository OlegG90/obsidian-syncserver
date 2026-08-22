/**
 * A rehearsal that actually restores (#159).
 *
 * [08](../../docs/08-backup-restore.md) says it plainly — *"a backup that has never been restored is not
 * a backup"* — and prescribes a quarterly rehearsal by hand. What the server did automatically was
 * confirm that every blob the database references is present in the copy. That is worth having and it is
 * **not the same claim**: it says the copy arrived, not that the dump can be read. A `pg_dump` that fails
 * to restore — a version mismatch, a truncated file, a corrupt custom-format archive — passes that check
 * and fails on the one day it is needed.
 *
 * So this loads the dump into a **scratch database** created for the purpose and dropped afterwards.
 * Never into the live one: a rehearsal that could damage what it is rehearsing for would be the worst
 * trade in the system.
 *
 * **What it claims, precisely.** That the archive loads, that what comes out carries this build's
 * functions and triggers, and that the account table is not empty. It does not claim the data is
 * *correct* — nothing outside the vaults' own keys could tell — and it must not be read as saying so.
 *
 * **Where the outcome lives, and why not in the database.** A rehearsal belongs to the backup run it
 * rehearsed, so a column on `backup_runs` is the tidy answer — and there is no migration tool
 * ([13](../../docs/13-deployment.md)), so a new column strands every database already running. It goes
 * into a file beside the restore epoch instead: the same directory, mounted for the same reason, and the
 * same property — it has to outlive the container that wrote it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { connect, type Db } from './db.js';
import { restoreArgv, runCommand } from './restore-argv.js';
import { declaredNames, missingFrom, SCHEMA_FILE } from './schema.js';

/** What the last rehearsal found, as the console reads it. */
export interface Rehearsal {
  /** ISO, so "the last successful rehearsal was 60 days ago" is answerable after a restart. */
  at: string;
  /** The backup run it loaded. */
  run: string;
  ok: boolean;
  /** One sentence: what loaded, or what stopped it. */
  detail: string;
  /**
   * The last rehearsal that **passed**, carried forward across failures (#173).
   *
   * Without it one bad run erased the only number worth reading. `docs/08` names the question — *"the
   * last successful rehearsal was 60 days ago"* — and a failure is precisely the moment somebody asks
   * it: knowing the archive did not load today matters much less than knowing whether one ever did, and
   * how long ago. Absent on a server that has never had a passing rehearsal, and on a record written
   * before this field existed, which the console reads the same way — as "not known".
   */
  lastGood?: { at: string; run: string };
}

/** Beside the restore epoch, for the reason the module docblock gives. */
export const rehearsalFile = (stateFile: string): string => join(dirname(stateFile), 'rehearsal.json');

export const readRehearsal = async (stateFile: string): Promise<Rehearsal | undefined> => {
  const text = await readFile(rehearsalFile(stateFile), 'utf8').catch(() => undefined);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Rehearsal;
  } catch {
    // A file somebody edited, or a half-written one. "No rehearsal on record" is the honest reading of
    // an unreadable record, and it is what makes the console say "never" rather than crash.
    return undefined;
  }
};

const writeRehearsal = async (stateFile: string, rehearsal: Rehearsal): Promise<void> => {
  await mkdir(dirname(rehearsalFile(stateFile)), { recursive: true });
  await writeFile(rehearsalFile(stateFile), JSON.stringify(rehearsal), 'utf8');
};

/**
 * Load the newest good backup into a scratch database and say what came out.
 *
 * The scratch database is named after the moment, so two rehearsals cannot collide, and it is dropped in
 * a `finally` — `WITH (FORCE)`, because a rehearsal that failed halfway may have left the connection its
 * own `pg_restore` opened, and a database nobody can drop would break every rehearsal after it.
 *
 * @returns the outcome, or `undefined` when there is nothing to rehearse — no successful backup with a
 *   copy still on disk. That is not a failure and must not be logged as one.
 */
export const rehearseRestore = async (
  db: Db,
  opts: {
    databaseUrl: string | undefined;
    restoreCommand: string[];
    stateFile: string;
    stamp: string;
    log?: (message: string) => void;
    warn?: (message: string) => void;
  },
): Promise<Rehearsal | undefined> => {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;

  const [latest] = await db.query<{ id: string; destination: string }>(
    `SELECT id::text AS id, destination FROM backup_runs
      WHERE status = 'ok' AND destination IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`,
  );
  if (!latest) return undefined;

  const scratch = `syncserver_rehearsal_${opts.stamp.replace(/[^0-9a-z]/gi, '_').toLowerCase()}`;
  const previous = await readRehearsal(opts.stateFile);
  const record = async (ok: boolean, detail: string): Promise<Rehearsal> => {
    const at = new Date().toISOString();
    // A pass is its own last-good; a failure inherits whatever the previous record knew — either the
    // previous run itself, if that one passed, or the last-good it was already carrying.
    const lastGood = ok
      ? { at, run: latest.id }
      : previous?.ok
        ? { at: previous.at, run: previous.run }
        : previous?.lastGood;
    const out: Rehearsal = { at, run: latest.id, ok, detail, ...(lastGood ? { lastGood } : {}) };
    await writeRehearsal(opts.stateFile, out);
    return out;
  };

  try {
    await db.query(`CREATE DATABASE ${scratch}`);
  } catch (e) {
    // Most likely the role cannot create databases. Reported rather than thrown: a server that refused
    // to run because it could not rehearse would be trading the thing for the check on it.
    const detail = `could not create a scratch database: ${e instanceof Error ? e.message : String(e)}`;
    warn(`rehearsal: ${detail}`);
    return record(false, detail);
  }

  let scratchDb: Db | undefined;
  try {
    // The same argv the real restore uses, pointed at the scratch database (#171): the rehearsal is only
    // worth anything if it exercises the command an operator would actually run.
    const { cmd, args } = restoreArgv(opts.restoreCommand, scratch, join(latest.destination, 'database.dump'));
    await runCommand(cmd, args);

    const url = new URL(opts.databaseUrl ?? 'postgres:///postgres');
    url.pathname = `/${scratch}`;
    scratchDb = connect(url.toString());

    // The same comparison the server runs against its own database at boot, pointed at what came out of
    // the archive. It answers the question that matters here — is this a SyncServer database — with the
    // one check that already knows what that means.
    const sql = await readFile(SCHEMA_FILE, 'utf8');
    const present = await scratchDb.query<{ name: string }>(
      `SELECT 'function ' || proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        UNION
       SELECT 'trigger ' || tgname AS name FROM pg_trigger WHERE NOT tgisinternal`,
    );
    const missing = missingFrom(declaredNames(sql), present.map((r) => r.name));
    if (missing.length > 0) {
      const detail = `the archive loaded and is missing ${missing.length} object(s): ${missing.slice(0, 5).join(', ')}`;
      warn(`rehearsal: ${detail}`);
      return await record(false, detail);
    }

    const users = await scratchDb.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    if (Number(users?.n ?? 0) === 0) {
      const detail = 'the archive loaded and holds no accounts at all, which no real installation does';
      warn(`rehearsal: ${detail}`);
      return await record(false, detail);
    }

    const detail = `restored backup ${latest.id} into a scratch database: schema complete, ${users!.n} account(s)`;
    log(`rehearsal: ${detail}`);
    return await record(true, detail);
  } catch (e) {
    const detail = `the archive did not restore: ${e instanceof Error ? e.message : String(e)}`;
    warn(`rehearsal: ${detail}`);
    return await record(false, detail);
  } finally {
    await scratchDb?.close();
    await db.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
  }
};
