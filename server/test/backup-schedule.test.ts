/**
 * The schedule's arithmetic and the moment it claims (#357, D-141).
 *
 * The first half needs no database and no waiting: a schedule, an instant, and the question
 * "when next". That is where the clock changes live — a night that is 23 hours long and one
 * that is 25 — and they are exercised by calling a function with a date in March rather than
 * by hoping a test runs in March.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  CATCH_UP_MS,
  claimDue,
  lastDue,
  nextRun,
  readSchedule,
  saveSchedule,
  scheduleProblem,
  tidyDays,
  type BackupSchedule,
} from '../src/backup-schedule.js';
import { OVERDUE_MS, scheduleView, sweepScheduledCopies, takeScheduledBackup } from '../src/backup-scheduler.js';
import { loadConfig } from '../src/config.js';
import { connect, type Db } from '../src/db.js';
import type { Legs } from '../src/backup.js';
import { holdForCollector } from '../src/interlock.js';

const EVERY_DAY: BackupSchedule = { enabled: true, time: '02:00', days: [0, 1, 2, 3, 4, 5, 6], zone: 'UTC', keep: 7 };
const kyiv = (over: Partial<BackupSchedule> = {}): BackupSchedule => ({ ...EVERY_DAY, zone: 'Europe/Kyiv', ...over });

describe('when a schedule fires', () => {
  it('takes the next matching day at the stated time', () => {
    const at = nextRun(EVERY_DAY, new Date('2026-03-10T03:00:00Z'));
    assert.equal(at?.toISOString(), '2026-03-11T02:00:00.000Z');
  });

  it('skips days it does not run on', () => {
    // Wednesdays and Sundays only. From Wednesday afternoon the next is Sunday.
    const s: BackupSchedule = { ...EVERY_DAY, days: [0, 3] };
    const at = nextRun(s, new Date('2026-03-11T15:00:00Z'));
    assert.equal(at?.toISOString(), '2026-03-15T02:00:00.000Z');
  });

  it('is nothing at all when no day is named', () => {
    assert.equal(nextRun({ ...EVERY_DAY, days: [] }, new Date()), undefined);
    assert.equal(lastDue({ ...EVERY_DAY, days: [] }, new Date()), undefined);
  });

  it('keeps the local hour across a spring clock change', () => {
    // Kyiv moves to +03:00 on 29 March 2026. 02:00 local is 00:00Z before and 23:00Z after.
    const before = nextRun(kyiv({ time: '04:00' }), new Date('2026-03-27T12:00:00Z'));
    assert.equal(before?.toISOString(), '2026-03-28T02:00:00.000Z', 'still +02:00 that night');
    const after = nextRun(kyiv({ time: '04:00' }), new Date('2026-03-29T12:00:00Z'));
    assert.equal(after?.toISOString(), '2026-03-30T01:00:00.000Z', '+03:00 once the clocks have moved');
  });

  it('keeps the local hour across an autumn clock change', () => {
    // Kyiv returns to +02:00 on 25 October 2026.
    const at = nextRun(kyiv({ time: '04:00' }), new Date('2026-10-25T12:00:00Z'));
    assert.equal(at?.toISOString(), '2026-10-26T02:00:00.000Z');
  });

  it('still runs on a night whose hour does not exist', () => {
    // 03:30 local never happens in Kyiv on 29 March 2026 — the clock jumps 03:00 → 04:00.
    // The run lands just after the gap rather than being lost for the night.
    const at = nextRun(kyiv({ time: '03:30' }), new Date('2026-03-28T12:00:00Z'));
    assert.equal(at?.toISOString(), '2026-03-29T01:30:00.000Z');
    assert.ok(at!.getTime() > new Date('2026-03-29T00:59:00Z').getTime(), 'after the jump, not before it');
  });

  it('looks backwards for the moment that has just passed', () => {
    const due = lastDue(EVERY_DAY, new Date('2026-03-11T02:00:30Z'));
    assert.equal(due?.toISOString(), '2026-03-11T02:00:00.000Z');
    const earlier = lastDue(EVERY_DAY, new Date('2026-03-11T01:59:00Z'));
    assert.equal(earlier?.toISOString(), '2026-03-10T02:00:00.000Z', 'yesterday, when today has not come round');
  });
});

describe('a schedule the server will not store', () => {
  it('names the field', () => {
    assert.equal(scheduleProblem({ ...EVERY_DAY, time: '2pm' }), 'bad_time');
    assert.equal(scheduleProblem({ ...EVERY_DAY, time: '24:00' }), 'bad_time');
    assert.equal(scheduleProblem({ ...EVERY_DAY, keep: 0 }), 'bad_keep');
    assert.equal(scheduleProblem({ ...EVERY_DAY, keep: 31 }), 'bad_keep');
    assert.equal(scheduleProblem({ ...EVERY_DAY, keep: 2.5 }), 'bad_keep');
    assert.equal(scheduleProblem({ ...EVERY_DAY, zone: 'Middle/Earth' }), 'bad_zone');
    assert.equal(scheduleProblem({ ...EVERY_DAY, days: [7] }), 'no_days');
  });

  it('refuses one that is on and runs on no day, and allows the same one off', () => {
    assert.equal(scheduleProblem({ ...EVERY_DAY, days: [] }), 'no_days');
    assert.equal(scheduleProblem({ ...EVERY_DAY, days: [], enabled: false }), undefined);
  });

  it('tidies the days it stores', () => {
    assert.deepEqual(tidyDays([3, 1, 3, 0]), [0, 1, 3]);
  });
});

// ─────────────────────────────────────────────────────────────── against the database

let db: Db;
let destination: string;

before(() => {
  db = connect(loadConfig().databaseUrl);
  destination = loadConfig().backup.destination;
});

after(async () => {
  await db.query(`DELETE FROM backup_runs`);
  await db.query(`UPDATE backup_schedule SET enabled = false, last_scheduled_for = NULL WHERE only_row`);
  await db.close();
});

const clean = async (): Promise<void> => {
  await db.query(`DELETE FROM backup_runs`);
  await db.query(
    `UPDATE backup_schedule SET enabled = false, at_time = '02:00', days = '{0,1,2,3,4,5,6}',
            zone = 'UTC', keep = 7, last_scheduled_for = NULL WHERE only_row`,
  );
};

/** Legs that write nothing: what this suite tests is the decision to run, not the copying. */
const quiet: Legs = {
  assertReady: async () => {},
  dumpDatabase: async () => ({ bytes: 1 }),
  copyBlobs: async () => ({ bytes: 2, count: 0 }),
};

