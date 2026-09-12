/**
 * The database schema, applied and brought forward by the server that needs it.
 *
 * It used to be a **file the operator had to place**: `server/db/schema.sql`, mounted into the
 * database container and run by PostgreSQL's entrypoint once, on an empty data directory. So it
 * travels **inside** the image, and the server applies it when the database is empty.
 *
 * For a database that already exists it used to only *compare* — names of functions and triggers
 * — and warn `BEHIND`. That could not see a changed function body or a new index, so a release
 * carrying either was not a straight pull: the operator applied SQL from the release notes by
 * hand (0.7.9 was the first). **Now it migrates** (#354):
 *
 * - `schema.sql` stays the one readable description, and a fresh installation gets it whole;
 * - `server/db/migrations/NNNN-name.sql` holds each change again as a step for a database that
 *   exists. Two descriptions drift unless something makes them agree, so
 *   `checks/schema-equivalence.sh` does: the baseline release's schema plus every migration must
 *   dump identically to `schema.sql`, or CI fails;
 * - a start applies what is pending, one migration per transaction, and **refuses to start** when
 *   one fails, when the database is newer than the image, or when an applied migration's file has
 *   changed. Those are facts, not suspicions, and serving on top of them is how data goes wrong.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { Db } from './db.js';
import { SCHEMA_LOCK_ID } from './interlock.js';

/**
 * Where the schema is, in the image and in a checkout alike.
 *
 * Resolved from this module rather than from the working directory: `server/dist/schema.js`
 * and `server/src/schema.ts` are both one level below `server/`, so one expression finds the
 * schema in the container (`/app/server/db/schema.sql`) and in development.
 */
export const SCHEMA_FILE = fileURLToPath(new URL('../db/schema.sql', import.meta.url));

/** The migrations beside it, found the same way. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations/', import.meta.url));

/** The marker: `server_meta` is seeded by the schema itself, so its absence is "no schema here". */
const MARKER = 'public.server_meta';

/** The table a database records its migrations in — itself created by migration 1. */
const LEDGER = 'public.schema_migrations';

/** A start that must not go on. Thrown, so `index.ts` exits instead of serving. */
export class SchemaRefusal extends Error {
  override name = 'SchemaRefusal';
}

/** One step, as the image carries it. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
  /** sha256 of the file with line endings normalised, so a checkout's CRLF is not a change. */
  checksum: string;
}

/** `0001-schema-migrations.sql`: four digits, a dash, lower-case words. */
const FILE_NAME = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

/**
 * The migrations in a directory, in order, or a refusal naming what is wrong with them.
 *
 * Strict, because every mistake here is cheapest now: a misnamed file would silently never run,
 * a gap would make "the newest applied" mean two things, and a `BEGIN`/`COMMIT` inside one would
 * end the transaction the runner wraps it in — and the lock with it.
 */
