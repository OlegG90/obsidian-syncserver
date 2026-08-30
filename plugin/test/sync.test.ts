/**
 * The sync coordinator, driven with scripted deps.
 *
 * This is the layer that used to live untested inside main.ts, and the hazard was re-entry:
 * a manual "Sync now" and a push notification could both start an engine over the same
 * data.state, because the session's `use()` serves concurrent callers. The coordinator
 * owns the guard now, and the tests pin it down: only one pass at a time, a push hint
 * never prompts for the passphrase, and unlock → one pass → render runs in that order.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openSyncCoordinator, type SyncCoordinatorDeps } from '../src/sync.js';
import { openGate } from '../src/gate.js';
import { openShareFlow } from '../src/share-flow.js';
import type { SyncReport } from '../src/engine/engine.js';

const emptyReport = (over: Partial<SyncReport> = {}): SyncReport => ({
  scanned: 1,
  pushed: [],
  pulled: [],
  matched: [],
  conflicts: [],
  renamed: [],
  deleted: [],
  removed: [],
  quarantined: [],
  vanished: [],
  unreadable: [],
  errors: [],
  events: [],
  ...over,
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const rig = (over: Partial<SyncCoordinatorDeps> = {}) => {
  const phases: unknown[] = [];
  const notices: string[] = [];
  let state: 'none' | 'locked' | 'open' = 'open';
  const calls = { unlock: 0, ask: 0, pass: 0 };
  const deps: SyncCoordinatorDeps = {
    gate: openGate(),
    sessionState: () => state,
    unlock: async () => {
      calls.unlock++;
      return true;
    },
    askPassphrase: async () => {
      calls.ask++;
      return 'phrase';
    },
    runPass: async () => {
      calls.pass++;
      return emptyReport();
    },
    setPhase: (p) => phases.push(p),
    notify: (m, d) => notices.push(d === undefined ? m : `${m} (${d}ms)`),
    ...over,
  };
  return {
    deps,
    phases,
    notices,
    calls,
    setState: (s: 'none' | 'locked' | 'open') => {
      state = s;
    },
  };
};

describe('the sync coordinator', () => {
  it('runs unlock → one pass → render in order', async () => {
    const r = rig();
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    assert.deepEqual(
      r.phases.map((p) => (p as { kind: string }).kind),
      ['syncing', 'idle'],
    );
    assert.equal(r.calls.pass, 1);
    assert.ok(r.notices.some((m) => m.includes('1 local files seen')));
  });

  it('renders a failed pass as failed, not as silence', async () => {
    const r = rig({ runPass: async () => { throw new Error('over_quota'); } });
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    const failed = r.phases.at(-1) as { kind: string; message: string };
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.message, 'over_quota');
    assert.ok(r.notices.some((m) => m.includes('over_quota')));
  });

  it('refuses to start a second pass while one is running', async () => {
    let release!: (report: SyncReport) => void;
    const r = rig();
    r.deps.runPass = () => {
      r.calls.pass++;
      return new Promise<SyncReport>((resolve) => {
        release = resolve;
      });
    };
    const sync = openSyncCoordinator(r.deps);

    const first = sync.run();
    assert.equal(r.calls.pass, 1, 'the first pass started');

    await sync.run(); // manual, during the pass
    assert.equal(r.calls.pass, 1, 'the manual second run was refused');
    assert.ok(r.notices.some((m) => m.includes('Waiting for a sync')));

    await sync.runIfIdle(); // push hint, during the pass
    assert.equal(r.calls.pass, 1, 'the push hint was silently skipped');

    release(emptyReport());
    await first;
  });

  it('a push hint never prompts for the passphrase', async () => {
    const r = rig();
    r.setState('locked');
    const sync = openSyncCoordinator(r.deps);
    await sync.runIfIdle();
    assert.equal(r.calls.ask, 0, 'no passphrase was asked');
    assert.equal(r.calls.pass, 0, 'no pass ran');
  });

  it('the manual path prompts when locked and then runs', async () => {
    const r = rig();
    r.setState('locked');
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    assert.equal(r.calls.ask, 1);
    assert.equal(r.calls.unlock, 1);
    assert.equal(r.calls.pass, 1);
  });

  it('a dismissed passphrase runs nothing', async () => {
    const r = rig({ askPassphrase: async () => undefined });
    r.setState('locked');
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    assert.equal(r.calls.unlock, 0);
    assert.equal(r.calls.pass, 0);
    assert.deepEqual(r.phases, [], 'no phase was set');
  });

  it('an unlock error renders as a failed pass', async () => {
    const r = rig({
      unlock: async () => { throw new Error('wrong passphrase'); },
    });
    r.setState('locked');
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    const failed = r.phases.at(-1) as { kind: string; message: string };
    assert.equal(failed.kind, 'failed');
    assert.equal(failed.message, 'wrong passphrase');
  });

  it('says so when there is no connection yet', async () => {
    const r = rig();
    r.setState('none');
    const sync = openSyncCoordinator(r.deps);
    await sync.run();
    assert.ok(r.notices.some((m) => m.includes('not connected')));
    assert.equal(r.calls.pass, 0);
  });

  it('a sync and a share operation cannot run at the same time', async () => {
    // The review's #8b: four re-entry guards, each guarding only its own module. A push
    // hint arriving between `leave/begin` and `finalize-leave` used to start a sync whose
    // engine met interior names with no key — the sync's guard did not know the share
    // flow's was held. One gate is now shared by both, so the second coordinator refuses.
    const gate = openGate();
    const r = rig({ gate });
    const sync = openSyncCoordinator(r.deps);

    // The share flow holds the gate; the sync is the latecomer.
    const shareNotices: string[] = [];
    let releaseShare!: () => void;
    const share = openShareFlow({
      gate,
      list: async () => ({ joined: [], invitations: [] }),
      share: () => new Promise((resolve) => (releaseShare = () => resolve({ shareId: 's' }))),
      invite: async () => undefined,
      accept: async () => undefined,
      decline: async () => undefined,
      leave: async () => ({ ended: false }),
      members: async () => [],
      remove: async () => ({ outcome: 'revoked' as const }),
      syncedPaths: () => ['Team'],
      folders: () => ['Team'],
      notify: (m) => shareNotices.push(m),
      done: () => undefined,
    });

    // Hold the gate with a slow share operation, then try to sync.
    const sharing = share.share('Team');
    await sync.runIfIdle(); // push hint mid-operation
    assert.equal(r.calls.pass, 0, 'the sync yielded to the operation in flight');

    releaseShare();
    await sharing;
  });
});

/**
 * What a pass nobody asked for is allowed to say (issue #238).
 *
 * Automatic syncing turned every one of these sentences from something a person met once, having
 * pressed a button, into something that can arrive every few seconds for as long as the vault is being
 * edited. The rule is that an unattended pass reports **outcomes**, never its own preconditions: a
 * conflict, an error and an account state are told either way, because nothing else on any screen would
 * mention them (D-124); "not connected" and "locked" are told to nobody, because the ribbon and the
 * status bar already say exactly that, permanently and without interrupting.
 */
