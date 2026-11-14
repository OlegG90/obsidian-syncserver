/**
 * One server per database (docs/02, D-144): the claim a boot takes, and what the next one reads.
 *
 * The boot path itself is not what is exercised — it holds the claim for the life of the
 * process, which a test cannot outlive. What is exercised is the claim: the first session
 * takes it, a second is refused with a sentence naming the holder, and ending the holder's
 * session frees it, which is what lets a crashed instance stop refusing by disconnecting.
 *
 * Needs the development database. It builds no app and claims no administrator, so it runs
 * anywhere in the file order and beside anything — the lock it takes is its own, shared with
 * nothing the other suites hold.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { claimInstance } from '../src/instance.js';

let db: Db;

before(() => {
  db = connect(loadConfig().databaseUrl);
});

after(async () => {
  await db.close();
});

describe('one server per database', () => {
  it('lets the first claim through and tells the second who holds it', async () => {
    await db.session(async (first) => {
      assert.deepEqual(await claimInstance(first), { ok: true });
      // A nested session is a second pooled connection, which is what a second process would be.
      const second = await db.session(async (other) => claimInstance(other));
      assert.equal(second.ok, false);
      if (second.ok) return;
      assert.match(second.holder, /another server instance is already running/);
      assert.match(second.holder, /connected \d{4}-\d{2}-\d{2}/, 'with when it connected');
      assert.match(second.holder, /as syncserver\//, 'under a name an operator can match');
    });
  });

  it('frees the claim when the holding session ends', async () => {
    // Session-scoped is the whole point: no row to age out, no stale refusal after a crash.
    await db.session(async (c) => {
      assert.deepEqual(await claimInstance(c), { ok: true });
    });
    await db.session(async (c) => {
      assert.deepEqual(await claimInstance(c), { ok: true });
    });
  });
});
