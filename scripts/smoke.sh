#!/usr/bin/env bash
# Walk M0 and M4 end to end against a running server:
#
#     ./scripts/smoke.sh http://127.0.0.1:8087
#
# The redemption below carries `kek_verifier` and **no recovery pair**, which is what a real
# client sends since M3.5 (#112): the verifier is what makes an account recoverable at all and
# is required, while null recovery columns are the honest way to say "this account has no
# recovery code". This script sent the opposite — a placeholder pair and no verifier — and had
# therefore been unable to claim an administrator since that milestone shipped, which nothing
# noticed because it only ever runs against a real deployment.
#
# Claims the seeded administrator if nobody has, then exercises the account surface, a
# blob, all three node verbs the roadmap names for M0 — create, put, delete — and the
# delta that reports them. Everything it sends is shaped correctly and means nothing — the key
# material is placeholder bytes, so this account can never decrypt anything a real client
# writes. It is a way to exercise the server, not a way to start using it.
#
# Against an installation somebody has already claimed, pass the token and vault:
#
#     ACCESS=<token> VAULT=<uuid> ./scripts/smoke.sh http://127.0.0.1:8087
#
# Every run uses its own content and its own filename, so it neither collides with nor
# depends on what an earlier run left behind — running it twice against the same vault is
# the normal case, not something to arrange. RESET=1 exists only as housekeeping, to clear
# accumulated runs out of a test vault; it DESTROYS the vault's own nodes with no undo, so
# it is never implied.
set -euo pipefail

base="${1:-http://127.0.0.1:8087}"

# No jq on a NAS. These are our own responses, so a field is either there or the request
# failed, and the next step says so plainly enough.
field() { sed 's/.*"'"$1"'":"\([^"]*\)".*/\1/'; }
# The same, for a field whose value is a bare number rather than a quoted string.
number() { sed 's/.*"'"$1"'":\([0-9]*\).*/\1/'; }
uuid() { cat /proc/sys/kernel/random/uuid; }
secret() { openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64; }

