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

describe('the schedule, over HTTP (#357)', () => {
  const put = (payload: unknown) =>
    app.inject({
      method: 'PUT', url: '/admin/backups/schedule',
      headers: { authorization: `Bearer ${adminToken}` }, payload: payload as object,
    });

  const good = { enabled: true, time: '02:30', days: [1, 3], zone: 'Europe/Kyiv', keep: 5 };

  after(async () => {
    await db.query(`UPDATE backup_schedule SET enabled = false, last_scheduled_for = NULL WHERE only_row`);
  });

  it('is read beside the history, on one call', async () => {
    const r = await app.inject({
      method: 'GET', url: '/admin/backups', headers: { authorization: `Bearer ${adminToken}` },
    });
    assert.equal(r.statusCode, 200);
    const body = r.json() as { schedule?: { enabled: boolean } };
    assert.ok(body.schedule, 'the screen gets its schedule without a second request');
  });

  it('stores one, and answers with what it will do next', async () => {
    const r = await put(good);
    assert.equal(r.statusCode, 200);
    const view = r.json() as { enabled: boolean; days: number[]; zone: string; nextRun: string | null };
    assert.equal(view.enabled, true);
    assert.deepEqual(view.days, [1, 3]);
    assert.equal(view.zone, 'Europe/Kyiv');
    assert.ok(view.nextRun, 'a live schedule says when it fires');
    const limits = r.json() as { keepMax: number; catchUpHours: number };
    assert.deepEqual([limits.keepMax, limits.catchUpHours], [30, 6], 'the limits the card says, from the one place that enforces them (#405)');
  });

  it('records the change in the audit log, with what it was', async () => {
    await put({ ...good, keep: 9 });
    const row = await db.one<{ details: { to?: { keep?: number }; from?: { keep?: number } } }>(
      `SELECT details FROM audit_log WHERE action = 'backup.schedule' ORDER BY at DESC LIMIT 1`,
    );
    assert.equal(row?.details.to?.keep, 9);
    assert.equal(row?.details.from?.keep, 5, 'the previous schedule is the thing somebody will want');
  });

  it('refuses what it cannot keep, by name', async () => {
    for (const [payload, code] of [
      [{ ...good, time: 'midnight' }, 'bad_time'],
      [{ ...good, days: [] }, 'no_days'],
      [{ ...good, zone: 'Middle/Earth' }, 'bad_zone'],
      [{ ...good, keep: 99 }, 'bad_keep'],
    ] as const) {
      const r = await put(payload);
      assert.equal(r.statusCode, 400, code);
      assert.equal((r.json() as { error: string }).error, code);
    }
  });

  it('lets a schedule that is off name no day', async () => {
    const r = await put({ ...good, enabled: false, days: [] });
    assert.equal(r.statusCode, 200);
    assert.equal((r.json() as { nextRun: string | null }).nextRun, null);
  });

  it('is behind the administrator guard, like the rest of the surface', async () => {
    const r = await app.inject({ method: 'PUT', url: '/admin/backups/schedule', payload: good });
    assert.equal(r.statusCode, 401);
  });
});
