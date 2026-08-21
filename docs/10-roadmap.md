# 10 — Roadmap

| Milestone | Scope | Done |
|---|---|---|
| **M0** | database schema (including `versions`), blob store, authentication, `delta`/`put`/`delete`; verified with curl, no plugin. Ships as a **Docker image** deployed to the home server for testing — see [13](13-deployment.md) | ☑ |
| **M0.5** | plugin, **one-way** sync: local changes reach the server, delta is only ever applied to an empty vault | ☑ |
| **M1** | **two-way** sync of one vault: adoption of a non-empty vault, conflict files, rescan, resync after journal TTL — scope below | ☑ |
| **M2** | WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | ☑ |
| **M3** | **folder sharing** by replication: create/invite/decline/withdraw/join/revoke/leave, the membership list, synchronous fan-out to at most 8 participants, history transfer on join, over-quota freeze | ☑ |
| **M3.5** | **getting back in, and getting out**: recovery with the passphrase, an editable server address, disconnect, and the thaw M3 left open — scope below | ☑ |
| **M4** | **space, and the history already on disk**: the nightly mark and sweep, emptying the trash, the administrative API with its audit trail, and the history/trash UI — scope below | ☑ |
| **M5** | **the operator's milestone**: the management console, backup operations, and an image that is pulled rather than built on the server — see [11](11-management-console.md), [08](08-backup-restore.md), and the scope below | ☑ |
| **M7** | the **recovery code**: the second proof to an endpoint that already takes two, answering the one loss nothing else does — a forgotten passphrase. Scope below | ☑ |

**There is no M6.** It was a WebDAV gateway, and it is dropped rather than deferred: the vault is reached
through the plugin, and a second protocol into the same data is a second place for the key model to be got
wrong — for a way in nobody here needs. The number is left as a gap on purpose. Renumbering M7 would silently
rewrite every reference to it in the issues and in this file, to save one integer.

E2EE is not a milestone: it is day one, in every milestone above (AC-08).

