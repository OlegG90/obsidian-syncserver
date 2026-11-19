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
 * **Nothing here takes a real backup.** Every server is configured now, so a `POST /admin/backups` on
 * the default legs would dump the development database and write a copy under `var/backups`. The
 * trigger is driven through the `backupLegs` seam instead, into a temporary destination: what is under
 * test is what the route answers and when, and a real copy is `backup.test.ts`'s job.
 *
 * Needs the development database: `npm run db:reset` first.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Legs } from '../src/backup.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import { aDevice, claimSeededAdmin, deviceToken, SEEDED_ADMIN_ID } from './support/accounts.js';

let db: Db;
let app: FastifyInstance;
let adminToken: string;
/** The seeded administrator, claimed exactly as operator.test.ts does. */
const adminId = SEEDED_ADMIN_ID;

before(async () => {
  db = connect(loadConfig().databaseUrl);
  await claimSeededAdmin(db);
  const deviceId = await aDevice(db, adminId);
  app = await buildApp(db, loadConfig());
  adminToken = deviceToken(app, adminId, deviceId);
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

describe('starting a backup, over HTTP (issue #479)', () => {
  // Legs of the test's own, so the route runs for real while nothing is dumped and nothing is
  // written under `var/backups`, where copies are data rather than residue.
  let root: string;
  let started: FastifyInstance;
  let dumpMayFinish: () => void = () => undefined;
  let ready: () => Promise<void> = async () => undefined;
  const legs = (): Legs => ({
    assertReady: () => ready(),
    dumpDatabase: () => new Promise((resolve) => (dumpMayFinish = () => resolve({ bytes: 1 }))),
    copyBlobs: async () => ({ bytes: 0, count: 0 }),
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'syncserver-backup-route-'));
    const cfg = loadConfig();
    started = await buildApp(db, { ...cfg, backup: { ...cfg.backup, destination: root } }, { backupLegs: legs });
  });

  after(async () => {
    await started.close();
    await rm(root, { recursive: true, force: true });
  });

  const press = () =>
    started.inject({ method: 'POST', url: '/admin/backups', headers: { authorization: `Bearer ${adminToken}` } });

  it('answers 202 with the run while the run is still going, and the list follows it', async () => {
    const r = await press();
    // The dump has not finished — it cannot, until this test says so — and the answer is here.
    assert.equal(r.statusCode, 202, r.body);
    const { id, status } = r.json() as { id: string; status: string };
    assert.equal(status, 'running');

    const runOf = async () => {
      const list = await started.inject({
        method: 'GET', url: '/admin/backups', headers: { authorization: `Bearer ${adminToken}` },
      });
      return (list.json() as { backups: { id: string; status: string }[] }).backups.find((b) => String(b.id) === id);
    };
    try {
      assert.equal((await runOf())?.status, 'running', 'the list shows the run the reply named');

      // A second press while it runs is told so at once, by the route rather than by the window.
      const again = await press();
      assert.equal(again.statusCode, 409, again.body);
      assert.equal(again.json().error, 'backup_in_progress');
    } finally {
      // Whatever failed above, the run must end, or it holds the window and the app open for ever.
      dumpMayFinish();
    }
    let settled: string | undefined;
    for (let i = 0; i < 100 && (settled = (await runOf())?.status) === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.notEqual(settled, 'running', 'the run finished behind the reply');
  });

  it('refuses a deployment that cannot take one, synchronously and with the reason', async () => {
    ready = async () => {
      throw new Error('pg_dump 16 cannot dump a PostgreSQL 18 server');
    };
    try {
      const r = await press();
      assert.equal(r.statusCode, 503, r.body);
      assert.equal(r.json().error, 'backup_not_ready');
      assert.match(r.body, /pg_dump 16 cannot dump/);
    } finally {
      ready = async () => undefined;
    }
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

  it('holds the schedule and its audit row in one transaction (issue #477)', async () => {
    // The save and the record used to be two transactions: a failure between them left a schedule
    // in force the log never recorded. The lock below holds the record's INSERT back after the
    // save has run but before anything commits — a reader in that window must still see the old
    // schedule, because either both land or neither does.
    const auth = { authorization: `Bearer ${adminToken}` };
    const list = () => app.inject({ method: 'GET', url: '/admin/backups', headers: auth });
    type Settings = { enabled: boolean; time: string; days: number[]; zone: string; keep: number };
    const settings = (s: Settings): Settings => ({
      enabled: s.enabled, time: s.time, days: s.days, zone: s.zone, keep: s.keep,
    });
    const before = settings(((await list()).json() as { schedule: Settings }).schedule);
    const wanted = { ...good, time: '03:30', days: [2], keep: 6 };

    // SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE an INSERT takes and with nothing a
    // SELECT takes — so the PUT runs up to its audit write and waits there, while reads go on.
    // (A transaction, because LOCK TABLE only lives in one.)
    const pending: Promise<{ statusCode: number }>[] = [];
    await db.tx(async (locker) => {
      await locker.query('LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE');
      pending.push(app.inject({ method: 'PUT', url: '/admin/backups/schedule', headers: auth, payload: wanted }));
      // Until the PUT's backend is waiting on the audit table it may not have saved yet — an
      // early read would show the old schedule for no reason and prove nothing.
      for (let i = 0; i < 100; i++) {
        const waiting = await db.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_locks WHERE relation = 'audit_log'::regclass AND NOT granted`,
        );
        if (waiting!.n !== '0') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const waited = await db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_locks WHERE relation = 'audit_log'::regclass AND NOT granted`,
      );
      assert.notEqual(waited!.n, '0', 'the PUT reached its blocked audit write');
      const mid = await list();
      assert.deepEqual(settings((mid.json() as { schedule: Settings }).schedule), before,
        'an uncommitted schedule stays invisible');
    });
    const done = await pending[0]!;
    assert.equal(done.statusCode, 200);
    const after = settings(((await list()).json() as { schedule: Settings }).schedule);
    assert.deepEqual(after, settings(wanted), 'releasing the lock lets both land together');
    const row = await db.one<{ details: { from?: unknown; to?: unknown } }>(
      `SELECT details FROM audit_log WHERE action = 'backup.schedule' ORDER BY at DESC LIMIT 1`,
    );
    assert.deepEqual(row?.details.from, before, 'the record names what it replaced');
    assert.deepEqual(row?.details.to, settings(wanted));
  });

  it('leaves the schedule as it was when its audit row is refused (issue #477)', async () => {
    // The failure the issue named, made to happen: the audit INSERT is refused after the save has
    // run. One transaction means the save goes with it. `NOT VALID` because the rows already
    // there are not the question — it still holds every new one to `CHECK (false)`.
    const auth = { authorization: `Bearer ${adminToken}` };
    const schedule = async () =>
      ((await app.inject({ method: 'GET', url: '/admin/backups', headers: auth })).json() as {
        schedule: { time: string; keep: number };
      }).schedule;
    const before = await schedule();
    await db.query(`ALTER TABLE audit_log ADD CONSTRAINT test_refuses_every_row CHECK (false) NOT VALID`);
    try {
      const r = await put({ ...good, time: '04:45', keep: 3 });
      assert.notEqual(r.statusCode, 200, 'the save did not report success');
    } finally {
      await db.query(`ALTER TABLE audit_log DROP CONSTRAINT test_refuses_every_row`);
    }
    const after = await schedule();
    assert.deepEqual([after.time, after.keep], [before.time, before.keep], 'and the schedule is unchanged');
  });
});
