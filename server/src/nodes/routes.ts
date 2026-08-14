import type { FastifyInstance } from 'fastify';
import type { Material as WireMaterial } from '@syncserver/shared';
import { requireAuth } from '../auth/guard.js';
import { ownsVault } from '../account.js';
import type { Db } from '../db.js';
import type { Refusal } from '../refusal.js';
import { refuse } from '../refuse-http.js';
import { createNode, dedupLookup, deleteNode, moveNode, putContent } from './service.js';
import type { Material } from '../material.js';

const HEX64 = /^[0-9a-f]{64}$/;

const isFailure = (v: object): v is Refusal => 'kind' in v;

/** The wire fragment (snake_case) normalised to the service's internal shape. */
const material = (b: WireMaterial): Material => ({
  envelopes: (b.blob_envelopes ?? []).map((e) => ({ sha256: e.sha256, scopeId: e.scope_id, wrappedKey: e.wrapped_key })),
  dedupTags: (b.dedup_tags ?? []).map((t) => ({ sha256: t.sha256, scopeId: t.scope_id, contentTag: t.content_tag })),
});

/**
 * Ownership is checked here and nowhere else in these handlers: a caller may only address
 * a vault of their own account. Vaults are not bound to devices (AC-13), so which one they
 * reach is their choice — but it is still their account's. The predicate itself is shared
 * with every other route family (`account.ts`); this comment is about the call sites.
 */

export const registerNodeRoutes = (app: FastifyInstance, db: Db): void => {
  /**
   * Which of these content tags this vault's own scope already knows, and what address each
   * one currently maps to. See `dedupLookup` for the reasoning; this route is the thin shell
   * around it — parse, bound, validate, delegate.
   */
  app.get<{ Params: { vaultId: string }; Querystring: { tags?: string } }>(
    '/vaults/:vaultId/dedup',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = (req.query.tags ?? '').split(',').filter(Boolean);
      if (raw.length === 0) return reply.code(400).send({ error: 'tags_required' });
      if (raw.length > 500) return reply.code(400).send({ error: 'too_many_tags' });
      if (!raw.every((h) => HEX64.test(h))) return reply.code(400).send({ error: 'bad_tag' });

      const rows = await dedupLookup(db, req.caller!.userId, req.params.vaultId, raw.map((h) => Buffer.from(h, 'hex')));
      return { matches: rows.map((r) => ({ content_tag: r.contentTag, sha256: r.sha256 })) };
    },
  );

  app.post<{
    Params: { vaultId: string };
    Body: WireMaterial & {
      parent_id: string;
      type: 'file' | 'folder';
      sha256?: string;
      size?: number;
      mtime: string;
      name_enc: string;
      name_hmac: string;
      name_key_id: string;
    };
  }>('/vaults/:vaultId/nodes', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const b = req.body;
    if (b.type === 'file' && !b.sha256) return reply.code(400).send({ error: 'content_required' });

    const out = await createNode(db, {
      vaultId: req.params.vaultId,
      parentId: b.parent_id,
      type: b.type,
      sha256: b.sha256,
      size: b.size,
      mtime: b.mtime,
      nameEnc: b.name_enc,
      nameHmac: b.name_hmac,
      nameKeyId: b.name_key_id,
      material: material(b),
    });
    if (isFailure(out)) return refuse(reply, out);
    return reply.code(201).send({ node_id: out.nodeId, rev: out.rev });
  });

  app.put<{
    Params: { vaultId: string; nodeId: string };
    Body: WireMaterial & { sha256: string; size: number; mtime: string; base_sha256: string | null };
  }>('/vaults/:vaultId/nodes/:nodeId', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const out = await putContent(db, {
      vaultId: req.params.vaultId,
      nodeId: req.params.nodeId,
      sha256: req.body.sha256,
      size: req.body.size,
      mtime: req.body.mtime,
      baseSha256: req.body.base_sha256 ?? null,
      material: material(req.body),
    });
    if (isFailure(out)) return refuse(reply, out);
    return { rev: out.rev };
  });

  app.delete<{ Params: { vaultId: string; nodeId: string } }>(
    '/vaults/:vaultId/nodes/:nodeId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const ifMatch = Number(req.headers['if-match']);
      if (!Number.isInteger(ifMatch)) return reply.code(428).send({ error: 'if_match_required' });

      const out = await deleteNode(db, { vaultId: req.params.vaultId, nodeId: req.params.nodeId, ifMatchRev: ifMatch });
      if (isFailure(out)) return refuse(reply, out);
      return { rev: out.rev };
    },
  );

  app.post<{
    Params: { vaultId: string; nodeId: string };
    Body: { parent_id: string; name_enc: string; name_hmac: string; name_key_id: string };
  }>('/vaults/:vaultId/nodes/:nodeId/move', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const ifMatch = Number(req.headers['if-match']);
    if (!Number.isInteger(ifMatch)) return reply.code(428).send({ error: 'if_match_required' });

    const out = await moveNode(db, {
      vaultId: req.params.vaultId,
      nodeId: req.params.nodeId,
      parentId: req.body.parent_id,
      nameEnc: req.body.name_enc,
      nameHmac: req.body.name_hmac,
      nameKeyId: req.body.name_key_id,
      ifMatchRev: ifMatch,
    });
    if (isFailure(out)) return refuse(reply, out);
    return { rev: out.rev };
  });
};
