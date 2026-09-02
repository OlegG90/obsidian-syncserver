/**
 * When a running pass is worth mentioning, and what it says (#319).
 *
 * The threshold is the part with a wrong answer that annoys people: automatic sync runs a pass after
 * every settling of the vault, so a surface that lit up for each one would flicker on every edit.
 * Testing that with a stopwatch is how it stops being tested, which is why `displayFor` takes `now`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { counterText, displayFor, SLOW_MS, type PassProgress } from '../src/pass-progress.js';

const at = (over: Partial<PassProgress> = {}): PassProgress => ({ done: 0, total: 100, startedAt: 0, ...over });

describe('whether a pass is worth mentioning', () => {
  it('says nothing about a pass that just started', () => {
    assert.deepEqual(displayFor(at({ done: 3 }), 10), { kind: 'quiet' });
  });

  // The ordinary case, and the one that must stay silent: a vault with nothing to do, walked after
  // somebody saved a note. Hundreds of files, all matched, finished long before the threshold.
  it('says nothing about a whole vault walked in under a second', () => {
    assert.deepEqual(displayFor(at({ done: 605, total: 605 }), 900), { kind: 'quiet' });
  });

  it('stays quiet right up to the threshold, and speaks on it', () => {
    assert.equal(displayFor(at({ done: 5 }), SLOW_MS - 1).kind, 'quiet');
    assert.equal(displayFor(at({ done: 5 }), SLOW_MS).kind, 'counting');
  });

  // A slow pass with nothing to walk — a large pull, or a tree read over a bad connection. `0 of 0`
  // tells a person less than the plain "working" every surface already shows.
  it('says nothing when there is nothing to count', () => {
    assert.deepEqual(displayFor(at({ done: 0, total: 0 }), 60_000), { kind: 'quiet' });
  });
});

describe('what it says', () => {
  it('counts what is done against what was expected', () => {
    const d = displayFor(at({ done: 128, total: 1180 }), 30_000);
    assert.deepEqual(d, { kind: 'counting', done: 128, total: 1180, grew: false, elapsedMs: 30_000 });
    assert.equal(counterText(d), '128 / 1180');
  });

  /**
   * The queue grows while it is drained: `resolveConflict` pushes the local original back onto it, so
   * a pass finishes having handled more files than it began with. A counter that reported the
   * starting total would read `1181 / 1180` — a bar past its own end, which is worse than no bar.
   */
  it('raises the total to meet the count, and marks it', () => {
    const d = displayFor(at({ done: 1181, total: 1180 }), 30_000);
    assert.equal(d.kind === 'counting' && d.total, 1181);
    assert.equal(d.kind === 'counting' && d.grew, true);
    assert.equal(counterText(d), '1181 / ~1181');
  });

  it('never reports more done than there is total', () => {
    const pairs: [number, number][] = [[0, 10], [10, 10], [11, 10], [500, 1]];
    for (const [done, total] of pairs) {
      const d = displayFor(at({ done, total, startedAt: 0 }), 10_000);
      assert.ok(d.kind === 'counting' && d.done <= d.total, `${done}/${total}`);
    }
  });

  it('has no counter text when it is quiet', () => {
    assert.equal(counterText({ kind: 'quiet' }), '');
  });
});
