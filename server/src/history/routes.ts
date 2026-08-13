import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import { ownsVault } from '../account.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse.js';
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

  app.get<{ Params: { vaultId: string }; Querystring: { under?: string } }>(
    '/vaults/:vaultId/trash',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!(await ownsVault(db, req.caller!.userId, req.params.vaultId))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return listTrash(db, req.params.vaultId, req.query.under);
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
};
