import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import { registerBlobRoutes } from './blobs/routes.js';
import { inProcessRateLimiter } from './blobs/rate.js';
import { openStore } from './blobs/store.js';
import { BlobService } from './blobs/service.js';
import { registerDeltaRoutes } from './delta/routes.js';
import { registerVaultRoutes } from './vaults/routes.js';
import { registerHistoryRoutes } from './history/routes.js';
import { registerNodeRoutes } from './nodes/routes.js';
import { hasActiveAdministrator, rearmBootstrapInvitation, registerBootstrapGuard } from './bootstrap.js';
import type { Config } from './config.js';
import type { Db } from './db.js';

export const buildApp = async (db: Db, cfg: Config): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, { secret: cfg.serverSecret });

  // Registered before the routes so it runs before any of them: while there is no
  // administrator, the only thing this server does is let one be made (#107).
  // Answers whether this process can do its job, which means asking PostgreSQL — a
  // server that is listening but cannot reach the database is not healthy, and a port
  // check would call it so.
  app.get('/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
    } catch {
      return reply.code(503).send({ status: 'database_unreachable' });
    }
    return { status: 'ok', bootstrap_pending: !(await hasActiveAdministrator(db)) };
  });

  registerBootstrapGuard(app, db);
  registerAuthRoutes(app, db, cfg);
  const blobStore = openStore(cfg.blobStorePath);
  const blobService = new BlobService(db, blobStore, inProcessRateLimiter(cfg.limits.uploadBytesPerMinute), cfg.limits);
  registerBlobRoutes(app, db, blobStore, blobService);
  registerNodeRoutes(app, db);
  registerHistoryRoutes(app, db);
  registerVaultRoutes(app, db);
  registerDeltaRoutes(app, db, cfg);

  // A seeded invitation that expired unredeemed would otherwise leave the installation
  // with no way in at all.
  await rearmBootstrapInvitation(db);

  return app;
};
