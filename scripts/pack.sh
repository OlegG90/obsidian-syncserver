#!/usr/bin/env bash
# Pack what a deployment of the server needs, and nothing else.
#
# The target host has no git, so the deployment is a copy rather than a pull. One archive
# rather than a list of paths to scp: a list drifts from the compose file the moment either
# changes, and the failure — a pull that stops halfway on a missing file — happens on the
# far side where it is least convenient.
#
# The server image is published from CI and pulled, so this is no longer the build context:
# it is what compose reads (the compose file, .env, db/schema.sql), the deploy and smoke
# scripts, and the manifests a local build would need. It stops being a copy of the source.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

out_dir="${1:-dist-deploy}"
stamp="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
# The release version, which is what the image CI publishes is pinned to (docs/13). Read
# from the root manifest rather than written twice; `check-version.mjs` already refuses
# drift across the six, and this is the seventh place it would otherwise have to be typed.
release="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' package.json | head -1)"
archive="$out_dir/syncserver-$release-$stamp.tar.gz"

mkdir -p "$out_dir"

# Listed explicitly rather than "everything minus ignores": this is what has to arrive, so
# a missing file is an error here and not a surprise during the pull.
files=(
  package.json
  package-lock.json
  tsconfig.base.json
  Dockerfile
  .dockerignore
  docker-compose.yml
  docker-compose.dev.yml
  .env.example
  db/schema.sql
  scripts/deploy-dev-host.sh
  scripts/smoke.sh
  scripts/run-smoke.sh
  shared/package.json
  shared/tsconfig.json
  server/package.json
  server/tsconfig.json
  # The console is built INTO the image and served by the server process (docs/11), so its
  # source travels with the server's rather than being a separate deployable.
  console/package.json
  console/tsconfig.json
  console/esbuild.mjs
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
# The release version, which the image this deployment will pull is pinned to. The archive
# name carries the commit too, so a stamp identifies the exact source; VERSION is what a
# deployment composes the image tag from.
printf '%s\n' "$release" > VERSION
sha256sum "${files[@]}" VERSION > MANIFEST.sha256

# Sources are deliberately absent: the image is pulled, so nothing here is compiled. The
# local-build override (docker-compose.dev.yml) is for a git checkout, where the archive
# is not how the code arrived.
tar czf "$archive" \
  --exclude='*.tsbuildinfo' \
  --exclude='node_modules' \
  --exclude='dist' \
  "${files[@]}" VERSION MANIFEST.sha256

echo "$archive"
echo "  $(tar tzf "$archive" | wc -l) files, $(du -h "$archive" | cut -f1), release $release"

