/**
 * Which screen the console shows — the one judgement this workspace makes that is not the
 * API's.
 *
 * The point of the module is that the decision is testable without a browser: the
 * dependencies are functions, and a fake supplies each branch. Two properties matter — the
 * right screen for each state, and that only the question the branch needs is ever asked
 * (a signed-in console never hits /health, and a first-run server never hits /admin/restore).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chooseScreen, sessionEnded, type Screen, type ScreenDeps } from '../src/screen.js';

const harness = (over: Partial<ScreenDeps> = {}) => {
  const calls: string[] = [];
  const track = <A extends unknown[], R>(name: string, fn: (...a: A) => R): ((...a: A) => R) => (...a) => {
    calls.push(name);
    return fn(...a);
  };
  const base: ScreenDeps = {
    signedIn: () => false,
    restoreStatus: async () => ({ pending: false }),
    health: async () => ({ bootstrap_pending: false }),
  };
  const deps: ScreenDeps = {
    signedIn: over.signedIn ?? base.signedIn,
    restoreStatus: track('restoreStatus', over.restoreStatus ?? base.restoreStatus),
    health: track('health', over.health ?? base.health),
  };
  return { deps, calls };
};

describe('choosing the console screen', () => {
  it('signed in and nothing pending shows the accounts screen, and asks only the restore status', async () => {
    const { deps, calls } = harness({ signedIn: () => true });
    assert.equal(await chooseScreen(deps), 'accounts');
    assert.deepEqual(calls, ['restoreStatus'], '/health is never asked of a signed-in console');
  });

  it('a pending restore outranks the accounts screen', async () => {
    const { deps, calls } = harness({ signedIn: () => true, restoreStatus: async () => ({ pending: true }) });
    assert.equal(await chooseScreen(deps), 'restore');
    assert.deepEqual(calls, ['restoreStatus']);
  });

  it('a fresh server shows the first run, and asks only health', async () => {
    const { deps, calls } = harness({ health: async () => ({ bootstrap_pending: true }) });
    assert.equal(await chooseScreen(deps), 'firstRun');
    assert.deepEqual(calls, ['health'], '/admin/restore is never asked before signing in');
  });

  it('a server that has been set up shows the sign-in screen', async () => {
    const { deps, calls } = harness();
    assert.equal(await chooseScreen(deps), 'signIn');
    assert.deepEqual(calls, ['health']);
  });
});

describe('a session that has ended rather than an act that was refused', () => {
  // The live walk: Audit log, then Accounts, and the page went to "unauthenticated" above a
  // "Loading…" that was never going to resolve. The console holds its token in memory and asks
  // for no refresh, so a tab left open outlives it — which is a change of screen, not a
  // sentence to read.
  class ApiError extends Error {
    constructor(readonly status: number, readonly code: string) {
      super(code);
    }
  }

  it('reads the token being no good as the session being over', () => {
    assert.equal(sessionEnded(new ApiError(401, 'unauthenticated')), true);
  });

  it('does not read a mistyped password that way', () => {
    // Same status, different word, and the server picks it deliberately: sending this person
    // to the sign-in screen would be sending them where they already are, told their session
    // had ended when they had never had one.
    assert.equal(sessionEnded(new ApiError(401, 'invalid_credentials')), false);
  });

  it('does not read a refusal to act that way', () => {
    // A demoted or disabled administrator is authenticated and is being told no. Signing in
    // again changes nothing about it.
    assert.equal(sessionEnded(new ApiError(403, 'forbidden')), false);
  });

  it('is unbothered by anything that is not a refusal at all', () => {
    assert.equal(sessionEnded(new TypeError('failed to fetch')), false);
    assert.equal(sessionEnded(undefined), false);
    assert.equal(sessionEnded('unauthenticated'), false);
  });
});
