/**
 * `WS /events` — the new-revision notification channel (docs/04).
 *
 * Auth is the first message, not the URL, and the handshake itself lives in `ws-auth.ts`;
 * this route binds it to the policy every HTTP route is held to and to the hub. A client
 * either gets `ok` (and a stream of `{vault_id, head_rev}` for the vault its device syncs) or
 * `refused` and a close.
 *
 * The socket lives as long as the access token does — `ws-auth.ts` closes it when the token
 * runs out — and the client refreshes and reconnects, which is the ordinary token lifecycle.
 * The hub is shared across all connections and owns the single `LISTEN` on the channel
 * (docs/04).
 */
import type { FastifyInstance } from 'fastify';
import type { EventsHub } from './events.js';
import { authenticate, type Claims } from './auth/guard.js';
import { beginSocketAuth } from './ws-auth.js';

export const registerEventsRoutes = (app: FastifyInstance, hub: EventsHub): void => {
  app.get('/events', { websocket: true }, (socket, req) => {
    let unsub: (() => void) | undefined;
    const auth = beginSocketAuth({
      send: (msg) => socket.send(JSON.stringify(msg)),
      close: (code, reason) => socket.close(code, reason),
      verify: async (token) => {
        // The JWT verify is synchronous: it returns the claims or throws.
        let claims: Claims;
        try {
          claims = req.server.jwt.verify<Claims>(token);
        } catch {
          return 'invalid_token';
        }
        // The very steps `requireAuth` takes, not a copy of them (#464): a token names an account
        // and a device (D-90), and the device must still be allowed, which only the database
        // knows (#373). A copy here once welcomed a phone the API had already revoked.
        const caller = await authenticate(req.server.db, claims);
        if (caller === 'unauthenticated') return 'invalid_token';
        if (caller === 'device_revoked') return caller;
        return {
          caller,
          ...(claims.exp === undefined ? {} : { expiresAt: claims.exp * 1000 }),
        };
      },
      onAuthenticated: (caller) => {
        unsub = hub.subscribe({
          deviceId: caller.deviceId,
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
