/**
 * `WS /events` — the new-revision notification channel (docs/04).
 *
 * Auth is the first message, not the URL: a token in the query string settles into access
 * logs, and a browser `WebSocket` cannot set a header. The client connects, sends the access
 * token, and either gets `ok` (and a stream of `{vault_id, head_rev}` for its account's
 * vaults) or `refused` and a close.
 *
 * The socket lives as long as the access token does; the client refreshes and reconnects,
 * which is the ordinary token lifecycle. The hub is shared across all connections and owns
 * the single `LISTEN` on the channel (docs/04).
 */
import type { FastifyInstance } from 'fastify';
import type { EventsHub } from './events.js';

export const registerEventsRoutes = (app: FastifyInstance, hub: EventsHub): void => {
  app.get('/events', { websocket: true }, (socket, req) => {
    // Auth is the first frame, and only it is interesting; anything after is noise. A
    // client that never sends it is closed off so a half-open socket cannot hang the pool.
    let accountId: string | undefined;
    const timeout = setTimeout(() => {
      if (accountId === undefined) socket.close(4001, 'auth_timeout');
    }, 10_000);
    let unsub: (() => void) | undefined;

    socket.on('message', (raw) => {
      if (accountId !== undefined) return;

      let token: string | undefined;
      try {
        token = (JSON.parse(raw.toString()) as { token?: string }).token;
      } catch {
        /* refused below */
      }
      if (!token) {
        socket.send(JSON.stringify({ error: 'refused' }));
        socket.close(4002, 'no_token');
        return;
      }

      // The JWT verify is synchronous: it returns the claims or throws.
      let claims: { sub?: string };
      try {
        claims = req.server.jwt.verify<{ sub?: string }>(token);
      } catch {
        socket.send(JSON.stringify({ error: 'refused' }));
        socket.close(4003, 'invalid_token');
        return;
      }
      if (!claims?.sub) {
        socket.send(JSON.stringify({ error: 'refused' }));
        socket.close(4003, 'invalid_token');
        return;
      }
      accountId = claims.sub;
      clearTimeout(timeout);
      unsub = hub.subscribe({
        accountId: accountId,
        send: (msg) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
        },
      });
      socket.send(JSON.stringify({ status: 'ok' }));
    });

    socket.on('close', () => unsub?.());
  });
};
