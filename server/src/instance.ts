import { hostname } from 'node:os';
import type { PoolClient } from 'pg';
import { INTERLOCK_ID } from './interlock.js';

/**
 * One server per database (docs/02, D-144).
 *
 * The backup window, the upload and sign-in rate limiters and the halt after an unconfirmed
 * restore all live in this process's memory, so a second instance against the same database
 * would accept writes a backup is refusing, allow every limit twice over, and never halt —
 * and nothing would say so. The boot therefore claims the database before it touches it, and
 * a claimant that arrives second refuses to start with a sentence naming the first.
 *
 * A session-level advisory lock, not a row. A row needs staleness logic — a crashed process
 * stops refreshing, and the next boot has to decide whether "ten minutes without a heartbeat"
 * means dead or slow — while a session lock goes away with the connection that held it: a
 * dead instance stops refusing the moment it disconnects, and only a live one ever does.
 *
 * Held, not taken. `pg_try_advisory_lock` on a pooled connection that goes straight back
 * releases the claim in the same statement that took it, so the boot holds its session open
 * until shutdown and the pool closing ends the claim. That is one pooled slot for the life
 * of the process, beside the one the event hub already keeps.
 */

export type InstanceClaim = { ok: true } | { ok: false; holder: string };

/** Beside the interlock and the schema lock, so the three can never be one number by accident. */
export const INSTANCE_LOCK_ID = INTERLOCK_ID + 2;

/** Who holds the claim, in words an operator can match to a log line or a `docker ps`. */
const describeHolder = async (client: PoolClient): Promise<string | undefined> => {
  // `classid` and `objid` are how a four-byte key reads back: the experiment that fixed this
  // shape took the lock and read `pg_locks`, and the key came back as `objid` with
  // `classid = 0`. Anything coarser — any advisory lock held by any other backend — would
  // blame a backup's interlock for a second server.
  const row = await client.query<{ app: string | null; addr: string | null; since: Date }>(
    `SELECT a.application_name AS app, a.client_addr::text AS addr, a.backend_start AS since
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = $1
        AND l.pid <> pg_backend_pid()`,
    [INSTANCE_LOCK_ID],
  );
  const found = row.rows[0];
  if (!found) return undefined;
  const parts = [`connected ${found.since.toISOString()}`];
  if (found.addr) parts.push(`from ${found.addr}`);
  if (found.app) parts.push(`as ${found.app}`);
  return `another server instance is already running against this database (${parts.join(' ')})`;
};

/**
 * Take the instance claim on this connection: try the lock, and name the holder when taken.
 *
 * The caller keeps the connection until shutdown — releasing it is releasing the claim.
 * When the holder cannot be found it disconnected between the attempt and the lookup, so
 * the sentence says to start again rather than naming nobody.
 */
export const claimInstance = async (client: PoolClient): Promise<InstanceClaim> => {
  const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
    INSTANCE_LOCK_ID,
  ]);
  if (got.rows[0]?.ok) {
    // So the next claimant reads something matchable rather than an empty application name
    // beside a backend pid. `set_config` rather than `SET` so the name travels as a value,
    // not as SQL the hostname would have to be quoted out of.
    await client.query(`SELECT set_config('application_name', $1, false)`, [
      `syncserver/${hostname()}/${process.pid}`,
    ]);
    return { ok: true };
  }
  return {
    ok: false,
    holder:
      (await describeHolder(client)) ??
      'another server instance held this database a moment ago and is already gone — start again',
  };
};
