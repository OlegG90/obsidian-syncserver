/**
 * The sentence somebody reads before a vault stops existing on the server (#175).
 *
 * This is a test of wording, which is unusual and deliberate: the wording is the whole safeguard on this
 * action. There is no undo, the server has no second copy, and the count is the only thing that tells
 * "remove the empty one I made by accident" apart from "remove the one with my notes in it".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { removalWarning } from '../src/vault-removal.js';

describe('what removing a vault says it will do', () => {
  it('names how much goes, so two very different decisions do not read the same', () => {
    assert.match(removalWarning(0), /holds nothing on the server/);
    assert.match(removalWarning(1), /^1 item on the server goes|^1 item on the server go/);
    assert.match(removalWarning(1204), /1204 items on the server go/);
  });

  it('says the files are not touched, every time', () => {
    // The rule itself: a removal is server-side and nothing else. If this sentence ever stops saying so,
    // somebody presses the button expecting their folder to survive and has no reason to think otherwise.
    for (const n of [0, 1, 1204]) {
      assert.match(removalWarning(n), /Nothing on any device is deleted/);
      assert.match(removalWarning(n), /removes the server's copy/);
    }
  });

  it('warns that another device will find it gone', () => {
    // The consequence the person cannot see from here: a phone still connected to this vault meets an
    // error rather than a silent resync, and being told that now is what makes the error unsurprising.
    assert.match(removalWarning(3), /still connected to this vault will find it gone/);
  });
});
