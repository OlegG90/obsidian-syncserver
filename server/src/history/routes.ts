import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import { ownsVault } from '../account.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { purgeTrash } from './purge.js';
import { listTrash, listVersions, restoreNode } from './service.js';

export const registerHistoryRoutes = (app: FastifyInstance, db: Db): void => {
  app.get<{ Params: { vaultId: string; nodeId: string } }>(
    '/vaults/:vaultId/versions/:nodeId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return listVersions(db, req.params.vaultId, req.params.nodeId);
    },
  );

  app.get<{ Params: { vaultId: string }; Querystring: { under?: string; limit?: string } }>(
    '/vaults/:vaultId/trash',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Bounded here rather than trusted, like the audit log: the trash only grows until
      // retention catches up with it.
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      return listTrash(db, req.params.vaultId, req.query.under, limit);
    },
  );

  app.post<{ Params: { vaultId: string }; Body: { node_id: string; rev: number } }>(
    '/vaults/:vaultId/restore',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (!req.body?.node_id || !Number.isInteger(req.body?.rev)) {
        return reply.code(400).send({ error: 'node_id_and_rev_required' });
      }

      const out = await restoreNode(db, {
        vaultId: req.params.vaultId,
        nodeId: req.body.node_id,
        rev: req.body.rev,
      });

      if ('kind' in out) return refuse(reply, out);

      return { rev: out.rev, lifted: out.lifted };
    },
  );

  // Two shapes of one act, and the URL is the only difference: the trash of a vault, or one
  // subtree of it. `DELETE` on the same path the listing is read from, because that is what
  // it is — the listing, emptied.
  //
  // No `If-Match`, unlike the soft delete. A revision precondition asks "is this still what I
  // saw", and what was seen here is a set rather than a row; the answer this returns is the
  // count, so a client that expected more can look again and see why.
  app.delete<{ Params: { vaultId: string } }>(
    '/vaults/:vaultId/trash',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const out = await purgeTrash(db, { vaultId: req.params.vaultId });
      if ('kind' in out) return refuse(reply, out);
      return { purged: out.purged, thawed: out.thawed };
    },
  );

  app.delete<{ Params: { vaultId: string; nodeId: string } }>(
    '/vaults/:vaultId/trash/:nodeId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const out = await purgeTrash(db, { vaultId: req.params.vaultId, nodeId: req.params.nodeId });
      if ('kind' in out) return refuse(reply, out);
      return { purged: out.purged, thawed: out.thawed };
    },
  );
};
