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

## verification

*(server)* **The one claim this server makes about a backup, and it makes it only when asked.**

A verification reopens one copy and confirms that every blob the database references is present in it.
It says the copy **arrived** — not that the archive can be read, which is a different claim and one
nothing here checks automatically. `backup_runs.verified` records it; the console's **Verify** button is
the only thing that runs it.

**Nothing about a backup happens on a schedule.** Taking one, verifying one and restoring from one are
all acts somebody asks for. A server that took backups nightly, verified them nightly and loaded them
weekly was doing three things nobody had asked it to do that day, and the settings for all three were
questions an operator had to answer before they had a reason to.
