/**
 * The one-at-a-time gate, and the part of it that is new: it can be watched.
 *
 * The rule was only ever enforced — `tryBegin()` answering `false` — so a screen could not
 * say it before a press, and somebody learned a sync was running only by pressing Invite
 * (#125). Watching is what lets the same rule be shown instead of applied.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { busyLine, openGate } from '../src/gate.js';

describe('one operation at a time', () => {
  it('lets the first in and refuses the second', () => {
    const gate = openGate();
    assert.ok(gate.tryBegin('a sync'));
    assert.ok(!gate.tryBegin('sharing the folder'));
  });

  it('gives it back', () => {
    const gate = openGate();
    gate.tryBegin('a sync');
    gate.end();
    assert.ok(gate.tryBegin('sharing the folder'));
  });

  it('names what is holding it, not merely that something is', () => {
    // A trash discard holding the gate while somebody presses Invite is ordinary, and "a
    // sync is running" would be a plain untruth about it.
    const gate = openGate();
    gate.tryBegin('discarding “notes.md”');
    assert.equal(gate.holding(), 'discarding “notes.md”');
    gate.end();
    assert.equal(gate.holding(), undefined);
  });

  it('does not let a refused attempt rename the holder', () => {
    // The refused caller is about to show the reason. If its own name had replaced the
    // holder's, the screen would name the operation that is NOT running.
    const gate = openGate();
    gate.tryBegin('a sync');
    gate.tryBegin('emptying the trash');
    assert.equal(gate.holding(), 'a sync');
  });
});

describe('watching it', () => {
  it('reports both edges, with the name on the way in', () => {
    const seen: (string | undefined)[] = [];
    const gate = openGate();
    gate.watch((h) => seen.push(h));

    gate.tryBegin('a sync');
    gate.end();
    assert.deepEqual(seen, ['a sync', undefined]);
  });

  it('says nothing when nothing changed', () => {
    // A refused attempt leaves the gate exactly as it was, and a screen redrawing itself for
    // a non-event is how a list of shares flickers under a press it already refused.
    const seen: (string | undefined)[] = [];
    const gate = openGate();
    gate.tryBegin('a sync');
    gate.watch((h) => seen.push(h));

    gate.tryBegin('sharing the folder');
    assert.deepEqual(seen, []);

    gate.end();
    gate.end();
    assert.deepEqual(seen, [undefined], 'the second end is not a second change');
  });

  it('stops when the listener lets go', () => {
    // The settings tab is rebuilt constantly; a listener that outlived its elements would be
    // disabling buttons nobody can see, and holding them from being collected.
    const seen: (string | undefined)[] = [];
    const gate = openGate();
    const stop = gate.watch((h) => seen.push(h));

    gate.tryBegin('a sync');
    stop();
    gate.end();
    assert.deepEqual(seen, ['a sync']);
  });

  it('survives a listener that throws, and still releases the gate', () => {
    // `end()` runs in an operation's `finally`. A screen failing to redraw must not leave the
    // gate held for the rest of the session — that fault outlasts the one that caused it.
    const gate = openGate();
    gate.watch(() => {
      throw new Error('the screen blew up');
    });

    assert.ok(gate.tryBegin('a sync'));
    gate.end();
    assert.equal(gate.holding(), undefined);
    assert.ok(gate.tryBegin('sharing the folder'), 'and the next operation can still run');
  });

  it('tells every listener, not only the first', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const gate = openGate();
    gate.watch(() => a.push(1));
    gate.watch(() => b.push(1));
    gate.tryBegin('a sync');
    assert.deepEqual([a.length, b.length], [1, 1]);
  });
});

describe('the sentence both the screen and the refusal use', () => {
  it('names the operation and what waits for it', () => {
    const line = busyLine('a sync');
    assert.match(line, /a sync/);
    assert.match(line, /come back when it does/);
  });

  it('does not claim pairing waits, because it does not', () => {
    // `pairing-flow.ts` guards itself with a local flag and never takes this gate. The
    // mockup's wording said pairing waits; the code says otherwise, and the screen must not
    // describe a rule nothing enforces.
    assert.ok(!/pairing/i.test(busyLine('a sync')));
  });
});
