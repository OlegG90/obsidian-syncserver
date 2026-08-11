/**
 * The status surfaces, and specifically the case that motivated them: a sync that moved
 * nothing must not read the same as a sync that never saw the vault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shortStatus, statusLines } from '../src/obsidian/status.js';
import type { SyncReport } from '../src/engine/engine.js';

const report = (over: Partial<SyncReport>): SyncReport => ({
  scanned: 0,
  pushed: [],
  pulled: [],
  matched: [],
  conflicts: [],
  renamed: [],
  vanished: [],
  errors: [],
  ...over,
});

describe('shortStatus', () => {
  it('distinguishes "nothing to do" from "saw nothing"', () => {
    // The two "0 up, 0 down" causes this whole surface exists to tell apart.
    const upToDate = shortStatus({ kind: 'idle', report: report({ scanned: 3 }) });
    const empty = shortStatus({ kind: 'idle', report: report({ scanned: 0 }) });
    assert.notEqual(upToDate, empty, 'a synchronised vault and an unseen one must not say the same thing');
    assert.match(upToDate, /up to date/);
    assert.match(empty, /empty/);
  });

  it('reports movement over the count of files scanned', () => {
    const s = shortStatus({ kind: 'idle', report: report({ pushed: [{ path: 'a.md' }], scanned: 5 }) });
    assert.match(s, /1↑/);
  });

  it('distinguishes "adoption recognised everything" from "nothing to look at"', () => {
    // Both leave pushed and pulled at zero — the third outcome adoption introduces, and the
    // reason a bare arrow count is not enough on its own.
    const matched = shortStatus({ kind: 'idle', report: report({ scanned: 40, matched: Array(40).fill({ path: 'x' }) }) });
    const empty = shortStatus({ kind: 'idle', report: report({ scanned: 0 }) });
    assert.match(matched, /40 matched/);
    assert.notEqual(matched, empty);
  });

  it('surfaces a failure count rather than folding it into the arrows', () => {
    const s = shortStatus({
      kind: 'idle',
      report: report({ pushed: [{ path: 'a.md' }], errors: [{ path: 'b.md', message: 'x' }] }),
    });
    assert.match(s, /1 failed/);
  });

  it('leads with a conflict even when ordinary movement also happened', () => {
    const s = shortStatus({
      kind: 'idle',
      report: report({
        pushed: [{ path: 'a.md' }],
        conflicts: [{ path: 'b.md', conflictPath: 'b (conflict 2026-08-11 device).md' }],
      }),
    });
    assert.match(s, /1 conflict/);
  });

  it('has a distinct word for every phase', () => {
    const words = [
      shortStatus({ kind: 'disconnected' }),
      shortStatus({ kind: 'locked' }),
      shortStatus({ kind: 'syncing' }),
      shortStatus({ kind: 'failed', message: 'x', at: 0 }),
      shortStatus({ kind: 'idle' }),
    ];
    assert.equal(new Set(words).size, words.length, 'every phase reads differently at a glance');
  });
});

describe('statusLines', () => {
  it('names every local file that failed, not just how many', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({ errors: [{ path: 'Notes/today.md', message: 'over_quota' }] }),
    });
    assert.ok(lines.some((l) => l.includes('Notes/today.md') && l.includes('over_quota')));
  });

  it('names both files of a conflict — where the server version landed and where the local one went', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({
        conflicts: [{ path: 'Notes/today.md', conflictPath: 'Notes/today (conflict 2026-08-11 device).md' }],
      }),
    });
    assert.ok(lines.some((l) => l.includes('Notes/today.md') && l.includes('today (conflict 2026-08-11 device).md')));
  });

  it('flags an empty scan as worth reporting, not a quiet success', () => {
    const lines = statusLines({ kind: 'idle', at: Date.now(), report: report({ scanned: 0 }) });
    assert.ok(lines.some((l) => l.includes('worth reporting')));
  });

  it('does not flag it when the emptiness is adoption having matched everything', () => {
    // scanned > 0 here — the "saw nothing" warning is specifically about scanned === 0, not
    // about pushed/pulled being zero, which is the entire point of a matched adoption.
    const lines = statusLines({ kind: 'idle', at: Date.now(), report: report({ scanned: 5, matched: [{ path: 'a.md' }] }) });
    assert.ok(!lines.some((l) => l.includes('worth reporting')));
  });

  it('shows no connection details before one exists', () => {
    const lines = statusLines({ kind: 'disconnected' });
    assert.ok(lines.some((l) => l.startsWith('Server: not connected')));
    assert.ok(!lines.some((l) => l.startsWith('Login:')));
  });
});
