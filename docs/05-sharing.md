# 05 — Sharing

The feature the project exists for: opening **one folder** of one vault to other users of the same server.

This document describes *how sharing works*. The conditions it implements — situation by situation, with ids
that tests cite — are in [12 — Sharing scenarios](12-sharing-scenarios.md). The two are one contract seen
from two sides: 12 states the outcome, 05 states the machinery. If they disagree, one of them is a bug —
fix both.

## Saying that a folder is shared

A shared folder is an ordinary folder that behaves differently: a note dropped into it
reaches other people, and leaving it is an operation with consequences. Nothing about it
looks different, and a person deciding where to put a note is not going to open a settings
screen first — so the client marks it **in the file tree**, where the decision is made.

The mark is the client's alone. The server cannot help: it holds no paths, and the names it
holds are ciphertext. What it can say is **which node** is the share's root in *this*
member's vault — a different node for each of them (SH-01, and a participant's replica root
is their own) — and `GET /shares` reports it. The client resolves that to a path with the
same tree it resolves everything else with, and remembers it, because the file tree is drawn
long before anything is unlocked. The remembered path is re-resolved whenever the share list
changes or the stored path is gone from disk — the rename case, where nothing on the server
moved but the badge would otherwise stay stuck on a folder that no longer exists.

## Who is in it, and taking somebody out

The member list is shown to **everybody in the share**, not only its initiator. "Who can read
this folder" is the question a shared folder raises, and a participant who cannot answer it is
being asked to trust a list they never see.

Removing is the initiator's, and it is one call whose meaning depends on the other person's
state: an invitation that was never answered is **withdrawn**, and somebody who joined is
**revoked**. The server decides which and says so, because the client cannot — and the two
outcomes are different sentences. A withdrawal took back something nobody received. A revoke
leaves a person holding a copy they keep (SH-05) and a finalization pass they owe; it is not a
punishment and must not read like one. Revoking the last participant ends the share for
everybody (SH-07), which is a third thing again, and the one the initiator most needs told —
they now owe that pass themselves.

Somebody already finalizing cannot be removed: they are on their way out, and the departure
they are running is the same one a revoke would ask for.

## The model: replication

**Every participant holds their own copy of the shared folder, as ordinary nodes in the vault they accepted
the invitation in** (SH-02, AC-Q4). Not a view of someone else's tree, not a mount, not a projection. A write by anyone is propagated
into every participant's vault, so what each of them syncs is always and only their own content.

Because a participant only ever reads their own nodes, there is no projection log, no cursor stitched from
several journals, no path column, no ACL at read time and no detach protocol. What replication costs
instead:

| Cost | Size |
|---|---|
| Node rows are multiplied by the number of participants | metadata only — blobs stay deduplicated, so bytes are not copied |
| One write fans out to up to 8 vaults, synchronously | bounded by SH-11; this is why the ceiling is a design limit and not a setting |
| Conflicts are N-way rather than two-way | same mechanism as ordinary sync — content precondition, conflict file |

### Corresponding nodes

Propagation has to find the same file in eight different vaults, and node ids are per-vault. Each node that
belongs to a replica therefore carries the share it belongs to and a **share-scoped item id** that is the
same across every copy. A write to one node resolves to the others through that pair.

The item id is what makes the two history operations possible at all (SH-21, SH-23): version rows have to
be attached to the right node in a vault that has never seen them.

## Rights

Conventional, and deliberately small (SH-16, SH-18, SH-24):

| | Initiator | Participant |
|---|---|---|
| Write in the folder | yes | **yes** |
| Invite | yes | no |
| Revoke someone | yes | no |
| Re-share the folder or part of it | — | no |
| Leave | yes — and it ends the share | yes |
| Hand the share to someone else | **nobody can** | no |

**There is no read-only participant** (SH-10). No roles, no share mode, no downgrade path. Obsidian has no
read-only state, so any such role would have to be emulated in the plugin — intercept the write, revert the
file from the server version, save the rejected text somewhere, explain the disappearance — and that is not
built.

