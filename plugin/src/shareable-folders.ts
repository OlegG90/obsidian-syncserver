/**
 * Which folders this vault can actually share, so the answer is picked instead of typed.
 *
 * The share field was a text box (`Folder/path`), which made a misspelling and a genuine
 * refusal arrive as the same sentence — "the server does not know that folder yet" — with no
 * way for the person to tell which of the two had happened. A list cannot be misspelled, and
 * it removes the question rather than improving the error.
 *
 * Two rules decide what belongs in it, and both come from somewhere outside this file:
 *
 * - **synced.** A share is rooted at a node id, so a folder this device has never uploaded
 *   has nothing to root it at (`share-flow.ts`). Same predicate as the refusal it replaces.
 * - **not overlapping an existing share.** This is the schema's, not a preference:
 *   `nodes_check_share_membership` refuses a marked node whose parent is in a different share,
 *   and refuses a marked node whose child carries a different mark or none. So a folder
 *   *inside* a share cannot start one, and neither can a folder *containing* one — the second
 *   is the direction that surprises people, and offering it would produce a check violation
 *   from the trigger rather than anything a person could act on.
 */

/**
 * Does the server know anything under this folder?
 *
 * A folder node exists on the server whenever anything below it does — the tree is held by
 * `parent_id` — so containing one synced path is the same fact as being synced, and cheaper
 * to establish than looking for the folder's own key.
 */
export const holdsSynced = (folder: string, syncedPaths: readonly string[]): boolean =>
  syncedPaths.some((p) => p === folder || p.startsWith(`${folder}/`));

/** Two paths are in each other's way when they are the same folder, or one is inside the other. */
const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * The folders worth offering, in the order they read on screen.
 *
 * The vault root needs no rule of its own: nothing is `` or starts with `/`, so it never
 * holds a synced path and drops out with the unsynced folders. A filter for it would read
 * like a decision and be dead.
 *
 * `folders` is what exists in the vault, `syncedPaths` is what the server knows, and `shared`
 * is what is already in a share — which the caller has from the share list, because a share
 * ended by somebody else while this screen was closed must not still be filtered against.
 */
export const shareableFolders = (
  folders: readonly string[],
  syncedPaths: readonly string[],
  shared: readonly string[],
): string[] =>
  folders
    .filter((f) => holdsSynced(f, syncedPaths))
    .filter((f) => !shared.some((s) => overlaps(f, s)))
    .sort((a, b) => a.localeCompare(b));

/**
 * Why the list is empty, when it is — or nothing, when it is not.
 *
 * An empty dropdown with no sentence beside it reads as a broken screen. The two reasons are
 * genuinely different situations and only one of them is waiting on a sync, so they are not
 * collapsed into "nothing to share".
 */
export const nothingToShare = (
  offered: readonly string[],
  folders: readonly string[],
  shared: readonly string[],
): string | undefined => {
  if (offered.length > 0) return undefined;
  if (folders.filter((f) => f !== '').length === 0) return 'This vault has no folders yet.';
  if (shared.length > 0) {
    return 'Every folder this device has synced is already in a share, or holds one. A share cannot sit inside another.';
  }
  return 'No folder here has been synced yet. Sync this vault, and the folders it uploads can be shared.';
};
