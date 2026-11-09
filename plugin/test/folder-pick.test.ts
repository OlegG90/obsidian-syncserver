/**
 * Finding the folder to share by typing (issue #455).
 *
 * The rule that matters is not the matching: it is that the field never names a folder the list
 * does not offer. The list encodes the no-overlap rule by omission, and the free-text field it
 * replaced (issue #125) let a typo arrive as the server's refusal.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickFolder, suggestFolders } from '../src/folder-pick.js';

const offered = ['Archive', 'Archive/2025', 'Projects', 'Projects/Archive/2026', 'Projects/Notes', 'Work/Notes'];

describe('suggestions narrow as the path is typed', () => {
  it('offers everything before anything is typed', () => {
    assert.deepEqual(suggestFolders(offered, '  '), offered);
  });

  it('matches part of any level, ignoring case', () => {
    assert.deepEqual(suggestFolders(offered, 'NOTES').sort(), ['Projects/Notes', 'Work/Notes']);
  });

  it('takes words in any order, each from any level', () => {
    assert.deepEqual(suggestFolders(offered, '2026 proj'), ['Projects/Archive/2026']);
  });

  it('puts a folder named by the last word before the ones that only sit beneath such a name', () => {
    // `Notes/Daily` holds "notes" only in a parent, so it follows the folder that is called that
    // even though it sorts first.
    assert.deepEqual(suggestFolders(['Notes/Daily', 'Projects/Notes'], 'notes'), ['Projects/Notes', 'Notes/Daily']);
  });

  it('suggests nothing outside the offered list', () => {
    assert.deepEqual(suggestFolders(offered, 'Drafts'), []);
  });
});

describe('the field names a folder only when the list offers it', () => {
  it('takes an offered path as typed', () => {
    assert.deepEqual(pickFolder(offered, 'Work/Notes'), { folder: 'Work/Notes' });
  });

  it('forgives case, surrounding space and a trailing slash, and answers with the real spelling', () => {
    assert.deepEqual(pickFolder(offered, '  work/notes/ '), { folder: 'Work/Notes' });
  });

  it('needs the exact spelling when two offered folders differ only by case', () => {
    const both = ['Notes', 'notes'];
    assert.deepEqual(pickFolder(both, 'notes'), { folder: 'notes' });
    const out = pickFolder(both, 'NOTES');
    assert.ok('reason' in out && out.reason.includes('differ only by case'));
  });

  it('refuses part of a path, and says to pick from the list', () => {
    const out = pickFolder(offered, 'Proj');
    assert.ok('reason' in out && out.reason.includes('Pick the folder from the list'));
  });

  it('refuses a folder the list does not offer, and says what is offered', () => {
    // `Drafts` may well exist: unsynced, or inside a share. Sending it would only bring back the
    // server's refusal, which is what the free-text field used to do.
    const out = pickFolder(offered, 'Drafts');
    assert.ok('reason' in out && out.reason.includes('Only synced folders outside every existing share'));
  });

  it('refuses an empty field with something to do', () => {
    const out = pickFolder(offered, '   ');
    assert.ok('reason' in out && out.reason.includes('Type part of a folder path'));
  });
});
