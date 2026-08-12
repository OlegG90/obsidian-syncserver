/**
 * The change-notification listener: wake on a matching vault, ignore others, and treat a
 * refused token as "refresh and reconnect" rather than a reason to keep retrying the same
 * stale token.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushListener, type PushSocket, type PushSocketFactory } from '../src/obsidian/push.js';

/** A socket you can script from the test: open it, feed messages, close it. */
class FakeSocket implements PushSocket {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0; // CONNECTING
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.();
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
      return state.refreshResult;
    },
    onNotify: (vaultId) => state.notified.push(vaultId),
    socketFactory: factory,
  };
  if (over.delays) options.delays = over.delays;
  const listener = new PushListener(options);
  return { listener, sockets, state };
};

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
    assert.deepEqual(second.sent, [JSON.stringify({ token: 'access-1' })]);
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
});
