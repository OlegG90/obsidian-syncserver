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

It can only come from opening a vault, which is what makes "one vault, opened once per
operation" a type instead of a habit. It is deliberately **not** cached across operations: a
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
