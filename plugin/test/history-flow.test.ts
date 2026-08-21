/**
 * The trash coordinator, unit-tested against fakes.
 *
 * It exists so these decisions are not made inside a `PluginSettingTab`, which cannot be
 * constructed outside Obsidian — the gap four of five defects lived in when a phone was first
 * used. What is asserted here is exactly what a settings tab must not decide: whether an
 * irreversible act asks first, what it says afterwards, and that nothing runs twice at once.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApiError } from '../src/api/client.js';
import { newestFirst, openHistoryFlow, type HistoryFlowDeps } from '../src/history-flow.js';
import { openGate } from '../src/gate.js';

const rows = [
  { nodeId: 'n1', name: 'note.md', type: 'file', deletedAt: '2026-08-01T00:00:00Z', versions: 3, shared: false },
];

const deps = (over: Partial<HistoryFlowDeps> = {}) => {
  const said: string[] = [];
  const asked: string[] = [];
  const base: HistoryFlowDeps = {
    gate: openGate(),
    trash: async () => ({ rows, total: rows.length }),
    versions: async () => [{ rev: 7, size: 10, at: '2026-08-01T00:00:00Z' }],
    restore: async () => undefined,
    discard: async () => ({ purged: 1, thawed: false }),
    usage: async () => ({ used: 10, quota: 100, frozen: false }),
    confirm: async (q) => {
      asked.push(q);
      return true;
    },
    notify: (m) => said.push(m),
    done: () => undefined,
    ...over,
  };
  return { deps: base, said, asked };
};

describe('discarding asks first', () => {
  it('names the file in the question, not a count', async () => {
    // "Discard 1 item" is what somebody agrees to by reflex; the name is what makes them
    // read it.
    const { deps: d, asked } = deps();
    await openHistoryFlow(d).discard('n1', 'note.md');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /note\.md/);
    assert.match(asked[0]!, /cannot be undone/);
  });

  it('does nothing at all when the answer is no', async () => {
    let called = false;
    const { deps: d } = deps({ confirm: async () => false, discard: async () => { called = true; return { purged: 1, thawed: false }; } });
    await openHistoryFlow(d).discard('n1', 'note.md');
    assert.equal(called, false, 'a dismissal is not consent');
  });

  it('says whether that was enough to lift a freeze', async () => {
    // The question somebody emptying their trash actually has. "3 items discarded" answers
    // one they did not ask.
    const { deps: d, said } = deps({ discard: async () => ({ purged: 3, thawed: true }) });
    await openHistoryFlow(d).empty(3);
    assert.match(said.join(' '), /no longer over its limit/);
  });

  it('refuses to ask about an empty trash', async () => {
    const { deps: d, asked, said } = deps();
    await openHistoryFlow(d).empty(0);
    assert.equal(asked.length, 0, 'nothing to confirm');
    assert.match(said.join(' '), /already empty/);
  });
});

describe('one operation at a time', () => {
  it('turns a second press into a sentence rather than a second discard', async () => {
    let running = 0;
    let peak = 0;
    const { deps: d, said } = deps({
      discard: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { purged: 1, thawed: false };
      },
    });
    const flow = openHistoryFlow(d);
    await Promise.all([flow.discard('n1', 'a.md'), flow.discard('n1', 'a.md')]);

    assert.equal(peak, 1, 'discarding is irreversible; a queue of them is not a feature');
    assert.ok(said.some((s) => /already running/.test(s)), `expected a busy notice: ${said.join(' | ')}`);
  });
});

describe('what a refusal says', () => {
  it('explains a blocked restore instead of repeating the status', async () => {
    const { deps: d, said } = deps({
      restore: async () => {
        throw new ApiError(409, 'name_taken', 'blocked by n9');
      },
    });
    await openHistoryFlow(d).restore('n1', 7);
    assert.match(said.join(' '), /already there under that name/);
  });

  it('tells a frozen account what to do about it', async () => {
    const { deps: d, said } = deps({
      restore: async () => {
        throw new ApiError(413, 'frozen', 'over quota');
      },
    });
    await openHistoryFlow(d).restore('n1', 7);
    assert.match(said.join(' '), /Discard something first/);
  });
});

describe('the screen asks for several things at once', () => {
  it('lets the usage and the trash arrive together', async () => {
    // Found by a live walk, not by anything above. The settings section issues both without
    // awaiting either — they fill in different parts of one page — and a guard that covered
    // every call let whichever arrived second fail with "something else is running". What a
    // person saw was a broken trash beside a working usage line, while the server had
    // answered both correctly.
    const { deps: d, said } = deps({
      trash: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { rows, total: rows.length };
      },
    });
    const flow = openHistoryFlow(d);
    const [trash, usage] = await Promise.all([flow.trash(), flow.usage()]);

    assert.ok(trash, `the trash came back empty-handed: ${said.join(' | ')}`);
    assert.ok(usage, 'and so did the usage');
    assert.deepEqual(said, [], 'neither of them had to apologise for the other');
  });

  it('still refuses a second discard while one is running', async () => {
    // The guard is about irreversible acts, and it has to keep being about them.
    let peak = 0;
    let running = 0;
    const { deps: d, said } = deps({
      discard: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return { purged: 1, thawed: false };
      },
    });
    const flow = openHistoryFlow(d);
    await Promise.all([flow.discard('n1', 'a.md'), flow.discard('n1', 'a.md')]);
    assert.equal(peak, 1);
    assert.ok(said.some((s) => /already running/.test(s)));
  });
});

describe('which revision is the newest (#125)', () => {
  // `VersionRow` said "newest first" in a comment and the settings tab restored `versions[0]`
  // — the newest by POSITION. Position is the server's to decide, and a client reading an
  // ordering as a fact restores whatever is first on the day the query gains an `ORDER BY`
  // somebody thought was equivalent. Silently, and over the newest copy of a file.
  const v = (rev: number, at: string) => ({ rev, at, size: rev * 100 });

  it('orders by revision, whatever order they arrive in', () => {
    const jumbled = [v(18, '2026-08-05T08:55:00Z'), v(31, '2026-08-12T18:31:00Z'), v(27, '2026-08-11T14:02:00Z')];

    assert.deepEqual(
      newestFirst(jumbled).map((x) => x.rev),
      [31, 27, 18],
    );
  });

  it('leaves the caller a list of its own', () => {
    // The rows come from a fetch the screen may draw twice; sorting them in place would
    // reorder somebody else's array as a side effect of reading it.
    const rows = [v(1, '2026-08-01T00:00:00Z'), v(2, '2026-08-02T00:00:00Z')];
    newestFirst(rows);

    assert.deepEqual(
      rows.map((x) => x.rev),
      [1, 2],
      'the input is untouched',
    );
  });

  it('orders by revision rather than by clock', () => {
    // `rev` is monotonic per node (docs/03); `at` is a timestamp, and two writes inside one
    // second are not a tie the client should be breaking.
    const sameSecond = [v(9, '2026-08-12T18:31:00Z'), v(10, '2026-08-12T18:31:00Z')];

    assert.equal(newestFirst(sameSecond)[0]!.rev, 10);
  });

  it('has nothing to say about an empty list', () => {
    assert.deepEqual(newestFirst([]), []);
  });
});
