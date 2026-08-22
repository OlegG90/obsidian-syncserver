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

## verification / rehearsal

*(server)* **Two different claims about a backup, and never one word for both.**

A **verification** reopens the newest copy and confirms that every blob the database references is
present in it. It says the copy **arrived**. Daily, and at every start; it is what the console's
**Verify** button runs, what `backup_runs.verified` records, and what `BACKUP_VERIFY_INTERVAL_SECONDS`
paces.

A **rehearsal** loads the newest dump into a scratch database and confirms that what comes out carries
this build's functions and triggers and holds at least one account. It says the archive can be **read**.
Weekly by default, paced by `REHEARSE_RESTORE_EVERY_SECONDS`, and `0` turns it off.

A `pg_dump` that will not restore — a version mismatch, a truncated file, a corrupt archive — **passes
the verification and fails the rehearsal**, which is the whole reason the second exists (#159).

Both were called *rehearsal* for a while, including in the operator manual, where the sentence "the
server rehearses on its own" described one of them and was read as the other. That is the failure D-114
reserved the word `freeze` to prevent: one word for two things makes every sentence naming it ambiguous,
and here it would mislead on the day somebody is reading the log to decide whether a backup is usable.
