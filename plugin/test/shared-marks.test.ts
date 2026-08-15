/**
 * The badge on a shared folder, as a pure function of the paths.
 *
 * It is CSS rather than element-poking precisely so it can be tested at all: the decision is
 * "which selectors, escaped how", and none of it needs a file explorer to exist.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sharedFolderCss } from '../src/obsidian/shared-marks.js';

/**
 * Built rather than written, and deliberately.
 *
 * A backslash in a test about escaping backslashes is a character that four layers each
 * claim a right to interpret — the editor, the shell that carried the file, TypeScript, and
 * the regular expression. One of them already ate a level and turned this test into an
 * assertion about the backspace character, which passed for the wrong reason until it did
 * not pass at all.
 */
const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

describe('marking a shared folder in the file tree', () => {
  it('selects the folder rows Obsidian actually renders', () => {
    const css = sharedFolderCss(['Notes', 'Work/Team']);
    assert.ok(css.includes('.nav-folder-title[data-path="Notes"]'));
    assert.ok(css.includes('.nav-folder-title[data-path="Work/Team"]'));
    assert.ok(css.includes("content: 'shared'"), 'and says what it is, rather than only colouring it');
  });

  it('produces nothing at all when nothing is shared', () => {
    // Distinguished from "an empty rule set" so the caller can treat no shares and no
    // stylesheet as the same thing, and remove the element instead of leaving a dead one.
    assert.equal(sharedFolderCss([]), '');
    assert.equal(sharedFolderCss(['']), '', 'a path that is not a path is not a folder either');
  });

  it('escapes a quote in a folder name, which would otherwise end the selector early', () => {
    // Vault paths are whatever a person typed. Unescaped, a quote closes the string
    // mid-selector and the rule lands on something else — or on everything.
    const css = sharedFolderCss([`He said ${QUOTE}hi${QUOTE}`]);
    assert.ok(css.includes(`data-path="He said ${BACKSLASH}${QUOTE}hi${BACKSLASH}${QUOTE}"`), css);
  });

  it('escapes a backslash, which CSS would otherwise read as an escape of its own', () => {
    const css = sharedFolderCss([`a${BACKSLASH}b`]);
    assert.ok(css.includes(`data-path="a${BACKSLASH}${BACKSLASH}b"`), css);
  });

  it('states each folder once, however many times it is given', () => {
    const css = sharedFolderCss(['Notes', 'Notes']);
    assert.equal(css.match(/data-path="Notes"/g)?.length, 2, 'once per rule, and there are two rules');
  });
});
