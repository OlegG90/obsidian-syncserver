/**
 * The rule in front of a password change.
 *
 * The stake is unusual and worth naming: a mistyped new password locks this console for good.
 * The server hashes what it is handed, `/auth/bootstrap` refuses once a password exists, and
 * there is nobody who can put one back — so the second field is guarding a door with no key
 * under the mat.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { whatIsWrong, MIN_LENGTH } from '../src/password-form.js';

const draft = (over: Partial<Parameters<typeof whatIsWrong>[0]> = {}) => ({
  current: 'the one in use',
  next: 'a longer replacement',
  again: 'a longer replacement',
  ...over,
});

describe('before a password is changed', () => {
  it('wants the current one, and says why being signed in is not enough', () => {
    const need = whatIsWrong(draft({ current: '' }));
    assert.match(need!, /current password is needed/);
    assert.match(need!, /not proof of the person/);
  });

  it('holds the server’s floor, and gives the reason for it', () => {
    const need = whatIsWrong(draft({ next: 'x'.repeat(MIN_LENGTH - 1) }));
    assert.match(need!, /too short/);
    assert.match(need!, /nothing slows a guess down/);
    assert.equal(whatIsWrong(draft({ next: 'x'.repeat(MIN_LENGTH), again: 'x'.repeat(MIN_LENGTH) })), undefined);
  });

  it('asks twice, naming the risk it is guarding', () => {
    const need = whatIsWrong(draft({ again: '' }));
    assert.match(need!, /second time/);
    assert.match(need!, /lock this console for good/);
  });

  it('calls a mismatch a mismatch, without deciding which is wrong', () => {
    const need = whatIsWrong(draft({ again: 'a longer replacemant' }));
    assert.match(need!, /different/);
    assert.match(need!, /Neither has been set/);
  });

  it('refuses the password already in use', () => {
    // Not a security rule — the server would accept it. It is that somebody who typed the same
    // thing twice meant to change something and did not.
    assert.match(whatIsWrong(draft({ next: 'the one in use', again: 'the one in use' }))!, /already has/);
  });

  it('is silent when the change is ready', () => {
    assert.equal(whatIsWrong(draft()), undefined);
  });
});
