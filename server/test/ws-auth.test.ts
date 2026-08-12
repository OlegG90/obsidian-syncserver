/**
 * The `WS /events` first-message handshake, driven with scripted hooks.
 *
 * The policy itself (a token names an account and a device) is `verifyCaller`'s, tested at
 * the socket level in events.test.ts; here the module's own contract is pinned down: it
 * settles exactly once, answers `ok` or `refused`, and its timer is gone whatever settled
 * it. The dangling-timer regressions are the point — a refused or silent socket must not
 * leave a 10s close waiting in the dark.
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
    verify: () => caller,
    onAuthenticated: (c) => authed.push(c),
    ...over,
  };
  return { hooks, sent, closed, authed };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = (token?: string) => Buffer.from(JSON.stringify(token === undefined ? {} : { token }));

describe('WS /events first-message handshake', () => {
  it('authenticates the first frame and ignores everything after it', async () => {
    const { hooks, sent, closed, authed } = rig();
    const auth = beginSocketAuth(hooks);
    auth.onMessage(frame('t1'));
    auth.onMessage(frame('t2'));
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
    assert.deepEqual(sent, [{ error: 'refused' }]);
    assert.deepEqual(closed, [[4002, 'no_token']], 'exactly one close — the timer never fires later');
  });

  it('refuses a token the policy rejects, with the same timer guarantee', async () => {
    const { hooks, closed } = rig({ verify: () => undefined });
    const auth = beginSocketAuth(hooks, 5);
    auth.onMessage(frame('bad'));
    await sleep(20);
    assert.deepEqual(closed, [[4003, 'invalid_token']], 'exactly one close — no late auth_timeout');
  });

  it('closes a socket that never authenticates', async () => {
    const { hooks, sent, closed } = rig();
    beginSocketAuth(hooks, 5);
    await sleep(20);
    assert.deepEqual(sent, [{ error: 'refused' }]);
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
});
