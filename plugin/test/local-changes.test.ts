/**
 * The quiet period, and the three things it has to get right (issue #238).
 *
 * A fake timer, because the value under test is *when* — and a suite that waited five real seconds per
 * case would be one nobody runs, which is how a timing rule stops being checked at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forTests, type Timer } from '../src/local-changes.js';

/** A clock the test advances by hand. Fires everything due at or before the new time, in order. */
const fakeTimer = () => {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timer: Timer = {
    set: (fn, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, t] of [...due.entries()]) {
      if (t.at <= now) {
        due.delete(id);
        t.fn();
      }
    }
  };
  return { timer, advance, pending: () => due.size };
};

const watcher = (over: { busy?: () => boolean; enabled?: () => boolean } = {}) => {
  const clock = fakeTimer();
  const runs: number[] = [];
  const w = forTests(
    {
      busy: over.busy ?? (() => false),
      enabled: over.enabled ?? (() => true),
      run: () => runs.push(runs.length + 1),
    },
    { quietMs: 5_000, timer: clock.timer },
  );
  return { w, clock, runs };
};

describe('syncing after the vault settles (issue #238)', () => {
  it('waits for the vault to be still, then runs once', () => {
    const { w, clock, runs } = watcher();

    w.touched();
    clock.advance(4_999);
    assert.deepEqual(runs, [], 'not yet — the vault was still moving a moment ago');

    clock.advance(1);
    assert.deepEqual(runs, [1], 'and once it has been still long enough, one pass');
  });

  it('a burst of edits costs one pass, not one per edit', () => {
    // A paste of forty files, a folder rename, a plugin rewriting frontmatter across a vault: the same
    // shape, and the reason this is a quiet period rather than a debounce per path.
    const { w, clock, runs } = watcher();

    for (let i = 0; i < 40; i++) {
      w.touched();
      clock.advance(100);
    }
    assert.deepEqual(runs, [], 'nothing ran while the burst was going on');

    clock.advance(5_000);
    assert.deepEqual(runs, [1], 'one pass for the whole burst');
  });

  it('does not start while something else is running, and does not forget either', () => {
    // The engine writes into the vault when it pulls, and those writes raise the same events. If a pass
    // could start on them the plugin would wake itself in a loop; if the events were dropped instead, an
    // edit made while a sync was running would be lost until something else happened to touch the vault.
    let busy = true;
    const { w, clock, runs } = watcher({ busy: () => busy });

    w.touched();
    clock.advance(5_000);
    assert.deepEqual(runs, [], 'held off while the gate is held');

    clock.advance(5_000);
    assert.deepEqual(runs, [], 'still waiting, for as long as it takes');

    busy = false;
    clock.advance(5_000);
    assert.deepEqual(runs, [1], 'and it runs once the way is clear');
  });

  it('is off when it is off, and takes effect without a reload', () => {
    let on = true;
    const { w, clock, runs } = watcher({ enabled: () => on });

    w.touched();
    on = false;
    w.touched();
    clock.advance(60_000);

    assert.deepEqual(runs, [], 'turning it off cancels what was already waiting');
  });

  it('stops when the plugin unloads', () => {
    const { w, clock, runs } = watcher();
    w.touched();
    w.stop();
    clock.advance(60_000);
    assert.deepEqual(runs, [], 'a timer that outlived its plugin would run against a dead session');
  });
});
