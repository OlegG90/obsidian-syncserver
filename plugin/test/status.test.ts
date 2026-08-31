/**
 * The status surfaces, and specifically the case that motivated them: a sync that moved
 * nothing must not read the same as a sync that never saw the vault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { phaseIcon, phaseState, shortStatus, statusLines, type SyncPhase } from '../src/obsidian/status.js';
import type { SyncReport } from '../src/engine/engine.js';

const report = (over: Partial<SyncReport>): SyncReport => ({
  scanned: 0,
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

/**
 * The split the ribbon depends on (#285).
 *
 * On a phone the ribbon is an entry in a menu of ACTIONS, and its registered name can never
 * be corrected — `addRibbonIcon` takes it once. So the name has to be the act and the state
 * has to be reachable separately. If `phaseState` ever grows the heading back, the two would
 * merge again and a control would go back to announcing a report it cannot keep true.
 */
describe('phaseState', () => {
  const every: SyncPhase[] = [
    { kind: 'disconnected' },
    { kind: 'locked' },
    { kind: 'syncing' },
    { kind: 'failed', message: 'the server said no', at: 0 },
    { kind: 'idle' },
    { kind: 'idle', report: report({ scanned: 3 }) },
    { kind: 'idle', report: report({ scanned: 0 }) },
    { kind: 'idle', report: report({ pushed: [{ path: 'a.md' }], scanned: 5 }) },
    { kind: 'idle', report: report({ conflicts: [{ path: 'a.md', conflictPath: 'a (conflict).md' }] }) },
  ];

  it('never carries the heading a surface puts in front of it', () => {
    for (const phase of every) {
      const state = phaseState(phase);
      assert.doesNotMatch(state, /^Sync:/, `“${state}” is a whole sentence, not a state`);
      assert.notEqual(state, '', 'every phase has something to say');
    }
  });

  it('is exactly what shortStatus heads', () => {
    for (const phase of every) assert.equal(shortStatus(phase), `Sync: ${phaseState(phase)}`);
  });
});

describe('shortStatus', () => {
  it('distinguishes "nothing to do" from "saw nothing"', () => {
    // The two "0 up, 0 down" causes this whole surface exists to tell apart.
    const upToDate = shortStatus({ kind: 'idle', report: report({ scanned: 3 }) });
    const empty = shortStatus({ kind: 'idle', report: report({ scanned: 0 }) });
    assert.notEqual(upToDate, empty, 'a synchronised vault and an unseen one must not say the same thing');
    assert.match(upToDate, /up to date/);
    assert.match(empty, /empty/);
  });

  it('reports movement over the count of files scanned', () => {
    const s = shortStatus({ kind: 'idle', report: report({ pushed: [{ path: 'a.md' }], scanned: 5 }) });
    assert.match(s, /1↑/);
  });

  it('distinguishes "adoption recognised everything" from "nothing to look at"', () => {
    // Both leave pushed and pulled at zero — the third outcome adoption introduces, and the
    // reason a bare arrow count is not enough on its own.
    const matched = shortStatus({ kind: 'idle', report: report({ scanned: 40, matched: Array(40).fill({ path: 'x' }) }) });
    const empty = shortStatus({ kind: 'idle', report: report({ scanned: 0 }) });
    assert.match(matched, /40 matched/);
    assert.notEqual(matched, empty);
  });

  it('surfaces a failure count rather than folding it into the arrows', () => {
    const s = shortStatus({
      kind: 'idle',
      report: report({ pushed: [{ path: 'a.md' }], errors: [{ path: 'b.md', message: 'x' }] }),
    });
    assert.match(s, /1 failed/);
  });

  it('leads with a conflict even when ordinary movement also happened', () => {
    const s = shortStatus({
      kind: 'idle',
      report: report({
        pushed: [{ path: 'a.md' }],
        conflicts: [{ path: 'b.md', conflictPath: 'b (conflict 2026-08-11 device).md' }],
      }),
    });
    assert.match(s, /1 conflict/);
  });

  it('has a distinct word for every phase', () => {
    const words = [
      shortStatus({ kind: 'disconnected' }),
      shortStatus({ kind: 'locked' }),
      shortStatus({ kind: 'syncing' }),
      shortStatus({ kind: 'failed', message: 'x', at: 0 }),
      shortStatus({ kind: 'idle' }),
    ];
    assert.equal(new Set(words).size, words.length, 'every phase reads differently at a glance');
  });
});