const deps = { destination: '/tmp/schedule-test', makeLegs: (): Legs => quiet };
const hush = (): void => {};

describe('claiming the moment a schedule owes', () => {
  it('claims it once, however many ticks arrive', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T01:00:00Z'));
    const now = new Date('2026-03-10T02:00:30Z');

    const first = await claimDue(db, now);
    assert.equal(first?.due.toISOString(), '2026-03-10T02:00:00.000Z');
    assert.equal(first?.late, false);
    assert.equal(await claimDue(db, now), undefined, 'the second tick of the same minute claims nothing');
    assert.equal(await claimDue(db, new Date('2026-03-10T02:05:00Z')), undefined, 'nor a later one that day');
  });

  it('claims nothing while the schedule is off', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY, enabled: false }, new Date('2026-03-10T01:00:00Z'));
    assert.equal(await claimDue(db, new Date('2026-03-10T02:00:30Z')), undefined);
  });

  it('starts counting from the moment it is saved, without a backlog', async () => {
    await clean();
    // Saved at nine in the morning: this morning's 02:00 is behind it and is not owed.
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T09:00:00Z'));
    const stored = await readSchedule(db);
    assert.equal(stored.lastScheduledFor?.toISOString(), '2026-03-10T02:00:00.000Z');
    assert.equal(await claimDue(db, new Date('2026-03-10T09:01:00Z')), undefined);
  });

  it('calls a moment older than the catch-up window late', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-09T12:00:00Z'));
    const late = await claimDue(db, new Date(new Date('2026-03-10T02:00:00Z').getTime() + CATCH_UP_MS + 60_000));
    assert.equal(late?.late, true);
  });
});

describe('what a scheduled run records', () => {
  it('records a missed moment as skipped, and takes no backup', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-09T12:00:00Z'));
    const noon = new Date('2026-03-10T12:00:00Z');

    assert.equal(await takeScheduledBackup(db, deps, noon, hush), 'missed');
    const rows = await db.query<{ status: string; error: string; source: string }>(
      `SELECT status::text AS status, error, source::text AS source FROM backup_runs`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'skipped');
    assert.equal(rows[0]!.source, 'schedule');
    assert.match(rows[0]!.error, /missed/);
  });

  it('gives up rather than queueing when the interlock is held, and says why', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T01:00:00Z'));

    // Somebody else's pass or backup owns the lock. The console's button would wait a minute
    // for it; the schedule waits none, because nobody is standing there and the next moment
    // is already on the calendar.
    const held = await new Promise<() => void>((ready) => {
      void db.session(async (lock) => {
        const release = await holdForCollector(lock);
        assert.ok(release, 'the test needs the lock it is about to hold against the schedule');
        await new Promise<void>((done) => ready(() => void done()));
        await release();
      });
    });

    const began = Date.now();
    const out = await takeScheduledBackup(db, deps, new Date('2026-03-10T02:00:30Z'), hush);
    const took = Date.now() - began;
    held();

    assert.equal(out, 'busy');
    assert.ok(took < 10_000, `waited ${took}ms — a scheduled run must not queue behind the lock`);
    const row = await db.one<{ status: string; error: string }>(
      `SELECT status::text AS status, error FROM backup_runs ORDER BY started_at DESC LIMIT 1`,
    );
    assert.equal(row?.status, 'skipped');
    assert.match(row!.error, /lock/);
  });

  it('does nothing at all when nothing is due', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T09:00:00Z'));
    assert.equal(await takeScheduledBackup(db, deps, new Date('2026-03-10T09:30:00Z'), hush), 'none');
    assert.equal((await db.query(`SELECT 1 FROM backup_runs`)).length, 0);
  });
});

