# 10 — Roadmap

| Milestone | Scope | Done |
|---|---|---|
| **M0** | database schema (including `versions`), blob store, authentication, `delta`/`put`/`delete`; verified with curl, no plugin. Ships as a **Docker image** deployed to the home server for testing — see [13](13-deployment.md) | ☑ |
| **M0.5** | plugin, **one-way** sync: local changes reach the server, delta is only ever applied to an empty vault | ☐ |
| **M1** | **two-way** sync of one vault: adoption of a non-empty vault, conflict files, rescan, resync after journal TTL — scope below | ☐ |
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
| renaming a file and a folder | `move`, `ancestry`, history survived |
| deletion and restore from the trash | soft delete, grouping, ancestor chain, `409` on a taken name |
| a conflict between two clients ◐ | the content precondition, the conflict file, and **no** spurious conflict on rename + edit — the first two are covered; the third needs rename detection, below |
| an interruption between `POST /blobs` and the node write | `refs_pending`, TTL, retry without duplication |
| a full rescan | changes made outside Obsidian, rename detection by hash |
| resync after journal TTL | `410`, `snapshot`, the cursor after the walk |

The last two are the most expensive to implement and the most valuable: they are what catches the bugs
that never appear on the happy path.

## State of the specification

Closed in full. The documentation is ready for implementation; from here the design changes in response to
code, not to reading.

| Artefact | State |
|---|---|
| `db/schema.sql` | applies cleanly on PostgreSQL 18.4 |
| `db/tests.sql` | mostly negative tests; run ends in `ROLLBACK` |
