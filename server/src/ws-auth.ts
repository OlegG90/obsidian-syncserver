/**
 * The first-message handshake of `WS /events`, and how long what it grants lasts (docs/04).
 *
 * Auth is the first frame, not the URL: a token in the query string settles into access
 * logs, and a browser `WebSocket` cannot set a header. This module owns that handshake —
 * waiting for the first frame, answering `ok` or `refused`, closing on refusal — and both of
 * its clocks, so the route is a thin adapter and no outcome leaves a timer behind.
 *
 * The verification is injected: the route binds it to the JWT and to the same device check
 * `requireAuth` makes. That is the point — the socket is held to the same policy as every
 * HTTP route, not to a weaker one the WS handler invented (docs/04, Change notifications).
 *
 * **The socket ends when its token does.** A token is the only thing this connection ever
 * showed, so a connection that outlived it would be a session nothing vouches for any more —
 * and the one place a device signed out everywhere kept an ear in. The client refreshes and
 * reconnects, which is the ordinary token lifecycle.
 *
 * The handshake settles exactly once. Whatever settles it — a valid token, a refusal, the
 * timeout, or `dispose()` from the socket closing — its timer is gone and no further frame
 * can change the answer.
 */
import type { Caller } from './auth/guard.js';

/** Why a token was turned away. It travels as the close reason, so a log can tell the two apart. */
export type SocketRefusal = 'invalid_token' | 'device_revoked';

export interface SocketGrant {
  caller: Caller;
  /** When the token stops being valid, in epoch milliseconds. Absent for a token that carries no expiry. */
  expiresAt?: number;
}

export interface SocketAuthHooks {
  /** Ships a protocol frame to the client. */
  send(msg: object): void;
  /** Closes the socket with the code and reason this module chose. */
  close(code: number, reason: string): void;
  /** The shared policy: who the token names and until when, or why it is refused. */
  verify(token: string): Promise<SocketGrant | SocketRefusal>;
  /** Called once, on success, before `ok` is sent — the route subscribes the socket here. */
  onAuthenticated(caller: Caller): void;
}

export interface SocketAuth {
  /** Feeds a frame from the socket. Only the first frame can authenticate. */
  onMessage(raw: unknown): void;
  /** Idempotent: from here on nothing settles, and no timer fires. */
  dispose(): void;
}

/** `setTimeout` wraps past this, and fires at once — the opposite of a long-lived token. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export const beginSocketAuth = (hooks: SocketAuthHooks, timeoutMs = 10_000): SocketAuth => {
  let settled = false;
  // The first frame is being checked. The check asks the database, so further frames can
  // arrive while it runs, and none of them may start a second one.
  let verifying = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const settle = (code: number, reason: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    hooks.send({ error: 'refused' });
    hooks.close(code, reason);
  };

  const timeout = setTimeout(() => {
    // A client that never authenticates is closed off so a half-open socket cannot hang
    // the pool. It also bounds a verification that never answers.
    settle(4001, 'auth_timeout');
  }, timeoutMs);

  const authenticate = async (token: string): Promise<void> => {
    let out: SocketGrant | SocketRefusal;
    try {
      out = await hooks.verify(token);
    } catch {
      // The policy could not be asked — the database, in practice. Not the token's fault, and
      // said so: the client's reconnect is the right answer to this one, a refresh is not.
      settle(1011, 'verification_unavailable');
      return;
    }
    // The socket closed, or the timeout fired, while the answer was on its way.
    if (settled) return;
    if (typeof out === 'string') {
      settle(4003, out);
      return;
    }
    settled = true;
    clearTimeout(timeout);
    hooks.onAuthenticated(out.caller);
    hooks.send({ status: 'ok' });
    if (out.expiresAt !== undefined) {
      const left = Math.min(Math.max(out.expiresAt - Date.now(), 0), LONGEST_TIMER_MS);
      expiry = setTimeout(() => hooks.close(4004, 'token_expired'), left);
      // The socket is what keeps a connection alive, never this clock.
      expiry.unref?.();
    }
  };

  return {
    onMessage(raw) {
      if (settled || verifying) return;
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
      verifying = true;
      void authenticate(token);
    },
    dispose() {
      settled = true;
      clearTimeout(timeout);
      clearTimeout(expiry);
    },
  };
};