describe('what the console is told about the schedule', () => {
  it('reports the next run and no alarm while it is keeping time', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T09:00:00Z'));
    const view = await scheduleView(db, new Date('2026-03-10T09:05:00Z'));
    assert.equal(view.nextRun, '2026-03-11T02:00:00.000Z');
    assert.equal(view.overdue, false);
    assert.equal(view.lastFailed, false);
  });

  it('calls it overdue when a moment passed and nothing answered it', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-09T12:00:00Z'));
    const soonAfter = new Date(new Date('2026-03-10T02:00:00Z').getTime() + OVERDUE_MS - 60_000);
    assert.equal((await scheduleView(db, soonAfter)).overdue, false, 'not within the hour');
    const later = new Date(new Date('2026-03-10T02:00:00Z').getTime() + OVERDUE_MS + 60_000);
    assert.equal((await scheduleView(db, later)).overdue, true);
  });

  it('is not overdue once a run of its own answered the moment, even a skipped one', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-09T12:00:00Z'));
    await db.query(
      `INSERT INTO backup_runs (started_at, finished_at, status, error, source)
       VALUES ('2026-03-10T02:00:10Z', '2026-03-10T02:00:10Z', 'skipped', 'the lock was held', 'schedule')`,
    );
    const later = new Date('2026-03-10T05:00:00Z');
    assert.equal((await scheduleView(db, later)).overdue, false);
  });

  it('says so when the last scheduled run failed', async () => {
    await clean();
    await saveSchedule(db, { ...EVERY_DAY }, new Date('2026-03-10T09:00:00Z'));
    await db.query(
      `INSERT INTO backup_runs (started_at, finished_at, window_opened_at, window_closed_at, status, error, source)
       VALUES (now(), now(), now(), now(), 'failed', 'the dump died', 'schedule')`,
    );
    assert.equal((await scheduleView(db, new Date('2026-03-10T09:30:00Z'))).lastFailed, true);
  });
});

describe('retention', () => {
  const copy = async (source: 'manual' | 'schedule', startedAt: string, dir: string): Promise<string> => {
    const row = await db.one<{ id: string }>(
      `INSERT INTO backup_runs (started_at, finished_at, window_opened_at, window_closed_at,
                                db_done_at, blobs_done_at, status, destination, source, bytes, blob_count)
       VALUES ($1, $1, $1, $1, $1, $1, 'ok', $2, $3, 1, 0) RETURNING id::text AS id`,
      [startedAt, dir, source],
    );
    return row!.id;
  };

  it('keeps the last few scheduled copies and never touches a manual one', async () => {
    await clean();
    const root = destination;
    const kept: string[] = [];
    for (let day = 1; day <= 4; day++) {
      kept.push(await copy('schedule', `2026-03-0${day}T02:00:00Z`, `${root}/backup-2026-03-0${day}`));
    }
    // Named the way a real run names its directory. A name of its own would be refused as
    // `outside_destination` — and a fixture the removal refuses for the WRONG reason is a
    // fixture that would keep passing if retention started sweeping manual copies.
    const byHand = await copy('manual', '2026-03-01T09:00:00Z', `${root}/backup-2026-03-01T09-00-00-000Z`);

    // Keep two. The two oldest scheduled copies go; the manual one is not a candidate at all.
    await sweepScheduledCopies(db, root, 2, hush);

    const gone = await db.query<{ id: string }>(`SELECT id::text AS id FROM backup_runs WHERE destination IS NULL`);
    assert.deepEqual(gone.map((r) => r.id).sort(), [kept[0]!, kept[1]!].sort());
    const manual = await db.one<{ destination: string | null }>(`SELECT destination FROM backup_runs WHERE id = $1`, [
      byHand,
    ]);
    assert.ok(manual?.destination, 'a copy somebody took by hand survives every sweep');
  });

  it('never removes the newest copy, whatever the number says', async () => {
    await clean();
    const root = destination;
    const only = await copy('schedule', '2026-03-01T02:00:00Z', `${root}/backup-2026-03-01`);
    await sweepScheduledCopies(db, root, 1, hush);
    const row = await db.one<{ destination: string | null }>(`SELECT destination FROM backup_runs WHERE id = $1`, [
      only,
    ]);
    assert.ok(row?.destination, 'the last copy standing is the one a restore would use');
  });
});
