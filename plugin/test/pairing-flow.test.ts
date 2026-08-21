/**
 * The pairing coordinator — the decisions that used to live inside a `PluginSettingTab`,
 * where nothing could watch them.
 *
 * Two of the defects a real phone found on 14 August were in that class. These are the
 * questions it was answering silently: does a join start without a passphrase, is the code
 * shown the code sent, does a cancel stop the next attempt, and can two attempts run at
 * once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/client.js';
import { openPairingFlow, type PairingFlowDeps } from '../src/pairing-flow.js';
import type { PairArgs } from '../src/session/index.js';

/** Records everything the flow decided to do, and lets a test answer for the world. */
const harness = (over: Partial<PairingFlowDeps> = {}) => {
  const shown: string[] = [];
  const statuses: string[] = [];
  const notices: string[] = [];
  const joined: PairArgs[] = [];
  const approved: string[] = [];
  const waits: number[] = [];
  let rebuilt = 0;

  const deps: PairingFlowDeps = {
    newCode: () => 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GG',
    join: async (args) => {
      joined.push(args);
    },
    approve: async (code) => {
      approved.push(code);
    },
    showCode: (code) => shown.push(code),
    setStatus: (text) => statuses.push(text),
    notify: (message) => notices.push(message),
    wait: async (ms) => {
      waits.push(ms);
    },
    done: () => {
      rebuilt++;
    },
    ...over,
  };

  return { flow: openPairingFlow(deps), shown, statuses, notices, joined, approved, waits, rebuilt: () => rebuilt };
};

const args = { serverUrl: 'http://x', login: 'admin', passphrase: 'a phrase' };

describe('joining an account from the new device', () => {
  it('registers nothing without a passphrase', async () => {
    // Checked before a code exists. A pairing the person cannot finish would sit on the
    // server for its full ten minutes, and the device would show a code that leads nowhere.
    const h = harness();
    await h.flow.join({ ...args, passphrase: '' });

    assert.deepEqual(h.joined, [], 'the server was never asked');
    assert.deepEqual(h.shown, [], 'and no code was put in front of anybody');
    assert.match(h.notices[0]!, /passphrase is required/);
  });

  it('shows exactly the code it sends', async () => {
    // One value, generated once. Showing one code and registering another is the shape of
    // failure that looks like the other device typing it wrong.
    const h = harness();
    await h.flow.join(args);

    assert.equal(h.shown.length, 1);
    assert.equal(h.joined[0]!.pairingCode, h.shown[0], 'the code on screen is the code registered');
    assert.equal(h.statuses[0], 'Waiting for approval…');
  });

  it('waits between attempts rather than hammering the claim', async () => {
    // The wait is a person walking to another device. The callback is what `Session.pair`
    // polls with, so this asserts the flow's answer to "should I ask again".
    let asked = 0;
    const h = harness({
      join: async (a, waiting) => {
        void a;
        // Three claim attempts before approval.
        assert.equal(await waiting(), true);
        assert.equal(await waiting(), true);
        asked = 2;
      },
    });
    await h.flow.join(args);

    assert.equal(asked, 2);
    assert.deepEqual(h.waits, [1000, 1000], 'a second apart, twice');
  });

  it('stops on cancel before the next attempt, not during the current one', async () => {
    const h = harness({
      join: async (a, waiting) => {
        void a;
        assert.equal(await waiting(), true, 'the first wait continues');
        h.flow.cancel();
        assert.equal(await waiting(), false, 'the next one does not');
        throw new Error('pairing was cancelled before it was approved');
      },
    });
    await h.flow.join(args);

    assert.ok(h.statuses.includes('Cancelled.'));
    assert.equal(h.rebuilt(), 0, 'a cancelled pairing does not rebuild the screen as if it had worked');
  });

  it('redraws the live code and status into a rebuilt element', async () => {
    // The settings tab is rebuilt on every display(), and the flow is now HELD across those
    // rebuilds — so a rebuilt tab must be able to draw the wait it began back in, or a
    // person who navigated away comes back to a code that exists on the server and nowhere
    // on screen. `redraw` is that call.
    let release: (() => void) | undefined;
    const h = harness({
      join: () => new Promise<void>((resolve) => (release = resolve)),
    });

    const first = h.flow.join(args);
    assert.equal(h.shown.length, 1, 'the code was drawn once, at the start of the wait');

    h.flow.redraw();
    assert.equal(h.shown.length, 2, 'a rebuilt tab gets the code back');
    assert.equal(h.shown[1], h.shown[0], 'the same code — the wait is the same wait');
    assert.equal(h.statuses.at(-1), 'Waiting for approval…', 'and the status line with it');

    h.flow.cancel();
    release!();
    await first;
  });

  it('refuses a second attempt while one is waiting', async () => {
    // Two live pairings would mean two codes on screen and only one of them approvable.
    let release: (() => void) | undefined;
    const h = harness({
      join: () => new Promise<void>((resolve) => (release = resolve)),
    });

    const first = h.flow.join(args);
    await h.flow.join(args);
    assert.match(h.notices.at(-1)!, /already waiting/);
    assert.equal(h.shown.length, 1, 'no second code was shown');

    release!();
    await first;
  });

  it('reports a failure in both places a person might be looking', async () => {
    const h = harness({
      join: async () => {
        throw new Error('404 Not Found');
      },
    });
    await h.flow.join(args);

    assert.ok(h.statuses.includes('404 Not Found'), 'under the code, where they have been staring');
    assert.match(h.notices.at(-1)!, /404 Not Found/, 'and as a notice');
    assert.equal(h.rebuilt(), 0);
  });

  it('rebuilds the screen once it has worked', async () => {
    const h = harness();
    await h.flow.join(args);

    assert.match(h.notices.at(-1)!, /paired/);
    assert.equal(h.rebuilt(), 1, 'the screen showing a pairing code is now the wrong screen');
  });

  it('allows another attempt after one failed', async () => {
    let fail = true;
    const h = harness({
      join: async () => {
        if (fail) throw new Error('nope');
      },
    });
    await h.flow.join(args);
    fail = false;
    await h.flow.join(args);

    assert.equal(h.shown.length, 2, 'the guard released with the failure');
  });
});

