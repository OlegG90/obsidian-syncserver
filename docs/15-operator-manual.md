# Running a SyncServer

For the person who runs the server. If you are syncing a vault, [14](14-user-manual.md) is yours.

A SyncServer installation is **two containers and a directory**: PostgreSQL, the server, and the data
they own. There is nothing to build — the image is pulled from a public registry — and nothing to compile
on the machine that runs it. The people using it install an Obsidian plugin; the server never sees a
passphrase and cannot read a note.

This file is the **procedure**. Where a step has a reason worth arguing about it links to the document
that argues it: [13](13-deployment.md) for deployment, [08](08-backup-restore.md) for backup and restore,
[11](11-management-console.md) for the console.

---

## What you need

- **Docker** with `docker compose` (v2 — the plugin, not the old `docker-compose` script);
- a **port** the host is not already using. `8080` is taken on most NAS boxes by their own admin panel;
- **four directories, created by you, with room to grow** — and their paths named in `.env`. They have no
  defaults: compose refuses to start rather than quietly writing an installation's whole state beside its
  own configuration file, where the next tidy-up would find something that looks like scratch:

  | directory | what it holds | who writes it |
  |---|---|---|
  | `DB_DIR` | the database | the postgres image, as its own user — create it and leave it alone |
  | `BLOB_DIR` | every file anybody has synced, encrypted | the server, as `RUN_AS` |
  | `BACKUP_DIR` | backup copies, once you turn them on | the server, as `RUN_AS` |
  | `STATE_DIR` | one small file: the restore epoch | the server, as `RUN_AS` |

  `STATE_DIR` is separate from the other three on purpose. Its file is what notices that a database has
  been restored — so it must survive restoring the database **and** restoring the blobs, which means it
  can live in neither;
- a **private network**. The server publishes on the host and terminates no TLS: a LAN, a VPN or a
  Tailscale tunnel is the boundary, until authentication has had a review of its own ([02](02-architecture.md)).

You do **not** need git, Node, a checkout of this repository, or a schema file. **An installation is two
files**: `docker-compose.yml` and `.env`.

---

## Quick start

Five steps, no choices. Two files, four directories, and a working server at the end.

### Step 1 — Get the two files

```bash
V=0.5.9                       # the release to install; the newest is on the repository's releases page
mkdir -p syncserver && cd syncserver

BASE=https://raw.githubusercontent.com/OlegG90/obsidian-syncserver/$V
curl -fsSL -o docker-compose.yml "$BASE/docker-compose.yml"
curl -fsSL -o .env              "$BASE/.env.example"
```

That is the whole of it. The database schema travels **inside the server image**, which applies it when
the database is empty — there is no third file to place, and no way to leave it behind.

**`0.5.5` or newer for this route, and the two versions must be the same one.** Before 0.5.5 the schema
was a third file mounted into the database container, so a compose file from one release and an image from
another disagree about who applies it.

### Step 2 — Make the four directories

Pick where the data lives. Anywhere with room, outside anything a future install replaces:

```bash
mkdir -p /srv/syncserver/{db,blobs,backups,state}
chmod 775 /srv/syncserver/{blobs,backups,state}
```

`chmod`, not `chown`: `chown` needs root, which a NAS administrator often does not have, and the group is
usually one both they and the container are in. `db` is the exception — the database image takes that
directory over as its own user, so create it and leave it alone.

### Step 3 — Fill in `.env`

Eight fields, and the file you downloaded lists them at the top. Later assignments win in an env file, so
this appends rather than edits, and `$V` is still the version from Step 1:

```bash
cat >> .env <<EOF
SERVER_IMAGE=ghcr.io/olegg90/syncserver:$V
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SERVER_SECRET=$(openssl rand -hex 32)
PUBLISH_PORT=8087
RUN_AS=$(id -u):$(id -g)
DB_DIR=/srv/syncserver/db
BLOB_DIR=/srv/syncserver/blobs
BACKUP_DIR=/srv/syncserver/backups
STATE_DIR=/srv/syncserver/state
EOF
```

**Keep those secrets.** `POSTGRES_PASSWORD` is what the database was initialised with: a different one on
a later start leaves the installation unable to open its own data, while the database reports itself
healthy. A **version** and never `latest`, because a server has to be able to say what it is running and
to go back to what it ran yesterday.

