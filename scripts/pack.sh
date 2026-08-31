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
#
# **Packed from the repository, not from the working tree** (#106). This used to `tar` the
# files where they lay, and the difference is not academic: an editor on the developing
# machine wrote CRLF into `deploy-dev-host.sh`, git normalised it on commit — `.gitattributes`
# says `eol=lf` and says why — and the archive shipped the working copy. `#!/usr/bin/env bash`
# with a carriage return on the end names a program called `bash\r`, so the deployment died
# on a NAS with `env: can't execute 'bash'` while `bash` sat on its PATH. The committed
# content was correct the whole time and every check in this repository reads the committed
# content, so nothing could have caught it.
#
# Line endings are the instance; the class is anything uncommitted — a half-finished edit, a
# debug line, a file staged and not committed. The archive's name carries a commit hash, which
# is a claim about provenance that tarring the working tree cannot back. `git archive` makes
# the name true.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

out_dir="${1:-dist/deploy}"
# Any committable point, not only the current one: a tag, a branch, a commit. This is the
# escape hatch that replaces "pack what is lying around" — testing an uncommitted change on a
# dev host means committing it to a branch first, which costs one command and makes the thing
# that ran identifiable afterwards.
ref="${PACK_REF:-HEAD}"
# Peeled to the commit, because an annotated tag is an object of its own: `rev-parse 0.5.0-b`
# answers with the tag's sha, and the archive would then be stamped with a hash that names no
# commit — the exact kind of untrue provenance this file was rewritten to stop.
stamp="$(git rev-parse --short "$ref^{commit}")"

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

# **Refused when the tree disagrees with the ref.** Packing HEAD while there are uncommitted
# changes to the files below is the same failure in a politer form: the archive is not what
# the person looking at their editor believes it is. Only the packed paths are checked —
# whatever else is in flight cannot reach the far side.
dirty="$(git status --porcelain -- "${files[@]}")"
if [ -n "$dirty" ] && [ "$(git rev-parse "$ref")" = "$(git rev-parse HEAD)" ]; then
  echo "uncommitted changes to files this archive ships:" >&2
  printf '%s\n' "$dirty" >&2
  echo >&2
  echo "commit them, or pack another point with PACK_REF=<ref> $0" >&2
  exit 1
fi

# The release version, read from the REF rather than from disk: the archive's name and the
# `SERVER_IMAGE` a deployment composes from `VERSION` must describe the commit that is
# actually inside it. `check-version.mjs` already refuses drift across the six manifests, so
# the root one answers for all of them.
release="$(git show "$ref:package.json" | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)"
[ -n "$release" ] || { echo "no version in package.json at $ref" >&2; exit 1; }
archive="$out_dir/syncserver-$release-$stamp.tar.gz"

# Extracted rather than piped straight into a tar, because two generated files have to travel
# with it and their checksums have to cover what ships.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
git archive --format=tar "$ref" -- "${files[@]}" | tar xf - -C "$staging"

# A file the list names and the ref does not hold is an error here, not a surprise during the
# pull. `git archive` is silent about a pathspec that matched nothing.
for f in "${files[@]}"; do
  [ -e "$staging/$f" ] || { echo "missing at $ref: $f" >&2; exit 1; }
done

printf '%s\n' "$release" > "$staging/VERSION"
# Checksums of what SHIPS, computed in the staging directory so the paths inside are the ones
# a checkout will have. run-smoke.sh checks them on the far side, because extracting a new
# checkout over an old one is not atomic and does not always succeed for every file — a file
# owned by another user is simply not replaced, and tar says so in a line that scrolls past.
# What follows is a checkout half one build and half another, which cost a debugging session:
# the runner was new, the walk it ran was old, and nothing on screen said so.
(cd "$staging" && sha256sum "${files[@]}" VERSION > MANIFEST.sha256)

# No excludes: `git archive` ships tracked files, so there is no `node_modules` or `dist` to
# leave out. Sources are absent because the image is pulled and nothing here is compiled; the
# local-build override (docker-compose.dev.yml) is for a git checkout, where the archive is
# not how the code arrived.
tar czf "$archive" -C "$staging" "${files[@]}" VERSION MANIFEST.sha256

echo "$archive"
echo "  $(tar tzf "$archive" | wc -l) files, $(du -h "$archive" | cut -f1), release $release from $ref ($stamp)"