# 64 hex characters. The fallback is sha256sum — already used further down, and present
# where `od` is not: some NAS userlands omit it, and it fails quietly enough that the
# field went out EMPTY and the server took it. A column that is NOT NULL is not thereby
# non-empty, so the value is checked here rather than assumed.
hex32() {
    h="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | sha256sum | cut -d' ' -f1)"
    [ ${#h} -eq 64 ] || fail "cannot generate random hex: neither openssl nor sha256sum worked"
    printf '%s' "$h"
}

step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

step "health"
health="$(curl -fsS "$base/health")" || fail "no answer from $base"
printf '  %s\n' "$health"

if [ -n "${ACCESS:-}" ]; then
    # An installation somebody has already claimed. The token and vault come from
    # whoever claimed it — this script has no way to obtain them, and inventing a
    # second administrator to get them would be a worse answer than asking.
    step "using the token supplied in ACCESS"
    access="$ACCESS"
    hdr="authorization: Bearer $access"
    vault="${VAULT:-$(curl -fsS "$base/vaults" -H "$hdr" | sed 's/.*"id":"\([^"]*\)".*/\1/')}"
    [ -n "$vault" ] || fail "no vault found; pass VAULT=<uuid>"
    root="${ROOT:-$(curl -fsS "$base/vaults/$vault" -H "$hdr" | field root_node_id)}"
    printf '  vault %s\n' "$vault"

elif printf '%s' "$health" | grep -q '"bootstrap_pending":true'; then
    step "claiming the seeded administrator"
    auth_secret="$(secret)"
    vault="$(uuid)"
    resp="$(curl -fsS -X POST "$base/auth/redeem" -H 'content-type: application/json' -d '{
      "invitation_token": "admin",
      "login": "admin",
      "auth_secret": "'"$auth_secret"'",
      "account_salt": "'"$(openssl rand -base64 16 2>/dev/null || head -c 16 /dev/urandom | base64)"'",
      "kdf_params": {"v":19,"m":65536,"t":3,"p":1},
      "pubkey": "AQ==", "enc_privkey": "Ag==", "wrapped_seed": "Aw==",
      "kek_verifier": "'"$(hex32)"'",
      "initial_vault_id": "'"$vault"'",
      "initial_vault_name_enc": "'"$(printf 'test vault' | base64)"'",
      "device_name": "smoke", "device_platform": "linux"
    }')" || fail "redeem refused; the invitation may already be spent"

    access="$(printf '%s' "$resp" | field access)"
    root="$(printf '%s' "$resp" | field root_node_id)"
    printf '  vault %s\n  auth_secret (keep this to log in again): %s\n' "$vault" "$auth_secret"
else
    fail "this installation already has an administrator, so there is no invitation to claim.
Re-run with the token from whoever claimed it:

    ACCESS=<token> VAULT=<uuid> $0 $base"
fi

hdr="authorization: Bearer $access"

# Housekeeping, on request only. The walk does not need it — each run is independent — but
# runs accumulate trashed nodes, and this clears them out.
#
# `reset` HARD-destroys the vault's own nodes (AC-14) — no trash, no undo from the server,
# recoverable only from a client that still holds the data. So it is opt-in rather than
# automatic: this script is pointed at whatever `$base` says, the ACCESS path exists
# precisely for installations somebody is already using, and nothing here can tell a vault
# holding a test note from a vault holding somebody's notes. A flag makes the caller say
# which one it is.
if [ -n "${RESET:-}" ]; then
    step "reset (RESET is set: the vault's own nodes will be DESTROYED, not trashed)"
    printf '  vault %s on %s\n' "$vault" "$base"
    out="$(curl -fsS -X POST "$base/vaults/$vault/reset" -H "$hdr")" || fail "reset was refused"
    printf '  %s\n' "$out"
    # The root survives a reset and the epoch moves, so both are re-read rather than
    # assumed: other devices are answered `410 reset` from here on (#80).
    root="$(printf '%s' "$out" | field root_node_id)"
    [ -n "$root" ] || fail "reset did not report a root node: $out"
fi

step "the bootstrap guard has lifted"
curl -fsS "$base/health"; echo

step "account surface"
printf '  vaults: %s\n' "$(curl -fsS "$base/vaults" -H "$hdr")"
printf '  usage:  %s\n' "$(curl -fsS "$base/usage" -H "$hdr")"

step "a blob"
# Every run makes its own content and its own filename.
#
# This used to be a fixed string, and that quietly made the whole walk a one-shot: the
# account keeps holding a blob it has bound, so on the second run `HEAD` answers 200 and the
# #20 assertion below fails — correctly. The same for the name, which collides with the one
# the last run left behind. Both were being papered over by resetting the vault, which is a
# destructive operation standing in for a property the test should have had to begin with.
run="$(hex32 | cut -c1-12)"
printf '  run %s\n' "$run"

tmp="$(mktemp)"; printf 'hello from the smoke test, run %s' "$run" > "$tmp"
sha="$(sha256sum "$tmp" | cut -d' ' -f1)"
size="$(wc -c < "$tmp" | tr -d ' ')"
key="$(uuid)"
curl -fsS -X POST "$base/blobs?sha256=$sha&size=$size&key_id=$key" \
     -H "$hdr" -H 'content-type: application/octet-stream' --data-binary @"$tmp"; echo

# Expected 404, and it is the point: an upload leaves a PENDING reference, and reads are
# authorised by a LIVE one (#20). A 200 here would mean the rule is not being enforced.
code="$(curl -s -o /dev/null -w '%{http_code}' -I "$base/blobs/$sha" -H "$hdr")"
[ "$code" = "404" ] \
    && printf '  HEAD /blobs → 404, correct: a pending reference is not a live one (#20)\n' \
    || fail "HEAD /blobs answered $code; expected 404 while the blob is only pending"

# Also expected: 201 rather than "already have it". The short circuit is absent on purpose,
# or the address would become an existence oracle (#46).
again="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/blobs?sha256=$sha&size=$size&key_id=$key" \
    -H "$hdr" -H 'content-type: application/octet-stream' --data-binary @"$tmp")"
[ "$again" = "201" ] \
    && printf '  re-upload → 201, correct: no "already have it" short circuit (#46)\n' \
    || fail "re-upload answered $again; expected 201"
rm -f "$tmp"

step "a node, and the delta that reports it"
# The vault's key SCOPE, which is not the blob's content key id above: names and envelopes
# are keyed per scope, and the schema checks that a private node is named under its own
# vault's key. An invented id gets as far as the database and no further.
scope="$(curl -fsS "$base/vaults/$vault" -H "$hdr" | sed 's/.*"key_id":"\([^"]*\)".*/\1/')"
[ -n "$scope" ] || fail "could not read the vault's key scope"
node="$(curl -fsS -X POST "$base/vaults/$vault/nodes" -H "$hdr" -H 'content-type: application/json' -d '{
  "parent_id": "'"$root"'", "type": "file",
  "sha256": "'"$sha"'", "size": '"$size"',
  "mtime": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'",
  "name_enc": "'"$(printf 'note-%s.md' "$run" | base64)"'",
  "name_hmac": "'"$(printf 'note-%s.md' "$run" | sha256sum | cut -d' ' -f1)"'",
  "name_key_id": "'"$scope"'",
  "blob_envelopes": [{"sha256":"'"$sha"'","scope_id":"'"$scope"'","wrapped_key":"AAAA"}],
  "dedup_tags": [{"sha256":"'"$sha"'","scope_id":"'"$scope"'","content_tag":"'"$(printf 'tag-%s' "$run" | sha256sum | cut -d' ' -f1)"'"}]
}')" || fail "creating a node failed"
printf '  node: %s\n' "$node"
node_id="$(printf '%s' "$node" | field node_id)"
rev="$(printf '%s' "$node" | number rev)"
[ -n "$node_id" ] && [ -n "$rev" ] || fail "could not read node_id/rev out of: $node"

# Now the blob has a live reference, so the same request that was 404 above is 200.
code="$(curl -s -o /dev/null -w '%{http_code}' -I "$base/blobs/$sha" -H "$hdr")"
[ "$code" = "200" ] \
    && printf '  HEAD /blobs → 200, correct: a node now holds it\n' \
    || fail "HEAD /blobs answered $code after the node was created; expected 200"

printf '  delta: %s\n' "$(curl -fsS "$base/vaults/$vault/delta" -H "$hdr")"
printf '  usage: %s\n' "$(curl -fsS "$base/usage" -H "$hdr")"

step "a second revision, and the precondition that guards it"
tmp2="$(mktemp)"; printf 'hello again, with different content, run %s' "$run" > "$tmp2"
sha2="$(sha256sum "$tmp2" | cut -d' ' -f1)"
size2="$(wc -c < "$tmp2" | tr -d ' ')"
curl -fsS -X POST "$base/blobs?sha256=$sha2&size=$size2&key_id=$key" \
     -H "$hdr" -H 'content-type: application/octet-stream' --data-binary @"$tmp2" >/dev/null
rm -f "$tmp2"

# The precondition is CONTENT, not a revision (#52): `rev` moves on a rename too, and using
# it here would turn "renamed on the desktop, edited on the phone" into a conflict between
# two changes that do not overlap. So a wrong base is refused even though the rev is right.
put_body() { printf '{
  "sha256": "%s", "size": %s, "mtime": "%s", "base_sha256": %s,
  "blob_envelopes": [{"sha256":"%s","scope_id":"%s","wrapped_key":"AAAA"}],
  "dedup_tags": [{"sha256":"%s","scope_id":"%s","content_tag":"%s"}]
}' "$sha2" "$size2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$sha2" "$scope" "$sha2" "$scope" \
   "$(printf 'tag2-%s' "$run" | sha256sum | cut -d' ' -f1)"; }

stale="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$base/vaults/$vault/nodes/$node_id" \
    -H "$hdr" -H 'content-type: application/json' -d "$(put_body '"'"$sha2"'"')")"
[ "$stale" = "409" ] \
    && printf '  PUT on a wrong base → 409, correct: the precondition is the content (#52)\n' \
    || fail "PUT with a mismatched base_sha256 answered $stale; expected 409"

# And the same write with the base it actually has goes through.
put="$(curl -fsS -X PUT "$base/vaults/$vault/nodes/$node_id" \
    -H "$hdr" -H 'content-type: application/json' -d "$(put_body '"'"$sha"'"')")" \
    || fail "PUT with the correct base_sha256 was refused"
rev2="$(printf '%s' "$put" | number rev)"
[ -n "$rev2" ] && [ "$rev2" != "$rev" ] \
    && printf '  PUT → rev %s (was %s)\n' "$rev2" "$rev" \
    || fail "PUT did not move the revision: $put"

step "delete"
# 428, not 400: the client is not being told it sent a bad request, it is being told the
# request needs a precondition it did not carry.
bare="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$base/vaults/$vault/nodes/$node_id" -H "$hdr")"
[ "$bare" = "428" ] \
    && printf '  DELETE without If-Match → 428, correct: the precondition is required\n' \
    || fail "DELETE without If-Match answered $bare; expected 428"

# Here the revision IS the right precondition — the subject of the operation is the node
# itself, not its content — so a stale one is refused.
old="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$base/vaults/$vault/nodes/$node_id" \
    -H "$hdr" -H "if-match: $rev")"
