/**
 * The first-message handshake of `WS /events`, and how long what it grants lasts (docs/04).
 *
 * Auth is the first frame, not the URL: a token in the query string settles into access
 * logs, and a browser `WebSocket` cannot set a header. This module owns that handshake —
 * waiting for the first frame, answering `ok` or `refused` with its reason, closing on refusal — and both of
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

/** `setTimeout` wraps past this and fires at once, so a longer wait is taken in steps of it. */
const LONGEST_TIMER_MS = 2 ** 31 - 1;

export const beginSocketAuth = (hooks: SocketAuthHooks, timeoutMs = 10_000): SocketAuth => {
  // Waiting for the first frame; checking it — which asks the database, so further frames can
  // arrive meanwhile and none of them may start a second check; or done, whichever way.
  let phase: 'waiting' | 'verifying' | 'done' = 'waiting';

  /** Refuse, saying why — in the frame as well as the close, since a browser client reads frames
   * far more readily than close reasons, and "refused" alone made it guess which. */
  const refuse = (code: number, reason: string): void => {
    if (!finish()) return;
    hooks.send({ error: 'refused', reason });
    hooks.close(code, reason);
  };

  // The one clock running: the handshake's deadline, then, once it is answered, the token's.
  // The deadline closes off a client that never authenticates, so a half-open socket cannot
  // hang the pool, and it bounds a verification that never answers.
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => refuse(4001, 'auth_timeout'), timeoutMs);

  /** Settle the handshake. False when it already was: the one place "exactly once" is kept. */
  const finish = (): boolean => {
    if (phase === 'done') return false;
    phase = 'done';
    clearTimeout(timer);
    return true;
  };

  /** Close the socket when the token runs out — re-armed, for a lifetime longer than one timer holds. */
  const endAt = (expiresAt: number): void => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      hooks.close(4004, 'token_expired');
      return;
    }
    timer = setTimeout(() => endAt(expiresAt), Math.min(left, LONGEST_TIMER_MS));
    // The socket is what keeps a connection alive, never this clock.
    timer.unref?.();
  };

  const authenticate = async (token: string): Promise<void> => {
    let out: SocketGrant | SocketRefusal;
    try {
      out = await hooks.verify(token);
    } catch {
      // The policy could not be asked — the database, in practice. Closed WITHOUT a `refused`
      // frame, because nothing was refused: that frame is what tells a client its token is no
      // good, and every connected device spending a refresh on a database outage is a second
      // outage. A bare close is answered by reconnecting, which is the right answer to this.
      if (finish()) hooks.close(1011, 'verification_unavailable');
      return;
    }
    if (typeof out === 'string') {
      refuse(4003, out);
      return;
    }
    // False when the socket closed, or the deadline passed, while the answer was on its way.
    if (!finish()) return;
    hooks.onAuthenticated(out.caller);
    hooks.send({ status: 'ok' });
    if (out.expiresAt !== undefined) endAt(out.expiresAt);
  };

  return {
    onMessage(raw) {
      if (phase !== 'waiting') return;
      let token: string | undefined;
      try {
        // The transport hands over a Buffer, a string, or a binary blob; the token frame
        // is text, and anything else fails the JSON parse and is refused.
        token = (JSON.parse(String(raw)) as { token?: string }).token;
      } catch {
        refuse(4002, 'no_token');
        return;
      }
      if (!token) {
        refuse(4002, 'no_token');
        return;
      }
      phase = 'verifying';
      // What can still throw in there is a write to a socket that closed a moment ago, and its
      // `close` event is already on the way to `dispose()`. Nothing is owed to it but not
      // becoming an unhandled rejection.
      void authenticate(token).catch(() => undefined);
    },
    dispose() {
      // Directly rather than through `finish`: after a success the handshake is already done
      // and the clock running is the token's, which has to stop as well.
      phase = 'done';
      clearTimeout(timer);
    },
  };
};
