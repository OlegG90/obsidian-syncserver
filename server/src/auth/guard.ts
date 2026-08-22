import type { FastifyReply, FastifyRequest } from 'fastify';

export interface Caller {
  userId: string;
  deviceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
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
 */
export const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const claims = await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined);
  const caller = verifyCaller(claims);
  if (!caller) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  req.caller = caller;
};