The accepted consequence is stated rather than mitigated: **any participant can delete anything in the
folder, for everyone.** What protects against it is history (SH-12) and the fact that this is a server for
people who already trust each other.

**Nobody can hand a share over** (SH-24). The initiator is a permanent single point of failure: if they
leave, lose interest, or have their account deleted, the share ends and everyone keeps files without
history. The remedy is a new share, which by SH-08 starts from nothing.

## Propagation

A write inside a shared folder — put, delete or move — is applied by one server command/transaction to the
writer's own node and to corresponding nodes in the **live non-frozen** participant set: `joined_at` is set,
`finalization_started_at` and `left_at` are unset, and the member's account is not frozen (SH-11, SH-20).
Each is an ordinary node
write in that vault: it bumps **that vault's** `head_rev`, appends to **that vault's** journal (AC-12), and
appends a version row.

There is no queue and no eventual convergence among that set. Either every eligible replica advanced or none
did. This is a service/API transaction contract, not a database-trigger guarantee; an integration test must
prove rollback when any replica write fails. Frozen replicas catch up separately on thaw.

A `move` cannot enter or leave a shared folder: it returns `409 share_boundary`. The client copy/puts the
item with destination-scope envelopes and tags, then deletes the source; the put is atomic with its metadata.

The 8-participant ceiling exists to keep that honest. A share that needs thirty people is a different
product and is refused rather than degraded.

### Conflicts

Two participants editing the same file is the ordinary conflict case, arriving from more than one
direction. The precondition is the same as everywhere else — the writer states the content they edited
(`base_sha256`), and a write whose base no longer matches is rejected. The client resolves it the way it
resolves any conflict: the server's version becomes the file, the local one becomes a conflict file.

A conflict file is an ordinary new file inside the shared folder, so it propagates like anything else and
everyone sees that there was a disagreement. That is intended.

CRDT stays out of scope. It solves two people typing in one note at the same second, which is not what a
shared folder of notes is for.

## History

A shared folder **has** version history, and every version records **which account wrote it** (SH-12). In a
folder where everyone may write, "who changed this" is the question that will be asked, so attribution is
the reason history is here at all.

**Authorship crosses replicas; version rows do not** (SH-19). When Bob writes, every other participant's
copy records a version authored by Bob — not by whoever's client applied the incoming change. Each
participant still holds their own rows on their own nodes; what travels is the identity stamped on them.
The server takes it from the authenticated request; attribution never needs to read content.

### Where a history starts and stops

Two rules, and together they are one idea.

**History from before a file entered the share is private** (SH-15). Whatever the file had before stays
with whoever held it, is never transferred, and is never visible to anyone else. This is phrased about the
file rather than about the initiator on purpose — a participant re-invited after leaving with a copy, and
anyone who moves a file in from elsewhere in their vault, hit exactly the same rule.

**What you keep on leaving depends on whether your custody of the file survives the share** (SH-22, SH-25):

- an **added participant** leaves with the files and nothing else. Their versions are gone from their copy;
- the **initiator** keeps everything. The versions written during the share — including those authored by
  participants — become ordinary history of their own files.

The distinction is not rank. The initiator held that file before the share, throughout, and after: one
unbroken custody, so one unbroken record. A participant's custody begins at joining and ends at leaving,
and **membership is repeatable** — stitching those intervals into a single history would assert a
continuity that never existed, and gaps in a version list are worse than no version list.

Note what this does *not* mean: a leaver's authorship stays in everyone else's history. "Who changed this"
keeps answering their name after they are gone. What they lose is their own view of it, and if they are
invited back while the share still exists, they receive the whole record again.

### Visibility is not retention

Someone invited on day 300 receives each shared file's retained history **from that file's entry into the
share**, not from the day they joined (SH-23). While you are inside, you see that per-file record; what you
keep on the way out is the separate question above.

Mechanically this is one operation used twice: the same catch-up that hands a thawed participant the
versions from their frozen gap hands a joiner the versions from each file's entry horizon.

Two bounded costs: joining transfers version rows, capped by retention thinning — a joiner gets what was
kept, not every save ever made; and a new participant learns who did what long before they arrived,
including people who have since left.

## Quota

