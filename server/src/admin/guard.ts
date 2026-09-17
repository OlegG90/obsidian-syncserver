/**
 * Who is allowed to act on somebody else's account.
 *
 * A second guard rather than a flag on the first, because the two answer different questions
 * and only one of them costs a query. `requireAuth` reads a token; this reads the database,
 * since a role can be taken away between a token being minted and being used — and an
 * administrator demoted an hour ago must not still be one for the life of their access token.
 *
 * **Active, not merely an administrator.** A disabled account keeps its role in the row (the
 * two are separate columns, deliberately: disabling is reversible and demotion is a different
 * decision), so a check on the role alone would let a disabled operator carry on.
 *
 * The refusal is `403` and says which of the two it was, because "you are signed in as
 * somebody who cannot do this" and "your account is switched off" call for different actions
 * from the person reading it.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import type { Actor } from './audit.js';
import { verifyCaller } from '../auth/guard.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The administrator this request is acting as, filled in by `requireAdmin`. */
    admin?: Actor;
  }
}

export const requireAdmin = (db: Db) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  // The same token rule every other route is held to, not a copy of it: two policies for one
  // server is how the newest path drifts (`auth/guard.ts`).
  const caller = verifyCaller(await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined));
  if (!caller) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }

  // The device comes with the account, for the reason `requireAuth` gives (#373): signing the console
  // out revokes its device row, and a token minted before that would otherwise keep administering.
  const row = await db.one<{ login: string; role: string; state: string; revoked: boolean }>(
    `SELECT u.login, u.role::text AS role, u.state::text AS state, d.revoked_at IS NOT NULL AS revoked
       FROM users u JOIN devices d ON d.user_id = u.id AND d.id = $2
      WHERE u.id = $1`,
    [caller.userId, caller.deviceId],
  );
  if (row?.revoked) {
    await reply.code(401).send({ error: 'device_revoked' });
    return;
  }
  if (!row || row.state !== 'active') {
    await reply.code(403).send({ error: 'forbidden', detail: 'this account is not active' });
    return;
  }
  if (row.role !== 'admin') {
    await reply.code(403).send({ error: 'forbidden', detail: 'this account is not an administrator' });
    return;
  }

  req.caller = caller;
  req.admin = { id: caller.userId, login: row.login };
};
