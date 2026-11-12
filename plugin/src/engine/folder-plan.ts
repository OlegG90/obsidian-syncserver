/**
 * What happens to the folders of this pass, decided before anything is sent.
 *
 * `rename.ts` answers "did this folder move?" from three maps. The answers that followed it —
 * a folder still on disk did not move (#419), a share root emptied with no move to explain it is
 * held (#409, #412), a share root deleted as a folder comes back (#417) — needed one more fact
 * that only the vault has: whether a folder is still there. Asking it inline put each of those
 * rules inside the engine, between server calls, where a case could only be reproduced by
 * building a whole pass around it.
 *
 * So the question is asked up front instead. `foldersToAsk` names every folder the plan could
 * depend on, the engine asks the vault about them once, and `planFolders` decides from the
 * answer. Nothing here performs anything; the engine executes the plan. Normative: docs/04.
 */
import { basePath, parentPath, type FolderMove, type TreeNode, type Vanished } from './rename.js';

/** What the plan reads about a server node: `rename.ts`'s view, plus the scope its name is under. */
export interface PlanNode extends TreeNode {
  nameKeyId: string | null;
}

/** Everything the plan decides from, as the pass holds it after the vanished set is built. */
export interface FolderPlanInput {
  vanished: ReadonlyMap<string, Vanished[]>;
  tree: ReadonlyMap<string, PlanNode>;
  /** Every live node by id, so a file the server shows somewhere else is recognised as moved (#418). */
  byNodeId: ReadonlyMap<string, { path: string }>;
  /** The local paths that exist now. */
  here: ReadonlySet<string>;
  /** The walk's queue, by path and in order: what the per-file walk would otherwise decide. */
  queue: readonly string[];
  /** The paths this device had synced — a file at one of them is not "new here". */
  known: ReadonlySet<string>;
  /** Share id → the scope its interior is named under (SH-01). */
  shareScopes: ReadonlyMap<string, string>;
}

/**
 * A share root emptied here with no folder move to explain where it went: nothing about it is sent.
 *
 * Left to the per-file walk, every file of it would read as leaving the share — re-created in
 * whatever folder it turned up in, and deleted from the share for everybody in it (#409). That is
 * what a rename looked like when `folderMoves` could not recognise it, and it is the one outcome a
 * missed rename must never have: a duplicate is recoverable at a glance, a share emptied for
 * somebody else is not. The state still names the old paths, so the next pass asks again — after
 * the folder is moved back, or renamed on its own.
 */
export interface HeldRoot {
  root: string;
  /** Its vanished files: claimed, so they are neither deleted nor taken for a rename source. */
  claimed: Vanished[];
  /** The local files that could be them: kept out of the walk. */
  outOfWalk: string[];
  /** The folder the server already has that it was carried onto — a merge, refused (#412). */
  mergeInto?: string;
}

/**
 * A share root deleted here as a folder: its files are put back rather than deleted (#417).
 *
 * What a person means by deleting a folder they share is "not here any more", and the act for
 * that is **Leave** (SH-05), which leaves everybody else's copy alone. The files leave the
 * vanished set and the state, and the pull at the end of the pass writes them back.
 */
export interface RestoredRoot {
  root: string;
  files: Vanished[];
}

export interface FolderPlan {
  /** The folder moves to carry out, in `folderMoves`' order. */
  moves: FolderMove[];
  held: HeldRoot[];
  restored: RestoredRoot[];
}

/**
 * Whether a node is the ROOT of a share: in the share, yet named under its holder's vault key
 * rather than the share's (SH-01). The one folder that must never be carried into another share.
 */
export const isShareRoot = (node: Pick<PlanNode, 'shareId' | 'nameKeyId'>, shareScopes: ReadonlyMap<string, string>): boolean =>
  Boolean(node.shareId) && node.nameKeyId !== shareScopes.get(node.shareId!);

/**
 * Every folder whose presence on disk `planFolders` may read.
 *
 * The sources of the planned moves, except a change of letter case — where case does not count,
 * `Team` renamed to `team` still "exists" under its old name and is a rename all the same (#421) —
 * and every share root with nothing left here under it. A superset is harmless; a path missing
 * from it reads as "not on disk", which is the answer that sends things to the server.
 */
export const foldersToAsk = (moves: readonly FolderMove[], input: FolderPlanInput): string[] => {
  const ask = moves.filter((m) => !caseOnly(m)).map((m) => m.from);
  for (const [path] of emptiedShareRoots(input)) ask.push(path);
  return ask;
};

/**
 * The folder moves to carry out, the share roots to hold, and those to put back.
 *
 * In that order, and the order is part of the rule: a root a move accounts for is neither held
 * nor restored, and a root that is held has no files left to restore. Each decision sees the
 * vanished set and the queue as the previous ones left them, exactly as the walk will.
 *
 * @param moves what `folderMoves` found.
 * @param onDisk the folders, out of `foldersToAsk`, that the vault still has.
 */
