/**
 * The database schema, applied by the server that needs it.
 *
 * It used to be a **file the operator had to place**: `db/schema.sql`, mounted into the
 * database container at a path relative to the compose file, run by PostgreSQL's entrypoint
 * once — on an empty data directory — and ignored ever after. Three failures came out of that
 * one arrangement:
 *
 * - a person following the install put the compose file somewhere and the schema nowhere. The
 *   database came up **empty** and the server failed against tables that were not there;
 * - an upgrade whose schema gained something arrived at a database that had never seen it, and
 *   nothing said so. The quiet half is the worst of it: a missing table breaks at the first
 *   query, while a missing **trigger** simply never fires. This deployment ran for weeks with
 *   change notification inert, for exactly that reason;
 * - and the schema had to travel beside the image while belonging to it.
 *
 * So it travels **inside** the image, and the server applies it when the database is empty.
 * An installation is two files now: a compose file and an `.env`.
 *
 * **What this is not.** It is not a migration tool, and does not pretend to be one: it applies
 * the whole schema to a database that has none, and for a database that has one it only
 * *compares* and says what is missing. Bringing an existing database forward is still a
 * deliberate act by a person who knows what changed (docs/13).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { SCHEMA_LOCK_ID } from './interlock.js';

/**
 * Where the schema is, in the image and in a checkout alike.
 *
 * Resolved from this module rather than from the working directory: `server/dist/schema.js`
 * and `server/src/schema.ts` are both two levels below the repository root, so one expression
 * finds `db/schema.sql` in the container (`/app/db/schema.sql`) and in development.
 */
export const SCHEMA_FILE = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

/**
 * A lock of its own, beside the collector's rather than shared with it.
 *
 * Two servers starting against one empty database would otherwise both apply the schema, and
 * the second would fail halfway through with a duplicate-object error that looks like
 * corruption. It is a **transaction** lock: it goes when the transaction ends, including when
 * it ends badly, so a crash mid-apply cannot leave the next start waiting for ever.
 */

/** The marker: `server_meta` is seeded by the schema itself, so its absence is "no schema here". */
const MARKER = 'public.server_meta';

/**
 * Every function and trigger the schema declares, as `kind name`.
 *
 * **The kind is not decoration.** A trigger may carry its function's name — `journal_notify` is
 * both — so a set of bare names reports a dropped trigger as present, on the strength of the
 * function that shares its name. The first version of this compared names, and its own test
 * caught it: the deploy script's check has the same blind spot and always did.
 *
 * Exported because the comparison is the argument, and an argument no test can reach is an
 * assertion.
 */
export const declaredNames = (sql: string): string[] => {
  const found = [...sql.matchAll(/^CREATE (FUNCTION|CONSTRAINT TRIGGER|TRIGGER)\s+([a-z_][a-z0-9_]*)/gm)].map(
    (m) => `${m[1] === 'FUNCTION' ? 'function' : 'trigger'} ${m[2]}`,
  );
  return [...new Set(found)].sort();
};

/** What is declared and not present. Empty when the database is level with the image. */
export const missingFrom = (declared: readonly string[], actual: readonly string[]): string[] => {
  const have = new Set(actual);
  return declared.filter((n) => !have.has(n));
};

export interface SchemaOutcome {
  /** `applied` — the database was empty; `level` — nothing missing; `behind` — see `missing`. */
  state: 'applied' | 'level' | 'behind';
  missing: string[];
}

/**
 * Apply the schema to an empty database, or report what an existing one is missing.
 *
 * Runs before anything else queries a table, which is why it is the first thing `index.ts`
 * awaits: on a fresh installation there is nothing to query until this has finished.
 */
export const ensureSchema = async (
  db: Db,
  opts: { log?: (m: string) => void; warn?: (m: string) => void; file?: string } = {},
): Promise<SchemaOutcome> => {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const sql = await readFile(opts.file ?? SCHEMA_FILE, 'utf8');

  return db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);

    // Asked INSIDE the lock. Two servers reaching this line together would otherwise both read
    // "empty" and both apply.
    const found = await c.query<{ marker: string | null }>('SELECT to_regclass($1)::text AS marker', [MARKER]);
    if (!found.rows[0]?.marker) {
      await c.query(sql);
      log(`schema applied from ${opts.file ?? SCHEMA_FILE}`);
      return { state: 'applied', missing: [] };
    }

    // Asked with the kind attached, for the reason `declaredNames` gives: a name alone cannot
    // tell a dropped trigger from the function it is named after.
    const rows = await c.query<{ name: string }>(
      `SELECT 'function ' || proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
        UNION
       SELECT 'trigger ' || tgname AS name FROM pg_trigger WHERE NOT tgisinternal`,
    );
    const missing = missingFrom(declaredNames(sql), rows.rows.map((r) => r.name));
    if (missing.length === 0) return { state: 'level', missing: [] };

    // A warning and not a refusal. The server runs perfectly well for everything that does not
    // touch what is missing, and a database is not something to refuse to serve on a suspicion
    // — but nothing else would ever say this out loud (docs/13).
    warn(
      `the database is BEHIND this build's schema. Missing: ${missing.join(', ')}. ` +
        'These are functions and triggers, whose absence is silent — a missing trigger does not ' +
        'fail, it simply never fires.',
    );
    return { state: 'behind', missing };
  });
};
