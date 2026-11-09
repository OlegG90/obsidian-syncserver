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

describe('a button the gate holds also waits for its own form', () => {
  /** A button that remembers only what was last done to it. */
  const button = () => {
    const b = { disabled: false, setDisabled: (d: boolean) => ((b.disabled = d), b) };
    return b;
  };
  /** A plugin whose gate is held or free as the test says, and which tells its watcher when it changes. */
  const gate = () => {
    let holding: string | undefined;
    let watcher: (h: string | undefined) => void = () => {};
    const plugin = {
      busyWith: () => holding,
      watchBusy: (w: typeof watcher) => ((watcher = w), () => {}),
    };
    return { plugin: plugin as never, set: (h: string | undefined) => ((holding = h), watcher(h)) };
  };

  it('does not enable a button whose form names nothing when an operation ends (issue #455)', () => {
    // The defect this guards: the share field disabled its own button, and the gate enabled it again
    // the moment any sync finished — with text in the field that named no folder.
    const g = gate();
    const s = new Surface({} as never, g.plugin, () => {});
    s.watch();
    let ready = false;
    const b = button();
    s.waits(b as never, () => ready);
    assert.equal(b.disabled, true, 'not ready from the start');

    g.set('syncing');
    g.set(undefined);
    assert.equal(b.disabled, true, 'the gate letting go did not make the form ready');

    ready = true;
    s.recheck();
    assert.equal(b.disabled, false);

    g.set('syncing');
    assert.equal(b.disabled, true, 'ready, and still held back by the gate');
  });
});
