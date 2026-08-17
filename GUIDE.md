# Using SyncServer

For the people who run it and the people who sync with it. Everything here has been walked
on a real installation rather than written from the code.

**This is not the design record.** `docs/` is, and it is where every rule actually lives —
this file says what to do, and cites `docs/` for why. If the two ever disagree, `docs/` is
right and this is stale.

---

## Two kinds of account, and you probably need both

| | console account | vault account |
|---|---|---|
| for | running the server | keeping notes |
| signs in with | a password, in a browser | a passphrase, in Obsidian |
| holds keys | **no** | yes, made on your device |
| can sync a vault | no | yes |
| can open the console | yes | no |

They are separate on purpose ([#115](docs/09-decisions.md)). An administrator holds no key,
so "the administrator cannot read your notes" is a fact about the account rather than a
promise about behaviour — there is nothing to read them with.

**If you run the server and also use it, you need one of each.** The administrator invites a
vault account for themselves, exactly as they would for anybody else.

---

## Quick start

Three things, in order. Ten minutes on a machine that already has Docker.

### 1. Bring the server up

```bash
cp .env.example .env      # then edit it: see below
docker compose up -d
curl -s localhost:8080/health
```

A fresh installation answers:

```json
{"status":"ok","bootstrap_pending":true,"version":"0.4.0"}
```

`bootstrap_pending: true` means it has no administrator yet, and until it has one it serves
**nothing but the screen that creates one**.

Two values in `.env` decide whether this works:

- **`RUN_AS`** — the `uid:gid` the container runs as. It must be able to write `BLOB_DIR`.
  Get it from `id -u`:`id -g` on the machine that owns those directories. Wrong here, the
  server starts, looks healthy, and fails on your first file with `EACCES … mkdir
  '/data/blobs/6e'`.
- **`PUBLISH_PORT`** — on a NAS, 8080 is usually the management interface. Change this, not
  the compose file.

The full procedure, including what a NAS adds, is [`docs/13`](docs/13-deployment.md).

### 2. Claim the server

Open `http://<server>:<port>/` in a browser. On a fresh installation there is one screen,
asking for a password.

**That password is created here, not changed.** There is no default to leave lying around
— which is the point ([#107](docs/09-decisions.md)). Choose something you would choose for a
password manager; **at least 12 characters**, and nothing else is required of it. It is
checked with Argon2id on the server, and it is the only credential here that a person
invented — everything else is random.

Sign in with login `admin` and that password. You are now looking at the accounts list.

### 3. Invite yourself a vault account

In **Invite somebody**, give a login and a quota in MiB. You get a **token, shown once** —
only its hash is stored, so there is no second chance to read it. If it is lost, reissue.

Then in Obsidian:

1. Install the plugin into your vault and enable it.
2. Settings → SyncServer → fill in the server address, **the login exactly as you invited
   it**, and a passphrase of your own choosing.
3. Paste the token under **Claim an invitation** and press Connect.
4. Press **Sync now**.

Your keys are made on your device at step 3. The server never sees your passphrase and
cannot recover it ([#61](docs/09-decisions.md)).

> **The login must match the invitation.** It belongs to whoever issued it, so typing
> anything else is refused with `this invitation is for "…"` rather than being quietly
> accepted — a mismatch used to produce a vault that synced once and could never log in
> again.

---

## First connect, in detail

What the plugin asks for, and why each one:

| | |
|---|---|
| **Server address** | where this device talks. An IP, a host name, a tunnel — nothing else depends on it, so it can be changed later without reconnecting |
| **Login** | the name on the invitation |
| **Passphrase** | yours, and never sent. It unwraps a random account seed; every vault key comes from that seed |
| **Invitation token** | one use, and redeeming it is what spends it |

**The passphrase is not stored.** It is asked for once per session — the first time a sync
runs after Obsidian starts. Everything the plugin writes down (`data.json`) is worthless
without it.

**Losing the passphrase loses every vault.** No administrator can reset it: the server has
no key to re-wrap the seed with. This is the trade the whole design is built on
([`docs/06`](docs/06-key-model.md)).

---

## Connecting a second device

The second device has no seed, so it cannot simply log in — it has to be handed the account
key by a device that already holds one.

**On the new device:** Settings → SyncServer → *Join an existing account*. It shows a
**pairing code**.

**On a device already connected:** Settings → SyncServer → *Add another device* → type that
code → **Approve**. You will be asked for your passphrase, because approving needs the seed.

The new device seals nothing to the server: the old one encrypts the account key to the new
one's public key, and the server only relays it ([`docs/07`](docs/07-onboarding.md)).

A pairing code lasts ten minutes and is single-use.

---

## Coming back to a vault

Three different situations, and they need different things.

### The passphrase, on a device that has none

*Every device gone — reinstalled, lost, replaced.*

Settings → SyncServer → **Recover this vault**: the address, the login, the passphrase.
Nothing else, and no second device anywhere.

The client proves it can open the account's envelope before the server hands it over, so the
passphrase still never travels. Past that point the device is an ordinary fresh one: it
picks a vault and fills it in.

### A different address for the same server

*Moved from an IP to a host name, put it behind a tunnel, changed the port.*

Settings → SyncServer → **Server address** → edit → **Save**.

That is all of it. Do **not** disconnect and reconnect: the invitation that created the
account was single-use and is long gone, so reconnecting is not a thing you can do twice
([#113](docs/09-decisions.md)). Changing the address locks the session, so the next sync
asks for the passphrase again.

### Leaving a server, keeping the files

Settings → SyncServer → **Disconnect**.

It forgets the local connection and revokes this device on the server. **Nothing is
deleted** — not a note here, not a byte there. Coming back needs the passphrase, or another
device that is still connected.

---

## Sharing a folder

Sharing is by **replication**: every participant ends up with their own copy, so leaving a
share leaves you with your files.

1. The folder must be **synced first** — a share is rooted at a node the server knows.
2. Settings → SyncServer → **Share a folder** → the path → **Share**. Its contents are
   re-keyed so participants can read them.
3. **Invite** by login. They accept in their own Obsidian and choose what to call the folder
   in their vault.

Shared folders are marked in the file tree, on both sides.

**Leaving keeps your copy.** So does being removed. What ends is the sharing, not the files
— which is also why leaving frees no space ([SH-05](docs/12-sharing-scenarios.md)).

---

## Space, and what actually frees it

**Deleting a note frees nothing.** It goes to the trash, its history is kept, and the bytes
stay charged to you. That is what makes deleting undoable.

**Emptying the trash is the only thing that lowers usage.** Settings → SyncServer → *Trash
and history* → **Discard** one item, or **Empty** the lot. The line above it turns red when
you are over your limit and says so.

Discarding cannot be undone. The bytes themselves are removed by the server a little later
— it holds an unreferenced file briefly in case an upload of the same content is in flight.

**Over your limit?** The account freezes: nothing that grows usage is accepted, while
reading and deleting keep working — deleting has to, since it is the way out
([SH-20](docs/12-sharing-scenarios.md)). Empty the trash, or ask for a larger quota.

---

## Running it: the console

Everything here is about **other people's** accounts, which is why it is a separate surface.

| | |
|---|---|
| **Accounts** | who exists, what state they are in, what they hold, when they were last seen |
| **Invitations** | create, reissue (which invalidates the old token), revoke |
| **Quotas** | change a limit. Lowering it below what somebody holds **deletes nothing** — it freezes them, and the answer says so before you commit to it |
| **Disable** | sessions revoked, writes refused, **data untouched**. Reversible |
| **Delete** | a procedure, not a button: shares are dissolved, participants convert their copies, authorship moves to a tombstone, and only then do the vaults go |
| **Audit** | every administrative act, append-only |

**The console cannot read a vault.** Not by policy — a console account holds no key.

**The console cannot change anybody's passphrase**, including its own operator's. That needs
the seed, which lives on a device.

---

## Things that look wrong and are not

**`HEAD /blobs/<hash>` answers 404 right after an upload.** A hash is not a capability: reads
need a live reference belonging to you, and an upload is only a reservation until a note
points at it.

**Uploading the same file twice answers 201, not "already have it".** A short circuit would
turn the address into an oracle for whether somebody else already holds that content.

**A deleted file still answers 200.** The trash holds it, so the content is still there —
that is what makes restoring possible.

**The server reports a version and warns on a mismatch, but still syncs.** Locking you out
of your own vault over a version string is the worse failure.

---

## When something goes wrong

**"that passphrase does not open this account"** — the phrase is wrong, or the connection
record names a login the server does not have. The server cannot check a passphrase and
cannot reset one.

**`EACCES … mkdir '/data/blobs/…'` on the first upload** — `RUN_AS` in `.env` is not a user
that can write `BLOB_DIR`. See the quick start.

**Everything answers 503 `bootstrap_pending`** — no administrator exists yet. Open the
console and set the first password.

**A sync says a folder could not be opened** — this device holds no key for a share it is
in. The rest of the vault syncs normally; the folder needs the key to reach this device,
which happens when the share is delivered again.
