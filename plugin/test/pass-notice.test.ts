/**
 * The rules that keep a progress notice from being a nuisance (#320).
 *
 * A notice is the only surface a phone has for a long pass — `addStatusBarItem` is desktop-only by
 * Obsidian's own documentation — and it is also the surface most able to annoy: it sits over the top
 * corner of the vault and a person cannot read past it. Every case here is one way that goes wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openPassNotice, type NoticeSurface } from '../src/pass-notice.js';
import { SLOW_MS } from '../src/pass-progress.js';
import type { SyncPhase } from '../src/obsidian/status.js';

const recorder = () => {
  const shown: string[] = [];
  let hides = 0;
  const surface: NoticeSurface = {
    show: (text) => void shown.push(text),
    hide: () => void (hides += 1),
  };
  return { surface, shown, hides: () => hides };
};

/** A clock a test moves by hand. */
const clock = (start = 0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

const syncing = (done: number, total: number, startedAt = 0): SyncPhase => ({
  kind: 'syncing',
  progress: { done, total, startedAt },
});

describe('a notice for a long pass', () => {
  it('says nothing about a pass that finishes quickly', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    n.onPhase(syncing(1, 605));
    c.advance(900);
    n.onPhase(syncing(605, 605));
    n.onPhase({ kind: 'idle', at: 900 });

    assert.deepEqual(r.shown, [], 'the ordinary pass is never mentioned');
  });

  it('appears once the pass has run long enough, and updates in place', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    n.onPhase(syncing(10, 1180));
    c.advance(SLOW_MS);
    n.onPhase(syncing(128, 1180));
    n.onPhase(syncing(129, 1180));

    assert.deepEqual(r.shown, ['SyncServer: syncing… 128 / 1180', 'SyncServer: syncing… 129 / 1180']);
  });

  it('goes away when the pass ends', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    c.advance(SLOW_MS);
    n.onPhase(syncing(128, 1180));
    n.onPhase({ kind: 'idle', at: 1 });

    assert.equal(r.hides(), 1);
  });

  it('does not keep taking down a notice that is not there', () => {
    const r = recorder();
    const n = openPassNotice({ surface: r.surface, now: clock().now });

    n.onPhase({ kind: 'idle', at: 1 });
    n.onPhase({ kind: 'idle', at: 2 });
    n.onPhase({ kind: 'locked' });

    assert.equal(r.hides(), 0);
  });
});

describe('dismissing it', () => {
  it('stays gone for the rest of that pass', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    c.advance(SLOW_MS);
    n.onPhase(syncing(128, 1180));
    n.dismiss();
    n.onPhase(syncing(129, 1180));
    n.onPhase(syncing(400, 1180));

    assert.deepEqual(r.shown, ['SyncServer: syncing… 128 / 1180'], 'shown once, and not again');
    assert.equal(r.hides(), 1, 'and taken down when dismissed');
  });

  /**
   * The next pass starts clean. Dismissal is impatience with one upload, not a setting — a person who
   * waved away this morning's migration still wants to know that tonight's has been running a while.
   */
  it('does not silence the next pass', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    c.advance(SLOW_MS);
    n.onPhase(syncing(128, 1180, 0));
    n.dismiss();

    const later = c.advance(60_000);
    n.onPhase(syncing(1, 900, later));
    c.advance(SLOW_MS);
    n.onPhase(syncing(50, 900, later));

    assert.equal(r.shown.at(-1), 'SyncServer: syncing… 50 / 900');
  });
});

describe('unloading', () => {
  it('takes the notice with it', () => {
    const r = recorder();
    const c = clock();
    const n = openPassNotice({ surface: r.surface, now: c.now });

    c.advance(SLOW_MS);
    n.onPhase(syncing(128, 1180));
    n.stop();

    assert.equal(r.hides(), 1);
  });
});
