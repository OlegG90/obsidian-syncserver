/**
 * First run: the server answers one thing until it has an administrator (#107).
 *
 * `schema.sql` seeds an unredeemed invitation for the first administrator — the only shape
 * the server can create, since keys are born on a device (#83). That token is a default
 * credential, and two properties make it acceptable; this file is the second one.
 *
 *   1. redeeming it is what replaces it — the invitation is consumed and the row becomes
 *      the operator's own keyed account, so there is no state in which the default still
 *      works;
 *   2. while it is outstanding the server does nothing else. The window is the first run,
 *      not "until somebody remembers".
 *
 * Neither half works alone, which is why the guard is not optional and not a warning.
 */
import type { FastifyInstance } from 'fastify';
import type { Db } from './db.js';

/** The only routes reachable before an administrator exists. */
// /health is open too: a server waiting for its first administrator is working as
// designed, and a container marked unhealthy for it would never be allowed to finish
// starting.
const OPEN_DURING_BOOTSTRAP = new Set(['/auth/kdf', '/auth/redeem', '/health']);

export const hasActiveAdministrator = async (db: Db): Promise<boolean> => {
  const row = await db.one<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE state = 'active' AND role = 'admin') AS exists`,
  );
  return row?.exists ?? false;
};

/**
 * Re-arm the seeded invitation if it expired unredeemed.
 *
 * A bricked server helps nobody: without this, an installation left alone for longer than
 * the seeded expiry can never be set up at all. It is safe precisely because of the guard
 * above — while there is no administrator the token opens nothing except the act that
 * replaces it.
 */
export const rearmBootstrapInvitation = async (db: Db): Promise<boolean> => {
  const rows = await db.query(
    `UPDATE users SET invite_expires_at = now() + interval '7 days'
      WHERE role = 'admin' AND state = 'provisioned' AND invite_expires_at <= now()
      RETURNING id`,
  );
  return rows.length > 0;
};

export const registerBootstrapGuard = (app: FastifyInstance, db: Db): void => {
  // Cached: once an administrator exists the answer can never go back to false —
  // users_last_admin_stays keeps at least one of them from then on.
  let settled = false;

  app.addHook('onRequest', async (req, reply) => {
    if (settled || OPEN_DURING_BOOTSTRAP.has(req.url.split('?')[0] ?? '')) return;

    if (await hasActiveAdministrator(db)) {
      settled = true;
      return;
    }

    return reply.code(503).send({
      error: 'bootstrap_pending',
      message:
        'This server has no administrator yet. Redeem the seeded invitation for login "admin" ' +
        'from a client; that is what replaces the default token.',
    });
  });
};
