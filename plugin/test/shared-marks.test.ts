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

  it('gives EVERY shared folder the badge, not only the last one', () => {
    // `a, b .x::after` binds the descendant part to `b` alone, so a list built by writing the
    // suffix after the joined selectors badged whichever folder came last and styled the rest
    // on a rule that does nothing. Invisible with one shared folder; measured with two, where
    // the first folder's row reported `content: none` against a stylesheet naming it.
    const css = sharedFolderCss(['Notes', 'Work/Team']);
    const badges = css.match(/\.nav-folder-title-content::after/g) ?? [];
    assert.equal(badges.length, 2, `one badge selector per folder:
${css}`);
    for (const path of ['Notes', 'Work/Team']) {
      assert.ok(
        css.includes(`.nav-folder-title[data-path="${path}"] .nav-folder-title-content::after`),
        `${path} carries the badge itself:
${css}`,
      );
    }
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
