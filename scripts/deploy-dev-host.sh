#!/usr/bin/env bash
# Bring the server up on a test host, from the extracted checkout, ON that host:
#
#     tar xzf syncserver-*.tar.gz -C checkout && checkout/scripts/deploy-dev-host.sh
#
# Nothing here is specific to one machine. Where a host needs its own values — a port, a
# data directory, an identity to run as — they come from the environment, so a per-host
# profile is a file of `export` lines rather than a second copy of this script:
#
#     . deploy/<host>.env && checkout/scripts/deploy-dev-host.sh
#
# Safe to re-run: it is the redeploy procedure as much as the first-install one. The one
# thing it will not do twice is write .env — the secrets in it are what the database was
# initialised with and what every issued token is signed by, so regenerating them would
# lock the installation out of its own data. That file therefore lives BESIDE the checkout,
# next to db/ and blobs/, because the checkout is the directory a new build replaces.
set -euo pipefail

checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(dirname "$checkout")"
# 8080 is the container's own port and a poor host default on a NAS, where a management
# interface usually holds it — and the clash surfaces late, after the database is healthy.
port="${PUBLISH_PORT:-8087}"

cd "$checkout"

say() { printf '\n== %s\n' "$1"; }

# The Docker CLI keeps state in $HOME, and on some NAS container runtimes that path is one
# an ordinary administrator cannot create — the build then fails with a permission denied on
# a directory whose name never mentions Docker. Pointing it beside the deployment costs
# nothing anywhere else.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$root/.docker}"
mkdir -p "$DOCKER_CONFIG"

say "directories"
mkdir -p "$root/db" "$root/blobs"
# chmod rather than chown: the container runs as a group the administrator usually already
# belongs to, so group-write is enough — and chown needs root, which is often not available.
chmod 775 "$root/blobs" || echo "  could not chmod blobs; uploads may fail with EACCES"
# The database directory is not ours to arrange: the image takes it over as its own user.
printf '  db:    %s\n  blobs: %s\n' "$root/db" "$root/blobs"

say "configuration"
# The real file lives BESIDE the checkout, not inside it.
#
# Inside, it was destroyed by the documented way of installing a new build — extract into an
# empty directory — and then regenerated, which is worse than losing a config file: the
# database in db/ was initialised with the OLD password and keeps it, so the server cannot
# authenticate and restarts for ever while the database reports itself healthy. "Do not
# write .env twice" cannot be the protection when it lives in the one directory the
# procedure deletes.
#
# The checkout keeps a symlink so that plain `docker compose` commands still work in here.
if [ -f .env ] && [ ! -L .env ]; then
    # An installation from before this change: move the real file up, keep the secrets.
    mv .env "$root/.env"
    echo "  moved .env beside the checkout, where re-extracting cannot reach it"
fi
if [ -f "$root/.env" ]; then
    echo "  $root/.env exists, left untouched"
else
    cd "$root"
    # Hex, not base64: these end up in an env file and, historically, in a connection
    # string. base64 emits / and + and cost us a deployment; hex has nothing to escape.
    # The fallback is sha256sum, not od: od is absent from some NAS userlands and fails
    # quietly, which here would write an EMPTY password into .env — and an empty secret is
    # not the kind of mistake that announces itself.
    secret() {
        s="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)"
        [ ${#s} -eq 64 ] || { echo "cannot generate a secret: neither openssl nor sha256sum worked" >&2; exit 1; }
        printf '%s' "$s"
    }
    cp "$checkout/.env.example" .env
    # Appended rather than substituted: later assignments win in an env file, so this
    # overrides the empty placeholders above without editing them in place.
    {
        printf 'POSTGRES_PASSWORD=%s\n' "$(secret)"
        printf 'SERVER_SECRET=%s\n' "$(secret)"
        printf 'DB_DIR=%s\n' "$root/db"
        printf 'BLOB_DIR=%s\n' "$root/blobs"
        printf 'PUBLISH_PORT=%s\n' "$port"
    } >> .env
    chmod 600 .env
    cd "$checkout"
    echo "  $root/.env written, secrets generated"

    # Secrets that do not match a database which already exists is the failure this whole
    # arrangement exists to prevent, so it is worth saying rather than discovering.
    # Non-empty rather than a named file: from PostgreSQL 18 the cluster sits in a
    # major-version subdirectory, so there is nothing at a fixed path to look for.
    if [ -d "$root/db" ] && [ -n "$(ls -A "$root/db" 2>/dev/null)" ]; then
        cat >&2 <<EOF

  WARNING: db/ already holds a database, and these are FRESH secrets. That database was
  initialised with the previous password and still expects it, so the server will not be
  able to authenticate. Either restore the old .env, or remove $root/db and
  $root/blobs to start over.
EOF
    fi
fi

# Linked only once the target exists: a symlink to a file that is not there yet is a
# dangling one, which some systems refuse to create outright.
ln -sfn "$root/.env" .env

say "build and start"
docker compose up -d --build

say "waiting for health"
for i in $(seq 1 60); do
    health="$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true)"
    case "$health" in
        *'"status":"ok"'*)
            printf '  %s\n' "$health"
            case "$health" in
                *'"bootstrap_pending":true'*)
                    cat <<EOF

The server is up and has no administrator yet, which is the expected first-run state: it
answers only /auth/kdf, /auth/redeem and /health until the seeded invitation is redeemed.

    ./scripts/smoke.sh http://127.0.0.1:$port

EOF
                    ;;
                *) printf '\nUp, with an administrator already claimed.\n\n' ;;
            esac
            exit 0
            ;;
    esac
    sleep 2
done

echo "  no healthy answer after two minutes" >&2
docker compose ps
# Printed, not pointed at. The reason is always in here — a container in a restart loop has
# already written it several times — and asking somebody to go and run another command to
# see it is asking them to guess which one matters.
echo >&2
echo "--- last 25 lines from the server ---" >&2
docker compose logs --tail 25 server >&2 || true
echo >&2
echo "If that says password authentication failed, .env and the database in db/ disagree:" >&2
echo "the database keeps the password it was created with. Restore the old .env, or remove" >&2
echo "the db/ and blobs/ directories to start over." >&2
exit 1