describe('statusLines', () => {
  it('names every local file that failed, not just how many', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({ errors: [{ path: 'Notes/today.md', message: 'over_quota' }] }),
    });
    assert.ok(lines.some((l) => l.includes('Notes/today.md') && l.includes('over_quota')));
  });

  it('names both files of a conflict — where the server version landed and where the local one went', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({
        conflicts: [{ path: 'Notes/today.md', conflictPath: 'Notes/today (conflict 2026-08-11 device).md' }],
      }),
    });
    assert.ok(lines.some((l) => l.includes('Notes/today.md') && l.includes('today (conflict 2026-08-11 device).md')));
  });

  it('flags an empty scan as worth reporting, not a quiet success', () => {
    const lines = statusLines({ kind: 'idle', at: Date.now(), report: report({ scanned: 0 }) });
    assert.ok(lines.some((l) => l.includes('worth reporting')));
  });

  it('does not flag it when the emptiness is adoption having matched everything', () => {
    // scanned > 0 here — the "saw nothing" warning is specifically about scanned === 0, not
    // about pushed/pulled being zero, which is the entire point of a matched adoption.
    const lines = statusLines({ kind: 'idle', at: Date.now(), report: report({ scanned: 5, matched: [{ path: 'a.md' }] }) });
    assert.ok(!lines.some((l) => l.includes('worth reporting')));
  });

  it('never prints "saw nothing" beside a conflict list it contradicts', () => {
    // A vault with conflicts and zero scanned files is not empty — it has work to resolve.
    // The old long-form conjunction (scanned===0 and pushed/pulled/matched zero) fired anyway
    // and printed "No local files were found" next to the conflicts. The warning belongs to
    // the report module's `empty` mood, and only to that.
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({
        scanned: 0,
        conflicts: [{ path: 'Notes/today.md', conflictPath: 'Notes/today (conflict 2026-08-13 device).md' }],
      }),
    });
    assert.ok(lines.some((l) => l.includes('Conflicts (1)')), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('worth reporting')), 'the empty warning is not printed');
  });

  it('shows no connection details before one exists', () => {
    const lines = statusLines({ kind: 'disconnected' });
    assert.ok(lines.some((l) => l.startsWith('Server: not connected')));
    assert.ok(!lines.some((l) => l.startsWith('Login:')));
  });

  it('names what was deleted on the server and removed here, so a disappearance is never silent', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({ removed: [{ path: 'Notes/gone.md' }] }),
    });
    assert.ok(lines.some((l) => l.includes('removed here') && l.includes('1')));
    assert.ok(lines.some((l) => l.includes('Notes/gone.md')));
  });

  it('tells the user directly when a reset moved their work aside', () => {
    const lines = statusLines({
      kind: 'idle',
      at: Date.now(),
      report: report({ quarantined: [{ from: 'Notes/mine.md', to: '_Reset 2026-08-12/Notes/mine.md' }] }),
    });
    assert.ok(lines.some((l) => l.includes('reset on another device')));
    assert.ok(lines.some((l) => l.includes('_Reset 2026-08-12/Notes/mine.md')));
  });
});

