# 12 — Sharing scenarios

The conditions the sharing module satisfies: concrete situations, and the one outcome each of them has. Not
a design document — [05](05-sharing.md) is that. This file states *what happens*; 05 states *how*, and both
describe one contract.

Every condition carries an id that tests and code cite. Ids are stable and never reused; gaps in the
numbering are ids that no longer name a condition.

Read "their own vault" throughout as **the vault the participant accepted the invitation in** (AC-Q4).
Quota is per account (AC-Q2) and each vault has its own key (AC-11).

## SH-01 · The initiator carries the primary data

A share is opened by one user — the **initiator** — over a folder of one of their own vaults. That folder
stays exactly where it was and keeps being ordinary content of that vault. Sharing adds participants; it
does not move or re-parent anything the initiator already had. Interior names are re-keyed to the share key
(SH-28).

## SH-02 · Every participant holds a full current copy

Each participant's copy is **ordinary nodes in their own vault**, not a view of someone else's. Every
participant who has the folder locally converges on the **latest current state**.

There is no partial mode: a participant either has the folder or is not a participant. Three consequences
follow directly, and they are the point of the model — a participant's cursor is their own vault revision,
the server never serves one user's node to another, and "is this file in the share" is never an
authorisation question at read time.

## SH-03 · Everyone pays for it

The bytes count against **every participant's account** quota, the initiator included. Deduplication applies
**within one key scope**: content already held under the same share scope is not charged twice, while a copy
in a private vault or in another vault uses another scope and is charged again (AC-09).

Because each participant's copy is their own nodes, this needs no separate accounting — it is the ordinary
own-content quota.

## SH-05 · A participant leaves on their own

Any participant may withdraw themselves at any time. Their copy **stays and becomes ordinary content of the
vault it lives in**. For the initiator, withdrawing is the same act as dissolving the share (SH-17); for
everyone else it is the only right they hold over their membership (SH-18).

Withdrawal cannot fail and cannot be partial: the nodes were already theirs, so there is nothing to transfer
and no quota to re-check. It does require the client-side metadata pass of SH-29 before the membership
closes.

The **files** stay; the history of those files does not — see SH-22.

## SH-07 · The last participant to leave ends the share

When the last **joined** participant other than the initiator **leaves**, the share ends and everything
becomes the initiator's own content — the same outcome as SH-05, arrived at from the other side, history
included (SH-25).

**The trigger is a departure, not a head count.** This distinction is the whole rule, because a share is
legitimately down to one member at several moments in its life and must survive all of them:

| Moment | Members | The share |
|---|---|---|
| created, `preparing` | the initiator alone | **lives** — nobody has left; `preparing` exists precisely so the folder can be readied before anyone is invited |
| activated, invitation sent, no answer yet | initiator + an outstanding invitation | **lives**, and would live at one member too |
| the invitee declines, or the initiator withdraws it | the initiator alone again | **lives** — a decline is not a departure (SH-16); the initiator may invite somebody else |
| someone joined, then left or was revoked | the initiator alone | **ends** — this, and only this, is what SH-07 names |

Read as a count instead, the rule would remove every share in the instant it was created, and let one
person's refusal destroy a folder somebody else had prepared.

A share nobody ever joined therefore lives until the initiator ends it. That is not free — its interior
names stay under `KS` (SH-28) — but ending is an explicit act, and it is the act that translates them back
to `KV`. Automatic cleanup would spend someone's preparation on someone else's silence.

## SH-08 · Re-sharing starts from scratch

Sharing the same folder again creates a **new** share with no reference of any kind to the previous one — no
history, no member list, no identity. It starts from whatever the initiator holds at that moment.

Consequence: a former participant who kept their copy and is invited again receives a second, independent
copy. Reconciling the two is theirs to do; the server does not attempt to match them.

## SH-10 · There is no read-only participant

Every participant has **write rights, from the invitation onwards and for the whole lifetime of the share**.
There is no `ro` role, no `rw` role, and no mode on the share — the concept does not exist rather than
defaulting to something.

