# 13 — Deployment and quick start

How to get a test instance running on a server you control. The architecture reasons for this
shape are in [02](02-architecture.md); this is the procedure.

Nothing below names a particular machine. Where a host needs its own values — a port, a data
directory, an identity to run as — they live in a **host profile** that is not committed; see
[Host profiles](#host-profiles).

## Before anything: the architecture trap

**An image built on the wrong platform starts and dies immediately with an exec format error**
that says nothing about why. A home server is usually x86-64 while the laptop preparing the
deployment may be ARM, and this project's answer to the trap is to **not build on either**. The
server image is built and published from CI, on the x86-64 runners, and pulled here — see
[Publishing the image](#publishing-the-image). That is why nothing in the deployment procedure
below builds anything.

Getting the source here is still a copy — the archive — but the server image itself is not
built from it. It carries the version to pull.

## Getting the source there

The image is **pulled, not built on the target**. The source has to reach it only for the
compose file, the schema, and the deploy script — a NAS commonly has no git, so the deployment
is a copy: one archive, made here, extracted there.

```bash
npm run pack        # → dist-deploy/syncserver-<version>-<sha>.tar.gz
```

It also writes `VERSION` (the release version, which the image tag is composed from) and
`MANIFEST.sha256` **into** the archive, so the far side can say which build it holds and prove
every file arrived — see the extraction rule below, which is the reason those exist.

One archive rather than a list of paths to copy, because a list drifts from the compose file
the moment either changes, and the failure lands on the far side where it is least convenient
to diagnose. `scripts/pack.sh` names what goes in explicitly and **fails here** if any of it is
absent.

It contains the compose file, `.env.example`, the schema, the deploy script, and the sources
that get built *if* a deployment chooses the local-build override — the default path pulls the
published image instead. The plugin's source is deliberately not in it — a different program
with a different build has no business in a server image.

> **Not "build here, copy the image".** Cross-platform images are a `docker save`/`load` round
> trip with no check that the platform came out right. **Publishing from CI and pulling**
> removes the question instead of avoiding it: the runners are x86-64, which is the platform
> the trap is about. This is M5.

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
container runtimes that path is one an ordinary administrator cannot create. The deploy
stops with a permission denied on a directory whose name never mentions Docker. Point it
somewhere writable instead:

```bash
export DOCKER_CONFIG="$DEPLOY_ROOT/.docker"
mkdir -p "$DOCKER_CONFIG"
```

Worth putting in the shell profile on that host: it is needed for every pull, not once.
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
generated secrets **only if there is none**, pulls the image, starts, and waits for health.
The exception matters: the secrets in `.env` are what the database was initialised with and
what every issued token is signed by, so regenerating them on a redeploy would lock the
installation out of its own data.

**`.env` lives beside the checkout, not inside it** — next to `db/` and `blobs/`, with a symlink
in the checkout so ordinary `docker compose` commands still work. It was inside once, which
meant installing a new build by extracting into a clean directory destroyed it, and the next run
generated fresh secrets against a database that still expected the old ones. What that looks
like is a server restarting for ever while the database reports itself healthy, and nothing on
screen connecting the two. Now the file survives the checkout, and a deployment that would
generate secrets over an existing `db/` says so before it pulls.

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

docker compose pull
docker compose up -d
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
{"status":"ok","bootstrap_pending":true,"version":"0.4.0"}
```

`bootstrap_pending` is the whole first-run state: the database has been created and seeded, and
the server is waiting for its first administrator (#107).

`version` is the release this server is, and `/health` is the only place it is reported (#111) —
because it is the only endpoint open before authentication and before an administrator exists,
which is precisely when a client has to decide whether it can talk to this server at all. It is
reported on the `503` path too: the version is a fact about the process, not about the database.

## Claiming the first administrator

Until a password is set the API answers **only** `/auth/kdf`, `/auth/bootstrap`, `/health` and
the console's own two files; everything else is `503 bootstrap_pending`. What makes that window
safe is not a token being short-lived — it is that there is **no credential at all** until this
call creates one (#107). A seeded password would keep working for anybody who never got round
to changing it.

The ordinary way is the console: open `http://<host>:$PUBLISH_PORT/` and it shows one screen,
asking for the password. By hand it is one request:

```bash
curl -s -X POST "localhost:$PUBLISH_PORT/auth/bootstrap" \
  -H 'content-type: application/json' \
  -d '{"password":"a password you would give a password manager"}'
```

**At least 12 characters**, or `400 password_too_short` — the one secret on this server a person
chooses, with only the server's own Argon2id behind it.

It answers `{"login":"admin"}` once and `409 already_bootstrapped` every time after: the
statement that sets the password is the same one that moves the row out of the state it matched
on, so there is no second chance and no window between checking and writing.

That account is a **console account** (#115): a password, and no key material at all. It
administers the server and cannot sync a vault — there is no seed to derive a vault key from.
Signing in is `POST /auth/console` with the login `admin` and that password, which answers with
the usual access and refresh tokens.

**A vault for yourself is a separate account**, invited from the console like anybody else's:

```bash
curl -s -X POST "localhost:$PUBLISH_PORT/admin/invitations" \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"login":"you","quota_bytes":"10737418240"}'
```

The token in that answer is shown once — only its hash is stored — and it is what the plugin
redeems, on the device where the keys are made.

`/health` reports `bootstrap_pending: false` from the moment the password exists, and the rest
of the API answers.

> **This is a test account, not a real one.** Its `wrapped_seed` and keys are placeholder bytes,
> so nothing it stores could ever be decrypted by a real client — and the plugin cannot adopt it,
> because it derives its own material from a passphrase. Redeeming by hand is a way to exercise
> the server, not a way to start using it. To connect the plugin instead, leave the invitation
> unclaimed and let it redeem.

## Publishing the image

The server image is built and pushed from CI, on a `v*` tag — one image per released version,
matching the single version across six manifests (#111). Each run also tags by commit, so a
running container can be traced to a build:

- `ghcr.io/<owner>/syncserver:<version>` — e.g. `ghcr.io/olegg90/syncserver:0.4.0`;
- `ghcr.io/<owner>/syncserver:sha-<short-commit>`.

The registry is GitHub's, and the image is **public** — a server pulls it with no credential,
which is the whole point of the choice. A private image would need a token stored on the
server, a credential added to a machine in exchange for hiding source that is already public.

`docker-compose.yml` pins `SERVER_IMAGE` from `.env`, defaulting to the release in
`package.json` — never `latest`. A server updated a few times a year must be able to say what
it is running, and to go back; `latest` names a moving target that a specific installation
cannot be rolled back to.

To run the source instead of the release — development, or a change not yet tagged — compose
merges the local-build override over the deployment file:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The override builds the same image name locally, so switching back to the published image is
just `docker compose pull` again.

## What this deployment is not

- **not exposed publicly.** It publishes on the host and nothing terminates TLS in front of it.
  Public exposure stays out of scope until authentication has had a review of its own
  ([02](02-architecture.md)). Reaching it from elsewhere is a VPN's job, not this compose file's;
- **not backed up.** The two bind mounts hold everything and nothing copies them anywhere. The
  procedure that would — one refusal window, database dumped first and blobs copied second
  inside it (#114) — is [08](08-backup-restore.md),
  and it is not wired up. Note that the collector must be held off during that window, which is
  what its advisory lock is for;
- **not upgradable in place.** `schema.sql` runs once, on an empty data directory. There is no
  migration tool yet, deliberately (see the repository README), so a schema change means
  discarding the database and starting again. That is fine while nothing in it matters, and it is
  exactly what stops being fine on the day something does.

  **The deploy refuses to finish when the database is behind**, rather than leaving it to be
  noticed. After the containers are up it compares the functions and triggers `schema.sql`
  declares against the ones the database actually has, names any that are missing, and exits
  non-zero — so a walk chained after a deploy does not run against a database the build does not
  match. Functions and triggers rather than tables, because that is the silent class: a missing
  column fails at the first query, while a missing trigger fails by not happening. This exists
  because it happened — a build arrived whose schema had gained the change-notification trigger,
  the database had never seen it, and push was inert with nothing anywhere saying so.

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
