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
    assert.ok(r.notices.some((m) => m.includes('already running')));

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
    assert.equal(r.calls.pass, 0);
    assert.ok(r.notices.some((m) => m.includes('not connected')));
    assert.deepEqual(r.phases, [], 'no phase changed for a refused run');
  });
});
