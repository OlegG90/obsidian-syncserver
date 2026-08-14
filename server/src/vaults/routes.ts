import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse.js';
import { resetVault } from './reset.js';
import { createVault, deleteVault, listVaults, readUsage, renameVault } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerVaultRoutes = (app: FastifyInstance, db: Db): void => {
  app.get('/vaults', { preHandler: requireAuth }, async (req) => {
    const rows = await listVaults(db, req.caller!.userId);
    return rows.map((v) => ({ id: v.id, name_enc: v.nameEnc }));
  });

  app.post<{ Body: { id: string; name_enc: string } }>('/vaults', { preHandler: requireAuth }, async (req, reply) => {
    // The id comes from the client and must look like one: it is a primary key the caller
    // chose, so it is the one input here that is not simply passed through.
    if (!UUID.test(req.body?.id ?? '')) return reply.code(400).send({ error: 'bad_vault_id' });
    if (!req.body?.name_enc) return reply.code(400).send({ error: 'name_enc_required' });

    const out = await createVault(db, req.caller!.userId, { id: req.body.id, nameEnc: req.body.name_enc });
    if ('kind' in out) return refuse(reply, out);
    return reply.code(201).send({ id: out.id, root_node_id: out.rootNodeId });
  });

  app.put<{ Params: { vaultId: string }; Body: { name_enc: string } }>(
    '/vaults/:vaultId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!req.body?.name_enc) return reply.code(400).send({ error: 'name_enc_required' });
      const ok = await renameVault(db, req.caller!.userId, req.params.vaultId, req.body.name_enc);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
    },
  );

  app.delete<{ Params: { vaultId: string } }>('/vaults/:vaultId', { preHandler: requireAuth }, async (req, reply) => {
    const refusal = await deleteVault(db, req.caller!.userId, req.params.vaultId);
    if (!refusal) return reply.code(204).send();
    return refuse(reply, refusal);
  });

  app.post<{ Params: { vaultId: string } }>(
    '/vaults/:vaultId/reset',
    { preHandler: requireAuth },
    async (req, reply) => {
      const out = await resetVault(db, req.caller!.userId, req.params.vaultId);
      if (!out) return reply.code(404).send({ error: 'not_found' });
      // The new epoch goes back before the client uploads its replacement tree: it is what
      // every other device will be answered with, and the caller needs to know it landed.
      return { reset_epoch: out.resetEpoch, root_node_id: out.rootNodeId, removed: out.removed };
    },
  );

  app.get('/usage', { preHandler: requireAuth }, async (req, reply) => {
    const usage = await readUsage(db, req.caller!.userId);
    if (!usage) return reply.code(404).send({ error: 'not_found' });
    return { used: usage.used, quota: usage.quota, frozen: usage.frozen };
  });
};
