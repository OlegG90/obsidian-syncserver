/**
 * What a connect attempt needs before anything reaches the server.
 *
 * This lived in a click handler inside a `PluginSettingTab`, which cannot be constructed
 * outside Obsidian — so the rule that decides whether an account gets created was decided
 * where nothing could watch it. That is the same reason `pairing-flow.ts` was extracted, and
 * the defect it hides here is worse than a wrong message: on one of the three routes, the
 * passphrase is not checked against anything. It is what the keys are made from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { whatIsMissing, type ConnectDraft } from '../src/connect-form.js';

const draft = (over: Partial<ConnectDraft> = {}): ConnectDraft => ({
  serverUrl: 'http://nas.local:8087',
  login: 'oleh',
  passphrase: 'correct horse battery staple',
  again: 'correct horse battery staple',
  token: '7f3a-9c21-e04b-88d1',
  ...over,
});

describe('the three fields every route needs', () => {
  it('names the one that is missing, and names it first', () => {
    // The address before the login before the passphrase, because that is the order they are
    // filled in: telling somebody about a field below the one they are still on is telling
    // them about a problem they have not reached.
    assert.match(whatIsMissing(draft({ serverUrl: '' }), 'pair')!, /server address/);
    assert.match(whatIsMissing(draft({ login: '' }), 'pair')!, /login/);
    assert.match(whatIsMissing(draft({ passphrase: '' }), 'pair')!, /passphrase/);
  });

  it('is silent when a route has what it needs', () => {
    // Silence is the answer, not an empty string: the caller branches on it to decide whether
    // to attempt at all.
    assert.equal(whatIsMissing(draft(), 'pair'), undefined);
    assert.equal(whatIsMissing(draft(), 'recover'), undefined);
    assert.equal(whatIsMissing(draft(), 'claim'), undefined);
  });
});

describe('the claim route asks for the passphrase twice, and the others do not', () => {
  // The asymmetry IS the decision. On `claim` the passphrase is not verified against anything
  // — it is what the account's keys are derived from — so a typo does not fail, it succeeds at
  // making an account nobody can ever open. There is no reset, by design (AC-11): the server
  // never sees the passphrase, so nobody can help afterwards, and the invitation that would
  // let somebody start again is one-time and by then spent.

  it('refuses a claim with the second field empty', () => {
    const need = whatIsMissing(draft({ again: '' }), 'claim');
    assert.match(need!, /second time/);
    assert.match(need!, /cannot be recovered from a typo/, 'and says why it is asking');
  });

  it('refuses a claim where the two differ, without calling either of them wrong', () => {
    // Neither is wrong yet, and the person is the only one who knows which they meant. A
    // message that picked one would be guessing on their behalf about the thing that cannot
    // be undone.
    const need = whatIsMissing(draft({ again: 'correct horse battery stapel' }), 'claim');
    assert.match(need!, /different/);
    assert.match(need!, /Neither has been used/);
  });

  it('lets a claim through when they match', () => {
    assert.equal(whatIsMissing(draft(), 'claim'), undefined);
  });

  it('does NOT ask twice when pairing or recovering', () => {
    // There the passphrase is proved against something that already exists — an envelope, a
    // verifier — so a typo fails loudly and costs one retry. Asking twice would charge those
    // routes for a risk they do not carry.
    assert.equal(whatIsMissing(draft({ again: '' }), 'pair'), undefined);
    assert.equal(whatIsMissing(draft({ again: 'something else entirely' }), 'recover'), undefined);
  });

  it('asks for the token last, after the passphrase is settled', () => {
    // A token is the cheap thing to fix — it is on screen in the console and can be reissued.
    // The passphrase is the one that cannot, so it is the one resolved first.
    const need = whatIsMissing(draft({ token: '', again: '' }), 'claim');
    assert.match(need!, /second time/, 'the irreversible field is asked about before the replaceable one');
    assert.match(whatIsMissing(draft({ token: '' }), 'claim')!, /invitation token/);
  });

  it('wants no token on the routes that are not claiming one', () => {
    assert.equal(whatIsMissing(draft({ token: '' }), 'pair'), undefined);
    assert.equal(whatIsMissing(draft({ token: '' }), 'recover'), undefined);
  });
});
