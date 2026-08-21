# Running a SyncServer

For the person who runs the server. If you are syncing a vault, [14](14-user-manual.md) is yours.

This is the **procedure**, start to finish. Where a step has a reason worth arguing about, it links to
the document that argues it — [13](13-deployment.md) for deployment, [08](08-backup-restore.md) for
backup and restore, [11](11-management-console.md) for the console. Nothing is restated here; the point
of this file is the order to do things in.

---

## 0 — What you need

- a machine with **Docker** and `docker compose` — a NAS is the case this was built for;
- **git** on your own machine, not on the server. The server never builds anything: the image is pulled
  from a registry, which is the whole answer to [13](13-deployment.md)'s architecture trap;
- a **port** the host is not already using. `8080` is taken on most NAS boxes by their own admin panel;
- somewhere for the data to live, with room for it.

**The server is not published to the internet.** Access is from inside a private perimeter — a LAN, a
VPN, a Tailscale tunnel — until authentication has had a review of its own. That is a deployment
constraint, and while it holds it is the boundary of the system.

---

## 1 — Install

On your machine, make the archive and copy it over:

```bash
npm run pack
```

That produces `dist-deploy/syncserver-<version>-<sha>.tar.gz` from the **committed** contents of `HEAD`
— not from your working tree, which is deliberate (#106). It refuses if the files it ships have
uncommitted changes; to deploy something not on `main` yet, name the point instead:

```bash
PACK_REF=some-branch npm run pack
```

Copy it to the host, then, **on the host**:

```bash
rm -rf checkout && mkdir checkout && tar xzf syncserver-*.tar.gz -C checkout
checkout/scripts/deploy-dev-host.sh
```

The script creates and permits the data directories, writes `.env` with generated secrets **only if
there is none**, pins the image version, pulls it, starts, and waits for health.

Two things it does that are worth knowing before you need them:

- **`.env` lives beside the checkout, not inside it.** The secrets in it are what the database was
  initialised with; regenerating them on a redeploy would lock the installation out of its own data.
  Installing a new build deletes the checkout and never touches `.env`.
- **Per-host values come from the environment**, so a host profile is a file of `export` lines rather
  than an edited script:

```bash
. deploy/myhost.env && checkout/scripts/deploy-dev-host.sh
```

`PUBLISH_PORT` is the one almost every host needs to set.

When it finishes it prints the health line. `"bootstrap_pending":true` is the expected first-run state.

### Doing it with compose alone

The script is a convenience over `docker compose`, and this is what it does, step by step. It is also
the route to take when the host runs compose from a UI — Portainer, a NAS app manager — that wants a
compose file and an `.env` rather than a shell script.

**Three files go on the host**, and the third is the one people miss:

```
syncserver/
  docker-compose.yml     from this repository, unedited
  db/schema.sql          mounted into the database on FIRST START only
  .env                   yours: secrets, paths, port, image version
```

`db/schema.sql` is mounted at a path relative to the compose file, so it has to sit beside it in exactly
that directory. **It runs once, on an empty database directory**, and never again: a database that has
started before ignores it completely.

Write `.env` from [`.env.example`](../.env.example), which documents every variable. The five that decide
a deployment:

```bash
SERVER_IMAGE=ghcr.io/olegg90/syncserver:<version>  # a version, never `latest` — see below
POSTGRES_PASSWORD=…                                # compose refuses to start without it
SERVER_SECRET=…                                    # likewise, and not the same value
PUBLISH_PORT=8087                                  # the container is always 8080; the host port is yours
RUN_AS=1001:100                                    # uid:gid the server runs as — see below
```

**A version and not `latest`**, because a server has to be able to say what it is running and to go back
to what it ran yesterday. The current one is on the repository's releases page; this file does not name it,
having twice been a release behind while looking exact.

Generate the two secrets rather than inventing them, and **keep them**. `POSTGRES_PASSWORD` is what the
database was initialised with; a different one on a later start leaves the installation unable to open
its own data, while the database reports itself healthy.

```bash
printf 'POSTGRES_PASSWORD=%s
SERVER_SECRET=%s
' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
```

Then say where the data lives. These are host paths; the container side is fixed:

```bash
DB_DIR=/share/AppData/SyncServer/db            # → /var/lib/postgresql
BLOB_DIR=/share/AppData/SyncServer/blobs       # → /data/blobs
BACKUP_DIR=/share/AppData/SyncServer/backups   # → /backups
STATE_DIR=/share/AppData/SyncServer/state      # → /state
```

Create them, and make the three the **server** writes writable by `RUN_AS`:

```bash
mkdir -p /share/AppData/SyncServer/{db,blobs,backups,state}
chmod 775 /share/AppData/SyncServer/{blobs,backups,state}
```

`chmod`, not `chown`: `chown` needs root, which a NAS administrator often does not have, and the group is
usually one both they and the container are in. The database directory is not yours to arrange — the
image takes it over as its own user.

Then, from that directory:

```bash
docker compose pull
docker compose up -d
docker compose ps          # both healthy
curl -s localhost:8087/health
```

**Four ways this goes wrong, and what each looks like:**

| what you did | what you see |
|---|---|
| left `PUBLISH_PORT` at 8080 on a NAS | the port is held by the box's own admin panel — and you find out *after* the database is healthy |
| `BLOB_DIR` not writable by `RUN_AS` | the server starts, and the first upload fails with `EACCES`. The confusing order |
| `STATE_DIR` not writable | the server does **not** start: the restore guard writes there before it listens |
| `db/schema.sql` not beside the compose file | the database comes up empty, and the server fails against tables that are not there |

Upgrading by this route is `SERVER_IMAGE=…:<new>` in `.env`, then `docker compose pull && docker compose up -d`.
Nothing else moves — every data directory is outside the containers. Read [§6](#6--upgrading) first: a
build whose schema gained something needs a step no `pull` performs.

---

## 2 — Create the first administrator

Open `http://<host>:<port>/` in a browser. A fresh server serves the console and almost nothing else.

The first screen asks you to **choose a password for the administrator**. Setting it is what *creates*
the administrator — there is no default password, so there is no state where a default still works
because nobody got round to changing it.

Once only. A second attempt is refused.

That account is a **console account**: a password, no keys, no vault, and a quota of zero that the
schema insists on. It can administer people and it can never read a note — not as a permission somebody
withheld, but because it holds no key to read one with.

---

## 3 — Give people accounts

**Console → Accounts → Invite somebody.** A login and a quota in MiB.

You get a **token, shown once and not stored**. Send it to the person; they redeem it in Obsidian,
where their keys are made ([14](14-user-manual.md)). If it is lost, reissue it — there is no way to
show it again.

**Quotas.** Change one from the account's card. Lowering a limit below what somebody already stores
**deletes nothing** — the account freezes: nothing that grows usage is accepted, while reading and
deleting keep working. The console asks you to confirm that specifically, because it is not what most
people expect a lowered quota to do.

A frozen account thaws by itself once its owner empties the trash. That needs no administrator, and
that is the design.

**Audit log.** Console → Audit log: who did what to whom, newest first. Append-only, with logins stored
as snapshots — an entry naming an account that has since been deleted is still the answer to what
happened.

---

## 4 — Turn on backups

Backups are **off until a destination is named.** Nothing else decides it: an unset `BACKUP_DESTINATION`
is a truthful "not configured", and the console's button says so.

In `.env` beside the checkout:

```bash
BACKUP_DESTINATION=/backups     # the path INSIDE the container
BACKUP_BLOB_SOURCE=/data/blobs  # likewise
BACKUP_DIR=/srv/syncserver/backups   # where that lands on THIS machine
BACKUP_EVERY_SECONDS=86400
```

`BACKUP_DESTINATION` and `BACKUP_DIR` are the two sides of one mount — the same split `BLOB_DIR` and
`/data/blobs` already use. Naming a destination with no host directory mounted writes the copy into the
container's writable layer, where the next `docker compose pull` takes it with it.

Restart, and the boot log says `backups are scheduled every 86400s to /backups`.

**Copies are kept for ever unless you say otherwise.** Add `BACKUP_KEEP=7` and each scheduled run prunes
what falls past the newest seven, after taking its own — the newest good copy is never removed, and every
removal is logged. Leave it unset and nothing is ever deleted, which is what a server does that has not
been asked.

### Taking one

**Console → Backups → Back up now.** The run:

1. opens a **refusal window** — new writes are answered "the server is being backed up". Requests
   already in flight go on and commit; this is not a freeze;
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

**Verify** re-runs that check on demand.

The server also rehearses on its own: at every start, and periodically after, it reopens the newest
backup and confirms it. That line is in the boot log.

### What a backup is not

It is not a second copy in a second place. Everything above writes to one directory on one machine — take
that directory somewhere else, on whatever schedule your data deserves, and remember that **a backup that
has never been restored is not a backup** ([08](08-backup-restore.md) has the quarterly rehearsal).

---

## 5 — Restoring

Never under load.

1. **stop the service;**
2. restore the blobs, then the database;
3. start the service. It will notice.

The server keeps the newest epoch it has ever run with in a **state file outside the database**, so a
restored database is *behind* that file — which is how a restore is detectable at all. The server then
**halts**: every request but the console and the restore endpoints is answered `restore_pending`.

That halt is deliberate. A restored database re-issues revision numbers it has already handed out, and
a client holding a cursor from that generation would believe it was current. Silent divergence, noticed
weeks later as missing files.

**Console → the restore screen → Confirm the restore.** It raises the epoch above anything ever issued,
records the act in the audit log, and lifts the halt in the same moment — no restart.

Then, the parts only you can do:

- every client will resync on its next pass. A long synchronisation is **expected**, not a fault;
- verify the restored copy against the blobs, and note anything the copy could not restore;
- **tell the people who use the server**, so the resync does not read as data loss.

---

## 6 — Upgrading

Same as installing. From your machine:

```bash
npm run pack
```

Copy it over, then on the host:

```bash
rm -rf checkout && mkdir checkout && tar xzf syncserver-<new>.tar.gz -C checkout
checkout/scripts/deploy-dev-host.sh
```

The checkout is the only directory a new build replaces. `.env`, the database, the blobs, the backups and
the state file all live beside it and are untouched. The script repins `SERVER_IMAGE` to the version in
the archive and says what it changed it from.

**There is no migration tool, deliberately.** `db/schema.sql` runs once, on an empty data directory, so a
build whose schema gained something arrives at a database that has never seen it. The deploy script
compares the two and **stops** if the database is behind, naming what is missing. A schema change is a
manual step you make knowingly, not something a script does to you while you are reading its output.

Users need nothing: BRAT offers them the matching plugin release.

---

## 7 — What will look like a fault and is not

| what you see | what it is |
|---|---|
| `"bootstrap_pending":true` and nothing else served | a fresh server with no administrator yet. Open the console |
| `restore_pending` from everything | a restore nobody confirmed. Console → confirm |
| `the server is being backed up` | the refusal window, for the second or so a backup takes |
| a backup row `ok` **with** an error line | the copy is not whole. This is the row to act on |
| `N backup run(s) were still marked running` at boot | a run whose process died. The window went with it; those rows are recorded failed |
| every client resyncing at length after a restore | expected — see above |

The server's own log is the surface on an unattended box. `docker compose logs -f server` is where the
backup schedule, the rehearsal, the restore guard and the boot warnings all say what they found.
