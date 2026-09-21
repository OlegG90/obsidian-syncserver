-- Scheduled backups (#357, D-141). Three things a schedule needs that this database has no
-- room for: a place to keep it, a way to tell a run it started from a run somebody pressed,
-- and a word for a moment the server decided not to take one.

-- `triggered_by` names the ADMINISTRATOR and is already nullable for one whose account was
-- deleted, so it cannot also mean "nobody, the schedule did it" — a NULL would rewrite what
-- old rows say about themselves.
CREATE TYPE backup_source AS ENUM ('manual', 'schedule');

ALTER TABLE backup_runs ADD COLUMN source backup_source NOT NULL DEFAULT 'manual';

-- A skip is not a failure: the server was asked to take a copy at a moment when taking one
-- would have been wrong, and said so. Recording it as `failed` would raise the console's
-- banner for a server that behaved exactly as designed.
ALTER TYPE backup_status ADD VALUE IF NOT EXISTS 'skipped';

-- `status::text`, not the enum literal: PostgreSQL refuses to USE a value added to an enum
-- in the transaction that added it, and every migration here is one transaction. The
-- comparison is on text, so nothing reads the new label until a later statement does.
ALTER TABLE backup_runs ADD CONSTRAINT skip_is_explained
    CHECK (status::text <> 'skipped' OR error IS NOT NULL);

-- One row, like `server_meta`, and separate from it: that row is the server's identity and
-- travels inside the delta cursor, this one is configuration an operator edits.
CREATE TABLE backup_schedule (
    only_row   boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    enabled    boolean NOT NULL DEFAULT false,
    at_time    time    NOT NULL DEFAULT '02:00',
    -- 0 = Sunday, as `EXTRACT(dow)` and `Date#getDay` both count.
    days       smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
    -- An IANA zone, because "22:00" alone is a time in no place at all. Checked against the
    -- runtime's own list before it is stored; the schema only insists it says something.
    zone       text    NOT NULL DEFAULT 'UTC' CHECK (zone <> ''),
    -- How many SCHEDULED copies survive. Manual ones are never swept.
    keep       smallint NOT NULL DEFAULT 7 CHECK (keep BETWEEN 1 AND 30),
    -- The scheduled moment already dealt with — the mark that stops a second tick, or a
    -- second server, firing the same one twice.
    last_scheduled_for timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT days_are_weekdays CHECK (days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
    -- A schedule that is on and names no day looks like a schedule and takes no backups.
    CONSTRAINT a_live_schedule_has_days CHECK (NOT enabled OR cardinality(days) > 0)
);

INSERT INTO backup_schedule DEFAULT VALUES;
