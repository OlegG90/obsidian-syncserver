/**
 * When the server takes a backup on its own (#357, D-141).
 *
 * Two halves, deliberately apart. Everything above `readSchedule` is arithmetic over a
 * schedule and an instant: no database, no clock of its own, no side effect — so the awkward
 * parts (a zone, two clock changes a year, a day list) are tested by calling a function
 * rather than by waiting for a Tuesday. Below it is the row that holds the schedule and the
 * one statement that claims a moment.
 *
 * The **zone** is the schedule's own, not the server's. A container runs in UTC and nobody
 * lives there: an operator who types 22:00 means 22:00 where they are, and D-122 forbids
 * asking them for a `TZ` on the day they install the server.
 */
import type { ScheduleRefusalCode } from '@syncserver/shared';
import type { Db } from './db.js';

export interface BackupSchedule {
  enabled: boolean;
  /** `HH:MM`, in `zone`. */
  time: string;
  /** Weekdays this runs on, 0 = Sunday, ascending and without repeats. */
  days: number[];
  /** An IANA zone name, e.g. `Europe/Kyiv`. */
  zone: string;
  /** How many scheduled copies survive the sweep. */
  keep: number;
}

/** What a caller sent that cannot be stored — the console's word for it is shared's. */
export type ScheduleProblem = ScheduleRefusalCode;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A zone this runtime knows. `Intl` is the list; there is no second one to disagree with. */
export const knownZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/** Sorted, without repeats — what the schema stores and what a day check reads. */
export const tidyDays = (days: number[]): number[] => [...new Set(days)].sort((a, b) => a - b);

/**
 * The first thing wrong with a schedule, or nothing.
 *
 * **A schedule that is on and names no day is refused**, rather than quietly read as every
 * day or as none: it would sit in the console looking like a schedule while taking no
 * backups, which is the silent failure D-121 refused to build. A schedule that is *off* may
 * hold anything storable — an operator sets the shape first and flips the switch after.
 */
export const scheduleProblem = (s: BackupSchedule): ScheduleProblem | undefined => {
  if (typeof s.time !== 'string' || !TIME.test(s.time)) return 'bad_time';
  if (!Number.isInteger(s.keep) || s.keep < 1 || s.keep > 30) return 'bad_keep';
  if (typeof s.zone !== 'string' || !knownZone(s.zone)) return 'bad_zone';
  if (!Array.isArray(s.days) || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'no_days';
  if (s.enabled && s.days.length === 0) return 'no_days';
  return undefined;
};

interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const formatter = (zone: string): Intl.DateTimeFormat => {
  let f = FORMATTERS.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(zone, f);
  }
  return f;
};

/** What a wall clock in `zone` reads at this instant. */
const localAt = (zone: string, at: Date): Local => {
  const parts = formatter(zone).formatToParts(at);
  const n = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour'),
    minute: n('minute'),
    second: n('second'),
  };
};

const offsetMs = (zone: string, at: Date): number => {
  const l = localAt(zone, at);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - at.getTime();
};

/**
 * The instant at which the clock in `zone` reads this date and time.
 *
 * **Two passes, because the offset depends on the answer.** The first guess uses the offset
 * in force at the wrong moment — an hour out, twice a year, exactly around the changes this
 * has to get right — and the second uses the offset in force at the first guess, which is
 * the right one on either side of a change.
 *
 * The two edge cases are settled rather than avoided. A local time that **does not exist**
 * (the hour a spring change skips) lands just after the gap, so a 02:30 schedule still runs
 * that night. A local time that happens **twice** (the hour an autumn change repeats) is
 * taken at its first occurrence, and the claim mark keeps the second from firing again.
 */
const instantOf = (zone: string, y: number, m: number, d: number, hh: number, mm: number): Date => {
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  const first = wanted - offsetMs(zone, new Date(wanted));
  return new Date(wanted - offsetMs(zone, new Date(first)));
};

/** The weekday of a local calendar date, counted as the schema counts: 0 = Sunday. */
const weekday = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

const atOn = (s: BackupSchedule, y: number, m: number, d: number): Date => {
  const [hh, mm] = s.time.split(':');
  return instantOf(s.zone, y, m, d, Number(hh), Number(mm));
};