[ "$old" = "409" ] \
    && printf '  DELETE on a stale rev → 409, correct\n' \
    || fail "DELETE with the pre-PUT revision answered $old; expected 409"

curl -fsS -X DELETE "$base/vaults/$vault/nodes/$node_id" -H "$hdr" -H "if-match: $rev2" >/dev/null \
    || fail "DELETE with the current revision was refused"
printf '  deleted\n'

trash="$(curl -fsS "$base/vaults/$vault/trash" -H "$hdr")"
printf '%s' "$trash" | grep -q "$node_id" \
    && printf '  the node is in the trash: the row IS the trash entry, not a tombstone beside it\n' \
    || fail "the deleted node is not in the trash: $trash"

# Still 200, and this is the point of a SOFT delete: the row and its versions survive, so
# the account still holds the blob and a restore has something to restore. A 404 here would
# mean the content had been released while the trash still claimed to hold the file.
code="$(curl -s -o /dev/null -w '%{http_code}' -I "$base/blobs/$sha2" -H "$hdr")"
[ "$code" = "200" ] \
    && printf '  HEAD /blobs → 200 after the delete, correct: the trash still holds it\n' \
    || fail "HEAD /blobs answered $code after a soft delete; expected 200"

delta="$(curl -fsS "$base/vaults/$vault/delta" -H "$hdr")"
printf '  delta: %s\n' "$delta"
printf '%s' "$delta" | grep -q '"op":"del"' \
    || fail "the delta does not report the deletion; a client would never learn about it"
