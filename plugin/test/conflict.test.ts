/**
 * Settling a conflict: pairing a copy with its note, and the line diff between them (#448).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copiesOf, folded, isText, lineDiff, originalOf, type DiffLine } from '../src/conflict.js';

describe('which note a conflict copy belongs to (#448)', () => {
  it('reads the note back out of the name the engine gives a copy', () => {
    assert.equal(originalOf('Notes/Plan (conflict 2026-10-29 laptop).md'), 'Notes/Plan.md');
    assert.equal(originalOf('Plan (conflict 2026-10-29 windows-desktop).md'), 'Plan.md');
    assert.equal(originalOf('a/b/Scan (conflict 2026-01-02 phone).pdf'), 'a/b/Scan.pdf');
    assert.equal(originalOf('Notes/README (conflict 2026-10-29 laptop)'), 'Notes/README', 'a name with no extension');
  });

  it('is not fooled by a note that only mentions a conflict', () => {
    assert.equal(originalOf('Notes/Plan.md'), undefined);
    assert.equal(originalOf('Notes/On conflict resolution.md'), undefined);
    assert.equal(originalOf('Notes/Plan (conflict notes).md'), undefined);
  });

  it('finds a note’s copies among the vault’s paths', () => {
    const paths = ['N/Plan.md', 'N/Plan (conflict 2026-10-29 phone).md', 'N/Plan (conflict 2026-10-28 laptop).md', 'M/Plan (conflict 2026-10-29 phone).md'];
    assert.deepEqual(copiesOf('N/Plan.md', paths), ['N/Plan (conflict 2026-10-28 laptop).md', 'N/Plan (conflict 2026-10-29 phone).md']);
  });
});

/** Apply a diff: the lines it keeps from each side must rebuild both texts exactly. */
const sides = (diff: readonly DiffLine[]) => ({
  before: diff.filter((l) => l.kind !== 'added').map((l) => l.text).join('\n'),
  after: diff.filter((l) => l.kind !== 'removed').map((l) => l.text).join('\n'),
});

describe('the line diff (#448)', () => {
  it('rebuilds both texts, whatever they are', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['a', 'a'],
      ['a\nb\nc', 'a\nc'],
      ['a\nc', 'a\nb\nc'],
      ['one\ntwo\nthree', 'zero\ntwo\nfour\nthree'],
      ['x\ny\nz', ''],
      ['', 'x\ny'],
      ['same\nsame\nsame', 'same\nsame'],
    ];
    for (const [before, after] of cases) assert.deepEqual(sides(lineDiff(before, after)), { before, after }, `${before} → ${after}`);
  });

  it('is the shortest: one changed line is one removal and one addition', () => {
    const diff = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd');
    assert.deepEqual(
      diff.filter((l) => l.kind !== 'same'),
      [
        { kind: 'removed', text: 'b' },
        { kind: 'added', text: 'B' },
      ],
    );
  });

  it('folds long unchanged runs, keeping context around each change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');
    const rows = folded(lineDiff(before, after), 2);
    assert.deepEqual(rows[0], { kind: 'skipped', count: 8 });
    assert.deepEqual(rows.at(-1), { kind: 'skipped', count: 7 }, 'nine after the change, two kept');
    assert.equal(rows.filter((r) => r.kind === 'same').length, 4, 'two lines either side');
  });
});

describe('what can be compared line by line (#448)', () => {
  it('compares notes and other text, and not a PDF or an image', () => {
    assert.equal(isText('a/b.md'), true);
    assert.equal(isText('a/b.canvas'), true);
    assert.equal(isText('a/b.PDF'), false);
    assert.equal(isText('a/b.png'), false);
  });
});