**Everyone pays** (SH-03). The bytes count against every participant's **account** quota, initiator included.
Deduplication applies only within one key scope: an identical blob already held under the same share scope is
not charged twice, while a private-vault copy or a copy in another vault uses another scope and is charged again.

This needs no special accounting. Each participant's copy is their own nodes, so it is the ordinary
own-content quota — there is no share contribution to synchronise, lazily or otherwise.

### Over quota freezes the whole account

Reaching the limit — from the share growing or from anything else the account holds growing — **freezes the
account** (SH-20). The quota is per account (AC-Q2), so the freeze is too: every vault it owns and every
share it is in, at once.

- nothing that grows usage may be sent, in any of that account's vaults;
- incoming changes stop being applied to their replicas, and their writes stop propagating outward;
- reading, downloading and **deleting** stay available — deleting is the way out;
- **everyone else is unaffected**.

Freeing space or raising the limit lifts it. The price of the mechanism is that unfreezing is a catch-up
from an arbitrary point in the past.

Two consequences worth knowing before they are met:

- **Freezing frees nothing.** The frozen copy still counts, and leaving keeps the copy too (SH-05), so the
  only way out of over-quota is deleting something. "Leave to free space" is two acts: leave, then delete
  what became yours.
- **A frozen participant can still edit locally**, because there is no read-only state to enforce (SH-10)
  and Obsidian has none to offer. The server refuses those writes; they are resolved as ordinary conflicts
  when the copy catches up.

### Thawing restores the gap

Catching up delivers the **current state and the version history of the whole frozen interval** (SH-21) —
not merely the latest snapshot. A freeze leaves no hole in the record.

The history comes from another replica's `versions`, which lives by the retention policy, not from
`journal`, which is a 90-day transport buffer. So a freeze that outlasts the journal TTL still catches up
correctly: only the cheap delta path expires and the catch-up falls back to walking the folder plus the
version rows for the interval. **The freeze has no expiry of its own.**

## Resources: in the folder or not at all

Three statements, and together they remove a subsystem (SH-26):

1. **The share is exactly its folder.** Inside or outside; there is no third category and no way for a
   share to reach past its own boundary.
2. **Everything inside was put there by a person, deliberately.** Nothing is pulled in by inference.
3. **A link pointing outside is left alone.** The embed is broken for participants, and that is correct
   behaviour. Keeping links resolvable is a convention between the people sharing the folder — where to
   keep attachments — not something the system negotiates.

There is no link closure: no resource manifest, no virtual shared-assets folder, no `strict` / `closure`
policy, no per-share copy of a resource's name. Two properties follow, and both are the point:

- **The server never parses Markdown, with no exception.** Nothing in the share model depends on knowing
  what a note links to.
- **A participant cannot widen what anyone sees.** A write can only change content inside the folder; there
  is no operation that pulls something outside it into view.

The rule is the same for every kind of file: a broken wikilink out of the folder is correct behaviour
whether it points at a note, an image or an attachment.

Two client-side conveniences exist, as conveniences and not contracts, because neither asks the server to
understand a link: the plugin may count and report outward links when a share is created, and it may keep
placing new attachments inside the shared folder rather than in the vault's global attachment location.

## Lifecycle

How each of these reaches the user — as a state to read rather than a question to answer — is
[02](02-architecture.md).

```
create        the initiator opens a folder of one of their vaults (`preparing`)
cancel        initiator only, while preparing; no participant copy exists
invite        initiator only; the invitation waits in the invitee's list until they accept it,
              in whichever vault they accept it from
decline       invitee only, before joining; the row is deleted and the slot freed
withdraw      initiator only, against an outstanding invitation; same deletion, other side
write         propagates synchronously to every live non-frozen participant
freeze/thaw   automatic on the quota boundary, per ACCOUNT — every vault and share it has
revoke        initiator only; stops propagation, then the target finalizes their private copy
leave         anyone; stops propagation, then the leaver finalizes their private copy
end           when the initiator leaves, or when the last joined participant besides them does;
              all copies finalize. A departure, never a head count — a share of one that
              nobody has left yet is alive and waiting
```

