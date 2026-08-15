# 08 — Backup and restore

How to copy and restore the server so that recovery does not cost more than the failure did.

The subject is cross-cutting on purpose: it concerns two stores, the garbage collector, the delta cursor
and client behaviour at once. Split across those documents, the mistakes would sit on the seams.

## What is backed up

| What | Where | Without it |
|---|---|---|
| metadata | PostgreSQL | the whole tree, rights, history, accounting |
| content | blob store (filesystem or S3) | the files themselves |
| configuration | compose file, environment, TLS | access and startup |

**There are no encryption keys in the backup** — they were never on the server (E2EE always, AC-08). That is both a
strength and a limit: an administrator cannot recover the data of a user who forgot their passphrase. Nobody
can. A user who still remembers it needs no administrator — recovery ([07](07-onboarding.md)) returns the
account to a device that holds nothing at all.

## One state, not two copies

> **Writes are frozen for the duration of the backup.** Both legs are taken inside the freeze, and only
> then are writes released.

Ordering the legs is not enough, and taking blobs first is the **dangerous** order. The invariant it leans
on is true ("a blob is uploaded before the node that references it") and does not say what it appears to
say: it constrains the order of two events, not their position relative to the blob snapshot. A file created
between the snapshot and the dump has its blob uploaded *after* the snapshot, so the dump references a blob
the copy does not hold. Every file created inside the backup window is exactly that case.

The failure is silent in the worst way: the restore completes, the tree is intact, the file is in it — and
it cannot be opened. Nobody finds out at restore time. Someone opens an old note months later.

A freeze removes the question. Both legs then describe the same instant, and the order between them stops
mattering. `backup_runs` records the window (`writes_frozen_at`, `writes_thawed_at`) alongside both legs,
and `CHECK`s reject a run with a leg outside it — because an operator who dumps outside the freeze "just
this once" produces a copy that restores cleanly and is missing files, and nothing about the run would
otherwise say so.

> **If a freeze is genuinely impossible, take the database first and the blobs second.** Then the blob copy
> is a *superset* of what the dump references. Surplus blobs are harmless — the collector removes them —
> and dangling references are not. Written down because this is the fallback an operator will improvise
> under pressure, and the intuitive order is the wrong one.

The PostgreSQL snapshot must be **transactionally consistent** (`pg_dump`, or a volume snapshot with
fsync); otherwise the invariant "node, journal and version are written together" breaks. The freeze does
not replace this: it makes the two *stores* agree, not the tables inside one of them.

The garbage collector must not run inside the window either, and it is not enough to schedule it elsewhere
and hope: it runs on an interval from process start, so "elsewhere" drifts. **It takes a session-scoped
advisory lock under key `0x53594E43` for the duration of a pass, and skips the pass when it cannot get
it.** So the backup takes the same lock, in one psql session held open across the whole window:

```sql
SELECT pg_advisory_lock(1398362179);   -- 0x53594E43; blocks until a pass in progress finishes
-- take the dump and copy the blobs here
SELECT pg_advisory_unlock(1398362179);
```

The blocking form matters: it waits for a pass already running, so the window is clean from the moment the
lock is granted rather than from the moment it was asked for. The same lock is what keeps two server
processes against one database from collecting at once.

> The quarantine (7 days) would cover an overlap if a run drifted, and eventually will. **It does not exist
> yet** — M0 removes an unreferenced blob on the pass that finds it, so the lock is the whole protection,
> not a second line of it.

## A restore sends the server back in time

This is the hard part, and it is not about the data — it is about the clients.

```mermaid
flowchart TD
    R["Server restored<br/>from yesterday's copy"] --> E["restore_epoch += 1"]
    E --> C["A client arrives with<br/>a cursor from another epoch"]
    C --> G["410 reason=restore"]
    G --> S["Full resync,<br/>WITHOUT applying deletions"]
    S --> U["Local files missing on the server<br/>are uploaded as new"]

    classDef default fill:#3b4252,stroke:#7b88a1,color:#eceff4;
    classDef accent fill:#3b5a82,stroke:#88c0d0,color:#eceff4;
    classDef warn fill:#5c4a1f,stroke:#d8b45a,color:#eceff4;
    classDef ok fill:#2f5a4f,stroke:#8fbcbb,color:#eceff4;
    class E accent;
    class G warn;
    class U ok;
```

**Without an epoch the outcome is worse than "nothing arrives".** After a restore `head_rev` is lower than
the cursors clients already hold, so the same revision numbers are **reused for different content**. The
client believes it is current and diverges from the server permanently, silently.

So `server_meta.restore_epoch` is raised on every restore and travels inside the opaque cursor. A cursor
from a foreign epoch gets `410` and a full resync — the same machinery as an expired journal, with one
extra field.

