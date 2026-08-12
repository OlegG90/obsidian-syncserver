/**
 * The first-message handshake of `WS /events` (docs/04).
 *
 * Auth is the first frame, not the URL: a token in the query string settles into access
 * logs, and a browser `WebSocket` cannot set a header. This module owns that handshake —
 * waiting for the first frame, answering `ok` or `refused`, closing on refusal — and its
 * timeout, so the route is a thin adapter and no outcome leaves a timer behind.
 *
 * The verification is injected: the route binds the shared `verifyCaller` predicate to the
 * JWT. That is the point — the socket is held to the same policy as every HTTP route, not
 * to a weaker one the WS handler invented (docs/04, Change notifications).
 *
 * The module settles exactly once. Whatever settles it — a valid token, a refusal, the
 * timeout, or `dispose()` from the socket closing — the timer is gone and no further
 * frame can change the answer.
 */
import type { Caller } from './auth/guard.js';

export interface SocketAuthHooks {
  /** Ships a protocol frame to the client. */
  send(msg: object): void;
  /** Closes the socket with the code and reason this module chose. */
  close(code: number, reason: string): void;
  /** The shared policy: the caller the token names, or nothing. */
  verify(token: string): Caller | undefined;
  /** Called once, on success, before `ok` is sent — the route subscribes the socket here. */
  onAuthenticated(caller: Caller): void;
}

export interface SocketAuth {
  /** Feeds a frame from the socket. Only the first frame can authenticate. */
  onMessage(raw: unknown): void;
  /** Idempotent: from here on nothing settles, and no timer fires. */
  dispose(): void;
}

export const beginSocketAuth = (hooks: SocketAuthHooks, timeoutMs = 10_000): SocketAuth => {
  let settled = false;

  const settle = (code: number, reason: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    hooks.send({ error: 'refused' });
    hooks.close(code, reason);
  };

  const timeout = setTimeout(() => {
    // A client that never authenticates is closed off so a half-open socket cannot hang
    // the pool.
    settle(4001, 'auth_timeout');
  }, timeoutMs);

  return {
    onMessage(raw) {
      if (settled) return;
      let token: string | undefined;
      try {
        // The transport hands over a Buffer, a string, or a binary blob; the token frame
        // is text, and anything else fails the JSON parse and is refused.
        token = (JSON.parse(String(raw)) as { token?: string }).token;
      } catch {
        settle(4002, 'no_token');
        return;
      }
      if (!token) {
        settle(4002, 'no_token');
        return;
      }
      const caller = hooks.verify(token);
      if (!caller) {
        settle(4003, 'invalid_token');
        return;
      }
      settled = true;
      clearTimeout(timeout);
      hooks.onAuthenticated(caller);
      hooks.send({ status: 'ok' });
    },
    dispose() {
      settled = true;
      clearTimeout(timeout);
    },
  };
};