export const readMigrations = async (dir: string = MIGRATIONS_DIR): Promise<Migration[]> => {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const file of files) {
    const m = FILE_NAME.exec(file);
    if (!m) throw new SchemaRefusal(`migration file ${file} is not named NNNN-name.sql`);
    const sql = (await readFile(join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im.test(sql)) {
      throw new SchemaRefusal(`migration ${file} controls its own transaction; the server wraps each one`);
    }
    out.push({ id: Number(m[1]), name: m[2]!, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  out.forEach((mig, i) => {
    if (mig.id !== i + 1) throw new SchemaRefusal(`migrations must be numbered 1, 2, 3… without gaps; found ${mig.id} at position ${i + 1}`);
  });
  return out;
};

/**
 * Every function and trigger a script declares, as `kind name`.
 *
 * **The kind is not decoration.** A trigger may carry its function's name — `journal_notify` is
 * both — so a set of bare names reports a dropped trigger as present, on the strength of the
 * function that shares its name.
 */
export const declaredNames = (sql: string): string[] => {
  const found = [...sql.matchAll(/^CREATE (?:OR REPLACE )?(FUNCTION|CONSTRAINT TRIGGER|TRIGGER)\s+([a-z_][a-z0-9_]*)/gm)].map(
    (m) => `${m[1] === 'FUNCTION' ? 'function' : 'trigger'} ${m[2]}`,
  );
  return [...new Set(found)].sort();
};

/** What is declared and not present. */
export const missingFrom = (declared: readonly string[], actual: readonly string[]): string[] => {
  const have = new Set(actual);
  return declared.filter((n) => !have.has(n));
};

/**
 * What a database from before migrations must already have: the schema's functions and triggers,
 * less any a migration declares.
 *
 * Names only, which is the old check's blind spot and is accepted here for one start: it cannot
 * tell a changed body, so a database that skipped a release's hand-applied SQL is not caught.
 * The baseline is the release that shipped migrations, whose notes say what it must be level with.
 */
export const baselineNames = (schemaSql: string, migrations: readonly Migration[]): string[] => {
  const later = new Set(migrations.flatMap((m) => declaredNames(m.sql)));
  return declaredNames(schemaSql).filter((n) => !later.has(n));
};

export interface SchemaOutcome {
  /** `applied` — the database was empty; `level` — nothing to do; `migrated` — see `ran`. */
  state: 'applied' | 'level' | 'migrated';
  /** Ids of the migrations this start applied, in order. */
  ran: number[];
  /** The newest migration the database now has; 0 for none. */
  version: number;
}

const exists = async (c: PoolClient, relation: string): Promise<boolean> =>
  Boolean((await c.query<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [relation])).rows[0]?.r);

const record = (c: PoolClient, m: Migration) =>
  c.query('INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)', [m.id, m.name, m.checksum]);

/**
 * The applied rows, checked against the image: none unknown, none changed. The next pending one, if any.
 */
const nextPending = async (c: PoolClient, migrations: readonly Migration[]): Promise<Migration | undefined> => {
  const applied = (await exists(c, LEDGER))
    ? (await c.query<{ id: number; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id')).rows
    : [];
  const known = new Map(migrations.map((m) => [m.id, m]));
  for (const row of applied) {
    const mine = known.get(row.id);
    if (!mine) {
      throw new SchemaRefusal(
        `the database has migration ${row.id}, which this image does not know: it was brought forward by a newer server. ` +
          'Run that version or newer; an older image cannot serve a schema it has never seen.',
      );
    }
    if (mine.checksum !== row.checksum) {
      throw new SchemaRefusal(
        `migration ${row.id} (${mine.name}) differs from the one this database applied. ` +
          'An applied migration is never edited; the change belongs in a new one.',
      );
    }
  }
  const done = new Set(applied.map((r) => r.id));
  return migrations.find((m) => !done.has(m.id));
};

/**
 * Apply the schema to an empty database, or bring an existing one forward.
 *
 * Runs before anything else queries a table, which is why it is the first thing `index.ts` awaits.
 * Every step holds the schema lock and re-reads the state inside it, so two servers starting
 * together serialise rather than both applying.
 */
export const ensureSchema = async (
  db: Db,
  opts: { log?: (m: string) => void; file?: string; migrationsDir?: string } = {},
): Promise<SchemaOutcome> => {
  const log = opts.log ?? console.log;
  const file = opts.file ?? SCHEMA_FILE;
  const sql = await readFile(file, 'utf8');
  const migrations = await readMigrations(opts.migrationsDir);
  const newest = migrations.at(-1)?.id ?? 0;

  const fresh = await db.tx(async (c) => {
    // A **transaction** lock: it goes when the transaction ends, including badly, so a crash
    // mid-apply cannot leave the next start waiting for ever.
    await c.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
    if (await exists(c, MARKER)) {
      if (!(await exists(c, LEDGER))) {
        // From before migrations. Everything that existed then must be here, or the first
        // migration would be built on a database that is not the one it was written against.
        const rows = await c.query<{ name: string }>(
          `SELECT 'function ' || proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
            UNION
           SELECT 'trigger ' || tgname AS name FROM pg_trigger WHERE NOT tgisinternal`,
        );
        const missing = missingFrom(baselineNames(sql, migrations), rows.rows.map((r) => r.name));
        if (missing.length > 0) {
          throw new SchemaRefusal(
            `the database predates schema migrations and is not level with the release they start from. ` +
              `Missing: ${missing.join(', ')}. Bring it level with that release's notes first.`,
          );
        }
      }
      return false;
    }
    // The file carries its own BEGIN/COMMIT, for psql. Here they would end THIS transaction
    // halfway and release the lock with it, so the server supplies the transaction and the
    // file's two lines go. The ledger rows are in the file: a database psql built from it is
    // exactly as current as one built here.
    await c.query(sql.replace(/^(BEGIN|COMMIT);$/gm, ''));
    return true;
  });
  if (fresh) {
    log(`schema applied from ${file}, at migration ${newest}`);
    return { state: 'applied', ran: [], version: newest };
  }

  const ran: number[] = [];
  for (;;) {
    const step = await db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
      const next = await nextPending(c, migrations);
      if (!next) return undefined;
      try {
        await c.query(next.sql);
      } catch (e) {
        throw new SchemaRefusal(`migration ${next.id} (${next.name}) failed and was rolled back: ${(e as Error).message}`);
      }
      await record(c, next);
      return next;
    });
    if (!step) break;
    log(`schema migration ${step.id} (${step.name}) applied`);
    ran.push(step.id);
  }
  return { state: ran.length > 0 ? 'migrated' : 'level', ran, version: newest };
};

/** The newest migration a database has had, for `/health`. 0 before the ledger exists. */
export const schemaVersion = async (db: Db): Promise<number> => {
  const row = await db.one<{ v: number | null }>(
    `SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 0
                 ELSE (SELECT coalesce(max(id), 0) FROM schema_migrations) END AS v`,
  );
  return row?.v ?? 0;
};
