/**
 * `WS /events` — the new-revision notification channel (docs/04).
 *
 * Auth is the first message, not the URL, and the handshake itself lives in `ws-auth.ts`;
 * this route binds it to the shared caller predicate and to the hub. A client either gets
 * `ok` (and a stream of `{vault_id, head_rev}` for its account's vaults) or `refused` and
 * a close.
 *
 * The socket lives as long as the access token does; the client refreshes and reconnects,
 * which is the ordinary token lifecycle. The hub is shared across all connections and owns
 * the single `LISTEN` on the channel (docs/04).
 */
import type { FastifyInstance } from 'fastify';
import type { EventsHub } from './events.js';
import { verifyCaller } from './auth/guard.js';
import { beginSocketAuth } from './ws-auth.js';

export const registerEventsRoutes = (app: FastifyInstance, hub: EventsHub): void => {
  app.get('/events', { websocket: true }, (socket, req) => {
    let unsub: (() => void) | undefined;
    const auth = beginSocketAuth({
      send: (msg) => socket.send(JSON.stringify(msg)),
      close: (code, reason) => socket.close(code, reason),
      verify: (token) => {
        // The JWT verify is synchronous: it returns the claims or throws.
        let claims: { sub?: string; device?: string };
        try {
          claims = req.server.jwt.verify<{ sub?: string; device?: string }>(token);
        } catch {
          return undefined;
        }
        // The same policy as every HTTP route: a token names an account AND a device (D-90).
        return verifyCaller(claims);
      },
      onAuthenticated: (caller) => {
        unsub = hub.subscribe({
          accountId: caller.userId,
          send: (msg) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
          },
        });
      },
    });

    socket.on('message', (raw) => auth.onMessage(raw));
    socket.on('close', () => {
      auth.dispose();
      unsub?.();
    });
  });
};