The reason it does not exist: Obsidian has no read-only state, so the plugin would have to emulate one —
intercept writes, revert files from the server version, save the rejected text outside the folder, and
explain a disappearing edit to the user. Several invariants that only hold together, for a role nobody on a
family server needs.

Accepted consequence, stated plainly: **any participant can delete anything in the shared folder for
everyone.** The protection against that is history (SH-12) and the fact that this is a server for people who
already trust each other — not permissions.

## SH-11 · At most 8 participants, propagated synchronously

A share holds **at most 8 participants**, the initiator included. One write therefore becomes at most 8 node
writes and 8 journal rows, and that fan-out happens **inside the write transaction** — no queue, no eventual
convergence, no state where one replica is behind because a background job has not run.

**An outstanding invitation occupies a slot.** The ceiling counts live membership rows, and a row exists from
the moment somebody is invited, not from the moment they accept — otherwise nine people could accept an
eighth place at once. The consequence is worth knowing before it surprises anyone: an initiator with seven
unanswered invitations is at the ceiling with one person actually in the folder, and has to withdraw one
(SH-16) before inviting anybody else.

The number is a design limit, not a tuning knob: it is what keeps synchronous fan-out honest. A share that
needs 30 people is a different product and should be refused rather than degraded.

## SH-12 · A share keeps history, and attributes it

Files in a shared folder **do** have version history, and each version records **which account wrote it**.
That is the primary reason it exists here: in a folder where everyone may write (SH-10), "who changed this"
is the question that will actually be asked.

Attribution is the requirement; the retention policy is the ordinary one. How the attribution reaches the
other copies is SH-19.

## SH-15 · History from before a file entered the share is private

A share's history begins **when the file enters the share**. Whatever the file had before that stays with
whoever owned it, is never transferred, and is never visible to anyone else. Participants see only what
happens from then on.

> **The rule is about the file, not about the initiator.** Phrased as a horizon it applies to everyone, and
> there are two ordinary cases where someone other than the initiator hits it:
>
> - a participant who left with their copy (SH-05) and is invited to a new share of the same folder (SH-08)
>   arrives carrying their own history;
> - anyone who moves a file from elsewhere in their vault into the shared folder brings that file's past
>   with it.
>
> In both, the same answer: the past stays private, the share starts from now.

This needs no filtering to implement. Each participant's copy is their own nodes, so a joiner's replica
receives the retained versions from the file's entry into the share and accrues from there. Versions before
that entry remain only on the prior holder's nodes.

## SH-16 · The initiator owns the share

The initiator, and **only** the initiator, may:

- invite a participant;
- revoke a participant's access.

An **outstanding invitation** is the one case with nothing to keep: whether the invitee declines it or the
initiator withdraws it, the membership row is deleted outright and the slot is free again. No copy was ever
materialised, so there is nothing to finalize.

A revoked participant who had **joined** keeps their copy as ordinary content of their vault, exactly as if
they had left on their own. Revocation and withdrawal differ in who pressed the button, not in what the person ends up
holding: the nodes were already theirs, so there is nothing to take back and the operation cannot fail. It
also cannot recall data — anyone who was a participant has a full copy by SH-02, and that is a property of
the model, not an oversight.

## SH-17 · The initiator's departure ends the share

If the initiator withdraws, the share ends for everyone. Each participant keeps their copy as their own
content (SH-05). "The initiator leaves" and "the share is dissolved" are therefore the same operation, with
one outcome.

## SH-18 · Participants hold no rights over the share

A participant may do exactly one thing to their membership: **leave** (SH-05). They may not invite anyone,
may not re-share the folder or any part of it, and may not remove another participant.

The re-share ban is worth stating explicitly because it is the first question anyone asks about a folder
they can write to: a share can only be created over content the initiator owns in their own vault, and the
schema ties it that way.

## SH-19 · Authorship travels with the change

When a participant writes, every other participant's copy records a version **authored by them** — not by
the account whose client happened to apply the incoming change. "Who changed this" has the same answer in
all eight vaults.

