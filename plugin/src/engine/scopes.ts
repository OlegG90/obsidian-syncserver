/**
 * Which key scope a node is named under.
 *
 * A one-line rule with one exception, and the exception is the most ordinary thing a
 * participant does. "Inherit the parent's scope" is right everywhere inside a private vault
 * and inside the body of a share — and wrong for a node created **directly in the shared
 * folder**, because a share root keeps its own label under `KV` (SH-01): it sits among the
 * initiator's private siblings, where no participant could read a `KS` name and none needs
 * to. Inheriting there hands `KV` to a node the schema requires to be under `KS`, and the
 * write is refused as a `check_violation`.
 *
 * So the **share** decides, not the parent. The pairing of share to scope cannot be read off
 * the tree for exactly the reason above, and comes from what the server reports when the
 * vault is opened.
 *
 * The same rule is stated by the schema's trigger, by `preparationGaps` on the server, and
 * here. This is the one place the client says it.
 */

/** Only what the decision reads about the folder a node is going into. */
export interface ParentScope {
  /** The scope the parent itself is named under — `KV` for a share root (SH-01). */
  nameKeyId: string | null;
  /** The share the parent belongs to, if any. */
  shareId?: string | null;
}

/**
 * @param parent the destination folder, or `undefined` for the vault root.
 * @param shareScopes share id → the scope its interior is named under.
 */
export const contentScopeFor = (
  parent: ParentScope | undefined,
  shareScopes: ReadonlyMap<string, string>,
  vaultScopeId: string,
): string => {
  if (!parent) return vaultScopeId;

  // Inside a share, including directly under its root: the share's key, never the parent's
  // label. Falling back to the parent's scope keeps a share whose pairing the server did
  // not report working exactly as it did before — wrongly at the root, correctly below it —
  // rather than naming everything under the vault key, which would be wrong everywhere.
  if (parent.shareId) return shareScopes.get(parent.shareId) ?? parent.nameKeyId ?? vaultScopeId;

  return parent.nameKeyId ?? vaultScopeId;
};
