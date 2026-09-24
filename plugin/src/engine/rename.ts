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
  /** The share this node belongs to, when the tree read says so — a shared folder is never a leftover. */
  shareId?: string | null;
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
  /**
   * An empty folder the server still holds at `to`, to delete before the move (#412).
   *
   * A leftover: folder deletions do not reach the server (#413), so a name nobody can see locally
   * can still be taken there. It cannot exist here as an empty folder either, or the local move
   * would have collided with it, so replacing it loses nothing anybody can see.
   */
  replaces?: { nodeId: string; rev: number };
}

/**
 * Folders that moved as a whole, rather than as one rename per child.
 *
 * The per-file heuristic would move each child correctly and still leave the empty source
 * folder behind on the server, because nothing ever told it the folder itself had moved. This
 * looks for the shape that proves it did: every file that vanished from under `V` reappearing
 * under one new folder `N`, at the same path relative to it.
 *
 * **At any depth, shallowest first** (#409). A renamed folder with subfolders vanishes as files
 * two levels down, and grouping by each file's own parent saw only `V/sub` — whose new parent
 * `N` the server did not have yet — so no folder move was ever planned for it. The folder that
 * moved is the shallowest one the evidence fits; its subfolders ride along with it.
 *
 * **Content may differ** (#409). A file edited in the same moment as the rename is still the same
 * file in the same folder: once the folder has moved, the edit goes up against its node like any
 * other. Demanding identical bytes sent a renamed share root down the per-file walk, which read
 * each file as leaving the share, and took them out of it for everybody. What still proves a
 * rename is the rest, and every condition earns its place:
 *
 * - `V` must be a folder the server actually has — a path prefix is not a node;
 * - **every** file that vanished from under `V` reappears at `N/<same relative path>`: one
 *   missing, or one somewhere else, is a scatter or a delete, not a move;
 * - **nothing stays behind** under `V`: moving a folder moves everything in it, so a folder that
 *   still holds anything locally did not move — only its vanished files did (#370);
 * - `N` is not already on the server, or this is a merge — a different operation with a
 *   different meaning for anybody else syncing — and it is not inside `V` (#351). The one
 *   exception is a leftover: an **empty**, unshared folder the server still holds at `N`, which
 *   the move replaces (#412);
 * - `N`'s own parent chain already exists, so no folder is invented mid-walk;
 * - exactly one `N` fits, and no two folders are planned into it.
 *
 * Anything failing falls through to the per-file walk, which is conservative by construction —
 * except for a share root, which the engine refuses to take apart (`holdShareRoots`).
 *
 * @param here the local paths that exist now, so a reappearance can be found.
 * @param meta what each local file hashes to: a tie between two possible destinations goes to
 *   the one where more bytes match, and a true tie is refused.
 */
export const folderMoves = (
  vanished: ReadonlyMap<string, Vanished[]>,
  tree: ReadonlyMap<string, TreeNode>,
  meta: ReadonlyMap<string, FileMeta>,
  here: ReadonlySet<string>,
): FolderMove[] => {
  const gone: { v: Vanished; hash: string }[] = [];
  for (const [hash, list] of vanished) for (const v of list) gone.push({ v, hash });

  // Every folder a vanished file lived under, at any depth.
  const folders = new Set<string>();
  for (const { v } of gone) {
    for (let p = parentPath(v.path); p; p = parentPath(p)) folders.add(p);
  }

  const plan: FolderMove[] = [];
  const claimed = new Set<string>();
  const within = (dir: string) => (p: string) => p.startsWith(`${dir}/`);

  for (const from of [...folders].sort((a, b) => a.split('/').length - b.split('/').length)) {
    // Already carried by a shallower folder this plan moves.
    if (plan.some((m) => from === m.from || within(m.from)(from))) continue;
    const source = tree.get(from);
    if (!source || source.isFile) continue;
    if ([...here].some(within(from))) continue;

    const children = gone
      .filter(({ v }) => within(from)(v.path))
      .map(({ v, hash }) => ({ hash, rel: v.path.slice(from.length + 1) }));
    const to = destinationOf(children, here, tree, meta);
    if (to === undefined || to === from || within(from)(to)) continue;
    if (!parentChainExists(to, tree) || claimed.has(to)) continue;
    const there = tree.get(to);
    if (there && !leftover(to, there, tree)) continue;
    claimed.add(to);

    plan.push({
      from,
      to,
      nodeId: source.nodeId,
      rev: source.rev,
      children: children.map(({ hash, rel }) => ({ hash, to: `${to}/${rel}` })),
      ...(there ? { replaces: { nodeId: there.nodeId, rev: there.rev } } : {}),
    });
  }

  return plan;
};

/** A folder the server holds with nothing in it and no share on it — what a deleted folder leaves (#413). */
const leftover = (path: string, node: TreeNode, tree: ReadonlyMap<string, TreeNode>): boolean =>
  !node.isFile && !node.shareId && ![...tree.keys()].some((p) => p.startsWith(`${path}/`));

/**
 * The one folder every child reappears under at its relative path, or nothing.
 *
 * Candidates come from where the first child turned up; each must hold all of them. More than
 * one survivor is decided by how many bytes match, and a tie is no answer at all.
 */
const destinationOf = (
  children: readonly { hash: string; rel: string }[],
  here: ReadonlySet<string>,
  tree: ReadonlyMap<string, TreeNode>,
  meta: ReadonlyMap<string, FileMeta>,
): string | undefined => {
  const first = children[0];
  if (!first) return undefined;

  const fits: { to: string; matching: number }[] = [];
  for (const path of here) {
    if (!path.endsWith(`/${first.rel}`) || tree.has(path)) continue;
    const to = path.slice(0, path.length - first.rel.length - 1);
    const at = children.map((c) => `${to}/${c.rel}`);
    // A path the server already holds is somebody's file, not one this folder brought.
    if (!at.every((p) => here.has(p) && !tree.has(p))) continue;
    const matching = children.filter((c, i) => meta.get(at[i]!)?.plainHash === c.hash).length;
    fits.push({ to, matching });
  }
  fits.sort((a, b) => b.matching - a.matching);
  if (fits.length === 0 || (fits.length > 1 && fits[0]!.matching === fits[1]!.matching)) return undefined;
  return fits[0]!.to;
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
