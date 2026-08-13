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
 * Every route outside `/auth` runs behind this.
 *
 * The access token names both the account and the **device**, because a limit that is not
 * attributed to a device cannot be throttled and a session that cannot be signed out one
 * device at a time is a session nobody signs out (#90).
 */
export const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const claims = await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined);
  if (!claims?.sub || !claims.device) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  req.caller = { userId: claims.sub, deviceId: claims.device };
};