printf '  usage: %s\n' "$(curl -fsS "$base/usage" -H "$hdr")"

step "empty the trash (M4)"
# The whole of M4's server half in three requests. A soft delete frees nothing — the row IS
# the trash entry and its versions still hold the blob, which the 200 above just showed — so
# this is the only call in the product that lowers what an account is using.
before="$(curl -fsS "$base/usage" -H "$hdr" | number used)"

purged="$(curl -fsS -X DELETE "$base/vaults/$vault/trash/$node_id" -H "$hdr")" \
    || fail "discarding the trashed node was refused"
printf '  DELETE /trash/{node} → %s\n' "$purged"
printf '%s' "$purged" | grep -q '"purged":[1-9]' \
    || fail "nothing was discarded: $purged"

curl -fsS "$base/vaults/$vault/trash" -H "$hdr" | grep -q "$node_id" \
    && fail "the node is still in the trash after being discarded" \
    || printf '  and it is out of the trash listing\n'

# 404 now, where it was 200 before: the account holds no live reference, so the address is
# no longer a capability for it (#20). The BYTES are still on disk — the collector holds a
# blob in quarantine before unlinking it, because losing a last reference is exactly when an
# upload of the same content is most likely to be in flight.
code="$(curl -s -o /dev/null -w '%{http_code}' -I "$base/blobs/$sha2" -H "$hdr")"
[ "$code" = "404" ] \
    && printf '  HEAD /blobs → 404 after the purge, correct: the claim went with the row\n' \
    || fail "HEAD /blobs answered $code after the trash was emptied; expected 404"

