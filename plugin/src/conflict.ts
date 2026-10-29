/**
 * Settling a conflict: which note a copy belongs to, and how the two differ (#448).
 *
 * A conflict leaves the server's version at the note's path and this device's beside it as
 * `Note (conflict 2026-08-01 laptop).md` (docs/04). Comparing them was left to a separate plugin that
 * knew neither which file pairs with which nor which side is which — and that will not run on a phone.
 *
 * Pure: the name is written and read here, side by side, so the two cannot drift apart; the comparison
 * is a line diff. The screen and the three ways out live in `obsidian/conflict-modal.ts`.
 */

/**
 * `Note (conflict 2026-08-01 laptop).md` — the exact form docs/04 specifies for a content
 * conflict, reused here for adoption's "no common ancestor" case since it is the same
 * situation stated the other way: two versions with no shared history landed on one path.
 */
export const conflictCopyName = (path: string, device: string, date = new Date()): string => {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  return `${dir}${stem} (conflict ${date.toISOString().slice(0, 10)} ${device})${ext}`;
};

/**
 * `conflictCopyName`, read backwards. The device part may hold anything a person named a device,
 * brackets included, so it runs to the last `)` before the extension.
 */
const COPY = /^(.*?) \(conflict \d{4}-\d{2}-\d{2} .*\)(\.[^./()]*)?$/;

/** The note a conflict copy belongs to, or nothing when the path is not a conflict copy. */
export const originalOf = (copy: string): string | undefined => {
  const slash = copy.lastIndexOf('/');
  const dir = copy.slice(0, slash + 1);
  const m = COPY.exec(copy.slice(slash + 1));
  return m ? `${dir}${m[1]}${m[2] ?? ''}` : undefined;
};

/** The conflict copies of one note, among the given paths. */
export const copiesOf = (note: string, paths: Iterable<string>): string[] =>
  [...paths].filter((p) => originalOf(p) === note).sort();

export type DiffLine = { kind: 'same' | 'removed' | 'added'; text: string };

/** Beyond this many changed lines `lineDiff` gives up rather than hold a phone's screen for seconds. */
export const MAX_EDITS = 2000;

/**
 * The two texts line by line: what only the first has is `removed`, what only the second has is
 * `added`.
 *
 * Myers' algorithm — the shortest edit script, the one `git diff` starts from. A note is short enough
 * that the plain O(ND) form is right, and writing it here keeps the plugin free of a dependency whose
 * only use would be this.
 */
export const lineDiff = (before: string, after: string, maxEdits = MAX_EDITS): DiffLine[] | undefined => {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  // One frontier array, offset so `k` may be negative; the trace keeps only the 2d+1 slots step `d`
  // could have touched, so memory grows with the edits rather than with the files' length.
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  const at = (row: Int32Array, d: number, k: number): number => row[k + d + 1] ?? 0;

  let done = false;
  for (let d = 0; d <= limit && !done; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }
  // Two texts this far apart are two texts, not one edited: a line-by-line comparison would be a wall
  // of red and green, and computing it holds the screen.
  if (!done) return undefined;

  // Walk the trace back from the end, emitting the path in reverse.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(vd, d, k - 1) < at(vd, d, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(vd, d, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ kind: 'same', text: a[x]! });
    }
    if (d > 0) {
      if (down) out.push({ kind: 'added', text: b[--y]! });
      else out.push({ kind: 'removed', text: a[--x]! });
    }
  }
  return out.reverse();
};

export type DiffRow = DiffLine | { kind: 'skipped'; count: number };

/**
 * The diff with long unchanged runs folded, keeping `context` lines around every change — what a
 * person reads; a note is mostly the same on both sides, and the sameness is not what they came for.
 */
export const folded = (diff: readonly DiffLine[], context = 3): DiffRow[] => {
  const near = diff.map(() => false);
  diff.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let j = Math.max(0, i - context); j <= Math.min(diff.length - 1, i + context); j++) near[j] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  diff.forEach((l, i) => {
    if (near[i]) {
      if (skipped) out.push({ kind: 'skipped', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skipped', count: skipped });
  return out;
};

/** Files a line diff means something for. Anything else is compared by size alone. */
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'canvas', 'json', 'css', 'js', 'csv', 'yaml', 'yml', 'html', 'xml', 'svg']);

export const isText = (path: string): boolean => TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
