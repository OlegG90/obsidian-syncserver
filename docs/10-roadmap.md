# 10 — Roadmap

| Milestone | Scope | Done |
|---|---|---|
| **M0** | database schema (including `versions`), blob store, authentication, `delta`/`put`/`delete`; verified with curl, no plugin. Ships as a **Docker image** deployed to the home server for testing — see [13](13-deployment.md) | ☑ |
| **M0.5** | plugin, **one-way** sync: local changes reach the server, delta is only ever applied to an empty vault | ☑ |
| **M1** | **two-way** sync of one vault: adoption of a non-empty vault, conflict files, rescan, resync after journal TTL — scope below | ☑ |
| **M2** | WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | ☑ |
| **M3** | **folder sharing** by replication: create/invite/decline/withdraw/join/revoke/leave, the membership list, synchronous fan-out to at most 8 participants, history transfer on join, over-quota freeze | ☑ |
| **M3.5** | **getting back in, and getting out**: recovery with the passphrase, an editable server address, disconnect, and the thaw M3 left open — scope below | ☐ |
| **M4** | management console (both zones, audit log, backup operations), history and trash UI, version thinning and blob GC — see [11](11-management-console.md) | ☐ |
| **M5** | WebDAV gateway | ☐ |

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

- [ ] **Schema.** `users.kek_verifier_hash`, **beside** `recovery_key` and `recovery_code_hash` rather than
      instead of them — the recovery code stays specified, and its fate is decided after M4. The two of them
      become **nullable**, which the three-shape `CHECK` on `state` and the key columns has to allow.
- [ ] **No account claims a path it does not have.** `connect()` writes a real `kek_verifier` — it already
      holds the `KEK` — and **null** where it used to write placeholder recovery values. Null means "no
      recovery code"; a fixed byte and a random hash nobody holds the preimage of mean "there is a way back"
      to every check that looks, and nothing at all on the day it is needed.
- [ ] **`POST /auth/recover`.** Anonymous, shaped like pairing's claim: verify, create the device, return
      `wrapped_seed`, `enc_privkey`, `account_salt`, `kdf_params`, `user_id`, `device_id`. An unknown login and
      a wrong phrase get the same refusal (#73).
- [ ] **An attempt limit that is real.** Per login and per source, backing off, audit-logged. The endpoint is
      the one place in the product where guessing pays, and the documents already promise a limit here and on
      `/auth/kdf` that no code currently applies — this closes both.
- [ ] **"Recover this vault" in the plugin**, beside "Join an existing account": address, login, passphrase.
      Past it nothing new is invented — the client logs in, lists vaults and enters **adoption**, which has
      existed since M1. The endpoint takes the recovery code as its second proof from the start, so building
      that half later is a client screen and a comparison, not a new shape.
- [ ] **Say it at registration.** One line, once: a forgotten passphrase loses every vault, and no
      administrator can help.

**Not in this milestone, deliberately:** generating and storing the **recovery code** itself, which answers
the other loss — a forgotten passphrase. It stays specified in [06](06-key-model.md) and [07](07-onboarding.md)
with its columns in place, and the decision on whether to build it is taken after M4. What M3.5 owes it is
only honesty: null rather than a placeholder.

### The scenario that decides it

Run end to end, against a real server, on a machine that keeps nothing:

1. connect a vault, sync it, share a folder — an ordinary, populated account;
2. **destroy the client entirely**: delete the plugin's `data.json`, then delete the vault folder itself;
3. on an empty vault, enter the address, the login and the passphrase — nothing else, and no second device
   anywhere;
4. every note comes back, with its history, and the shared folder is still shared.

Step 3 is the whole milestone. If it needs anything the user does not carry in their head, it has failed.

### The connection record — found by using it

- [ ] **The server address is editable in place** (#113). Moving from an IP to a host name changes one field;
      nothing else in the record depends on it. The instinct to "disconnect and reconnect with the new
      address" must not be catered to, because reconnecting costs a full bootstrap that the one-time
      invitation token cannot pay for twice.
- [ ] **Disconnect**, which does not exist at all today: clear the local record, revoke this device, keep
      every file and everything on the server, and say what coming back will cost **before** doing any of it.
      It ships after recovery, never before (#113).

### A shared folder that looks like any other — found by using it

- [ ] **Mark a shared folder as shared where the folder is**, not only in the plugin's settings. After the
      two-account walk both sides had a folder that behaved differently from its neighbours — writes reaching
      another person, a departure to perform — with nothing on screen to say so. A participant cannot reason
      about a boundary they cannot see.

### Carried over from M3

- [ ] **Thawing with catch-up (SH-21).** Freezing an over-quota account works and is enforced where
      propagation crosses an account boundary; the way back — releasing the freeze and delivering what was
      withheld — was specified and never built.

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
