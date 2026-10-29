/**
 * The marks on what arrived from somebody else, and on conflicts still open (#447).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterPass, allSeen, opened, removed, renamed, shareLabel, unseenCss, type Marks } from '../src/unseen.js';
import { sharedFolderCss } from '../src/obsidian/shared-marks.js';

const ME = 'me';
const pass = (pulled: object[], conflicts: { path: string; conflictPath: string }[] = []) => ({ pulled: pulled as never[], conflicts });

describe('what a pass marks (#447)', () => {
  it('marks what another account wrote into a shared folder, new or changed', () => {
    const marks = afterPass(
      {},
      pass([
        { path: 'Team/a.md', isNew: true, authorId: 'them', shareRoot: 'Team', firstFromShare: false },
        { path: 'Team/b.md', isNew: false, authorId: 'them', shareRoot: 'Team', firstFromShare: false },
      ]),
      ME,
      1,
    );
    assert.deepEqual(marks, { 'Team/a.md': { kind: 'new', at: 1 }, 'Team/b.md': { kind: 'changed', at: 1 } });
  });

  it('marks nothing this account wrote, nothing private, and nothing whose author is unknown', () => {
    const marks = afterPass(
      {},
      pass([
        { path: 'Team/mine.md', isNew: true, authorId: ME, shareRoot: 'Team' },
        { path: 'Notes/x.md', isNew: true, authorId: 'them' },
        { path: 'Team/old-server.md', isNew: true, authorId: null, shareRoot: 'Team' },
      ]),
      ME,
      1,
    );
    assert.deepEqual(marks, {});
  });

  it('marks a joined share once, on its folder, not file by file', () => {
    const files = ['a', 'b', 'c'].map((n) => ({ path: `Visa/${n}.md`, isNew: true, authorId: 'them', shareRoot: 'Visa', firstFromShare: true }));
    assert.deepEqual(afterPass({}, pass(files), ME, 1), { Visa: { kind: 'joined', at: 1 } });
  });

  it('keeps new as new through a later change, and marks every conflict copy, anywhere', () => {
    const before: Marks = { 'Team/a.md': { kind: 'new', at: 1 } };
    const marks = afterPass(
      before,
      pass([{ path: 'Team/a.md', isNew: false, authorId: 'them', shareRoot: 'Team' }], [{ path: 'Notes/n.md', conflictPath: 'Notes/n (conflict).md' }]),
      ME,
      2,
    );
    assert.deepEqual(marks, { 'Team/a.md': { kind: 'new', at: 1 }, 'Notes/n (conflict).md': { kind: 'conflict', at: 2 } });
  });
});

describe('how a mark goes away (#447)', () => {
  const marks: Marks = {
    'Team/a.md': { kind: 'new', at: 1 },
    'Visa': { kind: 'joined', at: 1 },
    'Notes/n (conflict).md': { kind: 'conflict', at: 1 },
  };

  it('opening a note clears it, and opening anything in a joined share clears the share', () => {
    assert.deepEqual(Object.keys(opened(marks, 'Team/a.md')), ['Visa', 'Notes/n (conflict).md']);
    assert.deepEqual(Object.keys(opened(marks, 'Visa/x.md')), ['Team/a.md', 'Notes/n (conflict).md']);
  });

  it('opening a conflict copy does not resolve it; deleting it does', () => {
    assert.ok(opened(marks, 'Notes/n (conflict).md')['Notes/n (conflict).md']);
    assert.equal(removed(marks, 'Notes/n (conflict).md')['Notes/n (conflict).md'], undefined);
  });

  it('a rename carries marks along, a folder with everything inside it', () => {
    assert.deepEqual(Object.keys(renamed(marks, 'Team', 'Crew')), ['Crew/a.md', 'Visa', 'Notes/n (conflict).md']);
    assert.deepEqual(Object.keys(renamed(marks, 'Team/a.md', 'Team/b.md')), ['Team/b.md', 'Visa', 'Notes/n (conflict).md']);
  });

  it('marking everything as seen keeps the conflicts', () => {
    assert.deepEqual(allSeen(marks), { 'Notes/n (conflict).md': { kind: 'conflict', at: 1 } });
  });
});

describe('how the marks are drawn (#447)', () => {
  it('draws nothing for no marks', () => {
    assert.equal(unseenCss({}, ['Team']), '');
  });

  it('badges each file, dots each folder above one, and counts inside a shared folder', () => {
    const css = unseenCss(
      { 'Team/sub/a.md': { kind: 'new', at: 1 }, 'Notes/n (conflict).md': { kind: 'conflict', at: 1 } },
      ['Team'],
    );
    assert.match(css, /\.nav-file-title\[data-path="Team\/sub\/a\.md"\][^{]*\{\s*content: 'new'/);
    assert.match(css, /\.nav-file-title\[data-path="Notes\/n \(conflict\)\.md"\][^{]*\{\s*content: 'conflict'[^}]*var\(--text-error\)/);
    assert.match(css, /\.nav-folder-title\[data-path="Team\/sub"\][^{]*::before/, 'a dot on the folder holding it');
    assert.match(css, /\.nav-folder-title\[data-path="Notes"\][^{]*::before/);
    assert.doesNotMatch(css, /data-path="Team"\][^{]*::before/, 'and no dot on the share: its own badge counts');
  });

  it('gives a shared folder’s badge the count, and a joined share “new”', () => {
    const marks: Marks = { 'Team/a.md': { kind: 'new', at: 1 }, 'Team/b.md': { kind: 'changed', at: 1 }, Visa: { kind: 'joined', at: 1 } };
    assert.equal(shareLabel(marks, 'Team'), 'shared · 2 new');
    assert.equal(shareLabel(marks, 'Visa'), 'shared · new');
    assert.equal(shareLabel(marks, 'Other'), 'shared');
    const css = sharedFolderCss(['Team', 'Other'], (p) => shareLabel(marks, p));
    assert.match(css, /data-path="Team"\] \.nav-folder-title-content::after \{ content: 'shared · 2 new'; \}/);
    assert.doesNotMatch(css, /data-path="Other"\] \.nav-folder-title-content::after \{ content/, 'the plain badge needs no second rule');
  });

  it('escapes a path with a quote in it', () => {
    assert.match(unseenCss({ 'Team/say "hi".md': { kind: 'new', at: 1 } }, []), /data-path="Team\/say \\"hi\\"\.md"/);
  });
});
