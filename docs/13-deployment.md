# 13 — Deployment and quick start

How to get a test instance running on a server you control. The architecture reasons for this
shape are in [02](02-architecture.md); this is the procedure.

Nothing below names a particular machine. Where a host needs its own values — a port, a data
directory, an identity to run as — they live in a **host profile** that is not committed; see
[Host profiles](#host-profiles).

## Before anything: the architecture trap

**Build the image on the machine that will run it, or explicitly for that machine's platform.**
A home server is usually x86-64 while the laptop preparing the deployment may be ARM, and an
image built for the wrong one starts and dies immediately with an exec format error that says
nothing about why. Two ways out, and the first is simpler:

- **build on the target** — no flag needed, `docker compose build` does the right thing;
- **build elsewhere for the right platform**:
  `docker buildx build --platform linux/amd64 -t syncserver:dev .`

## Getting the source there

The image is built **on the target**, so the source has to reach it — and a NAS commonly has no
git. The deployment is therefore a copy: one archive, made here, extracted there.

```bash
npm run pack        # → dist-deploy/syncserver-<sha>.tar.gz, about 85 KB
```

It also writes `VERSION` and `MANIFEST.sha256` **into** the archive, so the far side can say
which build it holds and prove every file arrived — see the extraction rule below, which is the
reason those exist.

One archive rather than a list of paths to copy, because a list drifts from the Dockerfile the
moment either changes, and the failure — a build stopping halfway on a missing file — lands on
the far side where it is least convenient to diagnose. `scripts/pack.sh` names what goes in
explicitly and **fails here** if any of it is absent.

It contains the Docker build context plus the two files compose reads directly: the compose
file, and `db/schema.sql`, which the database container mounts to initialise itself. The
plugin's source is deliberately not in it — a different program with a different build has no
business in a server image.

> **Not "build here, copy the image".** Even with Docker on the preparing machine, a
> cross-platform image needs `--platform linux/amd64` and a `docker save`/`load` round trip.
> Building where it runs avoids the question.

### What the deployment is

Two containers, PostgreSQL and the server that waits for it, and **one file to edit**: `.env`.
The compose file holds nothing installation-specific, so bringing this up somewhere else is a
different `.env` and never a different `docker-compose.yml`.

### Copying it across

Either way works; the first needs only SSH, the second only a mounted share.

```bash
scp dist-deploy/syncserver-*.tar.gz "$USER@$HOST:$DEPLOY_ROOT/"
```

```powershell
Copy-Item dist-deploy\syncserver-*.tar.gz \\$HOST\$SHARE\SyncServer\
```

Then on the target:

```bash
cd "$DEPLOY_ROOT"
rm -rf checkout && mkdir checkout && tar xzf syncserver-*.tar.gz -C checkout
cd checkout
```

> **Into an empty directory, never on top of the old one.** Extracting over an existing checkout
> is not atomic and does not always replace every file: one owned by a different user is simply
> skipped, in a `tar` line that scrolls past. What is left is half one build and half another,
> and it reads as neither — a runner from the new build ran a walk from the old one, silently,
> and the missing steps had to be inferred from headings that never appeared. `run-smoke.sh`
> checks `MANIFEST.sha256` before anything else and names the files that do not match, but
> removing the directory is what prevents it.
>
> This is safe to do precisely because **nothing in the checkout is edited by hand**. `.env`
> lives one level up, and the checkout holds only a symlink to it.

Re-deploying later is the same three commands: `npm run pack` here, copy, extract as above.

### What a NAS needs first

Two things, and neither announces itself as what it is.

**The Docker CLI keeps its state in the calling user's home directory**, and on some NAS
container runtimes that path is one an ordinary administrator cannot create. The build stops
with a permission denied on a directory whose name never mentions Docker. Point it somewhere
writable instead:

```bash
export DOCKER_CONFIG="$DEPLOY_ROOT/.docker"
mkdir -p "$DOCKER_CONFIG"
```

Worth putting in the shell profile on that host: it is needed for every build, not once.
`deploy-dev-host.sh` sets it too, so this matters mainly when running `docker` by hand.

**Directory permissions want the same care.** `chown` needs root there and is usually not what
is missing: an administrator's primary group is commonly the same group the container runs as,
so **`chmod 775` on the blob directory is enough** and needs no privilege. The database
directory needs nothing — the image takes it over as its own user.

> **`DB_DIR` is mounted at `/var/lib/postgresql`, not at `.../data`.** From PostgreSQL 18 the
> image keeps the cluster in a major-version subdirectory so that `pg_upgrade --link` does not
> have to cross a mount boundary, and it refuses to start against the old layout. The refusal is
> a screen of prose about `pg_ctlcluster` and never says "wrong mount point", so it is worth
> recognising: if the log mentions *"there appears to be PostgreSQL data in
> /var/lib/postgresql/data (unused mount/volume)"*, that is this.

## Host profiles

A host's own values are `export` lines in a file under `deploy/`, which is **not committed** —
it names a machine, its paths and its port, and none of that belongs in a public repository:

```bash
# deploy/<host>.env
export DEPLOY_HOST=nas.example.internal
export DEPLOY_USER=admin
export DEPLOY_ROOT=/share/AppData/SyncServer
export PUBLISH_PORT=8087
export PATH=/path/to/the/nas/docker/bin:$PATH
```

Sourced before the deploy script, it needs no flags:

```bash
. deploy/<host>.env && checkout/scripts/deploy-dev-host.sh
```

`RUN_AS`, `DB_DIR` and `BLOB_DIR` belong in `.env` on the target rather than here, because they
are the deployment's own configuration and the script writes them once.

## Quick start

The whole of it, as a script that is also the redeploy procedure:

```bash
rm -rf checkout && mkdir checkout && tar xzf syncserver-*.tar.gz -C checkout && checkout/scripts/deploy-dev-host.sh
```

It sets `DOCKER_CONFIG`, creates and permits the two data directories, writes `.env` with
generated secrets **only if there is none**, builds, starts, and waits for health. The exception
matters: the secrets in `.env` are what the database was initialised with and what every issued
token is signed by, so regenerating them on a redeploy would lock the installation out of its
own data.

**`.env` lives beside the checkout, not inside it** — next to `db/` and `blobs/`, with a symlink
in the checkout so ordinary `docker compose` commands still work. It was inside once, which
meant installing a new build by extracting into a clean directory destroyed it, and the next run
generated fresh secrets against a database that still expected the old ones. What that looks
like is a server restarting for ever while the database reports itself healthy, and nothing on
screen connecting the two. Now the file survives the checkout, and a deployment that would
generate secrets over an existing `db/` says so before it builds.

Then walk M0 end to end against it — one command, from any state:

```bash
./scripts/run-smoke.sh
```

It verifies the checkout against the manifest packed with it, deploys, obtains a token (signing
one with the server's own `SERVER_SECRET` when the installation is already claimed, since the
account's `auth_secret` is shown once and stored only as a hash), and runs the walk below.
`scripts/smoke.sh` can still be run directly against a server you have a token for.

It claims the seeded administrator if nobody has, then exercises the account surface, a blob and
all three node verbs M0 names — create, `put` with the content precondition (#52), `delete` with
its revision precondition — and the delta reporting each. Three of its assertions are answers
that look wrong and are not:

| It asserts | Because |
|---|---|
| `HEAD /blobs` is **404** on a freshly uploaded blob | an upload leaves a *pending* reference and reads are authorised by a **live** one (#20) |
| re-uploading identical content is **201**, not "already have it" | the short circuit would make the address an existence oracle (#46) |
| `HEAD /blobs` is still **200** after a delete | a **soft** delete releases nothing: the trash is the row, and a restore needs the content |

**Every run is independent** — it derives a nonce and puts it in the content, the filename and
the dedup tags, so it neither collides with nor depends on what an earlier run left. Running it
twice against the same vault is the normal case. `RESET=1` exists only as housekeeping for the
trashed nodes that accumulate, and it destroys with no undo.

On an installation somebody has already claimed, `run-smoke.sh` handles the token itself;
`scripts/smoke.sh` can be run directly with `ACCESS=… VAULT=…` if you already have one.

What each step does by hand, and why, is below.

### Doing it by hand

```bash
# in the extracted checkout. The real file goes one level UP, where the next extraction
# cannot delete it, and the checkout gets a symlink so compose still finds it.
cp .env.example ../.env
ln -sfn ../.env .env

# the two secrets, appended to the copy
printf 'POSTGRES_PASSWORD=%s\nSERVER_SECRET=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> ../.env

# where the data lives — beside the checkout, never inside it. Set DB_DIR and BLOB_DIR in
# .env to match, then create them.
mkdir -p "$DEPLOY_ROOT"/{db,blobs}
# chmod, not chown: chown needs root and is usually not what is missing, since the
# administrator's primary group is commonly the group the container runs as.
chmod 775 "$DEPLOY_ROOT/blobs"

docker compose up -d --build
docker compose ps            # both healthy
curl -s "localhost:$PUBLISH_PORT/health"
```

| `.env` | What it is |
|---|---|
| `POSTGRES_PASSWORD`, `SERVER_SECRET` | required, no defaults — compose refuses to start without them |
| `DB_DIR`, `BLOB_DIR` | the whole of the server's state on the host |
| `RUN_AS` | the uid:gid the server runs as |
| `PUBLISH_PORT` | host port; the container is always 8080. **On a NAS pick something else** — the management interface usually holds 8080, and the clash surfaces only after the database is already healthy |

**`BLOB_DIR` must be writable by `RUN_AS`** — writable, not owned, which is the difference that
matters on a NAS: `chown` needs root, `chmod 775` does not, and the group is typically shared by
the container and by any administrator. Get it wrong and the server comes up and then fails on
the first upload rather than at boot, which is the confusing order. `DB_DIR` is the opposite:
the postgres image takes that directory over as its own user, so create it and leave it alone.

A fresh instance answers:

```json
{"status":"ok","bootstrap_pending":true}
```

`bootstrap_pending` is the whole first-run state: the database has been created and seeded, and
the server is waiting for its first administrator (#107).

## Claiming the first administrator

Until that invitation is redeemed the API answers **only** `/auth/kdf`, `/auth/redeem` and
`/health`; everything else is `503 bootstrap_pending`. That is what makes the seeded token
`admin` safe — it opens exactly one thing, and redeeming it is what replaces it.

Redemption is normally the plugin's job, because the key material is born on the device. It can
be done by hand with values that are *shaped* right and mean nothing:

```bash
curl -s -X POST "localhost:$PUBLISH_PORT/auth/redeem" -H 'content-type: application/json' -d '{
  "invitation_token": "admin",
  "auth_secret": "'"$(openssl rand -base64 32)"'",
  "account_salt": "'"$(openssl rand -base64 16)"'",
  "kdf_params": {"v":19,"m":65536,"t":3,"p":1},
  "pubkey": "AQ==", "enc_privkey": "Ag==", "wrapped_seed": "Aw==",
  "recovery_key": "BA==", "recovery_code_hash": "'"$(openssl rand -hex 32)"'",
  "initial_vault_id": "'"$(uuidgen)"'",
  "initial_vault_name_enc": "'"$(printf 'test vault' | base64)"'",
  "device_name": "curl", "device_platform": "linux"
}'
```

Keep the `auth_secret` you generated: it is what logs that account in from then on. The server
stores only its hash (#108) and cannot tell you what it was.

The response carries `access`, `refresh`, `device_id`, `vault_id` and `root_node_id`. `/health`
now reports `bootstrap_pending: false`, and the rest of the API answers.

> **This is a test account, not a real one.** Its `wrapped_seed` and keys are placeholder bytes,
> so nothing it stores could ever be decrypted by a real client — and the plugin cannot adopt it,
> because it derives its own material from a passphrase. Redeeming by hand is a way to exercise
> the server, not a way to start using it. To connect the plugin instead, leave the invitation
> unclaimed and let it redeem.

## What this deployment is not

- **not exposed publicly.** It publishes on the host and nothing terminates TLS in front of it.
  Public exposure stays out of scope until authentication has had a review of its own
  ([02](02-architecture.md)). Reaching it from elsewhere is a VPN's job, not this compose file's;
- **not backed up.** The two bind mounts hold everything and nothing copies them anywhere. The
  procedure that would — one frozen window, both legs inside it — is [08](08-backup-restore.md),
  and it is not wired up. Note that the collector must be held off during that window, which is
  what its advisory lock is for;
- **not upgradable in place.** `schema.sql` runs once, on an empty data directory. There is no
  migration tool yet, deliberately (see the repository README), so a schema change means
  discarding the database and starting again. That is fine while nothing in it matters, and it is
  exactly what stops being fine on the day something does.

## Two things that will look like bugs

**The container is healthy while the server refuses everything.** That is `bootstrap_pending` —
working as designed. `/health` is deliberately reachable during it, because a container marked
unhealthy for waiting would never be allowed to finish starting.

**`docker compose down -v` does *not* delete the data, and that surprises people who expect it
to.** There are no named volumes here — `DB_DIR` and `BLOB_DIR` are **bind mounts**, and `-v`
does not touch those. So `down -v` is not the dangerous command it is elsewhere, and it is also
not how you start over.

Starting over means removing the directories, and the secrets have to go with them:

```bash
docker compose down && rm -rf ../db ../blobs ../.env
```

`../.env` is in that list on purpose. The database keeps the password it was **created** with,
so a new database wants new secrets — and keeping the old file while discarding the database is
the mirror of the mistake that made this section necessary.
