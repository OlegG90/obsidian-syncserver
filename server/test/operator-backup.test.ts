/**
 * The console's backup surface: list and verify — over HTTP.
 *
 * The window itself and the verify check are covered in `backup.test.ts` with the legs injected. What
 * this suite proves is the wiring: that the routes exist, that they sit behind the administrator guard,
 * and that they answer about the runs rather than about the configuration.
 *
 * **It used to prove the opposite** — that an unconfigured server answers "not configured" — and that
 * state no longer exists (D-122). Nothing replaces those cases with a test that the refusal is gone,
 * because `backup_not_configured` has left `OperatorRefusalCode` and the code can no longer name it: the
 * compiler holds that now, and a test asserting an absent string would pass whether or not the branch
 * came back under a different one.
 *
 * **Nothing here takes a backup.** Every server is configured now, so a `POST /admin/backups` would
 * dump the development database and open a refusal window in a file the runner may be running beside
 * others — a real copy is `backup.test.ts`'s job, with legs it controls.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';

let db: Db;
let app: FastifyInstance;
let adminToken: string;
/** The seeded administrator, claimed exactly as operator.test.ts does. */
const adminId = '00000000-0000-0000-0000-000000000001';

before(async () => {
  db = connect(loadConfig().databaseUrl);
  await db.query(
    `UPDATE users SET state = 'active', password_hash = '$argon2id$test'
      WHERE id = $1 AND state = 'provisioned'`,
    [adminId],
  );
  const device = await db.one<{ id: string }>(
    `INSERT INTO devices (user_id, name, platform) VALUES ($1, 'test', 'linux') RETURNING id`, [adminId]);
  app = await buildApp(db, loadConfig());
  adminToken = app.jwt.sign({ sub: adminId, device: device!.id });
});

after(async () => {
  await app.close();
  await db.close();
});

describe('the backup surface', () => {
  it('lists the history', async () => {
    const r = await app.inject({
      method: 'GET', url: '/admin/backups',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 200);
    // An array, and NOT an empty one. It asserted emptiness until this suite stopped being the only one
    // that could put a row in `backup_runs`: the runner starts these files beside each other against one
    // development database, and `operator-asking-to-restore.test.ts` seeds runs of its own. A test that
    // passes only when it wins that race proves nothing about the route and fails about something else.
    assert.ok(Array.isArray(r.json().backups));
  });

  it('refuses an unauthenticated caller', async () => {
    const r = await app.inject({ method: 'GET', url: '/admin/backups' });
    assert.equal(r.statusCode, 401);
  });

  it('answers not found for a verify of a run that does not exist', async () => {
    const r = await app.inject({
      method: 'POST', url: '/admin/backups/999999/verify',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // 404, and it used to be 503: the configuration was refused before the id was ever looked at, so
    // this case could not tell a missing run from a missing destination. Now the id is the only thing
    // that can be wrong here (D-122).
    assert.equal(r.statusCode, 404);
    assert.equal(r.json().error, 'not_found');
  });
});