describe('approving from the connected device', () => {
  it('refuses an empty code without calling anything', async () => {
    const h = harness();
    await h.flow.approve('   ');

    assert.deepEqual(h.approved, []);
    assert.match(h.notices[0]!, /enter the code/);
  });

  it('passes the code through untouched, because normalising is the session’s', async () => {
    // `Session` normalises at the point it hashes. Doing it here as well would state one
    // rule in two places — and hashing two different forms of one code is exactly what
    // made pairing fail on real devices.
    const h = harness();
    await h.flow.approve('  aaaa-bbbb  ');

    assert.equal(h.approved[0], '  aaaa-bbbb  ', 'untouched');
    assert.match(h.notices[0]!, /approved/);
  });

  it('surfaces a refusal rather than swallowing it', async () => {
    const h = harness({
      approve: async () => {
        throw new Error('already_settled');
      },
    });
    await h.flow.approve('AAAA');

    assert.match(h.notices[0]!, /already_settled/);
  });
});

describe('approving a code from the connected device (#131)', () => {
  it('sends one approval when the button is pressed twice', async () => {
    // `running` guarded the join and nothing guarded this, so two presses sent two
    // approvals. The server refuses the second — but a person who pressed twice would read
    // that refusal as something having gone wrong, when nothing had.
    // Only the FIRST call hangs. A fake that also hung on the second would make a missing
    // guard show up as a test that never finishes, which is not a failure anybody can read.
    let release: (() => void) | undefined;
    const sent: string[] = [];
    const h = harness({
      approve: async (code) => {
        sent.push(code);
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
      },
    });

    const first = h.flow.approve('AAAA-BBBB');
    await h.flow.approve('AAAA-BBBB');

    assert.deepEqual(sent, ['AAAA-BBBB'], 'the second press reached nothing');
    assert.match(h.notices.at(-1)!, /already under way/);
    release!();
    await first;
  });

  it('lets the next approval through once the first has finished', async () => {
    const h = harness();
    await h.flow.approve('AAAA-BBBB');
    await h.flow.approve('CCCC-DDDD');
    assert.deepEqual(h.approved, ['AAAA-BBBB', 'CCCC-DDDD']);
  });

  it('releases the flag when the approval fails', async () => {
    // A refusal must not leave this device unable to approve anything for the rest of the
    // session — the code on the other screen is expiring while it waits.
    let fail = true;
    const h = harness({
      approve: async () => {
        if (fail) throw new ApiError(409, 'already_settled', '{}');
      },
    });
    await h.flow.approve('AAAA-BBBB');
    fail = false;
    await h.flow.approve('AAAA-BBBB');
    // The second call got through, which is the point: a refusal must not leave this device
    // unable to approve for the rest of the session.
    assert.match(h.notices.at(-1)!, /approved\. The other device/);
  });

  it('says what a settled pairing means, not "409 already_settled"', async () => {
    const h = harness({
      approve: async () => {
        throw new ApiError(409, 'already_settled', '{}');
      },
    });
    await h.flow.approve('AAAA-BBBB');
    assert.match(h.notices.at(-1)!, /already been approved/);
    assert.ok(!/409/.test(h.notices.at(-1)!), 'a status code is not a sentence');
  });

  it('names all three causes of not_found, because the server will not separate them', async () => {
    // No such code, a mistyped one, and an expired one answer identically on purpose
    // (docs/06). A message that picked one would be guessing.
    const h = harness({
      approve: async () => {
        throw new ApiError(404, 'not_found', '{}');
      },
    });
    await h.flow.approve('AAAA-BBBB');
    const said = h.notices.at(-1)!;
    assert.match(said, /Check it against the other screen/);
    assert.match(said, /ten minutes/);
    assert.match(said, /expired/);
  });

  it('passes anything else through as it is', async () => {
    const h = harness({
      approve: async () => {
        throw new Error('the network is down');
      },
    });
    await h.flow.approve('AAAA-BBBB');
    assert.match(h.notices.at(-1)!, /the network is down/);
  });
});
