/**
 * The share endpoints that exist before anyone else is involved (docs/04).
 *
 * Shapes are normative and come from docs/04's endpoint table, including the snake_case on
 * the wire that every other route here already speaks. The service holds the decisions;
 * this file validates the shape of what arrived and turns a refusal into a status.
 */
import { body, optional } from '../http-schema.js';
import type { CreateNodeBody } from '@syncserver/shared';
import { CreateShareBody, FinalizeLeaveBody, InviteBody, JoinShareBody, PrepareShareBody } from '@syncserver/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
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
  recipientPubkey,
  listMembers,
  listShares,
  removeMember,
} from './service.js';
import { preparationOwed, replicaOf } from './owed.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A node's name as a conversion sends it, once `badName` has passed it: the body's own fields, all present.
 */
type WireName = Required<Pick<NonNullable<PrepareShareBody['items']>[number], 'node_id' | 'name_enc' | 'name_hmac' | 'name_key_id'>>;

/** The key material that travels with it, in the wire's spelling. */
type WireEnvelope = NonNullable<CreateNodeBody['blob_envelopes']>[number];
type WireTag = NonNullable<CreateNodeBody['dedup_tags']>[number];


/**
 * Which of a converted node's fields is malformed, or nothing.
 *
 * Both conversions check the same four, because a conversion is the same act in both
 * directions — only the scope it moves to differs.
 */
const badName = (n: Partial<WireName> | undefined): string | undefined => {
  if (!UUID.test(n?.node_id ?? '')) return 'bad_node_id';
  if (!UUID.test(n?.name_key_id ?? '')) return 'bad_name_key_id';
  if (!n?.name_enc || !n.name_hmac) return 'name_required';
  return undefined;
};

/**
 * One converted node, in the spelling the service speaks.
 *
 * Preparing a share moves a subtree from `KV` to `KS`; leaving moves it back. They are one
 * operation run in two directions (`sharing.ts` says so on the client side, where a single
 * `rekey` serves both), and the payloads differ only in what the fields are **called**:
 * `blob_envelopes` going in, `vault_envelopes` coming out. That naming is deliberate — it
 * makes a body meant for one endpoint fail at the other rather than half-apply — but it is
 * the only difference, and translating it twice invited the two to drift.
 */
const converted = (n: WireName, envelopes: WireEnvelope[] = [], tags: WireTag[] = []) => ({
  nodeId: n.node_id,
  nameEnc: n.name_enc,
  nameHmac: n.name_hmac,
  nameKeyId: n.name_key_id,
  envelopes: envelopes.map((e) => ({ sha256: e.sha256, scopeId: e.scope_id, wrappedKey: e.wrapped_key })),
  dedupTags: tags.map((t) => ({ sha256: t.sha256, scopeId: t.scope_id, contentTag: t.content_tag })),
});

/**
 * How large a departure may be, in bytes of request body (#335).
 *
 * Finalizing a departure is the one request that must carry a **whole replica**: the server
 * refuses a pass that misses a live node, so it cannot be split the way preparation is. Under
 * Fastify's default of 1 MiB, a share past a certain size could not be left at all.
 *
 * Measured from the plugin's own `leaveShare` output, per node: a folder 281 B, a file 804 B,
 * and every version behind the head another ~245 B (its envelope). 1 MiB was therefore about
 * 1300 files with no history — about 320 with ten versions each. 16 MiB takes ~20k plain files
 * or ~5k files ten versions deep. The body is held in memory several times over while it is
 * parsed, so this stays well inside a 256 MB container rather than raising every route with it:
 * the rest keep the default, having no reason to accept megabytes.
 */
export const FINALIZE_BODY_LIMIT = 16 * 1024 * 1024;

