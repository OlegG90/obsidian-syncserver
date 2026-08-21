/**
 * The rule in front of a passphrase change (#138).
 *
 * The new passphrase is not proved against anything — it becomes what the envelope is sealed
 * under. A typo succeeds, and is discovered at the next unlock by somebody who can no longer
 * open their vault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { whatIsWrong, wayBack } from '../src/passphrase-form.js';

const draft = (over: Partial<Parameters<typeof whatIsWrong>[0]> = {}) => ({
  current: 'the one in use',
  next: 'correct horse battery staple',
  again: 'correct horse battery staple',
  ...over,
});

describe('before a passphrase is changed', () => {
  it('wants the current one, because an open vault is not the person', () => {
    // The session is already unlocked, so this proves nothing to the server. It proves who is
    // at the keyboard, which an Obsidian window somebody walked away from does not.
    assert.match(whatIsWrong(draft({ current: '' }))!, /current passphrase is needed/);
  });

  it('asks twice, and says why: nothing will check it afterwards', () => {
    const need = whatIsWrong(draft({ again: '' }));
    assert.match(need!, /second time/);
    assert.match(need!, /a typo becomes the passphrase/);
  });

  it('calls a mismatch a mismatch, without deciding which is wrong', () => {
    const need = whatIsWrong(draft({ again: 'correct horse battery stapel' }));
    assert.match(need!, /different/);
    assert.match(need!, /Neither has been used/);
  });

  it('refuses the passphrase already in use', () => {
    assert.match(whatIsWrong(draft({ next: 'the one in use', again: 'the one in use' }))!, /already has/);
  });

  it('is silent when the change is ready', () => {
    assert.equal(whatIsWrong(draft()), undefined);
  });
});

describe('what it says about the way back', () => {
  it('says nothing until the server has answered', () => {
    // Guessing would either frighten somebody who is covered or reassure somebody who is not,
    // and the second is how an account is lost.
    assert.equal(wayBack(undefined), undefined);
  });

  it('names the recovery code as the way back, and not the server', () => {
    const said = wayBack(true)!;
    assert.match(said, /recoverable/);
    assert.match(said, /not by the server/);
  });

  it('is blunt when there is no code, and says what to do first', () => {
    const said = wayBack(false)!;
    assert.match(said, /NO recovery code/);
    assert.match(said, /would end this account/);
    assert.match(said, /Make a code first/);
  });
});