`PUBLISH_PORT` ships as `8080`, which is why the append overrides it: on a NAS that port belongs to the
box's own admin panel, and the clash surfaces only after the database is already healthy.

### Step 4 — Start it

```bash
docker compose pull
docker compose up -d
docker compose ps                       # both healthy
curl -s localhost:8087/health
```

`{"status":"ok","bootstrap_pending":true,...}` is the expected first-run answer: a server with no
administrator yet, serving nothing but the console and the two endpoints that create one.

### Step 5 — Create the administrator

Open `http://<the host>:8087/` — the console is the server's root page — and **choose a password**.

Setting it is what *creates* the administrator: there is no default password, so there is no state where
a default still works because nobody got round to changing it. Once only; a second attempt is refused.
You may choose the login too, and `admin` is a fine answer.

That account is a **console account**: a password, no keys, no vault, a quota of zero the schema insists
on. It can administer people and it can never read a note — not as a permission withheld, but because it
holds no key to read one with.

**That is a working server.** What follows is what to do with it.

---

## After it is running

### Give somebody an account

**Console → Accounts → Invite somebody.** A login and a quota in MiB.

You get a **token, shown once and not stored**. Send it to the person; they redeem it in Obsidian, where
their keys are made ([14](14-user-manual.md)). If it is lost, reissue it — there is no way to show it
again.

**Quotas** change from the account's card. Lowering one below what somebody already stores **deletes
nothing**: the account freezes — nothing that grows usage is accepted, while reading and deleting keep
working. The console asks you to confirm that specifically, because it is not what most people expect a
lowered quota to do. A frozen account thaws by itself once its owner empties the trash, with no
administrator involved.

The **Over limit** and **Frozen** tiles are two different counts on purpose: an account can be over its
quota for months without being frozen, and it is refused new files either way.

### They install the plugin

