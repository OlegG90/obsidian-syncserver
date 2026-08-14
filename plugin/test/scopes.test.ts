/**
 * Which key a new node's name is encrypted under.
 *
 * These exist because the rule had an exception nobody had written down, and the exception
 * is the FIRST thing a participant does: create a file in the folder somebody shared with
 * them. Inheriting the parent's scope there gave `KV` to a node the schema requires under
 * `KS`, so the write came back as a `check_violation` — from the server, about a rule the
 * client got wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contentScopeFor } from '../src/engine/scopes.js';

const VAULT = 'vault-scope';
const KS = 'share-scope';
const scopes = new Map([['share-1', KS]]);

describe('a node going into a private folder', () => {
  it('takes the vault scope at the root, where there is no parent', () => {
    assert.equal(contentScopeFor(undefined, scopes, VAULT), VAULT);
  });

  it('takes the parent’s scope, which for a private folder is the vault’s', () => {
    assert.equal(contentScopeFor({ nameKeyId: VAULT }, scopes, VAULT), VAULT);
  });
});

describe('a node going into a shared folder', () => {
  it('takes the SHARE key directly under the share root, not the root’s own key', () => {
    // The bug, in one assertion. A share root is named under KV (SH-01) because it lives
    // among private siblings — so inheriting from it is exactly wrong, and it is the most
    // ordinary write a participant makes.
    const root = { nameKeyId: VAULT, shareId: 'share-1' };
    assert.equal(contentScopeFor(root, scopes, VAULT), KS);
  });

  it('takes the share key deeper in too, where the parent already carries it', () => {
    const interior = { nameKeyId: KS, shareId: 'share-1' };
    assert.equal(contentScopeFor(interior, scopes, VAULT), KS);
  });

  it('falls back to the parent’s own scope when the pairing was not reported', () => {
    // Not to the vault key: that would be wrong everywhere inside the share. Falling back
    // to the parent leaves behaviour exactly as it was — wrong at the root, right below it
    // — which is the smaller failure while a client waits for the server to say more.
    const interior = { nameKeyId: KS, shareId: 'unknown-share' };
    assert.equal(contentScopeFor(interior, new Map(), VAULT), KS);
  });

  it('does not mistake a private folder for a shared one', () => {
    assert.equal(contentScopeFor({ nameKeyId: VAULT, shareId: null }, scopes, VAULT), VAULT);
  });
});