Only the author field crosses the boundary. Replicas do not merge histories: each participant still holds
their own version rows on their own nodes, and what travels is the identity stamped on them. The server
takes that identity from the authenticated request, so attribution never needs to read content.

Three consequences, all of them costs, stated here so they are not rediscovered:

- **A foreign user id lives in every participant's history.** This is what makes deleting an account a
  procedure rather than a query (#55, `ON DELETE RESTRICT` on `versions.author_id`), and the anonymisation
  pass has to walk up to eight vaults.
- **Authorship survives the author's departure.** A revoked or withdrawn participant's name stays on the
  versions they wrote in everyone else's copies. Scrubbing it on exit would make attribution worthless
  precisely when it is most likely to be consulted.
- **Everyone sees who did what, permanently.** That is the point, but it is also a disclosure: participants
  cannot edit anonymously, and leaving does not erase the record.
- **The name behind an id is the client's to remember.** What travels is `author_id`; the server offers no
  id-to-login lookup, because one would let any leaked id enumerate the server's users. Clients cache the
  names they meet in the membership list ([04](04-sync-protocol.md)), so a device that never saw the person
  shows the id rather than a guess.

## SH-20 · Hitting the quota freezes the whole account

When usage reaches the account limit — whether because a share grew or because anything else the account
holds grew — **the account freezes**. The quota is per account (AC-Q2), so the freeze covers **every vault
it owns and every share it participates in**, at once. It is a formal rule and nothing more: nothing that
grows usage may be sent to the server, while pulling from the server keeps working.

- nothing that grows usage may be written, in any of that account's vaults: no new node, no new content for
  an existing one;
- their replicas stop moving in either direction — incoming changes are not applied, their own writes into
  a shared folder do not propagate;
- **reading, downloading and deleting stay available.** Deleting has to: it is the only way out, so a freeze
  that blocked it would be a deadlock;
- **everyone else is unaffected** and keeps working.

Freeing space — or being given a larger limit — lifts the freeze and the copy catches up (SH-21). Nothing
about the freeze is visible to the other participants as a change in the folder. The price of the mechanism
is that unfreezing is a catch-up from an arbitrary point in the past.

Two consequences worth stating before they surprise someone:

- **Freezing frees nothing.** The frozen copy still counts against the limit. And since leaving keeps the
  copy (SH-05), leaving frees nothing either — so the only way out of over-quota is **deleting something**,
  either inside the folder or elsewhere in the vault. "Leave to free space" is two separate acts: leave,
  then delete what became yours.
- **A frozen participant can still edit the folder locally**, because SH-10 removed read-only enforcement
  and Obsidian has no such state to begin with. The server refuses those writes, and they resolve as
  **ordinary conflicts** when the copy catches up. Making the client enforce read-only would rebuild exactly
  the machinery SH-10 avoids, for a state that is rarer and more temporary.

## SH-21 · Unfreezing pulls the current state *and* the history of the gap

When the limit is raised or space is freed, the frozen copy catches up to the **current state and receives
the version history for the whole frozen interval** — not merely the latest snapshot. A freeze leaves no hole
in the record: once it lifts, that participant can see what changed while they were away and who changed it
(SH-19).

What this requires, and it is worth knowing before it is built:

- **Catch-up is not a re-copy.** Handing over the current files would be far simpler and is explicitly not
  what happens; the version rows for the interval come across too, authorship intact.
- **The source is another replica's history, not the delta journal.** `journal` is a 90-day transport
  buffer; `versions` lives by the retention policy. So a freeze that outlasts the journal TTL still catches
  up correctly — only the cheap delta path expires, and the catch-up falls back to walking the folder plus
  the version rows for the interval. The freeze has no expiry date of its own.
- **Retention still applies.** A six-month freeze yields the history that was **kept**, thinned by the
  ordinary policy — the frozen participant ends up with what everyone else has, not with more.
- **It presumes a stable correspondence between the same file's node in different replicas.** Propagation
  needs that mapping regardless — one write has to find its counterpart in eight vaults — but the catch-up
  is where it becomes visible, because version rows have to be attached to the right node in a vault that
  never saw them.

## SH-22 · Leaving zeroes the leaver's history

An **added participant** who leaves — by their own choice (SH-05), by being revoked (SH-16), or because the
share ended (SH-17, SH-07) — keeps **the files and nothing else**. The versions accrued while they were a
member are gone from their copy. History starts again from that moment, as it does for any folder they
created themselves.

The initiator is the exception, and for a reason that is not about rank: SH-25.

Two things this is **not**:

- **Not an erasure from the share.** Their authored versions stay in every other participant's copy (SH-19).
  "Who changed this" keeps answering their name after they are gone; what they lose is their own view of it.
- **Not permanent.** If the share still exists and they are invited back, they receive each file's retained
  history from its entry horizon again (SH-23) — including the part they made and the part that happened
  while they were away.

> **This costs an implementation.** The versions accrued while a member are already rows on the leaver's own
> nodes, so discarding them is an explicit act, not the default. If nobody writes that code, the rule
> silently becomes its opposite.

## SH-23 · A joiner receives each file's history from its entry horizon

Someone invited on day 300 receives the history of the shared files **from the moment each file entered the
share**, not from the day they joined. The horizon belongs to the file (SH-15), never to the participant's
arrival; once inside, everyone sees the same record.

Said as "from the day the share began" this reads as one date for everything, which is wrong for anything
added later: a file that arrived on day 200 has no history before day 200 to give. The two rules are one rule
seen twice — **per file, from when it entered** — and joining moves neither of them; it changes only who may
look.

Mechanically this is SH-21 with a different interval: the same operation that hands a thawed participant the
versions from their frozen gap hands a joiner the versions from each file's entry horizon. There is one
mechanism, used twice.

Two costs, both bounded:

- **Joining transfers version rows, potentially years of them.** Retention thinning caps that — a joiner
  receives what was kept, not every save ever made.
- **A new participant learns who did what long before they arrived**, including people who have since left.
  That follows from SH-19 and is the same disclosure, seen from the other end.

## SH-24 · A share cannot change hands

The initiator is the initiator for the life of the share. There is no transfer of ownership, no
co-initiator, and no succession.

Accepted consequence: the initiator is a **permanent single point of failure** for the share. If they
withdraw, lose interest, or have their account deleted — which dissolves their shares as part of the
deletion procedure — the share ends and every participant is left with files and no history (SH-22). The
remedy is to start a new share (SH-08), which begins from scratch by definition.

## SH-25 · The initiator's copy keeps the share's history

When a share ends, the versions written during it — **including those authored by participants** — stay on
the initiator's files as ordinary history. Nothing is zeroed for them. For everyone else SH-22 stands: files
without versions.

**The rule is not "the initiator is privileged". It is that history follows one continuous custody of the
file.** The initiator held that file before the share, throughout it, and after it — one unbroken life, so
one unbroken record. An added participant's custody begins when they join and ends when they leave, and it
can begin again later as a **separate** custody: membership is repeatable. Stitching those intervals into a
single history would assert a continuity that never existed, and gaps in a version list are worse than no
version list.

This also draws the line SH-23 needs: **visibility and retention are different things.** While you are in
the share you see each file's record back to that file's entry, regardless of when you arrived. What you
*keep* on leaving depends on whether your custody of the file survives the share. For the initiator it does;
for anyone else it does not.

Two consequences to build for:

- **The initiator ends up holding versions authored by people no longer connected to them** — possibly years
  later, in a folder that is now private. That is SH-19 continuing past the share's life, and it is
  intended: the record of who wrote what is the reason history is kept at all.
- **Account anonymisation has to cover former shares, not just live ones.** When an account is deleted, its
  id survives in the histories of every vault it ever contributed to, including initiators of shares that
  ended long ago. The pass cannot be scoped to current membership.

## SH-26 · A resource is in the share or it is not

Three statements, and together they mean there is no link closure in the system:

1. **The share is exactly its folder.** A file is inside it or outside it; there is no third category and no
   way for the share to reach beyond its own boundary. This is enforced, not assumed:
   `nodes_share_membership_is_real` checks the mark **both ways** (#105) — a node inside a shared folder must
   itself be marked, and a descendant probe refuses a subtree that was marked without its contents. A single
   unmarked node inside a replica would be invisible to propagation and swept in by a reset (SH-27), which is
   why the schema's share fixtures use a dedicated, fully-marked folder.
2. **Everything in the share was put there by a person, deliberately.** Nothing is pulled in by inference.
3. **A link pointing outside the share is left alone.** The embed will be broken for participants, and that
   is the correct outcome, not a defect. Keeping links resolvable is a convention between the people sharing
   the folder — where to keep attachments — not something the system negotiates.

Two properties worth naming, because they will otherwise be rediscovered as surprises:

- **The server never parses Markdown — with no exception.** Nothing in the share model depends on knowing
  what a note links to.
- **A participant cannot widen what anyone sees.** There is no operation that pulls something from outside
  the folder into view, so a member cannot act as an exfiltration channel.

The rule is the same for every kind of file: a broken wikilink out of the folder is correct behaviour
whether it points at a note, an image or an attachment.

> Two client-side niceties exist as **conveniences, not contracts** — neither requires the server to
> understand a link, and neither is load-bearing:
>
> - the plugin may **count and report** outward links when a share is created — "7 links point outside this
>   folder" — so the convention gets a chance to be applied before anyone is invited;
> - the plugin may keep placing attachments created inside the shared folder **inside it**, overriding
>   Obsidian's global attachment location.

## SH-27 · A reset never touches a replica

The "my client is the source of truth" reset acts on the user's **own nodes outside any share** and on
nothing else. Every node carrying a share mark is excluded — the folders they joined, and the folder they
opened themselves.

A replica **is** their own nodes, in their own vault, so a reset that mass-deleted "everything of mine" would
sweep the replicas in, and each of those deletions would propagate (SH-11): one person reinstalling Obsidian
and choosing "my client wins" would empty the shared folders of up to seven other people.

Two consequences:

- **a reset never refuses because the user owns an active share.** That folder is excluded like any other
  share, so the reset proceeds and leaves it alone;
- **the exclusion belongs to the reset operation.** Its hard-delete selects only `share_id IS NULL`, and must
  also keep the ancestor chain each retained replica hangs from ([07](07-onboarding.md)); ordinary in-share
  deletion is a different, soft-delete operation. A row constraint cannot establish that predicate over the
  reset's whole set, so the reset implementation enforces it before deleting.

## SH-28 · A writable share names every active copy under its share key

An added participant may create and rename files, but never holds the initiator's private `KV`. Therefore the
strict descendants of every **active** shared root carry `name_enc`, `name_hmac` and `name_key_id` under that
share's `KS`. The root label stays local under each vault's `KV`: it sits beside private siblings and does not
propagate.

Creating a share starts a `preparing` pass: it adds `KS` content-key envelopes and dedup tags, then translates
existing **interior** names from `KV` to `KS`. The pass blocks invite and join, not writes; a new or renamed
interior node must already use `KS`. Activation verifies that no `KV`-named interior node remains. When a copy
becomes private, the inverse metadata pass adds missing `KV` envelopes and tags and translates its interior
names back. Content bytes and `KC` keys never move.

## SH-29 · Leaving first stops propagation, then the affected client finalizes its copy

The server can revoke a participant or accept a leave request immediately, but it cannot turn that replica
private: it does not hold the participant's `KV` or plaintext names. The first step records
`finalization_started_at`, which stops propagation for that member. Their client later supplies KV envelopes,
KV dedup tags and `KS → KV` interior names; the server validates and atomically clears replica marks before
writing `left_at`.

An offline revoked device may finalize later, but receives no new share changes while pending. This is not a
partial share outcome: other participants continue normally, and the affected replica is atomic on its own.
An initiator ending a share starts the same finalization for every participant. A `preparing` share has no
added copies yet and is cancelled instead; an active share may only end after all finalizations have started
or completed.
