/**
 * What a `Surface` promises to let go of (issue #233).
 *
 * A `PluginSettingTab` cannot be constructed outside Obsidian, so this tests the part that is a
 * decision rather than markup — the same line `layout.test.ts` draws. `Surface` takes its `App` and
 * plugin as **types** only, so it is constructible here with stubs, and the rule it enforces is worth
 * the seam: a listener that outlives its draw writes into elements nobody can see.
 *
 * The rule was already written down and the code held one slot for it. A second listener — the phase
 * watcher this header now needs — silently replaced the first, which is a leak that looks like nothing
 * until a redrawn screen stops updating.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Surface } from '../src/obsidian/surface.js';

/** Enough plugin for the gate mirror: it registers a watcher and reports nothing is running. */
const stubPlugin = (undo: () => void) =>
  ({ watchBusy: () => undo, busyWith: () => undefined }) as never;

describe('a surface lets go of everything its draw subscribed to', () => {
  it('undoes every registration, not just the last one', () => {
    // The defect exactly: one slot, two listeners. The gate's own registration is the second here, so
    // a single-slot implementation drops the first and this fails on `first`.
    let first = 0;
    let second = 0;
    const s = new Surface({} as never, stubPlugin(() => second++), () => {});
    s.whileDrawn(() => first++);
    s.watch();

    s.stop();

    assert.equal(first, 1, 'the registration made before the gate was undone too');
    assert.equal(second, 1);
  });

  it('undoes them on a redraw as well, because a redraw throws the elements away', () => {
    let undone = 0;
    const s = new Surface({} as never, stubPlugin(() => {}), () => {});
    s.whileDrawn(() => undone++);

    s.reset();

    assert.equal(undone, 1, 'reset is a draw ending, and the listeners belong to the draw');
  });

  it('does not undo the same registration twice', () => {
    // `stop()` runs on close and `reset()` on redraw, and a screen can meet both. An unsubscribe called
    // twice is usually harmless and is not always: the second call would remove a listener the NEXT
    // draw had just registered under the same identity.
    let undone = 0;
    const s = new Surface({} as never, stubPlugin(() => {}), () => {});
    s.whileDrawn(() => undone++);

    s.stop();
    s.stop();
    s.reset();

    assert.equal(undone, 1);
  });
});
