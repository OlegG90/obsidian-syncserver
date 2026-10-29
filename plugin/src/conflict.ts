/**
 * Settling a conflict: which note a copy belongs to, and how the two differ (#448).
 *
 * A conflict leaves the server's version at the note's path and this device's beside it as
 * `Note (conflict 2026-08-01 laptop).md` (docs/04). Comparing them was left to a separate plugin that
 * knew neither which file pairs with which nor which side is which — and that will not run on a phone.
 *
 * Pure: the pairing is read off the name, the comparison is a line diff. The screen and the three ways
 * out live in `obsidian/conflict-modal.ts`.
 */

/** `stem (conflict YYYY-MM-DD device).ext` — the engine's `withConflictSuffix`, read backwards. */
const COPY = /^(.*) \(conflict \d{4}-\d{2}-\d{2} [^)]*\)(\.[^./]*)?$/;

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

/**
 * The two texts line by line: what only the first has is `removed`, what only the second has is
 * `added`.
 *
 * Myers' algorithm — the shortest edit script, the one `git diff` starts from. A note is short enough
 * that the plain O(ND) form is right, and writing it here keeps the plugin free of a dependency whose
 * only use would be this.
 */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }

  // Walk the trace back from the end, emitting the path in reverse.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
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
export const TEXT_EXTENSIONS = new Set(['md', 'txt', 'canvas', 'json', 'css', 'js', 'csv', 'yaml', 'yml', 'html', 'xml', 'svg']);

export const isText = (path: string): boolean => TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase());