after="$(curl -fsS "$base/usage" -H "$hdr" | number used)"
[ -n "$before" ] && [ -n "$after" ] && [ "$after" -lt "$before" ] \
    && printf '  usage fell from %s to %s — the one thing nothing else here does\n' "$before" "$after" \
    || fail "usage did not fall: $before → $after"

step "the operator's surface (M4)"
# Skipped rather than failed when the token is not an administrator's: ACCESS= may name an
# ordinary account, and refusing to finish the walk over that would answer a question nobody
# asked.
admin_code="$(curl -s -o /dev/null -w '%{http_code}' "$base/admin/accounts" -H "$hdr")"
if [ "$admin_code" = "403" ]; then
    printf '  skipped: this token is not an administrator (pass an admin ACCESS= to walk it)\n'
else
    [ "$admin_code" = "200" ] || fail "GET /admin/accounts answered $admin_code"
    printf '  accounts listed, with what each holds\n'
    printf '  storage: %s\n' "$(curl -fsS "$base/admin/storage" -H "$hdr")"

    # An invitation, then withdrawn again: the row IS the invitation, so this leaves the
    # installation exactly as it found it.
    login="smoke-$(uuid | cut -c1-8)"
    invited="$(curl -fsS -X POST "$base/admin/invitations" -H "$hdr" -H 'content-type: application/json' \
        -d "{\"login\":\"$login\",\"quota_bytes\":\"1048576\"}")" \
        || fail "creating an invitation was refused"
    invited_id="$(printf '%s' "$invited" | field user_id)"
    printf '%s' "$invited" | grep -q '"token":' \
        && printf '  invitation created; its token is in that response and nowhere else\n' \
        || fail "the invitation carried no token: $invited"

    curl -fsS -X DELETE "$base/admin/invitations/$invited_id" -H "$hdr" >/dev/null \
        || fail "revoking the invitation was refused"
    printf '  and revoked again — the row is the invitation, so nothing was left behind\n'

    # The record outlives the row it names, which is why the log carries no foreign key (#93).
    curl -fsS "$base/admin/audit?target=$invited_id" -H "$hdr" | grep -q 'account.invite' \
        && printf '  both acts are in the audit log, for an account that no longer exists\n' \
        || fail "the audit log does not record the invitation"
fi

# Nothing here has to be cleaned up for the next run: its content and its filename will be
# different ones, and the trash it creates is emptied above rather than left to accumulate —
# which is most of what RESET=1 used to be for.
printf '\nM0 and M4 walked on this server: create, put, delete and the delta for each,\n'
printf 'the trash emptied with its claim released, and the operator surface with its log.\n'
printf '\nWhat this cannot walk is the plugin half of M4 — the trash screen, and a frozen\n'
printf 'account emptying it from inside Obsidian. That is the scenario docs/10 names, and\n'
printf 'it needs a person and an editor.\n\n'
