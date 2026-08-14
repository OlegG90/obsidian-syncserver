/**
 * The share endpoints that exist before anyone else is involved (docs/04).
 *
 * Shapes are normative and come from docs/04's endpoint table, including the snake_case on
 * the wire that every other route here already speaks. The service holds the decisions;
 * this file validates the shape of what arrived and turns a refusal into a status.
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { cancelShare, createShare, listMembers, listShares } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerShareRoutes = (app: FastifyInstance, db: Db): void => {
  app.post<{
    Body: { vault_id: string; node_id: string; subtree_key_id: string; wrapped_key_initiator: string };
  }>('/shares', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body ?? ({} as Record<string, string>);
    // Three client-chosen identifiers, so three that are checked rather than passed
    // through. The scope id in particular becomes a primary key.
    for (const field of ['vault_id', 'node_id', 'subtree_key_id'] as const) {
      if (!UUID.test(body[field] ?? '')) return reply.code(400).send({ error: `bad_${field}` });
    }
    if (!body.wrapped_key_initiator) return reply.code(400).send({ error: 'wrapped_key_initiator_required' });

    const out = await createShare(db, req.caller!.userId, {
      vaultId: body.vault_id,
      nodeId: body.node_id,
      subtreeKeyId: body.subtree_key_id,
      wrappedKeyInitiator: Buffer.from(body.wrapped_key_initiator, 'base64'),
    });
    if ('kind' in out) return refuse(reply, out);
    return reply.code(201).send({ share_id: out.shareId, state: out.state });
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/cancel',
    { preHandler: requireAuth },
    async (req, reply) => {
      const refusal = await cancelShare(db, req.caller!.userId, req.params.shareId);
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.get('/shares', { preHandler: requireAuth }, async (req) => {
    const { joined, invitations } = await listShares(db, req.caller!.userId);
    return {
      joined: joined.map((s) => ({
        share_id: s.shareId,
        vault_id: s.vaultId,
        is_initiator: s.isInitiator,
        state: s.state,
      })),
      invitations: invitations.map((i) => ({
        share_id: i.shareId,
        initiator_login: i.initiatorLogin,
        invited_at: i.invitedAt,
      })),
    };
  });

  app.get<{ Params: { shareId: string } }>(
    '/shares/:shareId/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rows = await listMembers(db, req.caller!.userId, req.params.shareId);
      // One answer for "no such share" and "not yours to see", because distinguishing them
      // would report on another account's shares (#20).
      if (!rows) return reply.code(404).send({ error: 'not_found' });

      return rows.map((m) => ({
        user_id: m.userId,
        login: m.login,
        is_initiator: m.isInitiator,
        invited_at: m.invitedAt,
        joined_at: m.joinedAt,
        finalizing: m.finalizing,
      }));
    },
  );
};
