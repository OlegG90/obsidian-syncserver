-- The record of which migrations a database has had (#354).
--
-- The first migration, and the one that makes the rest possible: a database from before
-- migrations existed has every other object already, and lacks only this table.
CREATE TABLE schema_migrations (
    id         integer     PRIMARY KEY CHECK (id > 0),
    name       text        NOT NULL,
    checksum   text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
