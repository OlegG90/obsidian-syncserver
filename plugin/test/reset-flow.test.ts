/**
 * Starting a reset (#158) — the decisions, outside `main.ts` where nothing could watch them.
 *
 * The act itself has been covered live since M1: a vault reset on one device, and the other resyncing
 * through `410` and quarantining what it displaced. What had no home was the pair of rules around it —
 * the gate, and when the local state may be forgotten — and both are the kind that fail silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openGate } from '../src/gate.js';
import { openResetFlow, type ResetFlowDeps } from '../src/reset-flow.js';

const harness = (over: Partial<ResetFlowDeps> = {}) => {
  const said: string[] = [];
  const order: string[] = [];
  const gate = openGate();

  const deps: ResetFlowDeps = {
    gate,
    reset: async () => {
      order.push('reset');
      return { removed: 42, epoch: 3 };
    },
    forgetState: async () => void order.push('forget'),
    sync: async () => void order.push('sync'),
    notify: (m) => said.push(m),
    done: () => order.push('done'),
    ...over,
  };

  return { flow: openResetFlow(deps), said, order, gate };
};

describe('one operation at a time', () => {
  it('refuses while something else holds the gate, and names what', async () => {
    const h = harness();
    h.gate.tryBegin('a sync');

    assert.equal(await h.flow.start(), false);
    assert.deepEqual(h.order, [], 'nothing was asked of the server');
    assert.match(h.said[0]!, /Waiting for a sync/);
  });

  it('gives the gate back, so a second attempt is possible', async () => {
    const h = harness();
    assert.equal(await h.flow.start(), true);
    assert.equal(h.gate.holding(), undefined);
    assert.equal(await h.flow.start(), true);
  });

  it('gives it back after a failure too', async () => {
    // A reset the server refused must not leave the device unable to sync for the rest of the session.
    const h = harness({
      reset: async () => {
        throw new Error('nope');
      },
    });
    assert.equal(await h.flow.start(), false);
    assert.equal(h.gate.holding(), undefined);
    assert.match(h.said[0]!, /the reset failed/);
  });

  it('lets the sync take the gate for itself', async () => {
    // Held across both, the upload would refuse the very pass this act exists to start.
    const h = harness({
      sync: async () => {
        assert.equal(h.gate.tryBegin('a sync'), true, 'the gate is free when the sync runs');
        h.gate.end();
      },
    });
    assert.equal(await h.flow.start(), true);
  });
});

describe('when the local state may be forgotten', () => {
  it('resets first, then forgets, then uploads', async () => {
    const h = harness();
    await h.flow.start();
    assert.deepEqual(h.order, ['reset', 'forget', 'sync', 'done']);
  });

  it('remembers everything when the server refused', async () => {
    // Forgetting first would leave a device with no record of what it had synced, against a server that
    // still holds it all — and the next pass would upload the lot again beside the originals.
    const h = harness({
      reset: async () => {
        throw new Error('refused');
      },
    });
    await h.flow.start();
    assert.ok(!h.order.includes('forget'), 'nothing was forgotten');
    assert.ok(!h.order.includes('sync'), 'and nothing was uploaded');
  });
});

describe('what it says', () => {
  it('reports the count before the upload rather than after it', async () => {
    // The sync may take minutes. The number is the answer to "did that do what I meant", and it is
    // wanted at the moment of asking.
    const h = harness({
      sync: async () => {
        assert.match(h.said.join(' '), /42 item\(s\) removed/, 'said before the upload began');
      },
    });
    await h.flow.start();
  });
});
