import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';

export interface Caller {
  userId: string;
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
  interface FastifyInstance {
    /** Decorated by `buildApp`, so a guard can ask the database what a token cannot say (#373). */
    db: Db;
  }
}

/**
 * The one answer to "who does this token name". The HTTP guard and the WebSocket
 * handshake share it, so a token the API refuses is refused on the socket too — two
 * weaker policies for one server is exactly how the newest path drifts.
 *
 * The access token must name both the account and the **device**, because a caller that
 * is not attributed to a device cannot be throttled and a session that cannot be signed
 * out one device at a time is a session nobody signs out (D-90).
 */
export const verifyCaller = (
  claims: { sub?: string; device?: string } | undefined,
): Caller | undefined => {
  if (!claims?.sub || !claims.device) return undefined;
  return { userId: claims.sub, deviceId: claims.device };
};

/**
 * Every route outside `/auth` runs behind this.
 *
 * **A valid signature is not enough** (#373). Revoking a device stops it minting new access tokens, and
 * the one it holds stays valid for its whole lifetime — fifteen minutes by default. Blobs were the only
 * family that asked, so a phone somebody revoked went on reading notes, writing them and walking the
 * delta until the token aged out, while D-90 and the plugin both say it stops at once. So the guard asks
 * the database, which is the only place that knows.
 *
 * One indexed lookup per request, deliberately uncached: a cache would hold exactly the answer whose
 * being stale is the whole problem, and the server talks to a database on the same machine.
 *
 * The account's state is read with it. An account may not leave `active` while it owns devices, so in
 * practice the devices are revoked first and this is the second line — but a guard that reads one and
 * trusts the other is a guard with a gap in it.
 */
export const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const claims = await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined);
  const caller = verifyCaller(claims);
  if (!caller) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  if (!(await stillAllowed(req.server.db, caller))) {
    await reply.code(401).send({ error: 'device_revoked' });
    return;
  }
  req.caller = caller;
};

/** Whether this device may still act for this account: not revoked, and the account still active. */
export const stillAllowed = async (db: Db, caller: Caller): Promise<boolean> =>
  Boolean(
    await db.one<{ ok: boolean }>(
      `SELECT true AS ok FROM devices d JOIN users u ON u.id = d.user_id
        WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL AND u.state = 'active'`,
      [caller.deviceId, caller.userId],
    ),
  );
