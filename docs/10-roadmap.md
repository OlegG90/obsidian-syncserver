# 10 — Roadmap

| Milestone | Scope | Done |
|---|---|---|
| **M0** | database schema (including `versions`), blob store, authentication, `delta`/`put`/`delete`; verified with curl, no plugin. Ships as a **Docker image** deployed to the home server for testing — see [13](13-deployment.md) | ☑ |
| **M0.5** | plugin, **one-way** sync: local changes reach the server, delta is only ever applied to an empty vault | ☑ |
| **M1** | **two-way** sync of one vault: adoption of a non-empty vault, conflict files, rescan, resync after journal TTL — scope below | ☑ |
| **M2** | WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | ☑ |
| **M3** | **folder sharing** by replication: create/invite/decline/withdraw/join/revoke/leave, the membership list, synchronous fan-out to at most 8 participants, history transfer on join, over-quota freeze | ☑ |
| **M3.5** | **getting back in, and getting out**: recovery with the passphrase, an editable server address, disconnect, and the thaw M3 left open — scope below | ☐ |
| **M4** | **space, and the history already on disk**: the nightly mark and sweep, emptying the trash, the administrative API with its audit trail, and the history/trash UI — scope below | ☐ |
| **M5** | **the operator's milestone**: the management console (both zones), backup operations, and an image that is pulled rather than built on the server — see [11](11-management-console.md), [08](08-backup-restore.md), and the scope below | ☐ |
| **M6** | WebDAV gateway | ☐ |
| **M7** | the **recovery code**: the second proof to an endpoint that already takes two, answering the one loss nothing else does — a forgotten passphrase. Scope below | ☐ |

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
- [ ] **Something a frozen account can actually delete.** Thawing has a trigger only if usage can fall,
      and today it can fall two ways: a vault reset, and deleting a whole vault. An ordinary delete is
      **soft** — the row is the trash entry — so it frees nothing, and there is no purge. SH-20 says
      "deleting is the only way out"; until the trash can be emptied that sentence is not true, and the
      exit that recovery-by-deletion promises is a vault reset. It is **the first item of M4** and the
      reason that milestone leads with the purge; naming it here so the gap is not discovered by somebody
      stuck behind it. This box is what keeps M3.5 open, and it closes there rather than here.

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

- [ ] **A purge, so SH-20 stops being a sentence with nothing behind it.** Deleting is soft — the row *is*
      the trash entry — so today it frees nothing, and a frozen account's only exit is a vault reset. The
      statement that **lowers** a claim belongs in `holdings.ts`, beside the two that raise one; a per-blob
      decrement lived unreachable in `nodes/service.ts` for months, which read as evidence that releasing
      was already wired. This is the item M3.5 is still open on, and the reason it is first here.
- [ ] **Emptying is a write like any other**, so it obeys what writes obey: inside a share it propagates
      (SH-10 gave every participant their own row, and every one of them their own decision), and a frozen
      account may still do it — a freeze that blocked the only way out is a deadlock.

### The nightly mark and sweep

[03](03-data-model.md) specifies seven steps; `collector.ts` implements the TTL sweeps and says so in its
own header. The rest is this milestone, and its traps are already written down — they become tests, not
comments:

- [ ] **Thinning by the retention ladder**, which needs the column it has never had: [11](11-management-console.md)
      offers the user a retention setting and the schema holds nothing to set. The policy itself
      (all under 7 days, one a day to 30, one a week to a year, and the live head always) is in [03](03-data-model.md).
- [ ] **Node rows removed bottom-up**, ordered by ancestry length descending, because `parent_id` is
      `ON DELETE RESTRICT` — an orphaned branch is worse than a failed delete.
- [ ] **`user_blobs` recomputed from scratch** and reconciled against the accumulated counters. A live
      counter drifts under concurrent writes, and an error towards zero is data loss.
- [ ] **Mark, quarantine, and look again.** A blob's only reference may be a live `refs_pending` row, and a
      blob bound on day three must not be swept on day seven. Both halves are the rule, not an optimisation.
- [ ] **`blob_keys` is never collected on its own.** Tidying up the envelopes of a dissolved share would cut
      detached ex-members off from folders that are now their own.

### The administrative API, and the trail it leaves

The console is M5; the surface underneath it is here, because account deletion and quota changes are server
behaviour that a web client merely calls.

- [ ] **An administrator role that the routes actually check.** There is no `requireAdmin` today.
- [ ] **Users, invitations, quotas, storage.** List with state, quota, usage and last seen; invite, disable,
      enable, re-quota. Lowering a quota below usage deletes nothing — the account freezes (SH-20) — and the
      API says which accounts a change would freeze **before** it is applied.
