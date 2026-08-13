#!/usr/bin/env bash
# Pack everything the server needs to be built and run, and nothing else.
#
# The target host has no git, so the deployment is a copy rather than a pull. One archive
# rather than a list of paths to scp: a list drifts from the Dockerfile the moment either
# changes, and the failure — a build that stops halfway on a missing file — happens on the
# far side where it is least convenient.
#
# What goes in is the Docker build context plus the two files compose reads: the compose
# file itself and db/schema.sql, which the database container mounts to initialise itself.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

out_dir="${1:-dist-deploy}"
stamp="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
archive="$out_dir/syncserver-$stamp.tar.gz"

mkdir -p "$out_dir"

# Listed explicitly rather than "everything minus ignores": this is what has to arrive, so
# a missing file is an error here and not a surprise during the build.
files=(
  package.json
  package-lock.json
  tsconfig.base.json
  Dockerfile
  .dockerignore
  docker-compose.yml
  .env.example
  db/schema.sql
  scripts/deploy-dev-host.sh
  scripts/smoke.sh
  scripts/run-smoke.sh
  shared/package.json
  shared/tsconfig.json
  server/package.json
  server/tsconfig.json
  # npm ci installs the whole workspace, so every member's manifest must be present even
  # though the plugin's source is not built here.
  plugin/package.json
)

for f in "${files[@]}"; do
  [ -e "$f" ] || { echo "missing: $f" >&2; exit 1; }
done

# A stamp and a checksum for every file, both travelling inside the archive.
#
# Extracting a new checkout over an old one is not atomic and does not always succeed for
# every file — a file owned by another user simply is not replaced, and tar says so in a
# line that scrolls past. What follows is a checkout that is half one build and half
# another, which cost a debugging session: the runner was new, the walk it ran was old, and
# nothing on screen said so. run-smoke.sh verifies this before it does anything.
trap 'rm -f VERSION MANIFEST.sha256' EXIT
printf '%s\n' "$stamp" > VERSION
sha256sum "${files[@]}" $(find shared/src server/src -type f) VERSION > MANIFEST.sha256

# Sources: the two packages that are compiled. The plugin's source is deliberately absent —
# it is a different program with a different build, and it has no business in a server image.
tar czf "$archive" \
  --exclude='*.tsbuildinfo' \
  --exclude='node_modules' \
  --exclude='dist' \
  "${files[@]}" shared/src server/src VERSION MANIFEST.sha256

echo "$archive"
echo "  $(tar tzf "$archive" | wc -l) files, $(du -h "$archive" | cut -f1), build $stamp"
