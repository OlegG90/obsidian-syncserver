/**
 * What arrived from somebody else and has not been looked at yet, and the conflicts still open (#447).
 *
 * In a shared folder other people add notes and change existing ones, and nothing on screen said
 * which; a conflict copy appeared beside its note looking like any other file. These marks say so,
 * in the file tree, where a person looks for it.
 *
 * Pure, and kept apart from Obsidian: the plugin binds the events and the stylesheet, this decides.
 *
 * **Each device keeps its own.** Opening a note on the laptop leaves it marked on the phone: "seen"
 * is something a person did here, and carrying it across would need the server to hold it.
 */
import type { Arrival } from './engine/engine.js';

/**
 * - `new` / `changed` — another account wrote it, into a shared folder; cleared by opening it;
 * - `joined` — on a share root, for the pass that brought the whole folder in; cleared by opening
 *   anything inside it;
 * - `conflict` — on a conflict copy, in any folder; cleared only when the conflict is resolved,
 *   which is the copy going away.
 */
export type MarkKind = 'new' | 'changed' | 'joined' | 'conflict';
export interface Mark {
  kind: MarkKind;
  at: number;
}
export type Marks = Record<string, Mark>;

const under = (path: string, folder: string): boolean => path.startsWith(`${folder}/`);

/**
 * The marks after a pass, from what it pulled and the conflicts it left.
 *
 * Only what **another account** wrote is marked: the same person's edit from their phone is not news
 * to them. A server too old to name authors names nobody, and nobody is not somebody else.
 */
export const afterPass = (
  marks: Marks,
  pass: { pulled: readonly Arrival[]; conflicts: readonly { conflictPath: string }[] },
  me: string,
  now: number,
): Marks => {
  const out = { ...marks };
  for (const a of pass.pulled) {
    if (!a.shareRoot || !a.authorId || a.authorId === me) continue;
    if (a.firstFromShare) {
      out[a.shareRoot] ??= { kind: 'joined', at: now };
      continue;
    }
    // New stays new however often it changes before it is opened.
    if (out[a.path]?.kind === 'new') continue;
    out[a.path] = { kind: a.isNew ? 'new' : 'changed', at: now };
  }
  for (const c of pass.conflicts) out[c.conflictPath] = { kind: 'conflict', at: now };
  return out;
};

/** A note was opened. A conflict copy keeps its mark: reading it is not resolving it. */
export const opened = (marks: Marks, path: string): Marks => {
  const out = { ...marks };
  if (out[path] && out[path].kind !== 'conflict') delete out[path];
  for (const [p, m] of Object.entries(out)) if (m.kind === 'joined' && under(path, p)) delete out[p];
  return out;
};

/** A file or a folder moved: its marks, and those of everything inside it, go with it. */
export const renamed = (marks: Marks, from: string, to: string): Marks => {
  const out: Marks = {};
  for (const [p, m] of Object.entries(marks)) {
    if (p === from) out[to] = m;
    else if (under(p, from)) out[to + p.slice(from.length)] = m;
    else out[p] = m;
  }
  return out;
};

/** A file or a folder is gone. For a conflict copy this is the conflict resolved. */
export const removed = (marks: Marks, path: string): Marks =>
  Object.fromEntries(Object.entries(marks).filter(([p]) => p !== path && !under(p, path)));

/** Everything marked as seen — except a conflict, which is not a thing to have seen but to settle. */
export const allSeen = (marks: Marks): Marks => Object.fromEntries(Object.entries(marks).filter(([, m]) => m.kind === 'conflict'));

/** Same escaping as the shared badge: paths are user-chosen and may hold both characters. */
const cssString = (path: string): string => path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const BADGE = `  margin-inline-start: 0.5em;
  padding: 0 0.4em;
  border-radius: 0.4em;
  font-size: var(--font-ui-smaller);
  vertical-align: middle;`;

/**
 * The stylesheet: a badge on each marked file, a dot on every folder above one, and — on a shared
 * folder — how many are waiting inside it, in the place its `shared` badge already stands.
 *
 * `sharedRoots` is the list the `shared` badge is drawn from. A root's count is written with a doubled
 * class so it outranks that badge's rule whichever stylesheet the document reads last.
 */
export const unseenCss = (marks: Marks, sharedRoots: readonly string[]): string => {
  const entries = Object.entries(marks);
  if (entries.length === 0) return '';
  const rules: string[] = [];

  for (const [path, mark] of entries) {
    if (mark.kind === 'joined') continue;
    const conflict = mark.kind === 'conflict';
    rules.push(`.nav-file-title[data-path="${cssString(path)}"] .nav-file-title-content::after {
  content: '${mark.kind}';
${BADGE}
  color: var(--text-on-accent);
  background: ${conflict ? 'var(--text-error)' : 'var(--interactive-accent)'};
}`);
  }

  const counts = new Map<string, number>();
  const folders = new Set<string>();
  for (const [path, mark] of entries) {
    const parts = path.split('/');
    // A `joined` mark sits ON its folder; everything else marks the folders above it.
    const upTo = mark.kind === 'joined' ? parts.length : parts.length - 1;
    for (let i = 1; i <= upTo; i++) folders.add(parts.slice(0, i).join('/'));
    for (const root of sharedRoots) if (path === root || under(path, root)) counts.set(root, (counts.get(root) ?? 0) + 1);
  }

  for (const folder of folders) {
    if (counts.has(folder)) continue;
    rules.push(`.nav-folder-title[data-path="${cssString(folder)}"] .nav-folder-title-content::before {
  content: '● ';
  color: var(--interactive-accent);
}`);
  }
  for (const [root, n] of counts) {
    const joined = marks[root]?.kind === 'joined' && n === 1;
    rules.push(`.nav-folder-title.nav-folder-title[data-path="${cssString(root)}"] .nav-folder-title-content::after {
  content: '${joined ? 'shared · new' : `shared · ${n} new`}';
}`);
  }
  return rules.join('\n');
};