describe('phaseIcon — the surface that renders on a phone', () => {
  // Obsidian's own sync shows its state as a ribbon icon on mobile, which is where someone
  // will look. The status bar does not render there at all (docs/02), so before this the
  // phone showed nothing until the user went hunting for a command.

  it('gives every phase an icon, because a missing one renders as nothing at all', () => {
    // The failure mode this guards is silent: `setIcon` with a name it does not know draws
    // an empty ribbon, which looks exactly like the bug the ribbon was added to fix.
    const phases: SyncPhase[] = [
      { kind: 'disconnected' },
      { kind: 'locked' },
      { kind: 'syncing' },
      { kind: 'failed', message: 'x', at: 0 },
      { kind: 'idle' },
      { kind: 'idle', report: report({ scanned: 3 }) },
      { kind: 'idle', report: report({ scanned: 0 }) },
      { kind: 'idle', report: report({ conflicts: [{ path: 'a', conflictPath: 'b' }] }) },
      { kind: 'idle', report: report({ errors: [{ path: 'a', message: 'x' }] }) },
      { kind: 'idle', report: report({ quarantined: [{ from: 'a', to: 'b' }] }) },
    ];
    for (const p of phases) {
      const icon = phaseIcon(p);
      assert.ok(icon.length > 0, `${p.kind} has no icon`);
      assert.match(icon, /^[a-z][a-z0-9-]*$/, `${icon} is not a lucide id`);
    }
  });

  it('separates the states a glance has to tell apart', () => {
    const working = phaseIcon({ kind: 'syncing' });
    const locked = phaseIcon({ kind: 'locked' });
    const broken = phaseIcon({ kind: 'failed', message: 'x', at: 0 });
    const fine = phaseIcon({ kind: 'idle', report: report({ scanned: 3 }) });

    assert.equal(new Set([working, locked, broken, fine]).size, 4, 'four states, four icons');
  });

  it('shows anything that needs the user as one thing', () => {
    // A conflict, a failure and work put aside by a reset are different in the panel and
    // the same on a ribbon: something needs you.
    const conflict = phaseIcon({ kind: 'idle', report: report({ conflicts: [{ path: 'a', conflictPath: 'b' }] }) });
    const failed = phaseIcon({ kind: 'idle', report: report({ errors: [{ path: 'a', message: 'x' }] }) });
    const aside = phaseIcon({ kind: 'idle', report: report({ quarantined: [{ from: 'a', to: 'b' }] }) });

    assert.equal(conflict, failed);
    assert.equal(failed, aside);
    assert.notEqual(conflict, phaseIcon({ kind: 'idle', report: report({ scanned: 3 }) }), 'and not as "fine"');
  });
});

describe('an account state the server keeps repeating', () => {
  // The live walk that produced this: a vault went over its limit, the plugin said so once in
  // a twenty-second notice, and every surface then read "up to date" while the server refused
  // every write. A state is not a moment, and the surfaces a person actually has are the
  // status bar and the ribbon.
  const frozen = report({ events: [{ type: 'account_frozen', at: '2026-08-20T00:00:00Z' }] });

  it('holds the status bar for as long as the server keeps sending it', () => {
    assert.match(shortStatus({ kind: 'idle', report: frozen }), /over your limit/);
  });

  it('outranks a clean pass, because it is the reason the pass was clean', () => {
    // Nothing moved and nothing failed — which reads as "up to date" and is the opposite of
    // what is true: nothing moved because nothing was accepted.
    assert.ok(!/up to date/.test(shortStatus({ kind: 'idle', report: frozen })));
  });

  it('outranks the outcomes too, which answer a smaller question', () => {
    const alsoFailed = report({
      errors: [{ path: 'a.md', message: 'over_quota' }],
      events: [{ type: 'account_frozen', at: '2026-08-20T00:00:00Z' }],
    });

    assert.match(shortStatus({ kind: 'idle', report: alsoFailed }), /over your limit/);
    assert.equal(phaseIcon({ kind: 'idle', report: alsoFailed }), 'alert-triangle');
  });

  it('shows an ended share the same way, since it also waits on a person', () => {
    const ended = report({ events: [{ type: 'share_ended', share_id: 's', at: '2026-08-20T00:00:00Z' }] });
    assert.match(shortStatus({ kind: 'idle', report: ended }), /shared folder ended/);
  });

  it('says nothing extra when the server reports no state at all', () => {
    const quiet = report({ scanned: 3 });
    assert.match(shortStatus({ kind: 'idle', report: quiet }), /up to date/);
    assert.equal(phaseIcon({ kind: 'idle', report: quiet }), 'check-circle');
  });
});
