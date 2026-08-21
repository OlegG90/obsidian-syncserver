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
- a **directory with room** for the vaults, their history, and — if you turn them on — the backups;
- a **private network**. The server publishes on the host and terminates no TLS: a LAN, a VPN or a
  Tailscale tunnel is the boundary, until authentication has had a review of its own ([02](02-architecture.md)).

You do **not** need git, Node, or a checkout of this repository on the server.

---

## Quick start

Five steps, no choices. Everything lands under one directory you pick.

### Step 1 — Get the three files

The version appears twice — in these URLs and in `.env` — and the two must match: the compose file and
the schema belong to the image they shipped with. Set it once here.

```bash
V=0.5.4                       # the release to install; the newest is on the repository's releases page
mkdir -p syncserver/db && cd syncserver

BASE=https://raw.githubusercontent.com/OlegG90/obsidian-syncserver/$V
curl -fsSL -o docker-compose.yml "$BASE/docker-compose.yml"
curl -fsSL -o db/schema.sql     "$BASE/db/schema.sql"
curl -fsSL -o .env              "$BASE/.env.example"
```

`db/schema.sql` is the file people miss. Compose mounts it at a path **relative to the compose file**, so
it has to sit in `db/` beside it. It runs **once**, on an empty database directory, and is ignored for
ever afterwards.

**`0.5.4` or newer for this route.** `0.5.2` and `0.5.3` reject the empty `BACKUP_KEEP` that a compose
file passes when nobody has set it, and refuse to boot — which is why the version in the URL and the
version in the image have to be the same one.

### Step 2 — Make the data directories

Left alone, everything lands in `./data`. Docker would create those directories as `root`, and the server
does not run as root, so make them yourself:

```bash
mkdir -p data/{db,blobs,backups,state}
chmod 775 data/{blobs,backups,state}
```

`chmod`, not `chown`: `chown` needs root, which a NAS administrator often does not have, and the group is
usually one both they and the container are in. `data/db` is not yours to arrange — the database image
takes it over as its own user.

### Step 3 — Fill in `.env`

The file arrives with working values and **three gaps**: the image to run, and the two secrets. Compose
refuses to start without any of them, which is the point — there is no default secret to leave in place.

Later assignments win in an env file, so this appends rather than edits, and `$V` is still the version
from Step 1:

```bash
cat >> .env <<EOF
SERVER_IMAGE=ghcr.io/olegg90/syncserver:$V
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SERVER_SECRET=$(openssl rand -hex 32)
PUBLISH_PORT=8087
EOF
```

**Keep those secrets.** `POSTGRES_PASSWORD` is what the database was initialised with: a different one on
a later start leaves the installation unable to open its own data, while the database reports itself
healthy. A **version** and never `latest`, because a server has to be able to say what it is running and
to go back to what it ran yesterday.

Two values already in the file are worth a look:

- **`PUBLISH_PORT`** ships as `8080`, which is why the append above overrides it. On a NAS that port
  belongs to the box's own admin panel, and the clash surfaces only after the database is already healthy;
- **`RUN_AS`** ships as `1000:1000` — the first ordinary user on most Linux hosts. It has to be a user that
  can write the directories from Step 2; `id` tells you yours.

To put the data somewhere other than `./data`, set `DB_DIR`, `BLOB_DIR`, `BACKUP_DIR` and `STATE_DIR` to
host paths — the host side of four mounts whose container side is fixed.

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

### Turn on backups

Backups are **off until a destination is named**, and nothing else decides it. In `.env`:

```bash
BACKUP_DESTINATION=/backups          # the path INSIDE the container
BACKUP_BLOB_SOURCE=/data/blobs       # likewise
BACKUP_DIR=/srv/syncserver/backups   # where that lands on THIS machine — the default is ./data/backups
BACKUP_EVERY_SECONDS=86400
BACKUP_KEEP=7                        # optional: prune all but the newest 7 copies
```

`BACKUP_DESTINATION` and `BACKUP_DIR` are the two sides of one mount. Naming a destination with no host
directory behind it writes the copy into the container's writable layer, where the next `docker compose
pull` takes it.

`docker compose up -d` again, and the boot log says `backups are scheduled every 86400s to /backups`.

**Copies are kept for ever unless `BACKUP_KEEP` says otherwise.** With it set, each scheduled run prunes
what falls past the newest N *after* taking its own — the newest good copy is never removed, and every
removal is logged.

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
version number carries the compatibility promise in the **minor** while the major is `0` (#111): `0.5.2`
to `0.5.4` cannot break a client, `0.5.x` to `0.6.0` announces that it can.

**There is no migration tool, deliberately.** `db/schema.sql` runs once, on an empty data directory, so a
build whose schema gained something arrives at a database that has never seen it — and the failures are
quiet: a missing table breaks at the first query, while a missing **trigger** simply never fires. That is
how one deployment ran for weeks with change notifications inert.

So after an upgrade that changed the schema, compare the two. Fetch `db/schema.sql` for the new version
first, then:

```bash
docker compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
     SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '\''public'\''
     UNION SELECT tgname FROM pg_trigger WHERE NOT tgisinternal"' | tr -d '\r' | sort -u > /tmp/actual
sed -n 's/^CREATE FUNCTION \([a-z_][a-z0-9_]*\).*/\1/p;s/^CREATE TRIGGER \([a-z_][a-z0-9_]*\).*/\1/p' \
  db/schema.sql | sort -u | grep -Fxv -f /tmp/actual
```

Anything printed is missing from the database. (The archive route below runs this for you, and stops.)

---

## Installing from an archive instead

The route above needs the internet on the server. This one does not, and it does more for you: it creates
and permits the directories, writes `.env` with generated secrets **only if there is none**, pins the
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

Steps 2 and 3 are in that order and are not interchangeable ([08](08-backup-restore.md), #114). A window
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

**Verify** re-runs that check on demand. The server also rehearses on its own: at every start, and
periodically after, it reopens the newest backup and confirms it. That line is in the boot log.

**Remove a copy** from its row, behind a confirmation naming it. The run stays in the history with no
destination — the log keeps saying a backup ran, and the empty destination says its copy is gone. The
newest good copy cannot be removed, by that button or by `BACKUP_KEEP`.

### What a backup is not

It is not a second copy in a second place. Everything above writes to one directory on one machine — take
that directory somewhere else, on whatever schedule your data deserves, and remember that **a backup that
has never been restored is not a backup** ([08](08-backup-restore.md) has the quarterly rehearsal).

---

## Restoring

Never under load.

1. **stop the service;**
2. restore the blobs, then the database;
3. start the service. It will notice.

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
| the database comes up empty and the server fails on missing tables | `db/schema.sql` was not beside the compose file at first start |
| `password authentication failed` after an upgrade | `.env` and the database disagree. The database keeps the password it was created with |

The server's own log is the surface on an unattended box. `docker compose logs -f server` is where the
backup schedule, the rehearsal, the restore guard and the boot warnings all say what they found.
