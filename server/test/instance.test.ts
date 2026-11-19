/**
 * One server per database (docs/02, D-144): the claim a boot takes, and what the next one reads.
 *
 * The boot path itself is not what is exercised — it holds the claim for the life of the
 * process, which a test cannot outlive. What is exercised is the claim: the first connection
 * takes it, a second is refused with a sentence naming the holder, and ending the holder's
 * connection frees it, which is what lets a crashed instance stop refusing by disconnecting.
 *
 * **Each claimant is a pool of its own, closed when it is done.** `db.session` hands its
 * connection back to the pool rather than closing it, and a session lock goes with the
 * connection — so a claim taken through a shared pool outlives the test that took it, and the
 * next `session` on that pool is handed the same backend and "claims" a lock it already holds.
 * Ending the session is not ending the connection; a test that conflated them would pass for
 * the wrong reason.
 *
 * Needs the development database. It builds no app and claims no administrator, so it runs
 * anywhere in the file order and beside anything — the lock it takes is its own, shared with
 * nothing the other suites hold.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { claimInstance, onClaimLost } from '../src/instance.js';

/** Claims nothing: it only looks and terminates, as an operator's `psql` would. */
let db: Db;

before(() => {
  db = connect(loadConfig().databaseUrl);
});

after(async () => {
  await db.close();
});

/** One server process, as far as the database can tell: its own pool, closed on the way out. */
const asProcess = async <T>(fn: (p: Db) => Promise<T>): Promise<T> => {
  const p = connect(loadConfig().databaseUrl);
  try {
    return await fn(p);
  } finally {
    await p.close();
  }
};

describe('one server per database', () => {
  it('lets the first claim through and tells the second who holds it', async () => {
    await asProcess((first) =>
      first.session(async (c) => {
        assert.deepEqual(await claimInstance(c), { ok: true });
        const second = await asProcess((other) => other.session(claimInstance));
        assert.equal(second.ok, false);
        if (second.ok) return;
        assert.match(second.holder, /another server instance is already running/);
        assert.match(second.holder, /connected \d{4}-\d{2}-\d{2}/, 'with when it connected');
        assert.match(second.holder, /as syncserver\//, 'under a name an operator can match');
      }),
    );
  });

  it('frees the claim when the holding connection ends', async () => {
    // Session-scoped is the whole point: no row to age out, no stale refusal after a crash.
    await asProcess((first) =>
      first.session(async (c) => assert.deepEqual(await claimInstance(c), { ok: true })),
    );
    await asProcess((next) =>
      next.session(async (c) => assert.deepEqual(await claimInstance(c), { ok: true })),
    );
  });

  it('says so, in a sentence, when the connection holding the claim is cut', async () => {
    // A PostgreSQL restart ends the claim while the process goes on. Unheard, the driver's
    // `error` event was an uncaught exception and the operator got a stack trace; heard, it is
    // one line, and the claim is free for the restart that follows.
    const reason = await asProcess((holder) =>
      holder.session(async (c) => {
        assert.deepEqual(await claimInstance(c), { ok: true });
        const heard = new Promise<string>((resolve) => onClaimLost(c, resolve));
        const { rows } = await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        await db.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
        return heard;
      }),
    );
    assert.match(reason, /connection holding this server's claim on the database ended/);
    await asProcess((next) =>
      next.session(async (c) =>
        assert.deepEqual(await claimInstance(c), { ok: true }, 'and the claim is free again'),
      ),
    );
  });
});
