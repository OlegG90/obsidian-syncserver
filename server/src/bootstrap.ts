/**
 * First run: the server answers one thing until it has an administrator (#107).
 *
 * `schema.sql` seeds the first administrator with NO credential at all: a console account
 * (#115) whose password column is null. `POST /auth/bootstrap` creates that password, and
 * two properties make the window acceptable; this file is the second one.
 *
 *   1. there is nothing to guess. A seeded token or password keeps working for anybody who
 *      never got round to changing it; a null one cannot be used at all, and the statement
 *      that sets it is the same one that moves the row out of the state it matched on;
 *   2. while it is unset the server does nothing else. The window is the first run, not
 *      "until somebody remembers".
 *
 * Neither half works alone, which is why the guard is not optional and not a warning.
 */
import type { FastifyInstance } from 'fastify';
import { CONSOLE_PATHS } from './console.js';
import type { Db } from './db.js';

/** The only routes reachable before an administrator exists. */
// /health is open too: a server waiting for its first administrator is working as
// designed, and a container marked unhealthy for it would never be allowed to finish
// starting.
//
// The console's own files are open too, and they have to be: on a fresh server the only
// screen that matters is the one that sets the first password, and a guard that answered
// 503 to the page carrying it would make the server unreachable by the very thing meant to
// start it. The list stays exact rather than a prefix — "everything under /" would open the
// whole API, which is the opposite of what this file is for.
const OPEN_DURING_BOOTSTRAP = new Set(['/auth/kdf', '/auth/bootstrap', '/health', ...CONSOLE_PATHS]);

export const hasActiveAdministrator = async (db: Db): Promise<boolean> => {
  const row = await db.one<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM users WHERE state = 'active' AND role = 'admin') AS exists`,
  );
  return row?.exists ?? false;
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
        'This server has no administrator yet. Set the first administrator password at ' +
        'POST /auth/bootstrap — creating it is what makes this server usable, and there is ' +
        'no default to change.',
    });
  });
};
