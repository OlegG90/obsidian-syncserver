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

*(plugin)* The stillness a vault has to show before a sync starts on its own — five seconds, in
`local-changes.ts`. It is measured from the last change **event**, not from the last keystroke, which
matters because Obsidian saves a note about two seconds after typing stops and *that save* is the event.
So the period covers a run of saves landing together rather than the typing itself, and it is what keeps
a pass from uploading a note the editor is still writing.

It is also, deliberately, the thing that keeps a pass away from a file somebody is typing into right now
(D-124), and what turns a burst — a paste of forty files, a folder rename — into one pass rather than
forty.

**Not an interval.** A timer syncs a vault nobody touched and misses the edit made a second after it
fired; a quiet period does neither.

## skip hint

*(plugin)* The `mtime` and `size` recorded beside a path's hash, and the whole of what lets a pass
decide it need not read that file (issue #237). It is a **hint**: content can change under an unmoved
timestamp — a restore from a backup, `mv -p`, another sync tool — so a pass that must be right reads
anyway. Two things make it read: an epoch whose policy prefers the local copy, and a person asking for a
**Full rescan**.

Every hint comes from the vault. For a file the client itself wrote — a pulled node, a conflict copy, a
renamed file — it asks (`stat`) afterwards rather than recording what it intended, because the editor
stamps what it writes and an invented number is one `list()` will never report back.

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
