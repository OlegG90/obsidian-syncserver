#!/usr/bin/env bash
# One command to verify a deployed server, from any state it happens to be in:
#
#     ./tools/run-smoke.sh
#
# It brings the server up if it is down, obtains a token whichever way the installation
# allows, and walks M0 and M4. Run it ON the server — smoke.sh reads /proc for a UUID and talks to
# 127.0.0.1, so neither works from a Windows share.
#
# The token is the part that kept going wrong by hand. A fresh installation walks its own
# first run and is handed one at redeem; a claimed one only issues them to somebody who
# knows the account's auth_secret,
# which is printed once and then gone. So for a claimed installation this script signs its
# own, from the SERVER_SECRET in .env — see the step for why that is the operator's own key
# rather than a way around anything.
set -euo pipefail

checkout="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(dirname "$checkout")"
cd "$checkout"

say()  { printf '\n== %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

# The Docker CLI wants a writable HOME on Container Station, same as during deployment.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$root/.docker}"

env_of() { [ -f .env ] && grep "^$1=" .env | tail -1 | cut -d= -f2- || true; }

port="${PUBLISH_PORT:-$(env_of PUBLISH_PORT)}"
port="${port:-8087}"
base="http://127.0.0.1:$port"

say "checkout"
if [ -f MANIFEST.sha256 ]; then
    printf '  release %s\n' "$(cat VERSION 2>/dev/null || echo unknown)"
    # `-c` without --quiet, because busybox has the first and not always the second; every
    # line that is not ": OK" is a file that did not arrive or did not get replaced.
    bad="$(sha256sum -c MANIFEST.sha256 2>&1 | grep -v ': OK$' || true)"
    [ -z "$bad" ] || fail "this checkout is not the one that was packed:

$bad

Extracting over an existing checkout leaves files that could not be replaced. Remove the
directory and extract the archive into an empty one."
    printf '  every file matches the archive it was packed from\n'
else
    printf '  no MANIFEST.sha256 — this checkout predates the stamped archives, so what is\n'
    printf '  in it cannot be verified. Extract a current archive into an empty directory.\n'
fi

# Always, not only when the server is down. A running container is whatever image was built
# the last time somebody remembered — extracting a new checkout over the old one changes
# files on disk and nothing else. Walking against that answers "does the deployment work"
# with a yes about code that may be several commits old, which is worse than no answer.
# deploy-dev-host.sh is idempotent and the build is layer-cached, so an unchanged checkout costs
# seconds; SKIP_DEPLOY=1 is there for walking a server you deliberately did not rebuild.
if [ -n "${SKIP_DEPLOY:-}" ]; then
    say "SKIP_DEPLOY is set — walking whatever image is running, which may not be this checkout"
else
    say "deploying this checkout, so the walk tests the code that is in it"
    ./tools/deploy-dev-host.sh
fi

say "is it up?"
health="$(curl -fsS "$base/health" 2>/dev/null)" || fail "no answer from $base"
printf '  %s\n' "$health"

# A server with no administrator can walk its own first run: smoke.sh sets the console
# password, invites itself a vault account and redeems it. Nothing to arrange.
case "$health" in
    *'"bootstrap_pending":true'*)
        say "no administrator yet — smoke.sh will walk the first run"
        exec ./tools/smoke.sh "$base"
        ;;
esac

say "already claimed — signing a token with the server's own key"
# SERVER_SECRET signs every access token this server issues (docs/04). Holding it IS being
# the server, so producing a token from it is not a way around authentication: it is the
# same act the server performs at login, done by the operator who owns the key. It is here
# because the alternative — the account's auth_secret — is shown once at redeem and is
# stored only as a hash, so an installation whose first run scrolled out of the terminal
# can otherwise never be exercised again without destroying its database.
secret="$(env_of SERVER_SECRET)"
[ -n "$secret" ] || fail "no SERVER_SECRET in $checkout/.env — is this the directory the server was deployed from?"

pguser="$(env_of POSTGRES_USER)"; pguser="${pguser:-syncserver}"
pgdb="$(env_of POSTGRES_DB)";     pgdb="${pgdb:-syncserver}"
q() { docker exec syncserver-db psql -U "$pguser" -d "$pgdb" -At -c "$1"; }

# The token names an account and a DEVICE, because a session that cannot be signed out one
# device at a time is a session nobody signs out (#90). Both come from the database rather
# than being invented: a device row that does not exist is refused on the upload path.
#
# A VAULT account, not the administrator. Since #115 those are different rows: a console
# account holds a password and no key material, and therefore owns no vault, so minting a
# token for it would produce one that authenticates and has nothing to walk. Any active
# vault account with a live device and a vault will do — the walk makes its own content.
user_id="$(q "SELECT u.id FROM users u
              WHERE u.role = 'user' AND u.state = 'active'
                AND EXISTS (SELECT 1 FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL)
                AND EXISTS (SELECT 1 FROM vaults v WHERE v.user_id = u.id)
              ORDER BY u.created_at LIMIT 1")" \
    || fail "could not reach the database container (syncserver-db)"
[ -n "$user_id" ] || fail "no active vault account with a device and a vault in the database.
An administrator alone is not enough: a console account owns no vault. Invite one from the
console and connect it from Obsidian, then re-run this."

device_id="$(q "SELECT id FROM devices WHERE user_id = '$user_id' AND revoked_at IS NULL LIMIT 1")"
[ -n "$device_id" ] || fail "that account has no live device; nothing can hold a token"

vault="$(q "SELECT id FROM vaults WHERE user_id = '$user_id' ORDER BY created_at LIMIT 1")"
[ -n "$vault" ] || fail "that account has no vault"
printf '  user %s\n  device %s\n  vault %s\n' "$user_id" "$device_id" "$vault"

# HS256, which is what @fastify/jwt does with a string secret. base64url is base64 with two
# characters swapped and the padding dropped — spelled out because getting it wrong yields
# a 401 that looks like a credentials problem rather than an encoding one.
b64url() { base64 | tr '+/' '-_' | tr -d '=\n'; }
now="$(date +%s)"
header="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"sub":"%s","device":"%s","iat":%s,"exp":%s}' "$user_id" "$device_id" "$now" "$((now + 900))" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" \
    | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
access="$header.$payload.$signature"

# Checked before the walk, so a bad token fails here with a clear message rather than
# halfway through as a mysterious 401 on some later step.
probe="$(curl -s -o /dev/null -w '%{http_code}' "$base/vaults" -H "authorization: Bearer $access")"
[ "$probe" = "200" ] || fail "the minted token was refused ($probe). Is .env the one this
server is actually running with? A rebuild that regenerated SERVER_SECRET would do this."
printf '  token accepted\n'

say "walking M0 and M4"
printf '  vault %s on %s\n' "$vault" "$base"
# No RESET. The walk makes its own content and its own filename each time, so it does not
# collide with what an earlier run left; destroying the vault to make a test repeatable was
# solving the test's problem with the user's data. Pass RESET=1 to this script to clear
# accumulated runs out — it is forwarded, and it still destroys.
ACCESS="$access" VAULT="$vault" ./tools/smoke.sh "$base"