Endpoint shapes live in [04](04-sync-protocol.md).

### Creating and joining

Creating a share does not move or re-parent anything the initiator already had, but it **does** re-key the
strict descendants of its root from `KV` to the new `KS` (SH-28). The initiator's root label remains under
`KV`: it lives beside private siblings. A participant who can create a name does not know the initiator's
`KV`, so every interior shared name must use `KS`. Content bytes and their `KC` keys are not re-encrypted:
preparation adds `KS` envelopes and tags, then converts only name metadata.

The share begins in `preparing`. The initiator may continue writing; new or renamed **interior** shared nodes
must use `KS` immediately and carry their required envelope/tag material. The server refuses invite and join
until an explicit activation check verifies that all current interior nodes and reachable versions are prepared.

Joining an active share materialises a full copy in **the vault the joiner accepted in** (AC-Q4), with the
share's history from each file's entry into the share (SH-15, SH-23). It is checked against the joiner's
account quota — that is the one point where joining can be refused.

The vault is not asked for, it is observed: an Obsidian plugin instance can only reach the vault it runs in,
so accepting an invitation *is* choosing where the folder lands. Accepting the same invitation from a
different vault is not a second choice — an invitation is redeemed once ([02](02-architecture.md)).

### Ending

A share ends in exactly two ways, and both produce the same thing for everyone: files stay, the share is
gone.

- **the initiator leaves** (SH-17) — "the initiator leaves" and "the share is dissolved" are one operation;
- **the last joined participant other than the initiator leaves** (SH-07).

**Both are departures.** Neither is a head count, and the difference matters at three ordinary moments: a
share is down to one member while it is `preparing`, again after activation until somebody accepts, and
again if that person declines. It survives all three — nobody left. A share nobody ever joined lives until
the initiator ends it explicitly, and that act is what returns its interior names from `KS` to `KV`.

Every participant keeps their copy. Added participants keep files without history; the initiator keeps
everything (SH-22, SH-25).

**Re-sharing starts from scratch** (SH-08). A new share over the same folder has no reference of any kind
to the old one — no history, no member list, no identity. A former participant invited again receives a
second, independent copy; reconciling it with the one they kept is theirs to do.

### An invitation that was never accepted just disappears

Declining, and the initiator withdrawing an outstanding invitation, are the same act from two sides: the
membership row is **deleted**. There is no replica to convert, no envelope that was ever opened, and nothing
to keep — so the finalization pass below does not apply, and the freed slot counts against the ceiling of
eight again immediately.

Because the row is gone, **absence from the membership list is the whole record of a decline.** Every live
member can read that list (`GET /shares/{id}/members`), so the initiator sees who accepted, who has not
answered yet, and — by their no longer being there — who said no. Nothing is pushed at anybody; the client
compares the list with its own copy and reports the change locally ([02](02-architecture.md)).

The cost is stated rather than hidden: a decline leaves no durable trace, so an initiator who invites the
same person again months later has nothing to remind them it was already refused. That follows directly
from deleting the row, and the alternative — a permanent "declined" tombstone holding a slot or a state
column — buys less than it costs.

This is the one exception to "a membership row is evidence that finalization completed". It has to be one:
a row that never joined can carry neither `finalization_started_at` nor `left_at`, so without the exemption
an unanswered invitation would be unremovable and would occupy a slot for the life of the share.

### Leaving and ending are client-driven metadata passes

Leaving, revocation and dissolution are all the same operation seen from different sides. They do not move or
re-encrypt content bytes, and they do not re-check quota, but they are still an atomic metadata pass **run by
the affected client**: only it holds its `KV` and plaintext names. Starting finalization immediately stops
propagation; `left_at` is written only when the client supplied KV envelopes, KV tags and KS→KV names for its
whole replica and the server validated/unmarked it atomically. Added participants also lose their local version
rows; the initiator keeps theirs. A revoked offline device can finish later but receives no further changes.

Nor can any of them recall data. Anyone who was a participant holds a full copy (SH-02). That is a property
of the model, stated here so it is not mistaken for an oversight: **revocation stops the flow of new
content; it does not take back old content.**

