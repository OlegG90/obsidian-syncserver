# Domain terms

Words this codebase uses with a narrower meaning than English gives them. One entry per term,
added when a name is chosen rather than after the fact.

`docs/` remains the design record and the place rules live; this file only pins vocabulary, so
that two modules naming the same thing use the same word.

## VaultScopes

*(plugin)* The scopes of **one opened vault**, as one value: the vault key `KV`, the id of the
vault's own key scope, the share keys this device could unwrap, and the ids of the ones it
could not.

It answers exactly one question — *which key opens this name* — in two forms whose difference
is the failure, carried by the return type rather than by an argument:

- **strict**, for a caller about to write a name, an hmac or a wrapped content key, where a
  missing key means a wrong value written rather than a step not taken;
- **lenient**, for a caller that can carry on without one: list the row anyway, skip the
  subtree, sync the rest of the vault.

**A seam asks for the methods it uses, not for the class**: `Pick<VaultScopes, 'keyFor'>`,
`Pick<VaultScopes, 'readName'>`. Narrow enough that a caller supplies nothing it does not use
and a test can satisfy it without opening a vault, and still anchored to the type, so the seam
names this term and renaming a method fails **at the seam** rather than only at whoever passes
a real value. A hand-written `{ keyFor }` is not unsafe — that caller still stops compiling —
but the error lands on the wrong file, and a seam whose every caller is a fake stops being
checked at all. It is used only where an import cycle forbids the import, with a note saying so
at that site.

It can only come from opening a vault, which is what makes "one vault, opened once per
operation" a type instead of a habit — and that guarantee belongs to the caller that opens one.
Below that point the provenance is already established, which is why a mapping function asks
for a method rather than for proof somebody else has already given. It is deliberately **not** cached across operations: a
share can end between two syncs, and a key kept from before would be offered for a scope
nothing is named under any more.

**Not** the rule about which scope a node's content *belongs* to — that is placement, it lives
in `engine/scopes.ts`, and the two were kept apart on purpose.

## BoundVault

*(plugin)* **One vault, opened once, with everything bound to it for the length of one operation.**