/** The local date `offset` days from a local date, normalised through UTC arithmetic. */
const shift = (l: Local, offset: number): { y: number; m: number; d: number } => {
  const t = new Date(Date.UTC(l.year, l.month - 1, l.day + offset));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/**
 * The first moment this schedule fires after `after`, or nothing when it fires on no day.
 *
 * Walks nine local days rather than solving for one: a week, plus the slack a clock change
 * and a schedule that runs on a single weekday need between them.
 */
export const nextRun = (s: BackupSchedule, after: Date): Date | undefined => {
  const days = tidyDays(s.days);
  if (days.length === 0) return undefined;
  const here = localAt(s.zone, after);
  for (let i = 0; i <= 8; i++) {
    const { y, m, d } = shift(here, i);
    if (!days.includes(weekday(y, m, d))) continue;
    const at = atOn(s, y, m, d);
    if (at.getTime() > after.getTime()) return at;
  }
  return undefined;
};

/** The most recent moment this schedule fired at or before `at`, or nothing. */
export const lastDue = (s: BackupSchedule, at: Date): Date | undefined => {
  const days = tidyDays(s.days);
  if (days.length === 0) return undefined;
  const here = localAt(s.zone, at);
  for (let i = 0; i >= -8; i--) {
    const { y, m, d } = shift(here, i);
    if (!days.includes(weekday(y, m, d))) continue;
    const due = atOn(s, y, m, d);
    if (due.getTime() <= at.getTime()) return due;
  }
  return undefined;
};

/**
 * How late a missed moment may be and still be taken.
 *
 * A server that was off at 02:00 and came up at 04:00 should take the copy it owes; one that
 * comes up at noon should not, because the window refuses every device's writes and nobody
 * chose noon for that (D-121's fourth reason). Six hours is late enough to cover a restart
 * and an image pull, and early enough that what it catches is still night.
 */
export const CATCH_UP_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────── the row

interface Row {
  [column: string]: unknown;
  enabled: boolean;
  time: string;
  days: number[];
  zone: string;
  keep: number;
  lastScheduledFor: Date | null;
  updatedAt: Date;
}

/**
 * The stored schedule, with the two marks that make it readable afterwards: which moment has
 * already been dealt with, and when this schedule became the one in force. The second is what
 * keeps a moment that passed BEFORE an operator set the schedule from being called missed.
 */
export type StoredSchedule = BackupSchedule & { lastScheduledFor: Date | null; updatedAt: Date };

export const readSchedule = async (db: Db): Promise<StoredSchedule> => {
  const row = (await db.one<Row>(
    `SELECT enabled, to_char(at_time, 'HH24:MI') AS time, days, zone, keep::int AS keep,
            last_scheduled_for AS "lastScheduledFor", updated_at AS "updatedAt"
       FROM backup_schedule WHERE only_row`,
  ))!;
  return { ...row, days: tidyDays(row.days) };
};

/**
 * Store a schedule, and start counting from now.
 *
 * `last_scheduled_for` is set to the moment the new schedule most recently passed, so
 * switching one on at nine in the morning does not read this morning's 02:00 as missed and
 * open a refusal window while people are working. What an operator turns on begins with its
 * next run, never with a backlog.
 */
export const saveSchedule = async (db: Db, s: BackupSchedule, now = new Date()): Promise<void> => {
  const days = tidyDays(s.days);
  await db.query(
    `UPDATE backup_schedule
        SET enabled = $1, at_time = $2::time, days = $3::smallint[], zone = $4, keep = $5,
            last_scheduled_for = $6, updated_at = $7
      WHERE only_row`,
    // `updated_at` is the caller's instant, not the database's: it is read back as "since when
    // is this schedule the one in force", and a clock the caller cannot see is one a test — or
    // a second server a second out of step — would compare against the wrong moment.
    [s.enabled, s.time, days, s.zone, s.keep, lastDue({ ...s, days }, now) ?? null, now],
  );
};

/**
 * Claim the moment this schedule owes, if it owes one — the whole of "does a backup start now".
 *
 * **The claim is written before anything runs, by a conditional `UPDATE` on the single row.**
 * Two ticks of one server and two servers sharing a database therefore resolve the same way:
 * whoever's update matches takes the moment, and the other is handed nothing back and does
 * nothing. Claiming before the run rather than after is what makes a crash mid-backup cost
 * one copy instead of a loop that retries every minute for ever.
 *
 * `late` reports a moment older than the catch-up window: the caller records it as skipped
 * rather than opening a window at a time nobody chose.
 */
export const claimDue = async (db: Db, now = new Date()): Promise<{ due: Date; late: boolean } | undefined> => {
  const s = await readSchedule(db);
  if (!s.enabled) return undefined;
  const due = lastDue(s, now);
  if (!due) return undefined;
  if (s.lastScheduledFor && s.lastScheduledFor.getTime() >= due.getTime()) return undefined;

  const claimed = await db.one<{ ok: boolean }>(
    `UPDATE backup_schedule SET last_scheduled_for = $1
      WHERE only_row AND enabled
        AND (last_scheduled_for IS NULL OR last_scheduled_for < $1)
      RETURNING true AS ok`,
    [due],
  );
  if (!claimed) return undefined;
  return { due, late: now.getTime() - due.getTime() > CATCH_UP_MS };
};
