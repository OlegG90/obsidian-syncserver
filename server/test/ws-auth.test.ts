/**
 * The `WS /events` first-message handshake, driven with scripted hooks.
 *
 * The policy itself (a token names an account and a device that is still allowed) is the
 * route's, tested at the socket level in events.test.ts; here the module's own contract is
 * pinned down: it settles exactly once, answers `ok` or `refused`, ends the socket when the
 * token ends, and its timers are gone whatever settled it. The dangling-timer regressions are
 * the point — a refused or silent socket must not leave a close waiting in the dark.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Caller } from '../src/auth/guard.js';
import { beginSocketAuth, type SocketAuthHooks } from '../src/ws-auth.js';

const caller: Caller = { userId: 'u1', deviceId: 'd1' };

const rig = (over: Partial<SocketAuthHooks> = {}) => {
  const sent: object[] = [];
  const closed: Array<[number, string]> = [];
  const authed: Caller[] = [];
  const hooks: SocketAuthHooks = {
    send: (m) => sent.push(m),
    close: (code, reason) => closed.push([code, reason]),
    verify: async () => ({ caller }),
    onAuthenticated: (c) => authed.push(c),
    ...over,
  };
  return { hooks, sent, closed, authed };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = (token?: string) => Buffer.from(JSON.stringify(token === undefined ? {} : { token }));

describe('WS /events first-message handshake', () => {
  it('authenticates the first frame and ignores everything after it', async () => {
    let asked = 0;
    const { hooks, sent, closed, authed } = rig({
      verify: async () => {
        asked++;
        return { caller };
      },
    });
    const auth = beginSocketAuth(hooks);
    auth.onMessage(frame('t1'));
    // While the first is still being checked, and after it has been.
    auth.onMessage(frame('t2'));
    await sleep(5);
    auth.onMessage(frame('t3'));
    await sleep(5);
    assert.equal(asked, 1, 'the policy was asked once');
    assert.deepEqual(authed, [caller], 'authenticated once');
    assert.deepEqual(sent, [{ status: 'ok' }], 'one ok, nothing else');
    assert.deepEqual(closed, [], 'nothing refused');
    auth.dispose();
    auth.dispose();
  });

  it('refuses a frame without a token, and no timer is left behind', async () => {
    const { hooks, sent, closed } = rig();
    const auth = beginSocketAuth(hooks, 5);
    auth.onMessage(frame());
    await sleep(20);
    assert.deepEqual(sent, [{ error: 'refused', reason: 'no_token' }]);
    assert.deepEqual(closed, [[4002, 'no_token']], 'exactly one close — the timer never fires later');
  });

  it('refuses a token the policy rejects, with the same timer guarantee', async () => {
    const { hooks, closed } = rig({ verify: async () => 'invalid_token' });
    const auth = beginSocketAuth(hooks, 5);
    auth.onMessage(frame('bad'));
    await sleep(20);
    assert.deepEqual(closed, [[4003, 'invalid_token']], 'exactly one close — no late auth_timeout');
  });

  it('says which refusal it was: a revoked device is not a bad token', async () => {
    const { hooks, sent, closed, authed } = rig({ verify: async () => 'device_revoked' });
    beginSocketAuth(hooks, 5).onMessage(frame('t'));
    await sleep(20);
    assert.deepEqual(sent, [{ error: 'refused', reason: 'device_revoked' }], 'the frame names it too');
    assert.deepEqual(closed, [[4003, 'device_revoked']]);
    assert.deepEqual(authed, []);
  });

  it('closes without a refusal when the policy cannot be asked: the token was not judged', async () => {
    const { hooks, sent, closed, authed } = rig({
      verify: async () => {
        throw new Error('the database is away');
      },
    });
    beginSocketAuth(hooks, 50).onMessage(frame('t'));
    await sleep(10);
    // No `refused` frame: that is what makes a client spend a refresh, and nothing was refused.
    assert.deepEqual(sent, []);
    assert.deepEqual(closed, [[1011, 'verification_unavailable']]);
    assert.deepEqual(authed, []);
  });

  it('closes a socket that never authenticates', async () => {
    const { hooks, sent, closed } = rig();
    beginSocketAuth(hooks, 5);
    await sleep(20);
    assert.deepEqual(sent, [{ error: 'refused', reason: 'auth_timeout' }]);
    assert.deepEqual(closed, [[4001, 'auth_timeout']]);
  });

  it('an authenticated socket is not closed by the timer later', async () => {
    const { hooks, closed, authed } = rig();
    const auth = beginSocketAuth(hooks, 5);
    auth.onMessage(frame('t'));
    await sleep(20);
    assert.deepEqual(authed, [caller]);
    assert.deepEqual(closed, [], 'the timer was cleared on success');
  });

  it('dispose() on a silent socket stops the timer', async () => {
    const { hooks, closed } = rig();
    const auth = beginSocketAuth(hooks, 5);
    auth.dispose();
    await sleep(20);
    assert.deepEqual(closed, [], 'nothing fired after dispose');
  });

  it('a socket that closed while its token was being checked is not subscribed', async () => {
    const { hooks, sent, closed, authed } = rig({
      verify: async () => {
        await sleep(10);
        return { caller };
      },
    });
    const auth = beginSocketAuth(hooks, 50);
    auth.onMessage(frame('t'));
    auth.dispose();
    await sleep(30);
    assert.deepEqual(authed, [], 'nothing was subscribed for a socket that is gone');
    assert.deepEqual(sent, []);
    assert.deepEqual(closed, []);
  });
});

describe('WS /events — the socket ends when its token does', () => {
  it('closes with token_expired at the moment the token runs out, and not before', async () => {
    const { hooks, sent, closed } = rig({ verify: async () => ({ caller, expiresAt: Date.now() + 40 }) });
    beginSocketAuth(hooks).onMessage(frame('t'));
    await sleep(10);
    assert.deepEqual(closed, [], 'still open while the token is good');
    await sleep(60);
    assert.deepEqual(closed, [[4004, 'token_expired']]);
    assert.deepEqual(sent, [{ status: 'ok' }], 'an expiry is a close, not a second refusal frame');
  });

  it('dispose() takes the expiry clock with it', async () => {
    const { hooks, closed } = rig({ verify: async () => ({ caller, expiresAt: Date.now() + 15 }) });
    const auth = beginSocketAuth(hooks);
    auth.onMessage(frame('t'));
    await sleep(5);
    auth.dispose();
    await sleep(30);
    assert.deepEqual(closed, [], 'a socket already gone is not closed a second time');
  });

  it('a token with no expiry is given no clock', async () => {
    const { hooks, closed } = rig();
    beginSocketAuth(hooks).onMessage(frame('t'));
    await sleep(20);
    assert.deepEqual(closed, []);
  });
});
