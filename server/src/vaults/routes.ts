import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import { tokenMatches } from '../crypto.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { resetVault } from './reset.js';
import { createVault, deleteVault, listVaults, readUsage, renameVault } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const registerVaultRoutes = (app: FastifyInstance, db: Db): void => {
  app.get('/vaults', { preHandler: requireAuth }, async (req) => {
    const rows = await listVaults(db, req.caller!.userId);
    return rows.map((v) => ({ id: v.id, name_enc: v.nameEnc, nodes: v.nodes, bytes: v.bytes, shared: v.shared }));
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

  // **Any vault of the account, and a proof the token cannot carry** (D-140). This is the one route a
  // device uses on a vault other than its own — the plugin removes an old vault from the list of the
  // account's — and it is the most destructive one there is. So the token opens it, and the account's
  // `auth_secret` has to come with it: derived from the seed, held only by an unlocked device, and
  // never inside an access token. A token lifted off the wire can list the vaults and delete none.
  app.delete<{ Params: { vaultId: string }; Body: { auth_secret?: unknown } }>(
    '/vaults/:vaultId',
    { preHandler: requireAuth, config: { anyVaultOfTheAccount: true } },
    async (req, reply) => {
      const proof = req.body?.auth_secret;
      const held = await db.one<{ hash: string | null }>(`SELECT auth_secret_hash AS hash FROM users WHERE id = $1`, [
        req.caller!.userId,
      ]);
      if (typeof proof !== 'string' || !held?.hash || !tokenMatches(proof, held.hash)) {
        return reply.code(403).send({
          error: 'proof_required',
          detail: 'removing a vault needs the account unlocked on this device, not only signed in',
        });
      }

      // **`200` with a body, not `204`** (issue #247). Removing a vault is one of the three deletions
      // that can lift a freeze (D-121's neighbours, docs/03), and it was the one that did it silently:
      // the person did what they were told, watched the usage fall, and had to guess whether they were
      // back in. The trash purge has answered `thawed` since it gained the same call.
      const out = await deleteVault(db, req.caller!.userId, req.params.vaultId);
      if ('kind' in out) return refuse(reply, out);
      return out;
    },
  );

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
