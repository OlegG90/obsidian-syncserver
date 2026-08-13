# 10 — Roadmap

| Milestone | Scope | Done |
|---|---|---|
| **M0** | database schema (including `versions`), blob store, authentication, `delta`/`put`/`delete`; verified with curl, no plugin. Ships as a **Docker image** deployed to the home server for testing — see [13](13-deployment.md) | ☑ |
| **M0.5** | plugin, **one-way** sync: local changes reach the server, delta is only ever applied to an empty vault | ☑ |
| **M1** | **two-way** sync of one vault: adoption of a non-empty vault, conflict files, rescan, resync after journal TTL — scope below | ☑ |
| **M2** | WebSocket push, resumable upload, mobile, `.obsidian/` exclusions | ☐ |
| **M3** | **folder sharing** by replication: create/invite/decline/withdraw/join/revoke/leave, the membership list, synchronous fan-out to at most 8 participants, history transfer on join, over-quota freeze | ☐ |
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

**Three of M2's four pieces have landed**: the `.obsidian/` switch with its per-device exceptions
([01](01-context.md)), resumable upload ([04](04-sync-protocol.md)) — `PUT`/`GET`/`complete` on parts, with
the part size doubling as the threshold above which a client uses them at all — and WebSocket push
([04](04-sync-protocol.md), Change notifications): a journal-insert notification delivered on commit, fanned
out over `WS /events` to the account's devices, so a change wakes a connected client instead of waiting for
the button. **Mobile is what remains**, and it was a word rather than a criterion until the section below
gave it three — two about memory, one that no suite can run.

Estimate: M1 is two to three weeks of evenings. Re-estimate M2 and beyond only after M1; until then the
numbers are guesses.

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
the wait while the app is open ([04](04-sync-protocol.md)). The status-bar rule is met the way it had to be:
**sync, status and lock are commands**, and the status bar carries the same state without being the only
place it lives.

What is left is memory, and one thing that cannot be automated. Two copies of a file is now the peak in
both directions, which is the floor for this format.

| Scenario | What it proves |
|---|---|
| **a large attachment is pulled without three copies of it in memory** ☑ | Sealing has cost two copies of a file since the blob became one allocation; a pull cost three, because the vault adapter copied again on the way to `writeBinary`, which takes an `ArrayBuffer` that a `Uint8Array` is not. Both boundaries into Obsidian now lend the buffer when the view covers exactly all of it — which a sealed or a decrypted blob does — and copy only a view into something larger. That exception is load-bearing rather than defensive: a resumable upload's parts are `subarray`s of one blob, and lending there would send the whole file as every part |
| **the size ceiling is a written number** ☑ | [01](01-context.md) now carries both: the server's hard 2 GB on one blob, which the code already enforced while the document said there was no cap at all, and the device ceiling that no server can know — reckon on a file costing twice its size in memory, which on a phone puts it at tens of megabytes rather than hundreds. The second is stated and deliberately not enforced as a number: the budget depends on the device, and a fixed figure would refuse files that work on one phone while still failing on another |
| **one real pass on a phone** ☐ | Install the bundle, adopt a vault, sync both ways, watch a conflict resolve. No suite will ever run this: the tests exercise a Node transport against a real server, which proves the protocol and says nothing about a Capacitor WebView. This is the scenario that decides whether M2 is done |

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