export const registerShareRoutes = (app: FastifyInstance, db: Db, cfg: Config): void => {
  /**
   * Who to seal the share key to. Answers an unknown login with a deterministic fake rather
   * than a 404 (D-73) — the caller cannot read "no such account" out of it, and must not try.
   */
  app.get<{ Params: { shareId: string; login: string } }>(
    '/shares/:shareId/recipients/:login/pubkey',
    { preValidation: requireAuth },
    async (req, reply) => {
      const out = await recipientPubkey(
        db,
        cfg.serverSecret,
        req.caller!.userId,
        req.params.shareId,
        decodeURIComponent(req.params.login),
      );
      if ('kind' in out) return refuse(reply, out);
      return { user_id: out.userId, pubkey: out.pubkey };
    },
  );

  app.post<{
    Body: CreateShareBody | undefined;
  }>('/shares', { preValidation: requireAuth, ...body(optional(CreateShareBody)) }, async (req, reply) => {
    const body = req.body ?? ({} as Record<string, string>);
    // Three client-chosen identifiers, so three that are checked rather than passed
    // through. The scope id in particular becomes a primary key.
    for (const field of ['vault_id', 'node_id', 'subtree_key_id'] as const) {
      if (!UUID.test(body[field] ?? '')) return reply.code(400).send({ error: `bad_${field}` });
    }
    if (!body.wrapped_key_initiator) return reply.code(400).send({ error: 'wrapped_key_initiator_required' });

    // `!`: each id passed the test above, which is a regex the compiler cannot follow.
    const out = await createShare(db, req.caller!.userId, {
      vaultId: body.vault_id!,
      nodeId: body.node_id!,
      subtreeKeyId: body.subtree_key_id!,
      wrappedKeyInitiator: Buffer.from(body.wrapped_key_initiator, 'base64'),
    });
    if ('kind' in out) return refuse(reply, out);
    return reply.code(201).send({ share_id: out.shareId, state: out.state });
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/cancel',
    { preValidation: requireAuth },
    async (req, reply) => {
      const refusal = await cancelShare(db, req.caller!.userId, req.params.shareId);
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.post<{
    Params: { shareId: string };
    Body: PrepareShareBody | undefined;
  }>('/shares/:shareId/prepare', { preValidation: requireAuth, ...body(optional(PrepareShareBody)) }, async (req, reply) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) return reply.code(400).send({ error: 'items_required' });
    for (const i of items) {
      const bad = badName(i);
      if (bad) return reply.code(400).send({ error: bad });
    }

    const refusal = await prepareShare(
      db,
      req.caller!.userId,
      req.params.shareId,
      // Every item passed `badName` above, which is what makes it a whole name.
      items.map((i) => converted(i as WireName, i.blob_envelopes, i.dedup_tags)),
    );
    if (!refusal) return reply.code(204).send();
    return refuse(reply, refusal);
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/activate',
    { preValidation: requireAuth },
    async (req, reply) => {
      const out = await activateShare(db, req.caller!.userId, req.params.shareId);
      if ('kind' in out) return refuse(reply, out);
      return { state: out.state };
    },
  );

  app.post<{ Params: { shareId: string }; Body: InviteBody | undefined }>(
    '/shares/:shareId/invite',
    { preValidation: requireAuth, ...body(optional(InviteBody)) },
    async (req, reply) => {
      const body = req.body ?? ({} as Record<string, string>);
      if (!UUID.test(body.user_id ?? '')) return reply.code(400).send({ error: 'bad_user_id' });
      if (!body.wrapped_key) return reply.code(400).send({ error: 'wrapped_key_required' });

      const refusal = await invite(db, req.caller!.userId, req.params.shareId, {
        targetUserId: body.user_id!, // tested above
        wrappedKey: Buffer.from(body.wrapped_key, 'base64'),
      });
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.post<{
    Params: { shareId: string };
    Body: JoinShareBody | undefined;
  }>('/shares/:shareId/join', { preValidation: requireAuth, ...body(optional(JoinShareBody)) }, async (req, reply) => {
    const body = req.body ?? ({} as Record<string, string>);
    for (const field of ['vault_id', 'parent_id', 'name_key_id'] as const) {
      if (!UUID.test(body[field] ?? '')) return reply.code(400).send({ error: `bad_${field}` });
    }
    if (!body.name_enc || !body.name_hmac) return reply.code(400).send({ error: 'name_required' });

    // `!`: each id passed the test above, which is a regex the compiler cannot follow.
    const out = await joinShare(db, req.caller!.userId, req.params.shareId, {
      vaultId: body.vault_id!,
      parentId: body.parent_id!,
      nameEnc: body.name_enc,
      nameHmac: body.name_hmac,
      nameKeyId: body.name_key_id!,
    });
    if ('kind' in out) return refuse(reply, out);
    return reply.code(201).send({ root_node_id: out.rootNodeId });
  });

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/decline',
    { preValidation: requireAuth },
    async (req, reply) => {
      const refusal = await declineInvitation(db, req.caller!.userId, req.params.shareId);
      if (!refusal) return reply.code(204).send();
      return refuse(reply, refusal);
    },
  );

  app.delete<{ Params: { shareId: string; userId: string } }>(
    '/shares/:shareId/members/:userId',
    { preValidation: requireAuth },
    async (req, reply) => {
      const out = await removeMember(db, req.caller!.userId, req.params.shareId, req.params.userId);
      if ('kind' in out) return refuse(reply, out);
      // The outcome is reported rather than left to be inferred: withdrawing frees a slot
      // immediately, revoking leaves a replica somebody still has to finalize, and a client
      // that cannot tell them apart cannot say which happened.
      // `ended` travels with a revoke: removing the last participant closes the share for
      // everybody (SH-07), and the initiator's client has a different thing to say then.
      return out.ended === undefined ? { outcome: out.outcome } : { outcome: out.outcome, ended: out.ended };
    },
  );

  app.get<{ Params: { shareId: string } }>(
    '/shares/:shareId/replica',
    { preValidation: requireAuth },
    async (req, reply) => {
      const rows = await replicaOf(db, req.caller!.userId, req.params.shareId);
      if (!rows) return reply.code(404).send({ error: 'not_found' });
      return rows.map((n) => ({
        node_id: n.nodeId,
        name_enc: n.nameEnc,
        name_key_id: n.nameKeyId,
        type: n.type,
        deleted: n.deleted,
        sha256: n.sha256,
        needs_vault_material: n.needsVaultMaterial,
        history_needing_material: n.history,
      }));
    },
  );

  app.get<{ Params: { shareId: string } }>(
    '/shares/:shareId/preparation',
    { preValidation: requireAuth },
    async (req, reply) => {
      const rows = await preparationOwed(db, req.caller!.userId, req.params.shareId);
      if (!rows) return reply.code(404).send({ error: 'not_found' });
      return rows.map((n) => ({
        node_id: n.nodeId,
        name_enc: n.nameEnc,
        name_key_id: n.nameKeyId,
        type: n.type,
        deleted: n.deleted,
        sha256: n.sha256,
        needs_share_material: n.needsMaterial,
        history_needing_material: n.history,
      }));
    },
  );

  app.post<{ Params: { shareId: string } }>(
    '/shares/:shareId/leave/begin',
    { preValidation: requireAuth },
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
    Body: FinalizeLeaveBody | undefined;
  }>('/shares/:shareId/finalize-leave', { preValidation: requireAuth, bodyLimit: FINALIZE_BODY_LIMIT, ...body(optional(FinalizeLeaveBody)) }, async (req, reply) => {
    const nodes = req.body?.nodes;
    if (!Array.isArray(nodes)) return reply.code(400).send({ error: 'nodes_required' });
    for (const n of nodes) {
      const bad = badName(n);
      if (bad) return reply.code(400).send({ error: bad });
    }

    const refusal = await finalizeLeave(
      db,
      req.caller!.userId,
      req.params.shareId,
      // Every node passed `badName` above, which is what makes it a whole name.
      nodes.map((n) => converted(n as WireName, n.vault_envelopes, n.vault_dedup_tags)),
    );
    if (!refusal) return reply.code(204).send();
    return refuse(reply, refusal);
  });

  app.get('/shares', { preValidation: requireAuth }, async (req) => {
    const { joined, invitations } = await listShares(db, req.caller!.userId);
    // This device's vault's shares, once the server knows which vault that is (D-140). Invitations stay:
    // they belong to no vault until one accepts them.
    const own = req.caller!.vaultId;
    return {
      joined: joined.filter((s) => !own || s.vaultId === own).map((s) => ({
        share_id: s.shareId,
        vault_id: s.vaultId,
        is_initiator: s.isInitiator,
        state: s.state,
        root_node_id: s.rootNodeId,
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
    { preValidation: requireAuth },
    async (req, reply) => {
      const rows = await listMembers(db, req.caller!.userId, req.params.shareId);
      // One answer for "no such share" and "not yours to see", because distinguishing them
      // would report on another account's shares (D-20).
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
