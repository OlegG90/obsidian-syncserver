/**
 * The change-notification listener: wake on a matching vault, ignore others, and give each
 * reason the server refuses or closes for its one answer (docs/04) — refresh a stale token,
 * refresh an expired one BEFORE reconnecting, stop for a revoked device, and keep the same
 * token when the fault was not the token's.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PushListener, type PushSocket, type PushSocketFactory } from '../src/obsidian/push.js';
import type { RefreshOutcome } from '../src/api/client.js';

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
  refreshResult: RefreshOutcome;
  notified: string[];
  signedOut: number;
}

const makeListener = (over: { token?: string | undefined; refreshResult?: RefreshOutcome; delays?: number[] } = {}) => {
  const sockets: FakeSocket[] = [];
  const factory: PushSocketFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const state: ListenerState = {
    token: 'token' in over ? over.token : 'access-1',
    refreshCalls: 0,
    refreshResult: over.refreshResult ?? 'ok',
    notified: [],
    signedOut: 0,
  };
  const options: import('../src/obsidian/push.js').PushListenerOptions = {
    url: 'ws://x.test/events',
    vaultId: 'vault-1',
    tokenSource: () => state.token,
    refresh: async () => {
      state.refreshCalls++;
      // A refresh that works hands out a token the next connection can be told apart by.
      if (state.refreshResult === 'ok') state.token = `access-${state.refreshCalls + 1}`;
      return state.refreshResult;
    },
    onNotify: (vaultId) => state.notified.push(vaultId),
    onSignedOut: () => state.signedOut++,
    socketFactory: factory,
  };
  if (over.delays) options.delays = over.delays;
  const listener = new PushListener(options);
  return { listener, sockets, state };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One connection, an ending scripted onto it, and what the listener did about it: how often it
 * refreshed, how many sockets it opened, and which token the next one carried.
 */
const afterEnding = async (
  end: (socket: FakeSocket, state: ListenerState) => void,
  over: { refreshResult?: RefreshOutcome } = {},
) => {
  const made = makeListener({ delays: [1], ...over });
  made.listener.start();
  const first = made.sockets[0]!;
  first.open();
  end(first, made.state);
  await sleep(20);
  const next = made.sockets[1];
  next?.open();
  await made.listener.stop();
  const nextToken = next ? (JSON.parse(next.sent[0]!) as { token: string }).token : undefined;
  return { ...made, nextToken };
};

const refused = (reason: string) => JSON.stringify({ error: 'refused', reason });
const ok = JSON.stringify({ status: 'ok' });

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
    await sleep(20);
    const second = sockets[1]!;
    assert.ok(second, 'a second connection is attempted');
    second.open();
    assert.deepEqual(second.sent, [JSON.stringify({ token: 'access-2' })], 'with the refreshed token');
    await listener.stop();
  });

  it('waits for a token instead of spinning when the session is locked', async () => {
    const { listener, sockets } = makeListener({ token: undefined });
    listener.start();
    await sleep(30);
    // No socket should even be attempted while there is no token.
    assert.equal(sockets.length, 0, 'no connection while locked');
    await listener.stop();
  });

  it('stops for a revoked device, with no refresh and no reconnect, and says so once', async () => {
    const out = await afterEnding((s) => {
      s.receive(refused('device_revoked'));
      s.serverClose(4003);
    });
    assert.equal(out.state.refreshCalls, 0, 'a refresh cannot help a revoked device');
    assert.equal(out.sockets.length, 1, 'nothing reconnects');
    assert.equal(out.state.signedOut, 1, 'onSignedOut is how the user comes to hear of it');
  });

  it('refreshes on invalid_token, and reconnects once for the refusal and its close together', async () => {
    const out = await afterEnding((s) => {
      s.receive(refused('invalid_token'));
      s.serverClose(4003);
    });
    assert.equal(out.state.refreshCalls, 1);
    assert.equal(out.sockets.length, 2);
    assert.equal(out.nextToken, 'access-2');
  });

  // Endings that say nothing about the token: the same one tries again, unrefreshed.
  for (const [name, end] of [
    ['auth_timeout', (s: FakeSocket) => s.receive(refused('auth_timeout'))],
    ['no_token', (s: FakeSocket) => s.receive(refused('no_token'))],
    ['a 1011 close, which carries no refusal', (s: FakeSocket) => s.serverClose(1011)],
  ] as const) {
    it(`reconnects with the same token on ${name}`, async () => {
      const out = await afterEnding(end);
      assert.equal(out.state.refreshCalls, 0);
      assert.equal(out.nextToken, 'access-1');
    });
  }

  it('refreshes before reconnecting when the server closes for an expired token', async () => {
    const out = await afterEnding((s) => {
      s.receive(ok);
      s.serverClose(4004);
    });
    assert.equal(out.state.refreshCalls, 1, 'refreshed first');
    assert.equal(out.nextToken, 'access-2', 'and the new socket carries the new token');
  });

  it('does not refresh again when the session already holds a newer token', async () => {
    // A sync met the same expiry on its own requests and refreshed for them.
    const out = await afterEnding((s, state) => {
      s.receive(ok);
      state.token = 'access-from-a-sync';
      s.serverClose(4004);
    });
    assert.equal(out.state.refreshCalls, 0);
    assert.equal(out.nextToken, 'access-from-a-sync');
  });

  it('still reconnects when the server could not answer the refresh, because offline is not signed out', async () => {
    const out = await afterEnding(
      (s) => {
        s.receive(ok);
        s.serverClose(4004);
      },
      { refreshResult: 'unavailable' },
    );
    assert.equal(out.state.refreshCalls, 1);
    assert.equal(out.sockets.length, 2, 'the channel keeps trying');
    assert.equal(out.state.signedOut, 0);
  });

  it('stops, and says so once, when the server refuses the refresh token', async () => {
    // The loop this ends: a spent refresh token answered `false` exactly like an offline one,
    // so the channel refreshed and reconnected into the same refusal every eight seconds.
    const out = await afterEnding(
      (s) => {
        s.receive(refused('invalid_token'));
        s.serverClose(4003);
      },
      { refreshResult: 'spent' },
    );
    assert.equal(out.state.refreshCalls, 1);
    assert.equal(out.sockets.length, 1, 'nothing reconnects with a session that has ended');
    assert.equal(out.state.signedOut, 1);
  });
});