- [ ] **Every administrative act is audited.** `audit_log` exists, is append-only by trigger, and is written
      from exactly two places in `auth/service.ts`. An action on somebody else's account that leaves no
      record is the one kind this table was built to refuse.
- [ ] **Deletion is a state, not a button** (#55): dissolve the shares the account initiated, wait for each
      participant to finalize their copy (SH-29), reassign authorship to the **tombstone**, then remove the
      vaults. `versions.author_id` is `NOT NULL` with `ON DELETE RESTRICT`, so authorship must go somewhere
      — and the reserved row it goes to is described by the schema and seeded by nobody. Disable and delete
      are different operations and must not share a control.

### History and the trash, where the notes are

- [ ] **The trash and the version list in the plugin.** The server surface has existed since M0 — the
      versions of a node, the trash of a vault, and restore as a new write with an old hash — and no screen
      has ever called it. Restoring into a taken name is `409` with the blocking node id, and stays that
      way: a file silently named "Note (1).md" is a file the user cannot account for.
- [ ] **Usage the user can act on**, broken into current content and history. A number without the action
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

## M5 — the operator's milestone

Everything the person running the server does that is not synchronising a note. Two halves are
specified elsewhere and are not restated here: the console is [11](11-management-console.md), and backup
operations are [08](08-backup-restore.md) plus the `backup_runs` table that has held their constraints
since M0 and is written by nothing.

The third half is specified nowhere, because it has never been a feature — it has been a procedure in
[13](13-deployment.md).

### The image is pulled, not built on the server

Today `docker compose build` runs **on the target**, which is why the deployment copies an archive of the
source at all. That has three costs, and only one of them is convenience:

- **the platform trap is permanent.** [13](13-deployment.md) opens with it and the `Dockerfile` repeats
  it: an image built on an ARM machine dies on an x86-64 server with an exec format error that explains
  nothing. Building on the target is the current answer, and it is an answer that costs a build;
- **the build happens on the weakest machine involved**, using its memory and its disk;
- **the source has to be there to build from**, so a server that only ever runs the thing holds the
  whole build context.

- [ ] **Publish the image from CI to a registry**, on a version tag rather than on every push to `main`
      — one image per released version, matching the single version across five manifests (#111), and
      tagged by commit as well so a running container can be traced to a build. The runners are x86-64,
      which is the platform the trap is about.
- [ ] **`docker compose pull` replaces `docker compose build`** in the procedure, with the image
      pinned to a version. `latest` is not used: a server updated a few times a year must be able to
      say what it is running, and to go back.
- [ ] **`pack.sh` shrinks to what compose actually reads** — the compose file, `.env` and
      `db/schema.sql`, which the database container mounts to initialise itself. The copy does not
      disappear, and the roadmap should not pretend it does; it stops being a copy of the source.
- [ ] **The registry choice is a public one**, so no credential lives on the server. The image holds a
      built server and its dependencies — the same code the repository already publishes — and no
      secret: `.env` is excluded from the build context, and neither `POSTGRES_PASSWORD` nor
      `SERVER_SECRET` has a default to leak.

**Not a private registry, unless something changes.** A private image needs a token stored on the server
to pull it, which is a credential added to a machine in exchange for hiding source that is already public.
If the repository ever stops being public, this decision comes back with it.

## M7 — the recovery code

The last row of the loss table in [06](06-key-model.md): every other way of losing access already has an
answer, and a **forgotten passphrase** has none. It is placed after M6 rather than earlier because the loss
it answers is the only one the user can prevent on their own, and because the mechanism is small enough that
its position in the queue costs nothing to change — the endpoint was built to take a second proof from the
day it was written.

Mechanically it is a second wrapping of the **same seed**: nothing is re-encrypted, and `recovery_key` sits
beside `wrapped_seed` exactly as `enc_privkey` sits beside both. The columns and their paired `CHECK` have
been in the schema since M3.5.

- [ ] **Generate, show once, store the hash.** A high-entropy code produced on the client, `recovery_key =
      seal(code, seed)` and `recovery_code_hash` sent up. The code itself never reaches the server, and is
      shown exactly once — there is no second viewing, because a code the server could show again would be
      a code the server could use.
- [ ] **The second proof at `/auth/recover`.** The endpoint's shape does not change: one endpoint, two
      proofs, each returning only the envelope its own proof opens. The same generic refusal (#73) and the
      same attempt limit cover it, so a code cannot be used to distinguish an account from a stranger either.
- [ ] **Regenerate**, which is another wrapping of the same seed and therefore cheap — and which
      **invalidates the previous code**, since the whole risk of this feature is a slip of paper from three
      years ago that still opens the account.
- [ ] **A screen that says what it is for**, because the value of this depends entirely on where the user
      puts it.

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