**Raised, not incremented.** The epoch in the restored database is whatever it was when the copy was taken,
which may be several restores behind. `+ 1` on that value can produce an epoch the server has already
issued cursors under: those cursors then look current again, and every reason the epoch exists evaporates.
The rule is `max(state file, restored database) + 1`. The trigger only guarantees the number never goes
*down* — it cannot know that a legal-looking increase is a repeat.

There are two epochs: this one (server-wide), and `vaults.reset_epoch` (per vault) for the "my client is the source of truth" reset
(see [07](07-onboarding.md)). Distinguishing them is mandatory, because the required client behaviour is
opposite. **Both may only increase**, enforced by a trigger: a lowered epoch makes stale cursors look
current again, disabling the protection exactly when it is needed most.

> **A resync after a `restore_epoch` change does not apply deletions.** The client will see that the server lacks
> files it holds locally. The naive reading — "missing on the server means deleted remotely" — would wipe
> fresh work **on every device at once**, precisely when the user is already recovering from a failure.
>
> The rule: after a `restore_epoch` change, local files absent from the server are treated as **new local
> files** and uploaded. Whatever really was deleted before the failure, the user deletes once more —
> cheaper than the alternative.
>
> The rule is about `restore_epoch` **only**. A `vaults.reset_epoch` change is the opposite instruction and
> the resync that follows it *does* apply deletions (#79) — that is the entire reason there are two
> counters rather than one. Never state this as "after an epoch change": that phrasing is what merges the
> two back into one.

## Backup depth and the collector

Restoring a dump older than the GC quarantine yields references to blobs the collector has already removed.
Two ways out, and the choice is deliberate — read both as describing the quarantine once it exists; until
then the effective quarantine is zero and every restore should expect the report below:

- keep the quarantine longer than the backup retention — simple, but a quarantine measured in months means
  deleted space is not reclaimed for months;
- **keep the quarantine short and verify integrity during the restore**, producing a list of lost blobs.
  Chosen: an honest report of "13 files not restored" beats a store that never frees space.

## What backups do not replace

- **Version history is not a backup.** It lives in the same database: corruption or a mistaken `DROP`
  takes the files and their history together. The presence of `versions` creates a false sense of safety,
  which is worth remembering separately.
- **A single user cannot be restored.** Blobs are shared, and `refcount` and `user_blobs` are computed
  across the whole database. The granularity is **the whole server**; a partial restore is a manual
  operation with reference reconciliation, not a supported scenario.
- **Clients need no backup.** The vault is ordinary files on disk; a lost local plugin state is rebuilt by
  a full rescan.

## Procedure

**Backup — nightly, before the GC window:**

1. freeze writes, record `writes_frozen_at`;
2. snapshot the blob store;
3. `pg_dump`;
4. release writes, record `writes_thawed_at`;
5. copy the configuration;
6. write an operations log entry: time, sizes, checksums.

Steps 2 and 3 are interchangeable — that is the point of the freeze. Steps 1 and 4 are not optional, and
a run that records neither is not a usable copy no matter what its status column says.

**Restore:**

1. stop the service — never restore under load;
2. restore blobs, then the database;
3. **raise `restore_epoch` above every epoch that has ever been handed out.** Not `+ 1`: the restored
   database brings back an *old* epoch with it, and a blind increment can land on a value clients have
   already seen — cursors from that generation would pass validation and the protection would be off
   precisely when it is needed. The new value is
   `max(state file, restored database) + 1`, where the state file is the copy the server keeps outside
   every dump (#92) and which therefore still holds the newest epoch the server ever ran with;
4. run the integrity check and collect the list of lost blobs;
5. start the service; clients will resync on their own;
6. tell the users — not because it is required, but because they will see a long synchronisation and should
   know why.

## Verification

> **A backup that has never been restored is not a backup.**

Quarterly: restore into a separate instance and run the check —

- every `nodes.sha256` is present in the blob store;
- **every `versions.sha256` as well**;
- every blob either has a reference or is marked for collection;
- `head_rev` is not lower than the maximum journal revision, for every vault;
- every node carrying a share mark belongs to a live participant of that share, and the folder each share
  names carries that share's root item — the replication invariants, which a restore can break silently;
- `user_blobs` counters match a recount.

> **A check that skips `versions` misses exactly the loss a backup is for.** History is a separate,
> long-lived log with its own retention ([03](03-data-model.md)): a blob can be present for a node's
> current version and gone for an older one. A restore then passes verification with a damaged history, and
> it surfaces at the worst possible moment — when someone opens the version list precisely because they
> lost the current file.

The same check is the tool for the nightly reconciliation and for post-incident diagnosis. Write it once.
