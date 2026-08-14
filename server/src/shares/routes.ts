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
import {
  activateShare,
  cancelShare,
  createShare,
  declineInvitation,
  invite,
  finalizeLeave,
  joinShare,
  leaveShare,
  prepareShare,
  listMembers,
  listShares,
  removeMember,
} from './service.js';

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

  app.post<{
    Params: { shareId: string };
    Body: {
      items: {
        node_id: string;
        name_enc: string;
        name_hmac: string;
        name_key_id: string;
        blob_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
        dedup_tags?: { sha256: string; scope_id: string; content_tag: string }[];
      }[];
    };
  }>('/shares/:shareId/prepare', { preHandler: requireAuth }, async (req, reply) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) return reply.code(400).send({ error: 'items_required' });
    for (const i of items) {
      if (!UUID.test(i?.node_id ?? '')) return reply.code(400).send({ error: 'bad_node_id' });
      if (!UUID.test(i?.name_key_id ?? '')) return reply.code(400).send({ error: 'bad_name_key_id' });
      if (!i.name_enc || !i.name_hmac) return reply.code(400).send({ error: 'name_required' });
    }

    const refusal = await prepareShare(
      db,
      req.caller!.userId,
      req.params.shareId,
      items.map((i) => ({
        nodeId: i.node_id,
        nameEnc: i.name_enc,
        nameHmac: i.name_hmac,
        nameKeyId: i.name_key_id,
        envelopes: (i.blob_envelopes ?? []).map((e) => ({
          sha256: e.sha256,
          scopeId: e.scope_id,
          wrappedKey: e.wrapped_key,
        })),
        dedupTags: (i.dedup_tags ?? []).map((t) => ({
          sha256: t.sha256,
          scopeId: t.scope_id,
          contentTag: t.content_tag,
        })),
      })),
    );
    if (!refusal) return reply.code(204).send();
    return refuse(reply, refusal);
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/activate',
    { preHandler: requireAuth },
    async (req, reply) => {
      const out = await activateShare(db, req.caller!.userId, req.params.shareId);
      if ('kind' in out) return refuse(reply, out);
      return { state: out.state };
    },
  );

  app.post<{ Params: { shareId: string }; Body: { user_id: string; wrapped_key: string } }>(
    '/shares/:shareId/invite',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body ?? ({} as Record<string, string>);
      if (!UUID.test(body.user_id ?? '')) return reply.code(400).send({ error: 'bad_user_id' });
      if (!body.wrapped_key) return reply.code(400).send({ error: 'wrapped_key_required' });

      const refusal = await invite(db, req.caller!.userId, req.params.shareId, {
        targetUserId: body.user_id,
        wrappedKey: Buffer.from(body.wrapped_key, 'base64'),
      });
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.post<{
    Params: { shareId: string };
    Body: { vault_id: string; parent_id: string; name_enc: string; name_hmac: string; name_key_id: string };
  }>('/shares/:shareId/join', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body ?? ({} as Record<string, string>);
    for (const field of ['vault_id', 'parent_id', 'name_key_id'] as const) {
      if (!UUID.test(body[field] ?? '')) return reply.code(400).send({ error: `bad_${field}` });
    }
    if (!body.name_enc || !body.name_hmac) return reply.code(400).send({ error: 'name_required' });

    const out = await joinShare(db, req.caller!.userId, req.params.shareId, {
      vaultId: body.vault_id,
      parentId: body.parent_id,
      nameEnc: body.name_enc,
      nameHmac: body.name_hmac,
      nameKeyId: body.name_key_id,
    });
    if ('kind' in out) return refuse(reply, out);
    return reply.code(201).send({ root_node_id: out.rootNodeId });
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/decline',
    { preHandler: requireAuth },
    async (req, reply) => {
      const refusal = await declineInvitation(db, req.caller!.userId, req.params.shareId);
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.delete<{ Params: { shareId: string; userId: string } }>(
    '/shares/:shareId/members/:userId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const out = await removeMember(db, req.caller!.userId, req.params.shareId, req.params.userId);
      if ('kind' in out) return refuse(reply, out);
      // The outcome is reported rather than left to be inferred: withdrawing frees a slot
      // immediately, revoking leaves a replica somebody still has to finalize, and a client
      // that cannot tell them apart cannot say which happened.
      return { outcome: out.outcome };
    },
  );

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/leave/begin',
    { preHandler: requireAuth },
    async (req, reply) => {
      const out = await leaveShare(db, req.caller!.userId, req.params.shareId);
      if ('kind' in out) return refuse(reply, out);
      // Whether the share ended is the caller's to know: it decides what their client tells
      // the person — "you left" or "the share is over for everybody".
      return { ended: out.ended };
    },
  );

  app.post<{
    Params: { shareId: string };
    Body: {
      nodes: {
        node_id: string;
        name_enc: string;
        name_hmac: string;
        name_key_id: string;
        vault_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
        vault_dedup_tags?: { sha256: string; scope_id: string; content_tag: string }[];
      }[];
    };
  }>('/shares/:shareId/finalize-leave', { preHandler: requireAuth }, async (req, reply) => {
    const nodes = req.body?.nodes;
    if (!Array.isArray(nodes)) return reply.code(400).send({ error: 'nodes_required' });
    for (const n of nodes) {
      if (!UUID.test(n?.node_id ?? '')) return reply.code(400).send({ error: 'bad_node_id' });
      if (!UUID.test(n?.name_key_id ?? '')) return reply.code(400).send({ error: 'bad_name_key_id' });
      if (!n.name_enc || !n.name_hmac) return reply.code(400).send({ error: 'name_required' });
    }

    const refusal = await finalizeLeave(
      db,
      req.caller!.userId,
      req.params.shareId,
      nodes.map((n) => ({
        nodeId: n.node_id,
        nameEnc: n.name_enc,
        nameHmac: n.name_hmac,
        nameKeyId: n.name_key_id,
        envelopes: (n.vault_envelopes ?? []).map((e) => ({
          sha256: e.sha256,
          scopeId: e.scope_id,
          wrappedKey: e.wrapped_key,
        })),
        dedupTags: (n.vault_dedup_tags ?? []).map((t) => ({
          sha256: t.sha256,
          scopeId: t.scope_id,
          contentTag: t.content_tag,
        })),
      })),
    );
    if (!refusal) return reply.code(204).send();
    return refuse(reply, refusal);
  });

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