describe('an unattended pass and its silences', () => {
  it('says nothing about not being connected — the ribbon already does', async () => {
    // The regression this pins: the notice was raised before the attended check, so an installed but
    // unconnected vault answered every edit with it, five seconds later, for ever.
    const r = rig();
    r.setState('none');
    const sync = openSyncCoordinator(r.deps);

    await sync.runIfIdle();
    assert.equal(r.notices.length, 0, 'nobody asked, so there is nobody to tell');

    await sync.run();
    assert.ok(r.notices.some((m) => m.includes('not connected')), 'but a person who pressed it is told');
  });

  it('says nothing about being locked either, and never asks for the passphrase', async () => {
    const r = rig();
    r.setState('locked');
    const sync = openSyncCoordinator(r.deps);

    await sync.runIfIdle();

    assert.deepEqual(r.notices, [], 'the phase says `locked` on every surface that renders one');
    assert.equal(r.calls.ask, 0, 'and a background pass must never put a prompt in front of somebody');
    assert.equal(r.calls.pass, 0);
  });

  it('says nothing when a pass moved nothing', async () => {
    const r = rig();
    const sync = openSyncCoordinator(r.deps);

    await sync.runIfIdle();

    assert.deepEqual(r.notices, [], '"nothing changed" every few seconds teaches somebody to ignore notices');
    assert.equal(r.calls.pass, 1, 'the pass still ran');
  });

  it('still tells a person what needs them, asked for or not', async () => {
    // The half that must not be silenced. Each of these is the only place it would be said.
    const r = rig({
      runPass: async () =>
        emptyReport({
          conflicts: [{ path: 'note.md', conflictPath: 'note (conflict).md' }],
          errors: [{ path: 'broken.md', message: 'the disk refused it' }],
          events: [{ type: 'account_frozen' } as SyncReport['events'][number]],
        }),
    });
    const sync = openSyncCoordinator(r.deps);

    await sync.runIfIdle();

    assert.ok(r.notices.some((m) => m.includes('note (conflict).md')), 'a conflict is told (D-124)');
    assert.ok(r.notices.some((m) => m.includes('the disk refused it')), 'so is a file that failed');
    assert.ok(r.notices.some((m) => m.toLowerCase().includes('limit')), 'so is an account that stopped accepting');
  });

  it('says what it did when a person pressed it, even if that is nothing', async () => {
    const r = rig();
    const sync = openSyncCoordinator(r.deps);

    await sync.run();

    assert.ok(r.notices.some((m) => m.includes('nothing changed')), 'a press deserves an answer');
  });
});