export const planFolders = (moves: readonly FolderMove[], input: FolderPlanInput, onDisk: ReadonlySet<string>): FolderPlan => {
  // **A folder still on disk did not move** (#419). `folderMoves` reads files, and a folder emptied
  // by moving its files out has none — but Obsidian keeps it, and a person who dragged the last
  // note out of a shared folder meant the note to leave, not the folder to be renamed after
  // wherever the note went.
  const plan = moves.filter((m) => caseOnly(m) || !onDisk.has(m.from));

  const vanished = new Map([...input.vanished].map(([hash, list]) => [hash, [...list]]));
  let queue = [...input.queue];
  const roots = emptiedShareRoots(input).filter(
    ([path]) => !plan.some((m) => m.from === path || m.from.startsWith(`${path}/`) || path.startsWith(`${m.from}/`)),
  );

  const held: HeldRoot[] = [];
  for (const [path] of roots) {
    // Emptied on purpose, not moved (#419): its files were taken out one by one, and they leave
    // the share by the per-file rules (#402).
    if (onDisk.has(path)) continue;
    const within = (p: string): boolean => p.startsWith(`${path}/`);

    // Its vanished files, by path relative to it, and what could be them somewhere else: new
    // here, and at one of those relative paths.
    const claimed = [...vanished.values()].flat().filter((v) => within(v.path));
    const rels = claimed.map((v) => v.path.slice(path.length + 1));
    const couldBe = (p: string): boolean => !input.known.has(p) && rels.some((rel) => p === rel || p.endsWith(`/${rel}`));

    // **Only the shape of a folder move is held.** Files dropped into folders the server already
    // has, one here and one there, were moved out on purpose, and the walk carries them out of
    // the share (#402). Two shapes are a folder that went somewhere this pass could not prove:
    // files in a folder the server has never seen (#409), and every file regrouped under ONE
    // folder of the shared folder's OWN name — the folder itself carried onto one that is
    // already there, a merge (#412). A different name is files dropped into somebody's folder.
    const under = regroupedUnder(rels, queue.filter(couldBe));
    const regrouped = under !== undefined && basePath(under) === basePath(path) ? under : undefined;
    if (!regrouped && !queue.some((p) => couldBe(p) && !input.tree.has(parentPath(p)))) continue;

    drop(vanished, new Set(claimed));
    const outOfWalk = queue.filter(couldBe);
    queue = queue.filter((p) => !couldBe(p));
    held.push({ root: path, claimed, outOfWalk, ...(regrouped && input.tree.has(regrouped) ? { mergeInto: regrouped } : {}) });
  }

  // Everything else is left to the rules that already hold. A root still on disk had its files
  // deleted one by one, which is deleting them for everybody, on purpose (SH-10). Files that turned
  // up elsewhere are a move, and the hold above or the per-file walk answers for them (#402, #409).
  // A private folder deleted with a shared folder inside it deletes its own files as ever; only the
  // shared folder in it comes back.
  const restored: RestoredRoot[] = [];
  for (const [path] of roots) {
    const within = (p: string): boolean => p.startsWith(`${path}/`);
    // Only files the server still holds where they were: one it shows somewhere else was renamed
    // there, and #418's rule answers for it.
    const files = [...vanished.values()].flat().filter((v) => within(v.path) && input.byNodeId.get(v.nodeId)?.path === v.path);
    if (files.length === 0) continue;
    const rels = files.map((v) => v.path.slice(path.length + 1));
    if (queue.some((p) => !input.known.has(p) && rels.some((rel) => p === rel || p.endsWith(`/${rel}`)))) continue;
    if (onDisk.has(path)) continue;

    drop(vanished, new Set(files));
    restored.push({ root: path, files });
  }

  return { moves: plan, held, restored };
};

/** A rename that changes only letter case, which a case-blind disk still answers to by its old name. */
const caseOnly = (m: Pick<FolderMove, 'from' | 'to'>): boolean => m.from.toLowerCase() === m.to.toLowerCase();

/** Share roots with nothing left here under them — the only ones a hold or a restore can be about. */
const emptiedShareRoots = (input: FolderPlanInput): [string, PlanNode][] =>
  [...input.tree].filter(
    ([path, node]) => !node.isFile && isShareRoot(node, input.shareScopes) && ![...input.here].some((p) => p.startsWith(`${path}/`)),
  );

/** Remove these entries from a vanished set, dropping any hash left with none. */
export const drop = (vanished: Map<string, Vanished[]>, gone: ReadonlySet<Vanished>): void => {
  for (const [hash, list] of [...vanished]) {
    const rest = list.filter((v) => !gone.has(v));
    if (rest.length) vanished.set(hash, rest);
    else vanished.delete(hash);
  }
};

/** The one folder every relative path reappears under, among `paths`, or nothing (#412). */
const regroupedUnder = (rels: readonly string[], paths: readonly string[]): string | undefined => {
  const first = rels[0];
  if (first === undefined) return undefined;
  const found = new Set(paths);
  for (const p of paths) {
    if (!p.endsWith(`/${first}`)) continue;
    const under = p.slice(0, p.length - first.length - 1);
    if (rels.every((rel) => found.has(`${under}/${rel}`))) return under;
  }
  return undefined;
};
