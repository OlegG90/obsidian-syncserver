#!/usr/bin/env bash
# The schema and the migrations say the same thing (#354).
#
# `server/db/schema.sql` is what a fresh installation gets; `server/db/migrations/` is what an
# existing database gets. Two descriptions of one schema drift the moment nothing holds them
# together, so this does: the BASELINE release's schema.sql plus every migration, in order, must
# dump exactly like the current schema.sql. A change made in one place and not the other fails
# here instead of on the first database that has it.
#
# Needs psql, pg_dump and createdb on the PATH (the same as db-reset.sh) and git with the baseline
# tag, which is fetched if the checkout is shallow. Not part of `npm test` for those reasons; CI
# runs it in the server job.
set -euo pipefail

# The release migrations start from. Never moves: every migration is written against it.
BASELINE=0.7.10

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! git rev-parse -q --verify "refs/tags/$BASELINE^{commit}" >/dev/null; then
    git fetch -q --depth=1 origin tag "$BASELINE"
fi

fresh=syncserver_equiv_fresh
stepped=syncserver_equiv_stepped
a="$(mktemp)"; b="$(mktemp)"
cleanup() { dropdb --if-exists "$fresh" 2>/dev/null || true; dropdb --if-exists "$stepped" 2>/dev/null || true; rm -f "$a" "$b"; }
trap cleanup EXIT
cleanup
createdb "$fresh"
createdb "$stepped"

psql -d "$fresh" -q -v ON_ERROR_STOP=1 -f server/db/schema.sql >/dev/null
git show "$BASELINE:server/db/schema.sql" | psql -d "$stepped" -q -v ON_ERROR_STOP=1 >/dev/null
count=0
for f in server/db/migrations/[0-9][0-9][0-9][0-9]-*.sql; do
    # One transaction each, as the server applies them.
    psql -d "$stepped" -q -v ON_ERROR_STOP=1 -1 -f "$f" >/dev/null
    count=$((count + 1))
done

# Comments, SET lines and pg_dump's per-run \restrict key differ between any two dumps.
dump() {
    pg_dump --schema-only --no-owner --no-privileges -d "$1" \
        | grep -vE '^(--|SET |SELECT pg_catalog\.set_config|\\restrict|\\unrestrict)' \
        | sed '/^$/d'
}
dump "$fresh" > "$a"
dump "$stepped" > "$b"

if diff -u --label "schema.sql" --label "$BASELINE + $count migration(s)" "$a" "$b"; then
    echo "schema.sql is $BASELINE plus $count migration(s)"
else
    echo "::error::schema.sql and $BASELINE + migrations disagree; the diff above is what one has and the other does not" >&2
    exit 1
fi