**M0 was walked end to end on the home server** (`scripts/run-smoke.sh`, build 4e47a15): claim, account
surface, blob, node, `put` with the content precondition, `delete` with its revision precondition, the trash,
and a delta reporting each. Including the three answers that look like faults and are not — `HEAD` on a
freshly uploaded blob is `404` until a node references it ([#20](03-data-model.md)), re-uploading identical
content is `201` rather than a short circuit (#46), and `HEAD` stays `200` after a **soft** delete because
the trash still holds the content. The collector and the schema's 117 assertions ride along; the server's
own integration suite is run from a development machine, not from the NAS.

**M3 is closed**, and the box above was ticked by a walk rather than by a suite. All
twelve endpoints of [04](04-sync-protocol.md)'s table exist: create, prepare, activate, cancel, invite,
decline, join, the two lists, removal (withdraw or revoke, decided by whether they ever joined), leave and
finalize-leave. Writes fan out synchronously to every live non-frozen participant **in the same transaction
as the original**, which is the atomicity contract [04](04-sync-protocol.md) states and the reason a share
is capped at eight; a test injects a failing replica write and proves the original rolls back too.

Two rules were found to have no enforcer while building it. `users.frozen_at` was read in four places and
written in none, so SH-20's "reaching the limit freezes the account" was a sentence with nothing behind it;
propagation is where somebody else's write crosses your boundary, so that is where the freeze now happens.
And a node created inside a shared folder carried no share mark, which the schema refuses — so creating
anything inside a share was impossible rather than merely untested.

The client half followed, and then two accounts on two machines used it: share a folder, invite, accept,
write from either side, and leave — each keeping their copy, the initiator with the whole history and the
added participant without it, exactly as SH-05 and SH-22 say. That pass found **eighteen defects that
around five hundred green tests had no opinion about**, and three tests that were asserting the bug
instead of the rule. The rules distilled from it are in `AGENTS.md`; the sharpest is that every operation
leaving the system in an intermediate state must be recoverable **from that state, using the product's own
buttons**, which the vault then demonstrated four times without the database being touched.

Two things M3 named are still open, neither blocking the milestone, and both now carried by **M3.5** below:
thawing with catch-up, and the absence of any sign in the file tree that a folder is shared at all.

**M2 is closed.** Its four pieces: the `.obsidian/` switch with its per-device exceptions
([01](01-context.md)), resumable upload ([04](04-sync-protocol.md)) — `PUT`/`GET`/`complete` on parts, with
the part size doubling as the threshold above which a client uses them at all — and WebSocket push
([04](04-sync-protocol.md), Change notifications): a journal-insert notification delivered on commit, fanned
out over `WS /events` to the account's devices, so a change wakes a connected client instead of waiting for
the button. And **mobile**, which was a word rather than a criterion until the section
below gave it three — two about memory, one that no suite could run and that has now been run on a real
phone. Getting there also required the thing docs/07 had specified since the first draft and no code
performed: **pairing**, without which a phone cannot join an account at all, because a second device has no
seed and therefore no way to log in.

Estimate: M1 is two to three weeks of evenings. Re-estimate M2 and beyond only after M1; until then the
numbers are guesses.

## M3.5 — getting back in, and getting out

A milestone of its own because what it fixes is not a feature gap but a **claim the product makes and cannot
keep**. A server that holds every byte of a vault and has no way to return it to the person who wrote it is
not a backup; it is a transport between two live machines, and the day one machine dies is the day that
becomes apparent. Everything here was found the same way: by using the thing.

### Recovery — the reason this milestone exists

Today a device with no `data.json` has exactly one way in: pairing, which needs **another working device to
approve it**. An account whose only device is gone is gone with it, and nothing in the product says so until
it is too late. Worse, `connect()` writes placeholder recovery values, so an account created today *claims* a
recovery path it does not have.

The design is settled in [06](06-key-model.md) and walked through in [07](07-onboarding.md); the decision and
its cost are #112.

- [x] **Schema.** `users.kek_verifier_hash`, **beside** `recovery_key` and `recovery_code_hash` rather than
      instead of them — the recovery code stays specified, and is now M7. The two of them
      become **nullable**, which the three-shape `CHECK` on `state` and the key columns has to allow.
- [x] **No account claims a path it does not have.** `connect()` writes a real `kek_verifier` — it already
      holds the `KEK` — and **null** where it used to write placeholder recovery values. Null means "no
      recovery code"; a fixed byte and a random hash nobody holds the preimage of mean "there is a way back"
      to every check that looks, and nothing at all on the day it is needed.
- [x] **`POST /auth/recover`.** Anonymous, shaped like pairing's claim: verify, create the device, return
      `wrapped_seed`, `enc_privkey`, `account_salt`, `kdf_params`, `user_id`, `device_id`. An unknown login and
      a wrong phrase get the same refusal (#73).
- [x] **An attempt limit that is real.** Per login and per source, backing off, audit-logged. The endpoint is
      the one place in the product where guessing pays, and the documents already promise a limit here and on
      `/auth/kdf` that no code currently applies — this closes both.
- [x] **"Recover this vault" in the plugin**, beside "Join an existing account": address, login, passphrase.
      Past it nothing new is invented — the client logs in, lists vaults and enters **adoption**, which has
      existed since M1. The endpoint takes the recovery code as its second proof from the start, so building
      that half later is a client screen and a comparison, not a new shape.
- [x] **Say it at registration.** One line, once: a forgotten passphrase loses every vault, and no
      administrator can help.
- [x] **Backfill the accounts that predate all this.** They cannot make a verifier themselves — it
      takes the `KEK`, which exists only on a client holding the passphrase — so `login` reports that one
      is missing and the client files it on the next unlock. Without this, every account created before
      M3.5 stays unrecoverable forever and nothing says so.

**Not in this milestone, deliberately:** generating and storing the **recovery code** itself, which answers
the other loss — a forgotten passphrase. It stays specified in [06](06-key-model.md) and [07](07-onboarding.md)
with its columns in place, and is M7. What M3.5 owes it is only honesty: null rather than a placeholder.

### The scenario that decides it

Run end to end, against a real server, on a machine that keeps nothing:

1. connect a vault, sync it, share a folder — an ordinary, populated account;
2. **destroy the client entirely**: delete the plugin's `data.json`, then delete the vault folder itself;
3. on an empty vault, enter the address, the login and the passphrase — nothing else, and no second device
   anywhere;
4. every note comes back, with its history, and the shared folder is still shared.

Step 3 is the whole milestone. If it needs anything the user does not carry in their head, it has failed.

**Walked, and it holds.** A third vault with no plugin state recovered an account from the address, the
login and the passphrase alone — no second device, nobody approving anything — and the server's audit log
records the one event that has no other witness. What the walk found was not in the protocol: three
onboarding forms asking for the same three details, one of them prefilled with a developer's `127.0.0.1`,
so the recovery attempt went to an address nobody had chosen and failed before the passphrase was used.

### The connection record — found by using it

- [x] **The server address is editable in place** (#113). Moving from an IP to a host name changes one field;
      nothing else in the record depends on it. The instinct to "disconnect and reconnect with the new
      address" must not be catered to, because reconnecting costs a full bootstrap that the one-time
      invitation token cannot pay for twice.
- [x] **Disconnect**, which does not exist at all today: clear the local record, revoke this device, keep
      every file and everything on the server, and say what coming back will cost **before** doing any of it.
      It ships after recovery, never before (#113).

### A shared folder that looks like any other — found by using it

- [x] **Mark a shared folder as shared where the folder is**, not only in the plugin's settings. After the
      two-account walk both sides had a folder that behaved differently from its neighbours — writes reaching
      another person, a departure to perform — with nothing on screen to say so. A participant cannot reason
      about a boundary they cannot see.

### Carried over from M3

- [x] **Thawing with catch-up (SH-21).** The freeze lifts when the account is back inside its limit, and
      the catch-up runs in the same transaction: a walk of another member's copy, delivering what arrived
      during the gap **and the version rows behind it**, authorship intact. Not the journal — that is a
      90-day transport buffer, and a freeze has no expiry of its own.
- [x] **Something a frozen account can actually delete.** Thawing has a trigger only if usage can fall,
      and today it can fall two ways: a vault reset, and deleting a whole vault. An ordinary delete is
      **soft** — the row is the trash entry — so it frees nothing, and there is no purge. SH-20 says
      "deleting is the only way out"; until the trash can be emptied that sentence is not true, and the
      exit that recovery-by-deletion promises is a vault reset. Closed by M4's first item: the trash can
      be emptied, the claim goes down through `dropUnreferenced`, and the freeze lifts in the same
      transaction that freed the space.

## M4 — space, and the history already on disk

Everything that was written down and never collected. The schema has carried this milestone's tables and
columns since M0 — `audit_log` with its append-only triggers, `blobs.gc_marked_at` with its index, the
`disabled`/`deleting`/`tombstone` states, the trigger that refuses to remove the last administrator — and
almost none of it has a line of code. A column nothing writes is a promise nothing keeps, and the one being
broken here is the only one a user can feel: **the product has no way to give space back.**

It is separated from the console (M5) because they are different products that happen to share a document.
This one is a collector, a purge and an API; that one is a web client. Building them as one milestone would
mean the space problem waits for a front end.

### The trash can be emptied, and a claim can go down

- [x] **A purge, so SH-20 stops being a sentence with nothing behind it.** Deleting is soft — the row *is*
      the trash entry — so today it frees nothing, and a frozen account's only exit is a vault reset. The
      statement that **lowers** a claim belongs in `holdings.ts`, beside the two that raise one; a per-blob
      decrement lived unreachable in `nodes/service.ts` for months, which read as evidence that releasing
      was already wired. This is the item M3.5 is still open on, and the reason it is first here.
- [x] **It is local, and a replica is not exempt** (SH-30). The item is already deleted in every copy, so
      there is nothing to propagate; what is discarded is this account's own retention of it, which is per
      account exactly as the quota it is spent against. A frozen account may do it — a freeze that blocked
      the only way out is a deadlock, and the schema agrees: the trigger refusing a frozen account's writes
      fires on `INSERT` and `UPDATE`, never on `DELETE`.

### The nightly mark and sweep

[03](03-data-model.md) specifies seven steps; `collector.ts` implements the TTL sweeps and says so in its
own header. The rest is this milestone, and its traps are already written down — they become tests, not
comments:

- [x] **Thinning by the retention ladder**, which needs the column it has never had: [11](11-management-console.md)
      offered the user a retention setting and the schema held nothing to set: `users.history_days`
      is the ladder's outer bound, per account because history is spent against the account's quota.
      The rungs themselves stay fixed (all under 7 days, one a day to 30, one a week after that), and
      the live head sits outside the policy entirely — a deleted node's head does not, which is what
      lets the trash empty itself.
- [x] **Node rows removed bottom-up**, ordered by ancestry length descending, because `parent_id` is
      `ON DELETE RESTRICT` — an orphaned branch is worse than a failed delete.
- [x] **`user_blobs` recomputed from scratch** and reconciled against the accumulated counters. A live
      counter drifts under concurrent writes, and an error towards zero is data loss.
- [x] **Mark, quarantine, and look again.** A blob's only reference may be a live `refs_pending` row, and a
      blob bound on day three must not be swept on day seven. Both halves are the rule, not an optimisation.
- [x] **`blob_keys` is never collected on its own.** Tidying up the envelopes of a dissolved share would cut
      detached ex-members off from folders that are now their own.

### The administrative API, and the trail it leaves

The console is M5; the surface underneath it is here, because account deletion and quota changes are server
behaviour that a web client merely calls.

- [x] **An administrator role that the routes actually check.** There is no `requireAdmin` today.
- [x] **Users, invitations, quotas, storage.** List with state, quota, usage and last seen; invite, disable,
      enable, re-quota. Lowering a quota below usage deletes nothing — the account freezes (SH-20) — and the
      API says which accounts a change would freeze **before** it is applied.
- [x] **Every administrative act is audited.** `audit_log` exists, is append-only by trigger, and is written
      from exactly two places in `auth/service.ts`. An action on somebody else's account that leaves no
      record is the one kind this table was built to refuse.
- [x] **Deletion is a state, not a button** (#55): dissolve the shares the account initiated, wait for each
      participant to finalize their copy (SH-29), reassign authorship to the **tombstone**, then remove the
      vaults. `versions.author_id` is `NOT NULL` with `ON DELETE RESTRICT`, so authorship must go somewhere
      before the account naming it can be removed — which is why the tombstone is seeded by `schema.sql`
      rather than minted by the procedure that needs it. Disable and delete are different operations and
      must not share a control.

### History and the trash, where the notes are

- [x] **The trash and the version list in the plugin.** The server surface has existed since M0 — the
      versions of a node, the trash of a vault, and restore as a new write with an old hash — and no screen
      has ever called it. Restoring into a taken name is `409` with the blocking node id, and stays that
      way: a file silently named "Note (1).md" is a file the user cannot account for.
- [x] **Usage the user can act on**, broken into current content and history. A number without the action
      that lowers it is the same dead end this milestone exists to close.

### The scenario that decides it

An account is frozen at its limit. Without touching the console, without a vault reset, and without
deleting a vault:

1. empty the trash from the plugin;
2. the next collector pass frees the blobs nothing references any more;
3. usage falls below the limit, the account thaws, and the catch-up SH-21 already runs delivers what
   arrived while it was frozen.

If any step needs an administrator, the milestone has failed: the person who ran out of space is the person
who must be able to make space.

**Walked, and it holds.** A person emptied the trash of a vault sitting at 210% of its limit; the claim
went with the row, usage fell from 210 bytes to 85 against a 100-byte limit, and the collector unlinked
the freed bytes once their quarantine expired. Nothing in it needed an administrator.

The walk found **six defects that 302 green tests had no opinion about**, which is the ratio M3 produced
and the reason this row waits for a person. Five were the same shape — a decision made where no test was
watching — and the quietest of them cost the walk its first twenty minutes: `/auth/redeem` takes the
account's name from the invitation and never took one from the caller, so a client that typed a different
name stored one the server had never confirmed. Nothing failed at the moment of the mistake. It failed at
the next unlock, and it had bound the recovery proof to a name nobody had.

The others: a confirmation whose "yes" was read as "no", because the dialogue closed before it recorded
the answer; a guard written for irreversible acts that also gagged reads, so a screen asking for two
things at once got one; a usage line marked red on `frozen` rather than on being over the limit, which an
account syncing alone never is; three passphrase prompts to open one page; and a trash listing nobody had
ever bounded. The last of those was not the walk's — it had one file in it — but the walk is what made
somebody ask.

## M5 — the operator's milestone

Everything the person running the server does that is not synchronising a note. Two halves are
specified elsewhere and are not restated here: the console is [11](11-management-console.md), and backup
operations are [08](08-backup-restore.md) plus the `backup_runs` table that has held their constraints
since M0 — and which, at the start of this milestone, nothing wrote a row to.

The third half is specified nowhere, because it has never been a feature — it has been a procedure in
[13](13-deployment.md).

**Walked, and it holds.** Every box below was ticked while the milestone row stayed open, under the same
rule M0, M3 and M4 were closed by: a milestone is closed by a walk, not by a suite. What was missing was
precisely the walk — no commit in M5 had met a real deployment, because the machine this was written on has
no Docker. It has met one now. A published image was pulled onto a home server, an administrator was
created, a vault synchronised, a quota was lowered under a live account, and `pg_dump` ran inside a real
refusal window: 657 milliseconds, a custom-format archive holding all seventeen tables, four blobs in the
copy against four in the store, and `verified_at` stamped before the row was settled — the self-check
working for the first time outside a fixture.

The walk found **nine defects, in five pull requests, that a green suite had no opinion about** — the ratio
M3 and M4 both produced, and the reason this row waited for a person. Four of them meant the deployment did
not work at all, and every one was a mount or a path: a deploy script that silently invented the version it
pinned, because `cat VERSION` ran in the wrong directory and a `|| echo` beside it answered `0.4.0`; a
default given to `BACKUP_DB_COMMAND` that turned every *unconfigured* server into a restart loop, since the
backup trio was all-or-none and one of the three was now always set; a backup destination that could only
name a path inside the container, so a copy was written to the writable layer and went with the next pull;
and the restore epoch in the same place, which additionally could not be written at all under a `RUN_AS`
that is not the image's own uid — `EACCES` before the server listens.

The other five were surfaces telling somebody something they could not read. A quota outcome appended to
the card that the following refresh replaced, so the sentence was rendered and destroyed by the same act. A
frozen account announced once, as a twenty-second notice, after which every surface read "up to date" while
the server refused every write — a state told as a moment. A console session that simply expired, leaving
the word `unauthenticated` on the page and a "Loading…" underneath it that was never going to resolve; and
that placeholder itself, a promise no failure path kept. And the last one the walk's own final step
produced: a backup taken by hand opened a refusal window and closed it leaving **nothing in the log** —
every sentence about an outcome belonged to the schedule wrapper, and the button a person presses wrapped
none of them.

Three of the nine were regressions introduced by earlier pull requests in the same sitting, which is its
own argument for walking: the suite that reviewed them was written by whoever wrote them.

M5 also carried a set of defects that only a review found, listed with the boxes below rather than
separately: a version check inside the window it was meant to precede, a `verified_at` stamped on copies
found incomplete, a rehearsal that stopped for ever after one failed run, and a backup nothing ever took.

### Where the console lives, and what it may not assume

- [x] **The server serves it**, from the same process and therefore the same version and the same
      `/health` — which is what [11](11-management-console.md)'s "one deployment, one session" means when
      read literally. A second container would be a moving part that document already refuses.
- [x] **The bootstrap guard has to let it in.** It is an exact-match allowlist today — `/auth/kdf`,
      `/auth/redeem`, `/health` and nothing else — so a fresh server would answer `503` to the console's
      own assets, and the one screen that matters on a fresh server is the one that redeems the seeded
      invitation (#107). Whatever widens it must widen it for **exactly** the static bundle, since the
      point of the guard is that a server with no administrator does nothing else.
- [x] **`restore_pending` needs the same exemption**, for the same reason and preferably through the same
      list: a halt that also refuses the endpoint used to confirm the restore is a halt nobody can leave.
      `/admin/restore` and `/admin/restore/confirm` sit in both the bootstrap allowlist and the halt's
      open list (server/src/bootstrap.ts, server/src/app.ts).
- [x] **The first administrator sets a password rather than redeeming an invitation** (#107, #115). The
      seeded row is a console account with none, the console's only screen until one exists is the setting
      of it, and setting it is what creates it — so no default ever works. A fresh server therefore needs
      no Obsidian to become usable, which is what made "the console shows a notice" a dead end before.
- [x] **A console account is administered, not synced** (#115): it holds no key material, so it cannot be
      invited into a share and cannot open a vault. Inviting one must refuse in a sentence rather than on
      a null `pubkey`, and `role` stops being a column crossed with a keyed account — an administrator IS
      a console account.
- [x] **The password gets a slow hash on the server** (#108, #115), which nothing else here needs: every
      other verifier is at least 128 bits of CSPRNG and a person's password is not. `@noble/hashes` is
      already in the tree.
- [x] **It does what [11](11-management-console.md) says it does.** That document opens by naming four
      things — accounts invited, quotas changed, backups run, the audit log read — and for a while two of
      them had endpoints and no screen. A review found it rather than a person using it, which is the
      cheaper way round but not the one to rely on: a surface is not built until the thing it promises
      can be pressed. Lowering a quota below what an account stores explains itself **before** it is
      applied, because nothing is deleted and writes stop (SH-20), and that is a different act from the
      one an operator usually expects.

### Backup, as the thing that runs it

- [x] **In-process**, because the advisory lock the window needs is already this process's — the collector
      takes it and skips a pass while it is held, which is half of the machinery. `pg_dump` therefore
      lives in the runtime image, and its **major version must match the server's** or the first real
      backup fails on a production database: pinned explicitly (`postgresql18-client`, against the
      `postgres:18-alpine` compose runs; `check-compose.mjs` compares the two and CI builds the image
      and asks the binary), and checked **before the window opens** rather than discovered.
      That last word changed in the doing. The check first landed on the first line of `dumpDatabase`,
      which reads as "before the work" and is not — the lock was held, the row inserted and writes
      already refused. `assertReady` is a precondition of the run rather than a step in it; the startup
      check stayed, as the thing that tells an operator early, and enforcement is the one before the
      window.
- [x] **Database first, blobs second** (#114). Not interchangeable here: the window refuses new writes and
      does not reach the ones in flight, so blobs-first can copy a blob store that is missing a file the
      dump references — a restore that completes, looks whole, and cannot open a note.
- [x] **The window closes in a `finally`.** A run that fails between the legs must not leave the server
      refusing writes, and a `running` row surviving a restart is a lie the next boot has to settle.
- [x] **One integrity check, three callers** ([08](08-backup-restore.md)): the console's verify, the
      periodic restore rehearsal, and whatever runs it nightly. Written once — `verifyBackup` in
      `backup.ts` — and all three now call it: the Verify button, `verifyLatestBackup` on its own rare
      interval, and every scheduled run checking the copy it just wrote (`backup-schedule.ts`).
      Two things it was willing to claim had to stop first. `verified_at` was stamped unconditionally,
      so a copy the check had just found incomplete was listed as verified; and the rehearsal fetched
      one row and then filtered it for `ok`, so a single failed run at the head meant the last good
      copy was never rehearsed again.
- [x] **Something presses the button.** `runBackup` had one caller — the console — so a backup happened
      when a person remembered, which for an unattended NAS means an installation nobody touches for a
      month has no copies from that month. A schedule takes one every `BACKUP_EVERY_SECONDS`, on by
      default once a destination is configured, and `0` turns it off for a deployment driving backups
      from cron on the host. Nothing runs at boot: a server in a restart loop would otherwise take a
      backup per restart, each opening a refusal window.

### The image is pulled, not built on the server

The image is published from CI and pulled, which ends the three costs of building on the target:
the platform trap (an image built on ARM dies on x86-64 with a silent exec-format error), a build
that happens on the weakest machine involved, and a server that holds the whole build context
just to build what it runs.

- [x] **Publish the image from CI to a registry**, on a version tag rather than on every push to `main`
      — one image per released version, matching the single version across six manifests (#111), and
      tagged by commit as well so a running container can be traced to a build. The runners are x86-64,
      which is the platform the trap is about. `docker-publish.yml` does this on a `v*` tag.
- [x] **`docker compose pull` replaces `docker compose build`** in the procedure, with the image
      pinned to a version. `latest` is not used: a server updated a few times a year must be able to
      say what it is running, and to go back. The local-build path survives as `docker-compose.dev.yml`.
- [x] **`pack.sh` shrinks to what compose actually reads** — the compose file, `.env` and
      `db/schema.sql`, which the database container mounts to initialise itself. The copy does not
      disappear, and the roadmap should not pretend it does; it stops being a copy of the source.
- [x] **The registry choice is a public one**, so no credential lives on the server. The image holds a
      built server and its dependencies — the same code the repository already publishes — and no
      secret: `.env` is excluded from the build context, and neither `POSTGRES_PASSWORD` nor
      `SERVER_SECRET` has a default to leak.

**Not a private registry, unless something changes.** A private image needs a token stored on the server
to pull it, which is a credential added to a machine in exchange for hiding source that is already public.
If the repository ever stops being public, this decision comes back with it.

### What M5 also absorbed, which was not an operator feature at all

Five server and plugin refactors landed inside this milestone without a line above asking for them. They
came from an architecture review rather than from the operator's list, and they are recorded here because
a milestone that does not say what it contained is a milestone nobody can read back. Two of them fixed
live defects, which is the reason the list is not simply tidying.

- [x] **One module deletes nodes deepest-first.** `parent_id` is `ON DELETE RESTRICT`, and that fact was
      restated in four modules that never import each other — the retention sweep, the purge, account
      deletion and a reset, each with its own grouping and its own paragraph explaining the same
      constraint. `nodes/remove.ts` owns the ordering as its invariant rather than as a rule four callers
      have to remember; each caller keeps only the predicate that decides what is doomed.
- [x] **The share fan-out has a seam.** Four write families each restated by hand what a write must be
      for it to travel, and the four disagreed in shape where they agreed in intent. `fanOut(c, event)` is
      the whole interface now: the write path describes what happened to one node, and the share domain
      decides whether that fans out and to whom. `nodes` stops knowing about shares. The atomicity
      contract also gained the tests it never had — only `create` had one.
- [x] **Membership state has an owner** — and this one was a defect, not a duplication. A membership's
      position in `invited → joined → finalizing → left` was spelled out in ten SQL predicates across five
      modules, and two had diverged for real: `catchup.ts`'s `sourceOf` omitted the frozen-account check
      that fan-out carries. A frozen member's replica is behind **by construction**, because propagation
      skipped it (SH-20) — so a catch-up could read from one and inherit the gap instead of closing it.
- [x] **Join and catch-up share the walk they always were.** Both order the source parents-first, find or
      create each counterpart, and bring the history behind it with the people who wrote it.
      `materialise.ts` owns that, and names the difference as a mode rather than a flag one caller passes
      to make the other behave differently: `renumber` for a join, whose head is the highest revision by
      construction — the invariant `retention.ts` reads — and `keep` for a catch-up, which absorbs a
      collision and is therefore idempotent.
- [x] **Pairing's `cancel()` has an address**, and this was the second live defect. The settings tab
      rebuilt a flow per `display()` and discarded it on the same line, so the wait could never be stopped
      and the re-entry guard went with the discarded instance: navigating away and back started a
      **second** live pairing while the first still polled. The flow is now held for the plugin's
      lifetime, and the code survives a rebuilt tab.

**None of this belonged to M5 by right.** It is here because it happened here, and the alternative —
leaving five refactors and two defect fixes unmentioned because no checklist line predicted them — makes
the record worse than the sprawl does.

## M7 — the recovery code

The last row of the loss table in [06](06-key-model.md): every other way of losing access already has an
answer, and a **forgotten passphrase** has none. It was placed last because the loss it answers is the only
one the user can prevent on their own — and with the WebDAV gateway dropped, it is what remains. The
mechanism is small: the endpoint was built to take a second proof from the day it was written.

Mechanically it is a second wrapping of the **same seed**: nothing is re-encrypted, and `recovery_key` sits
beside `wrapped_seed` exactly as `enc_privkey` sits beside both. The columns and their paired `CHECK` have
been in the schema since M3.5.

**Walked by a person on 2026-08-21, against the home server on 0.5.0.** A code made in one vault's settings,
then that code typed into a second vault: the account came back, and — the assertion that matters — **the
passphrase it had been living under no longer opens it.** That is the half no local check can see, because it
is about the server having moved `wrapped_seed` and `kek_verifier_hash` *together*: written apart, both
columns are individually valid and the account answers recovery with an envelope its accepted proof cannot
open. A suite can assert the pair; only a walk proves the account a person is holding is the one that moved.

**It found three defects, and none of them were in the mechanism.** The cryptography and the endpoints did
what they were written to do; the screen did not know what it had just done. Its row was rendered once from
the server's answer at page load — so after making a code the line still said the account had none, and the
button still believed it was creating one. A second press would have taken the *creating* path: no
confirmation, and the code just written down replaced in silence. The third was naming: two buttons a
paragraph apart both said "Recover", and only one of them is for somebody who still has the passphrase.

The pattern holds, then, for the sixth time: **what a suite cannot see is the screen's idea of the state it
is in.** Every one of these lived inside a `PluginSettingTab`, which cannot be constructed outside Obsidian —
the same gap that produced four of M2's five defects and the reason the coordinators exist at all.

- [x] **Generate, show once, store the hash.** A high-entropy code produced on the client, `recovery_key =
      seal(code, seed)` and `recovery_code_hash` sent up through `PUT /auth/recovery-code`. The code itself
      never reaches the server, and is shown exactly once — there is no second viewing, because a code the
      server could show again would be a code the server could use. `GET` on the same path answers a
      **boolean**, which is the most a screen may ask.
- [x] **The second proof at `/auth/recover`.** The endpoint's shape does not change: one endpoint, two
      proofs, each returning only the envelope its own proof opens. The same generic refusal (#73) and the
      same attempt limit cover it, so a code cannot be used to distinguish an account from a stranger either.
      This half was built with M3.5 and had no way to acquire a code until now.
- [x] **Regenerate**, which is another wrapping of the same seed and therefore cheap — and which
      **invalidates the previous code**, since the whole risk of this feature is a slip of paper from three
      years ago that still opens the account. It is the same endpoint: there is no way to hold two, and the
      answer says `replaced` so the screen can say the old one has stopped working.
- [x] **A screen that says what it is for**, because the value of this depends entirely on where the user
      puts it. It shows the code and offers to copy it, and it says the one thing that is not obvious: a copy
      kept inside this vault survives forgetting the passphrase and does not survive losing the device.
- [x] **Redeeming it** (#34) — the client half of `/auth/recover` with a code instead of a passphrase, as a
      fourth route on the connect screen. It **sets a passphrase on the way through**, because somebody
      arriving with a code has none and an account left under the forgotten one would be openable by its code
      alone from then on. That took the one endpoint this milestone did not plan for — `PUT /auth/passphrase`,
      writing `wrapped_seed` and `kek_verifier_hash` as a pair — which is the write half of #138.

**Offered, never forced.** It is an action in the settings and not a step of registration. A code demanded
during sign-up lands in the same password manager as the passphrase, where it is a second key to the same
door: all of the cost, none of the protection. It pays only when it lives in a different medium — printed
and in a drawer, in a safe, with a family member — and that is a choice the product can explain and must not
make on somebody's behalf.

**It survives a passphrase change** by construction, since the seed does not change: what a new passphrase
re-derives is `wrapped_seed` and `kek_verifier`, and neither is what a code opens. That is a convenience and
a hazard in one sentence, which is why regeneration exists beside it.

### The scenario that decides it

The passphrase is gone — not the devices, the *passphrase*, which no backup anywhere holds. With the code
alone, on a machine with nothing on it, the account and every vault the server still holds come back. And
with neither the code nor the phrase, nothing does: there is no escrow and no administrator in either path,
which is the same sentence M3.5 already had to say out loud.

## M1 — the scope of the first complete release

- **M0.5** is a one-way prototype. The plugin sees the vault, uploads changes, and applies delta to an
  **empty** vault. It proves the protocol is alive; conflicts cannot occur in it by construction.
- **M1** is two-way synchronisation on a real vault. This is its boundary.

One desktop client, one account, one vault, E2EE, no WebSocket, no mobile, no sharing. Inside it, however,
everything that would otherwise have to be rebuilt later: id-keyed nodes, the journal, `versions` from the
first write, `user_blobs`, and the `base_sha256` precondition.

### Acceptance scenarios

Each is run end to end. A ☑ means the scenario is covered by a test that runs against a **real server**
(`npm run test:live`), not that the surrounding milestone is finished; ◐ means partly, with what is
missing named in the row.

| Scenario | What it proves |
|---|---|
| **adoption of a non-empty vault** ☑ | matching by path, equal hashes transfer nothing, differing ones produce a conflict file |
| renaming a file and a folder ☑ | `move`, `ancestry`, history survived. A file moves as one node; a renamed FOLDER moves as one folder node too — every child reappearing with identical content under one new parent collapses to a single folder `move`, and the empty source folder does not linger. Rename on one device + edit on another lands as a move plus an edit on the same node — no duplicate, no conflict. A child edited during the move still falls back to per-file, as docs/04's conservative heuristic intends |
| deletion and restore from the trash ☑ | soft delete, grouping, ancestor chain, `409` on a taken name (server-side, `history.test.ts`). Deletion propagates end-to-end: a delete on one device is pushed, another device removes its copy without resurrecting it, and the deleted file can be restored from the trash through the client (`history` protocol surface) — a new write with an old hash (docs/04). The plugin's trash **UI** is M4; the mechanism is proven |
| a conflict between two clients ☑ | the content precondition, the conflict file, and **no** spurious conflict on rename + edit — rename and edit are now recognised TOGETHER by node id (the third case the hash heuristic could not do alone) |
| an interruption between `POST /blobs` and the node write ☑ | `refs_pending`, TTL, retry without duplication — the server mechanism is covered (`collector.test.ts`), and the client's retry is proven live: a node write that dies after the blob upload is reported, and the next sync succeeds creating exactly one node, not two |
| a full rescan ☑ | changes made outside Obsidian, rename detection by hash — every sync is a full scan by construction (there is no watcher), and rename detection is covered live |
| resync after journal TTL ◐ | the client presents its stored cursor and resyncs on `410`, taking the snapshot as the new cursor — covered for all four reasons (`continuous`, `restore`, `reset`, `journal_ttl`) in `engine-delete.test.ts`, and the **`410 reset` path is proven live end-to-end** (a reset on one device resyncs the other, quarantining its displaced work). A live `journal_ttl` still needs the journal to age 90 days, which the suite cannot wait for |

The last two are the most expensive to implement and the most valuable: they are what catches the bugs
that never appear on the happy path.

## M2 — what "mobile" means

The other three pieces of M2 are things that either work or do not. "Mobile" is a word, and a word cannot
be ticked, so this is what it stands for.

Most of what [02](02-architecture.md) demands of a phone is already structural rather than pending: the
bundle carries no Node API and no native dependency (the crypto is pure TypeScript for exactly this
reason), `manifest.json` sets `isDesktopOnly: false`, the device registers under its own platform, and iOS
having no background execution is already written into the protocol — a change notification only shortens
the wait while the app is open ([04](04-sync-protocol.md)).

The status-bar rule ([02](02-architecture.md)) was the one this list got wrong. Commands satisfied "never
alone" and the row was counted as met — then a phone showed **nothing at all** until the user went hunting
for one. A state you have to ask for is not a status. The **ribbon** carries it now, and it is also where
the one action this plugin performs finally has a button.

What is left is memory, and one thing that cannot be automated. Two copies of a file is now the peak in
both directions, which is the floor for this format.

| Scenario | What it proves |
|---|---|
| **a large attachment is pulled without three copies of it in memory** ☑ | Sealing has cost two copies of a file since the blob became one allocation; a pull cost three, because the vault adapter copied again on the way to `writeBinary`, which takes an `ArrayBuffer` that a `Uint8Array` is not. Both boundaries into Obsidian now lend the buffer when the view covers exactly all of it — which a sealed or a decrypted blob does — and copy only a view into something larger. That exception is load-bearing rather than defensive: a resumable upload's parts are `subarray`s of one blob, and lending there would send the whole file as every part |
| **the size ceiling is a written number** ☑ | [01](01-context.md) now carries both: the server's hard 2 GB on one blob, which the code already enforced while the document said there was no cap at all, and the device ceiling that no server can know — reckon on a file costing twice its size in memory, which on a phone puts it at tens of megabytes rather than hundreds. The second is stated and deliberately not enforced as a number: the budget depends on the device, and a fixed figure would refuse files that work on one phone while still failing on another |
| **one real pass on a phone** ☑ | Run on an Android phone against the home server, and it is the only row here no suite could have produced: the tests drive a Node transport, which proves the protocol and says nothing about a Capacitor WebView. The pass was install, **pair** (the phone is a second device, so it had to receive the seed sealed to an ephemeral key rather than log in), adopt, sync both ways, and a real conflict — the same file edited on both, neither version lost, the loser kept beside the winner. It found four defects that every green suite had missed: a status a phone never showed, a sync with no button, a pairing code hashed in two different forms, and a server deployed eight commits behind the client that depended on it |

Going below two copies means a **framed** blob format — a nonce and a tag per frame — which is the same
decision as giving a wrapped value a version byte ([06](06-key-model.md)): both ask whether the AEAD stays
one pass over a whole value. Neither is M2's to make. M2's job is to stop paying a third copy and to say
out loud what the second one costs.

## State of the specification

Closed in full. The documentation is ready for implementation; from here the design changes in response to
code, not to reading.

| Artefact | State |
|---|---|
| `db/schema.sql` | applies cleanly on PostgreSQL 18.4 |
| `db/tests.sql` | mostly negative tests; run ends in `ROLLBACK` |