## Encryption and the share key

Everything is E2EE (AC-08), so this is not a special mode — it always applies. Details belong to
[06](06-key-model.md); two facts belong here because they shape the flow.

**The share key is a storage scope for interior names and a transport scope for content keys.** Every strict
descendant of an active shared root carries `name_enc` and `name_hmac` under `KS`. The root itself keeps a
local `KV` name in each vault: the initiator preserves its existing label, while a joiner chooses a private
parent and label. Root labels never propagate. This keeps sibling uniqueness inside private parents while
still letting an added participant create or rename every interior file without the initiator's `KV`.

**Creating a share needs a resumable pass over the folder by the initiator's client.** It adds `KS` envelopes
and tags for blobs, then rewrites each existing **interior** node name from `KV` to `KS`. The pass is additive
for content and destructive only for replaceable name metadata. A node already under `KS` is skipped, so retry
is safe.

**`preparing` blocks invite and join, not writing** — and the schema holds both halves, not just join: a
membership row for anyone other than the initiator is refused while the share is not `active`, whether it
carries `joined_at` or is an invitation waiting for one. Until the pass finishes a joiner would receive
interior names they cannot read. A write during the pass is valid only if it uses `KS` for its new or renamed interior
nodes and adds the corresponding envelope/tag material in the same transaction. There is no plaintext
shortcut: every share goes through preparation.

The initiator is a participant from the moment the share exists, which is while it is still `preparing`, so
the "join only an active share" rule exempts them: they are not receiving a copy, they already have the
folder.

Symmetrically, every copy that becomes private adds content-key envelopes under its receiving vault key,
re-keys names from `KS` back to `KV`, and writes dedup tags — all metadata, no bytes. This includes the
initiator when the share ends: participant writes may have introduced blobs visible only through `KS`.
The envelope step is the one that matters: without it files stop opening on the next device
([06](06-key-model.md)).

## Server-side checklist

- [ ] a write inside a shared folder uses one server command/transaction for every live non-frozen participant,
      or for none; an integration test injects a replica failure and proves rollback
- [ ] a share never exceeds 8 participants, invitation included
- [ ] only the initiator may invite or revoke; a participant's only right over their membership is to leave
- [ ] a participant cannot create a share over any part of a folder they hold as a replica
- [ ] joining checks the joiner's quota, and it is the only point where joining is refused
- [ ] `preparing` permits only initiator-side preparation and shared writes under `KS`; invite and join reject
      until activation verifies names, envelopes and tags for all current nodes and versions
- [ ] `preparing` may transition only to `active` or `cancelled`; an active share may transition only to
      `ended`, and no terminal share may regain a live member
- [ ] an invitation that was declined or withdrawn is deleted, and its slot is available again; a membership
      that joined can only be removed after finalization
- [ ] the membership list is readable by every live member, shows joined members and outstanding
      invitations, and never exposes another account's freeze state
- [ ] leave/revoke/end stops propagation through `finalization_started_at`; unmarking accepts only the
      affected member's KV-complete metadata pass, then records `left_at`
- [ ] joining delivers each file's retained history from its entry into the share, not from the join
- [ ] every propagated version row carries the **original writer** as author, not the receiving user
- [ ] leaving or being revoked removes an added participant's version rows for the folder, and keeps the
      initiator's
- [ ] leaving removes nothing from anyone else's history, including the leaver's authorship
- [ ] the initiator leaving ends the share for everyone; so does the departure of the last joined
      participant besides them
- [ ] a share with one member that nobody has left — `preparing`, awaiting an answer, or after a decline —
      is **not** ended; only a departure ends a share
- [ ] crossing the quota boundary freezes exactly one account — all of its vaults and shares — and is
      invisible to everyone else
- [ ] thawing restores the current state **and** the version history of the frozen interval
- [ ] a frozen participant's local edits become ordinary conflicts on catch-up, not errors
- [ ] nothing outside the shared folder is ever part of the share, and no link is ever rewritten
- [ ] a share is rooted at a live folder of one of the initiator's own vaults
- [ ] re-sharing produces a share with no reference to any previous one
