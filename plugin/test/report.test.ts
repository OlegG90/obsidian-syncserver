/**
 * The one precedence rule for "what a SyncReport means", in isolation.
 *
 * This is the surface both status.ts and main.ts read, so the rules here are the ones that
 * used to drift: a reset that quarantined work must never read "up to date", failures and
 * conflicts must dominate ordinary counts, and matched (adoption recognised everything) is
 * a different "nothing moved" from an empty vault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { priority, summary } from '../src/engine/report.js';
import type { SyncReport } from '../src/engine/engine.js';

const report = (over: Partial<SyncReport>): SyncReport => ({
  scanned: 0,
  pushed: [],
  pulled: [],
  matched: [],
  conflicts: [],
  renamed: [],
  deleted: [],
  removed: [],
  quarantined: [],
  vanished: [],
  errors: [],
  ...over,
});

describe('priority', () => {
  it('puts failures above conflicts above ordinary movement', () => {
    const both = report({ pushed: [{ path: 'a.md' }], conflicts: [{ path: 'b.md', conflictPath: 'b.md' }], errors: [{ path: 'c.md', message: 'x' }] });
    assert.equal(priority(both), 'failed');
    assert.equal(priority(report({ pushed: [{ path: 'a.md' }], conflicts: [{ path: 'b.md', conflictPath: 'b.md' }] })), 'conflicts');
  });

  it('never reads a reset that kept work aside as "up to date"', () => {
    const kept = report({ quarantined: [{ from: 'Notes/mine.md', to: '_Reset 2026-08-12/Notes/mine.md' }] });
    assert.equal(priority(kept), 'quarantined');
  });

  it('calls any movement moved, even when the counts are small', () => {
    assert.equal(priority(report({ pushed: [{ path: 'a.md' }] })), 'moved');
    assert.equal(priority(report({ renamed: [{ from: 'a.md', to: 'b.md' }] })), 'moved');
    assert.equal(priority(report({ removed: [{ path: 'a.md' }] })), 'moved');
  });

  it('distinguishes "adoption matched everything" from "saw nothing"', () => {
    const matched = report({ scanned: 40, matched: Array(40).fill({ path: 'x' }) });
    assert.equal(priority(matched), 'matched');
    assert.equal(priority(report({ scanned: 0 })), 'empty');
    assert.equal(priority(report({ scanned: 3 })), 'up_to_date');
  });
});

describe('summary', () => {
  it('lists what happened most important first, skipping zeros', () => {
    const s = summary(report({ pushed: [{ path: 'a.md' }], pulled: [{ path: 'b.md' }], conflicts: [{ path: 'c.md', conflictPath: 'c.md' }] }));
    assert.deepEqual(s, ['1 conflict', '1 up', '1 down']);
  });

  it('names quarantine in the summary, not only in the per-file notices', () => {
    const s = summary(report({ quarantined: [{ from: 'a.md', to: '_Reset 2026-08-12/a.md' }], pushed: [{ path: 'b.md' }] }));
    assert.ok(s[0]!.includes('kept aside'), s.join(', '));
    assert.ok(s[1]!.includes('1 up'));
  });

  it('pluralises conflicts but not a single one', () => {
    assert.deepEqual(summary(report({ conflicts: [{ path: 'a.md', conflictPath: 'a.md' }] })), ['1 conflict']);
    assert.deepEqual(summary(report({ conflicts: [{ path: 'a.md', conflictPath: 'a.md' }, { path: 'b.md', conflictPath: 'b.md' }] })), ['2 conflicts']);
  });

  it('is empty for a quiet pass, so the surface decides how to say it', () => {
    assert.deepEqual(summary(report({ scanned: 3 })), []);
    assert.deepEqual(summary(report({ scanned: 0 })), []);
  });

  it('orders failures first and includes matched only when nothing moved', () => {
    const s = summary(report({ matched: [{ path: 'a.md' }], errors: [{ path: 'b.md', message: 'x' }] }));
    assert.deepEqual(s, ['1 failed', '1 already in sync']);
  });
});
