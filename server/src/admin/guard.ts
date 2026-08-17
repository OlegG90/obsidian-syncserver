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

declare module 'fastify' {
  interface FastifyRequest {
    /** The administrator this request is acting as, filled in by `requireAdmin`. */
    admin?: Actor;
  }
}

export const requireAdmin = (db: Db) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const claims = await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined);
  if (!claims?.sub || !claims.device) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }

  const row = await db.one<{ login: string; role: string; state: string }>(
    `SELECT login, role::text AS role, state::text AS state FROM users WHERE id = $1`,
    [claims.sub],
  );
  if (!row || row.state !== 'active') {
    await reply.code(403).send({ error: 'forbidden', detail: 'this account is not active' });
    return;
  }
  if (row.role !== 'admin') {
    await reply.code(403).send({ error: 'forbidden', detail: 'this account is not an administrator' });
    return;
  }

  req.caller = { userId: claims.sub, deviceId: claims.device };
  req.admin = { id: claims.sub, login: row.login };
};
