/**
 * The recovery row's two states, and the rule that they are two.
 *
 * A live walk found the screen in neither: it had made a code and was still describing an
 * account without one, with a button that would have replaced it silently. The defect was not
 * in either branch — it was the screen believing a fact it had stopped checking.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recoveryRow } from '../src/recovery-row.js';

describe('what the recovery row says', () => {
  it('offers to create when there is nothing, and names the stake', () => {
    const row = recoveryRow(false);
    assert.match(row.button, /^Create/);
    assert.match(row.desc, /no recovery code/);
    assert.match(row.desc, /would be the end of it/, 'why it is worth having, not just that it is absent');
  });

  it('offers to replace when there is one, and says what replacing costs', () => {
    const row = recoveryRow(true);
    assert.match(row.button, /^Replace/);
    assert.match(row.desc, /has a recovery code/);
    assert.match(row.desc, /old one stops working/);
  });

  it('never lets the button and the sentence disagree', () => {
    // The defect, stated as a property: a button reading "Create" beside a line saying the
    // account has one is exactly what a person saw after making their first code.
    for (const present of [true, false]) {
      const row = recoveryRow(present);
      assert.equal(/^Replace/.test(row.button), /has a recovery code/.test(row.desc), String(present));
    }
  });

  it('asks before replacing and not before creating', () => {
    // Creating adds a way in; replacing takes one away, and somebody may be holding the old
    // code on paper. Only one of those deserves a question.
    assert.equal(recoveryRow(true).confirms, true);
    assert.equal(recoveryRow(false).confirms, false);
  });
});
