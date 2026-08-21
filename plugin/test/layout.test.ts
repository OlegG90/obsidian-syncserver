/**
 * The parts of the settings layout that are decisions rather than markup (#130).
 *
 * A `PluginSettingTab` cannot be constructed outside Obsidian, so what a screen *believes* is
 * where this project's defects live — six times over. These are the beliefs: what the last
 * action was, and how much of the trash is actually on screen.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lastActionLine } from '../src/last-action.js';
import { matching, showing } from '../src/trash-filter.js';

describe('the last thing that happened', () => {
  const at = new Date('2026-08-21T14:32:05Z').getTime();

  it('carries the time, because the question is “did that work”', () => {
    const line = lastActionLine({ at, message: 'SyncServer: “Team” is shared. Invite somebody to it.' })!;
    assert.ok(line.startsWith(new Date(at).toLocaleTimeString()));
    assert.match(line, /“Team” is shared/);
  });

  it('drops the notification prefix, which is not for a screen of its own', () => {
    const line = lastActionLine({ at, message: 'SyncServer: paired.' })!;
    assert.ok(!line.includes('SyncServer:'));
    assert.match(line, /paired\./);
  });

  it('says nothing at all when nothing has happened', () => {
    // A row reading "nothing yet" is a row somebody has to read before ignoring.
    assert.equal(lastActionLine(undefined), undefined);
  });
});

describe('finding one file in the trash', () => {
  const rows = [{ name: 'notes/2026/august.md' }, { name: 'Recipes/soup.md' }, { name: 'AUGUSTINE.md' }];

  it('matches anywhere in the name, not only the start', () => {
    // A trashed file is looked for by the word somebody remembers, which is rarely the first.
    assert.deepEqual(matching(rows, 'august').map((r) => r.name), ['notes/2026/august.md', 'AUGUSTINE.md']);
  });

  it('ignores case and stray spaces', () => {
    assert.equal(matching(rows, '  SOUP ').length, 1);
  });

  it('returns everything for an empty query, and a copy rather than the original', () => {
    const all = matching(rows, '   ');
    assert.equal(all.length, 3);
    assert.notEqual(all, rows, 'the caller sorts and slices what it gets back');
  });
});

describe('saying how much is on screen', () => {
  it('is silent when the screen holds everything', () => {
    assert.equal(showing(12, 12, 12), undefined);
  });

  it('separates “this is a page” from “this is a filter”', () => {
    // Different situations with different next steps: one is answered by discarding, the other
    // by typing something else. Collapsing them into "showing 3 of 900" tells a person the
    // file they are looking for is not there when it may simply be on another page.
    assert.match(showing(200, 200, 900)!, /most recently deleted of 900/);
    assert.match(showing(3, 12, 12)!, /^Showing 3 of 12\.$/);
  });

  it('says all three when all three differ', () => {
    const said = showing(3, 200, 900)!;
    assert.match(said, /3 of the 200 most recently deleted/);
    assert.match(said, /out of 900/);
  });
});
