#!/usr/bin/env bash
# Drop the development database, apply the schema, run the tests, report.
#
# There is no migration tool: schema.sql creates everything from nothing, so a schema
# change is an edit plus this script (docs/README.md). Needs psql on the PATH — on
# Windows, run it from WSL, where the development PostgreSQL lives.
set -euo pipefail

DB="${SYNCSERVER_DB:-syncserver_dev}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

command -v psql >/dev/null || { echo "psql not found on PATH" >&2; exit 1; }

dropdb --if-exists "$DB" 2>/dev/null || true
createdb "$DB"

# Sweep the blob stores tests write (server/test/support/store.ts). This is the half of the
# guarantee teardown cannot give: a run that crashes, is interrupted, or throws inside a hook
# never reaches its own cleanup, and its store then sits beside var/blobs and var/backups
# looking like data. Swept here because this is already the command for "give me a clean
# slate", and a stale store is exactly as stale as the database being dropped above.
rm -rf "$here/server/var/tmp"

if psql -d "$DB" -q -v ON_ERROR_STOP=1 \
        -f "$here/server/db/schema.sql" -f "$here/server/db/tests.sql" > "$log" 2>&1; then
    echo "$DB: schema applied, $(grep -c 'NOTICE:  PASS' "$log") assertions passed"
else
    # The failing assertion is the only interesting line; expect_fail prints which rule
    # rejected the statement and which one was expected.
    echo "FAILED — $DB left in place for inspection" >&2
    grep -E 'ERROR|FAIL' "$log" >&2 || tail -20 "$log" >&2
    exit 1
fi
