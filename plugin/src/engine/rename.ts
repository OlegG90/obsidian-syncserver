/**
 * Was this a rename, or a delete and a create that happen to look like one?
 *
 * The hardest decision in the project, and until now it had no home: it was made inside
 * methods that also talked to the network and wrote to disk, so the only way to ask it a
 * question was to run a whole synchronisation and see what came out the other end. Every
 * subtle bug of M1 lived here — rename-plus-edit, a folder collapsing into its parent, the
 * 512-byte threshold — and each one cost a full round trip to reproduce.
 *
 * Nothing here performs anything. Three maps in, a plan out; the engine executes the plan
 * and this module never learns whether it worked. That is what makes a case cheap to add:
 * a fixture and an assertion, with no server, no vault and no clock.
 *
 * **The asymmetry that shapes every rule below.** A missed rename costs one upload that
 * deduplication makes nearly free. A wrong one moves a node the user still has somewhere
 * else — silently, and on every device. So every test here is a reason to say *no*, and
 * falling through to delete-and-create is always the safe answer. Normative: docs/04.
 */

/** A path this device had synced and can no longer find — a possible rename source. */
export interface Vanished {
  path: string;
  nodeId: string;
  rev: number;
  address: string;
}

/** Only what the decision reads: a node's identity and whether it is a folder. */
export interface TreeNode {
  nodeId: string;
  rev: number;
  isFile: boolean;
}

/** Only what the decision reads about a local file. */
export interface FileMeta {
  plainHash: string;
  size: number;
}

/**
 * Below this, a hash match means nothing (docs/04).
 *
 * Empty notes, a repeated icon, a stub from a template — small files collide constantly,
 * and the heuristic would move whichever one it happened to see first. Falling back to
 * delete-and-create costs nothing extra, because the blob deduplicates anyway.
 */
export const RENAME_MIN_BYTES = 512;

/** Everything above the last separator, or `''` for a path at the root. */
export const parentPath = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

/** Everything after the last separator. */
export const basePath = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
};

/**
 * The vanished file this local one is a rename of, if the evidence is unambiguous.
 *
 * Four conditions, and all of them are refusals waiting to happen:
 *
 * - **big enough to be identifying.** Below the threshold a hash proves nothing;
 * - **exactly one candidate.** Two vanished files with these bytes and the heuristic would
 *   pick whichever it saw first, which is a coin toss with a silent wrong side;
 * - **the source is still where the walk thinks it is**, and carries the same node id. A
 *   path that has since been reused by something else is not a rename source;
 * - **not already claimed.** Callers consume the entry, so a second file with the same
 *   bytes cannot claim the same source.
 *
 * Failing any of them is not a failure. It falls through to delete-and-create, and the blob
 * deduplicates, so the cost of being conservative here is metadata.
 *
 * Consumption is the caller's, deliberately: this module decides, and a decision that
 * quietly mutated its own input could not be asked the same question twice in a test.
 */
export const renameSourceFor = (
  meta: FileMeta,
  vanished: ReadonlyMap<string, Vanished[]>,
  tree: ReadonlyMap<string, TreeNode>,
): Vanished | undefined => {
  if (meta.size < RENAME_MIN_BYTES) return undefined;

  const candidates = vanished.get(meta.plainHash);
  if (!candidates || candidates.length !== 1) return undefined;

  const source = candidates[0]!;
  const node = tree.get(source.path);
  if (!node || node.nodeId !== source.nodeId) return undefined;

  return source;
};

/** One folder to move as a unit, with the children the move accounts for. */
export interface FolderMove {
  from: string;
  to: string;
  nodeId: string;
  rev: number;
  /** `hash` so the caller can consume the vanished entry; `to` is the child's new path. */
  children: { hash: string; to: string }[];
}

/**
 * Folders that moved as a whole, rather than as one rename per child.
 *
 * The per-file heuristic would move each child correctly and still leave the empty source
 * folder behind on the server, because nothing ever told it the folder itself had moved.
 * This looks for the shape that proves it did: every child of `V` reappearing under one
 * new parent `N`, at the same relative path, with the same bytes.
 *
 * **Deliberately strict, and every condition earns its place:**
 *
 * - `V` must be a folder the server actually has — a path prefix is not a node;
 * - **every** child must reappear, not most: one child edited mid-move means the folder is
 *   not the same folder, and the per-file walk handles it correctly;
 * - all of them under the **same** new parent, or it is a scatter, not a move;
 * - `N` must not already exist on the server, or this is a merge — which is a different
 *   operation with a different meaning for anybody else syncing;
 * - `N`'s own parent chain must already exist, so no folder is invented in the middle of a
 *   walk that has not reached it.
 *
 * Anything failing falls through to the per-file walk, which is conservative by
 * construction.
 *
 * @param here the local paths that exist now, so a reappearance can be found.
 */
export const folderMoves = (
  vanished: ReadonlyMap<string, Vanished[]>,
  tree: ReadonlyMap<string, TreeNode>,
  meta: ReadonlyMap<string, FileMeta>,
  here: ReadonlySet<string>,
): FolderMove[] => {
  // Group the vanished by the folder they were in: a "folder" here is a path prefix every
  // child shares.
  const byParent = new Map<string, { rel: string; v: Vanished; hash: string }[]>();
  for (const [hash, list] of vanished) {
    for (const v of list) {
      const parent = parentPath(v.path);
      const arr = byParent.get(parent) ?? [];
      arr.push({ rel: basePath(v.path), v, hash });
      byParent.set(parent, arr);
    }
  }

  const plan: FolderMove[] = [];
  const claimed = new Set<string>();

  for (const [parent, children] of byParent) {
    const source = tree.get(parent);
    // The vault root is not a movable node, and neither is a path the server holds as a file.
    if (!source || source.isFile || children.length === 0) continue;

    let newParent: string | undefined;
    const moved: { hash: string; to: string }[] = [];

    const allMoved = children.every(({ rel, v, hash }) => {
      const appeared = appearedUnder(rel, hash, here, meta);
      if (!appeared || appeared === v.path) return false;
      const np = parentPath(appeared);
      if (newParent !== undefined && np !== newParent) return false;
      newParent = np;
      moved.push({ hash, to: appeared });
      return true;
    });
    if (!allMoved || newParent === undefined) continue;

    if (tree.has(newParent)) continue;
    if (newParent && !parentChainExists(newParent, tree)) continue;
    // Two folders cannot move to the same destination in one pass; the second is not a
    // move but a merge into something this pass is already creating.
    if (claimed.has(newParent)) continue;
    claimed.add(newParent);

    plan.push({ from: parent, to: newParent, nodeId: source.nodeId, rev: source.rev, children: moved });
  }

  return plan;
};

/** A local path ending in `rel` whose content hash matches, or nothing. */
const appearedUnder = (
  rel: string,
  plainHash: string,
  here: ReadonlySet<string>,
  meta: ReadonlyMap<string, FileMeta>,
): string | undefined => {
  for (const path of here) {
    if (!path.endsWith(`/${rel}`)) continue;
    if (meta.get(path)?.plainHash === plainHash) return path;
  }
  return undefined;
};

/** Every ancestor ABOVE this path already exists on the server as a folder. */
export const parentChainExists = (path: string, tree: ReadonlyMap<string, TreeNode>): boolean => {
  // The destination is not part of its own parent chain; only the folders above it.
  const parent = parentPath(path);
  if (!parent) return true;

  let sofar = '';
  for (const part of parent.split('/')) {
    sofar = sofar ? `${sofar}/${part}` : part;
    const node = tree.get(sofar);
    if (!node || node.isFile) return false;
  }
  return true;
};
