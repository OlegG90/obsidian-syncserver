/**
 * The change-notification listener: wake on a matching vault, ignore others, and give each
 * reason the server refuses or closes for its one answer (docs/04) — refresh a stale token,
 * refresh an expired one BEFORE reconnecting, stop for a revoked device, and keep the same
 * token when the fault was not the token's.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushListener, type PushSocket, type PushSocketFactory } from '../src/obsidian/push.js';

/** A socket you can script from the test: open it, feed messages, close it. */
class FakeSocket implements PushSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  /** The client closing it: a browser reports 1005, "no status", for a close it made itself. */
  close(): void {
    this.serverClose(1005);
  }

  /** The server closing it, with the code the server chose. */
  serverClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({ code });
  }

  /** The test opens the socket as the server would. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The test delivers a server message. */
  receive(text: string): void {
    this.onmessage?.({ data: text });
  }
}

interface ListenerState {
  token: string | undefined;
  refreshCalls: number;
  refreshResult: boolean;
  notified: string[];
}

const makeListener = (over: { token?: string | undefined; refreshResult?: boolean; delays?: number[] } = {}) => {
  const sockets: FakeSocket[] = [];
  const factory: PushSocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const state: ListenerState = {
    token: 'token' in over ? over.token : 'access-1',
    refreshCalls: 0,
    refreshResult: over.refreshResult ?? true,
    notified: [],
  };
  const options: import('../src/obsidian/push.js').PushListenerOptions = {
    url: 'ws://x.test/events',
    vaultId: 'vault-1',
    tokenSource: () => state.token,
    refresh: async () => {
      state.refreshCalls++;
      // A refresh that works hands out a token the next connection can be told apart by.
      if (state.refreshResult) state.token = `access-${state.refreshCalls + 1}`;
      return state.refreshResult;
    },
    onNotify: (vaultId) => state.notified.push(vaultId),
    socketFactory: factory,
  };
  if (over.delays) options.delays = over.delays;
  const listener = new PushListener(options);
  return { listener, sockets, state };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('PushListener', () => {
  it('authenticates with the token as the first message, then wakes on a matching vault', async () => {
    const { listener, sockets, state } = makeListener();
    listener.start();

    const socket = sockets[0]!;
    socket.open();
    assert.deepEqual(socket.sent, [JSON.stringify({ token: 'access-1' })], 'the token is the first message');

    socket.receive(JSON.stringify({ status: 'ok' }));
    socket.receive(JSON.stringify({ vault_id: 'vault-1', head_rev: 5 }));
    socket.receive(JSON.stringify({ vault_id: 'vault-2', head_rev: 3 }));

    assert.deepEqual(state.notified, ['vault-1'], 'only the vault this device syncs wakes it');
    await listener.stop();
  });

  it('ignores messages before the auth reply', async () => {
    const { listener, sockets, state } = makeListener();
    listener.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(JSON.stringify({ vault_id: 'vault-1', head_rev: 5 })); // before auth
    assert.deepEqual(state.notified, [], 'nothing before auth');
    await listener.stop();
  });

  it('refreshes and reconnects on a refused token instead of retrying it', async () => {
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();

    const first = sockets[0]!;
    first.open();
    first.receive(JSON.stringify({ error: 'refused' }));

    assert.equal(state.refreshCalls, 1, 'a refusal triggers one refresh');
    assert.equal(first.closed, true, 'the refused socket is closed');

    // The reconnect comes after the (tiny) backoff delay.
    await new Promise((r) => setTimeout(r, 20));
    const second = sockets[1]!;
    assert.ok(second, 'a second connection is attempted');
    second.open();
    assert.deepEqual(second.sent, [JSON.stringify({ token: 'access-2' })], 'with the refreshed token');
    await listener.stop();
  });

  it('waits for a token instead of spinning when the session is locked', async () => {
    const { listener, sockets } = makeListener({ token: undefined });
    listener.start();
    await new Promise((r) => setTimeout(r, 30));
    // No socket should even be attempted while there is no token.
    assert.equal(sockets.length, 0, 'no connection while locked');
    await listener.stop();
  });

  it('stops for a revoked device: no refresh, no reconnect', async () => {
    // The loop this replaced: every refusal read as a stale token, and a revoked device's
    // refresh can only fail, so it went round on backoff for as long as the app was open.
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();
    const first = sockets[0]!;
    first.open();
    first.receive(JSON.stringify({ error: 'refused', reason: 'device_revoked' }));
    first.serverClose(4003);

    await sleep(20);
    assert.equal(state.refreshCalls, 0, 'a refresh cannot help a revoked device');
    assert.equal(sockets.length, 1, 'nothing reconnects');
  });

  it('refreshes on invalid_token, the reason a stale token is given', async () => {
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();
    sockets[0]!.open();
    sockets[0]!.receive(JSON.stringify({ error: 'refused', reason: 'invalid_token' }));
    sockets[0]!.serverClose(4003);

    await sleep(20);
    assert.equal(state.refreshCalls, 1);
    assert.equal(sockets.length, 2, 'one reconnect, not one for the refusal and one for its close');
    await listener.stop();
  });

  it('reconnects with the same token when the handshake timed out', async () => {
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();
    sockets[0]!.open();
    sockets[0]!.receive(JSON.stringify({ error: 'refused', reason: 'auth_timeout' }));

    await sleep(20);
    assert.equal(state.refreshCalls, 0, 'the token was never judged');
    sockets[1]!.open();
    assert.deepEqual(sockets[1]!.sent, [JSON.stringify({ token: 'access-1' })]);
    await listener.stop();
  });

  it('refreshes before reconnecting when the server closes for an expired token', async () => {
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();
    sockets[0]!.open();
    sockets[0]!.receive(JSON.stringify({ status: 'ok' }));
    sockets[0]!.serverClose(4004);

    await sleep(20);
    assert.equal(state.refreshCalls, 1, 'refreshed first');
    sockets[1]!.open();
    assert.deepEqual(sockets[1]!.sent, [JSON.stringify({ token: 'access-2' })], 'and the new socket carries the new token');
    await listener.stop();
  });

  it('keeps the token when the server could not ask its database', async () => {
    // `1011` comes with no `refused` frame: nothing was refused, so nothing is refreshed.
    const { listener, sockets, state } = makeListener({ delays: [1] });
    listener.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(1011);

    await sleep(20);
    assert.equal(state.refreshCalls, 0);
    sockets[1]!.open();
    assert.deepEqual(sockets[1]!.sent, [JSON.stringify({ token: 'access-1' })]);
    await listener.stop();
  });

  it('stops when the refresh fails, instead of reconnecting into the same refusal', async () => {
    const { listener, sockets, state } = makeListener({ delays: [1], refreshResult: false });
    listener.start();
    sockets[0]!.open();
    sockets[0]!.receive(JSON.stringify({ status: 'ok' }));
    sockets[0]!.serverClose(4004);

    await sleep(20);
    assert.equal(state.refreshCalls, 1);
    assert.equal(sockets.length, 1, 'no token can be had, so there is nothing to reconnect with');
  });
});