Every act against the server needs the same four things: the session's client, the vault id, that vault's
[VaultScopes](#vaultscopes), and a `SyncEngine` built from all three. Seven call sites used to assemble
them by hand, and nine read the vault id out of `data.connection` directly.

The rule that made the assembly correct — *one opening per operation, shared by everything in it* — lived
in a docblock. An operation that opened twice would hold two `VaultScopes` for one vault, and the second
could disagree with the first about which share keys arrived: the exact failure `VaultScopes` exists to
prevent **within** one opening. `withVault` hands the value out, so there is no assembly left to get
wrong.

**It is not `OpenedVault`, and the near-miss is why it is named at all.** `shared` has carried
`OpenedVault` since the beginning for what `GET /vaults/:id` returns — root, head, key scopes — and a
`BoundVault` *contains* one of those, as `scopes.opened`. The first name given to this value was
`OpenedVault` too, which put two types with identical names and different shapes in one plugin; **bound**
is what this one adds beyond the opening.

**`runPass` deliberately does not use it.** A pass runs on a session that is already open and must never
be the thing that asks for the passphrase; `withVault` goes through `unlocked()`, which would put a
prompt in the middle of a background sync.

## SessionHold

*(plugin)* **What this device is holding an account by, and the four ways that changes.**

`BoundVault` is one opening of one vault. This is its longer-lived twin: one device's grip on one
account, which outlives every opening and is what a restart finds waiting.

| act | when | what moves |
| --- | --- | --- |
| **take** | a session opened here for the first time — connecting, recovering, pairing | connection written, sync ledger **emptied** so adoption runs |
| **resume** | a connection already written down becomes a session again — a restart, or moving to another server | connection written, ledger untouched |
| **keep** | the connection changed under a live session: a passphrase change re-wraps the seed | connection only |
| **release** | the device lets go | both erased |

**The rule it holds is that the connection and the ledger move together.** It used to be a sentence
in a comment, and the six lines enforcing it were re-typed at three sites while a private method
containing exactly those lines sat between them, used by two others — the shape #303 was, where a
device holding one device's identity and another's account of what it has synced looks healthy and
writes conflict files for ever. `checks/check-connection-writes.mjs` refuses an assignment to
`data.connection` anywhere but here.

It does **not** own the session: `this.sess` is read in seventeen places, and a module owning the
field would be a middle man for all of them. It owns the transition, and the ordering is part of it —
the session is held before the socket asks for its token, and the file is saved before any surface
says `idle`.

## AccountAsks

*(plugin)* **What a screen may ask of the account, as opposed to the vault** — and which of two ways
in each ask needs.

Ten operations: the account's vaults, its devices, its recovery code, its passphrase, approving
another device. They were ten one-line methods on the plugin, and the forwarding was never their
content. The content is a rule that differed per operation and lived only in the prose above it:

- **seeded** — needs the seed, so it unlocks and **may ask for the passphrase**;
- **handled** — a borrowed handle is enough, and asking for a passphrase to read a row would be a
  question with no reason behind it.

The two are wrappers, so an operation cannot be written without choosing one. A table of routes
beside the definitions was considered and rejected: it is a second description of the same thing, and
it drifts the first time an eleventh operation is added and the second edit forgotten.

**None of them takes the one-at-a-time gate**, and that is one fact rather than ten — none touches
what a sync touches (#131). The gate belongs to the flows that move a vault's contents.

**The other half of the distinction is [BoundVault](#boundvault)**, deliberately: that value is one
vault *opened*, and everything here works without opening any vault at all. `changeServerUrl` and
`disconnect` are **not** here either — they change what this plugin *is* rather than asking the
account anything, and they touch the push connection, the badges and the phase.

The unlock, the borrow and the keeping of a replaced envelope arrive as functions, so the module
holds no state and no keys — which is what lets a test assert the route by counting calls.

## Situation / Decision

*(plugin)* **What one local file's position looks like, and what a pass should therefore do about it.**

A **Situation** is everything a pass knows about one path at the moment it reaches it: what this device
measured on disk, what it recorded last time, what the walked tree holds there, plus the three lookups a
choice can consult — the tree by node id, the dedup index, and the paths that vanished. Nothing in it is
mutated.

A **Decision** is one of ten answers: `nothing`, `refresh-hint`, `pull`, `push-edit`, `adopt`,
`conflict`, `remote-rename`, `remove-local`, `push-move`, `push-new`.

The pair exists because a pass does two jobs and only one of them needs a server. Choosing what a
situation means is arithmetic over values; carrying it out reads files, seals bytes and writes state.
They were one method, so every branch could only be reached by building a world that led to it — and
two defects used that cover to ship (#295, #296), both of them a wrong branch rather than wrong work.

**Deciding does not consume.** A `push-move` names its source; removing that source from the vanished
map, so a second file with the same bytes cannot claim it, is the caller's act. `rename.ts` makes the
same separation one level down, for the same reason: a decision that mutates its input cannot be asked
the same question twice.

## SharedFolderMarks

*(plugin)* The mapping from each live share to the path of its folder **in this vault**, plus
the badge in the file tree that says so. A share *is* the folder its root node resolves to —
the server names the root but holds no paths, and only the client can turn a node id into a
path, because only it can read a name.

One module (`shared-folder-marks.ts`) owns the map, the reconcile guard that decides when the
expensive node→path resolution is due, and the badge decision; Obsidian, the server and the
session are ports bound in `main.ts`. The guard compares `share_id:root_node_id` pairs, not
ids alone — a re-materialised share keeps its id but changes its root, and the badge has to
follow.

## quiet period

*(plugin)* The stillness a vault has to show before a sync starts on its own. Measured from the last
change **event**, not the last keystroke — Obsidian saves a note about two seconds after typing stops,
and that save is the event — so the word names an interval of *no events*, not of no typing.

Not an interval and not a debounce per path: one period for the whole vault, so a burst is one pass.
`local-changes.ts` owns it; the rule it serves is in [docs/04](docs/04-sync-protocol.md).

## skip hint

*(plugin)* The `mtime` and `size` recorded beside a path's hash, and the whole of what lets a pass
decide it need not read that file. **Hint** is the load-bearing word: content can change under an
unmoved timestamp, so this is evidence a pass may act on and never a fact it may rely on — when being
right matters more than being quick, the file is read regardless.

When that is, and where a hint may come from, are rules and live in
[docs/04](docs/04-sync-protocol.md).

## walked tree

*(plugin)* The server's nodes turned into **paths** — what one pass produces and the next may reuse. The
server holds no paths at all, so this exists only after a client has decrypted every name on the way
down, which makes it a function of two things: the nodes, and **which key scopes this device can open**.
A subtree whose scope will not open is not in it; it is in the `unreadable` list beside it.

Both halves are why a remembered one is keyed on a cursor *and* a scope fingerprint: node changes travel
in the journal and the cursor covers them, while share membership travels as events and does not. The
rules are in [docs/04](docs/04-sync-protocol.md); its lifetime, being plaintext, is in
[docs/06](docs/06-key-model.md).

## verification

*(server)* **The one claim this server makes about a backup — and nothing runs it that nobody asked for.**

A verification reopens one copy and confirms that every blob the database references is present in it.
It says the copy **arrived** — not that the archive can be read, which is a different claim and one
nothing here checks automatically. `backup_runs.verified_at` records it. Two things run the check, and
both are tails of an act somebody asked for: the console's **Verify** button, and each backup's own
pass over the copy it just wrote — taken **after** the row settles and the window shuts, because a walk
over a copy that can no longer change has no reason to keep writes refused (#225).

**Nothing about a backup happens on a schedule.** Taking one, verifying one and restoring from one are
all acts somebody asks for. A server that took backups nightly, verified them nightly and loaded them
weekly was doing three things nobody had asked it to do that day, and the settings for all three were
questions an operator had to answer before they had a reason to.