There is **no plugin in the image and there never will be** — the server holds no key and the plugin holds
every one of them. It installs through [BRAT](https://github.com/TfTHacker/obsidian42-brat), pointed at
this repository, which offers each release. [14](14-user-manual.md) is the page to send them.

### Somebody lost a device

**Console → the account → Devices.** Names, platforms, and when each was last seen — no keys and no
cursors, because an administrator holds nothing that opens a vault and a device row is not where that
would start.

`last seen` is as fresh as the access token's lifetime, fifteen minutes by default: it moves every time a
device renews its session, not on every sync and not only when it signed in. A device that has not been
seen in weeks has not been used in weeks.

**Revoke** kills that device's refresh token. Its next renewal fails and it can do nothing further; the
files already on it stay on it, because nothing here reaches a disk somebody else owns.

This exists for the person the account's owner cannot be — their only device is the one that is gone, so
nobody but you can take it away. Revoking here is written to the audit log, because it is done **to**
somebody rather than by them; a person revoking their own device from the plugin is not.

### Turn on backups

Backups are **off until a destination is named**, and nothing else decides it. In `.env`:

```bash
BACKUP_DESTINATION=/backups          # the path INSIDE the container
BACKUP_BLOB_SOURCE=/data/blobs       # likewise
BACKUP_DIR=/srv/syncserver/backups   # where that lands on THIS machine — the default is ./data/backups
```

`BACKUP_DESTINATION` and `BACKUP_DIR` are the two sides of one mount. Naming a destination with no host
directory behind it writes the copy into the container's writable layer, where the next `docker compose
pull` takes it.

`docker compose up -d` again, and the console's **Back up now** stops answering "not configured".

**Nothing about backups happens on a schedule.** Taking one, verifying one and restoring from one are
acts you ask for. There is no retention setting either: copies pile up at the rate you take them, and you
remove the ones you no longer want, per row. **Whatever rhythm your data deserves is yours to keep** —
this server will not keep it for you, and will not pretend to.

### Audit log

**Console → Audit log**: who did what to whom, newest first. Append-only, with logins stored as snapshots
— an entry naming an account that has since been deleted is still the answer to what happened.

---

## Upgrading

In `.env`, change `SERVER_IMAGE` to the new version, then:

```bash
docker compose pull
docker compose up -d
docker image prune                    # optional
```

Nothing else moves: the database, the blobs, the backups and the state file are all outside the
containers. Users need nothing — BRAT offers them the matching plugin release.

**Read the release notes first.** They name anything that is not a straight pull, and this project's
version number carries the compatibility promise in the **minor** while the major is `0` (D-111): `0.5.2`
to `0.5.4` cannot break a client, `0.5.x` to `0.6.0` announces that it can.

**There is no migration tool, deliberately.** The server applies the schema **once**, to a database that
has none; a build whose schema gained something arrives at a database that has never seen the new part, and
the failures are quiet — a missing table breaks at the first query, while a missing **trigger** simply
never fires. That is how one deployment ran for weeks with change notifications inert.

So the server compares, at every start, and says in its log what is missing:

```
the database is BEHIND this build's schema. Missing: trigger journal_notify. These are functions and
triggers, whose absence is silent — a missing trigger does not fail, it simply never fires.
```

A warning and not a refusal: everything that does not touch what is missing works, and a database is not
something to refuse to serve on a suspicion. `docker compose logs server | grep BEHIND` after an upgrade
is the whole of the check. Bringing an existing database forward is still a deliberate act by somebody who
knows what changed.

---

## Installing from an archive instead

The route above needs the internet on the server. This one does not, and it does more for you: it creates
and permits the four directories, writes `.env` with generated secrets **only if there is none**, pins the
image, pulls, starts, waits for health, and compares the schema.

On your own machine, from a checkout of this repository:

```bash
npm run pack
```

That produces `dist-deploy/syncserver-<version>-<sha>.tar.gz` from the **committed** contents of `HEAD` —
not from your working tree, deliberately (#106). It refuses if the files it ships have uncommitted
changes; to deploy something not on `main` yet, name the point instead: `PACK_REF=some-branch npm run pack`.

Copy it over, then **on the host**:

```bash
rm -rf checkout && mkdir checkout && tar xzf syncserver-*.tar.gz -C checkout
checkout/scripts/deploy-dev-host.sh
```

Two things it does that are worth knowing before you need them:

- **`.env` lives beside the checkout, not inside it.** Installing a new build deletes the checkout and
  never touches `.env` — regenerating those secrets would lock the installation out of its own data;
- **per-host values come from the environment**, so a host profile is a file of `export` lines rather than
  an edited script: `. deploy/myhost.env && checkout/scripts/deploy-dev-host.sh`. `PUBLISH_PORT` is the
  one almost every host sets.

Upgrading by this route is the same two commands with the new archive.

---

## Backups

### Taking one

**Console → Backups → Back up now.** The run:

1. opens a **refusal window** — new writes are answered "the server is being backed up". Requests already
   in flight go on and commit; this is not a freeze;
2. dumps the database;
3. copies the blobs;
4. verifies the copy it just wrote;
5. closes the window and settles the row.

Steps 2 and 3 are in that order and are not interchangeable ([08](08-backup-restore.md), D-114). A window
that only refuses *new* writes leaves the running ones, so blobs-first would produce a copy that restores
without complaint and cannot open a file.

It takes about a second on a small installation. The log names the window opening and how it closed, on
every run, whoever pressed the button.

### Reading the history

Console → Backups lists the runs. A row says `ok`, its size, its blob count, and `verified` with a time
when the self-check found the copy whole.

**`ok` with an error line under it is the case to look at**: the backup completed and the copy is *not*
whole — some blob the database references is missing from it. A backup nobody can restore from is not a
backup, and this is the difference between learning that now and learning it at restore time.

**Verify** re-runs that check, and **only when asked**. Nothing verifies on a schedule or at boot.

It says the copy **arrived**. It does not say the archive can be **read** — a `pg_dump` that fails to
restore passes this check and fails on the one day it matters. **The server does not test that**, so
restoring a copy somewhere safe, now and then, is yours to do; `docker compose run --rm server node
server/dist/restore-cli.js …` against a scratch deployment is the honest way.

**Remove a copy** from its row, behind a confirmation naming it. The run stays in the history with no
destination — the log keeps saying a backup ran, and the empty destination says its copy is gone. The
newest good copy cannot be removed — a server that will not leave itself without a backup is worth more
than one that does exactly as it is told.

### What a backup is not

It is not a second copy in a second place. Everything above writes to one directory on one machine — take
that directory somewhere else, on whatever schedule your data deserves, and remember that **a backup that
has never been restored is not a backup** — and nothing here does that for you.

---

## Restoring

**Console → Backups → the row → Restore from this copy.** It asks twice, the second time naming the copy,
and then the server **stops**. The restore itself runs on its next start, before it opens a connection
for serving — which is the moment `pg_restore --clean` is safe, and exactly what the old instruction to
stop the server first was buying.

It comes back **only if your deployment restarts it**. `restart: unless-stopped` is in the compose file,
so `docker compose up -d` has already arranged that; a deployment that turned it off has to start it.

When it is back it refuses every request until you confirm — see below. That halt is the guard working,
not a failed restore.

### By hand instead

The same thing, typed, for a server that cannot reach its console or an operator who would rather see it:

```bash
docker compose stop server
docker compose run --rm server node server/dist/restore-cli.js /backups/backup-<the one you want>
docker compose start server
```

The row also shows this command with the directory already in it, folded under the button.

**It refuses while anything else is connected to the database**, naming how many. `pg_restore` drops and
recreates what it restores, and doing that under a running server is not a race to be careful about: it is
open transactions against tables being dropped, and the result is neither the old data nor the new.

**Blobs first, then the database** — the opposite order to a backup, and for the same reason a backup runs
the other way. A database restored ahead of its blobs references content that is not there yet; blobs
restored ahead of their database are content nothing references, which is harmless and is what the
collector sweeps. The half-applied state should be the harmless one.

**It ends by saying what it could not bring back**: every address the restored database references that
the restored store does not have. Those notes exist and their content does not, and this is the moment to
learn it rather than one file at a time over the following weeks. The restore still happened — the list is
information, not a failure.

**Neither route lets the server overwrite itself while running**, which is the part of this that is a
decision rather than a convenience (D-92). And neither one finishes the job: confirming afterwards is
the act only a person can take responsibility for.

The server keeps the newest epoch it has ever run with in a **state file outside the database**, so a
restored database is *behind* that file — which is how a restore is detectable at all. The server then
**halts**: every request but the console and the restore endpoints is answered `restore_pending`.

That halt is deliberate. A restored database re-issues revision numbers it has already handed out, and a
client holding a cursor from that generation would believe it was current. Silent divergence, noticed
weeks later as missing files.

**Console → the restore screen → Confirm the restore.** It raises the epoch above anything ever issued,
records the act in the audit log, and lifts the halt in the same moment — no restart.

Then, the parts only you can do:

- every client will resync on its next pass. A long synchronisation is **expected**, not a fault;
- verify the restored copy against the blobs, and note anything the copy could not restore;
- **tell the people who use the server**, so the resync does not read as data loss.

---

## What will look like a fault and is not

| what you see | what it is |
|---|---|
| `"bootstrap_pending":true` and nothing else served | a fresh server with no administrator yet. Open the console |
| `restore_pending` from everything | a restore nobody confirmed. Console → confirm |
| `the server is being backed up` | the refusal window, for the second or so a backup takes |
| a backup row `ok` **with** an error line | the copy is not whole. This is the row to act on |
| `N backup run(s) were still marked running` at boot | a run whose process died. The window went with it; those rows are recorded failed |
| every client resyncing at length after a restore | expected — see above |
| an account over its quota that is **not** frozen | ordinary: a freeze is raised when somebody else's write crosses the boundary. New files are refused either way |

And the ones that are faults, with what each looks like:

| what you see | what it is |
|---|---|
| the port is taken, after the database came up healthy | `PUBLISH_PORT` is the host's admin panel. Pick another |
| the server starts, and the first upload fails with `EACCES` | the blob directory is not writable by `RUN_AS` |
| the server does not start at all, on `EACCES` | the state directory is not writable. The restore guard writes there before it listens |
| the database comes up empty and the server fails on missing tables | a compose file from before 0.5.5 with a 0.5.5+ image: the old one expected a schema file mounted, the new one applies its own. Take both from the same release |
| `password authentication failed` after an upgrade | `.env` and the database disagree. The database keeps the password it was created with |

The server's own log is the surface on an unattended box. `docker compose logs -f server` is where the
the restore guard and the boot warnings say what they found.
