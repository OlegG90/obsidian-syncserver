import fastifyJwt from '@fastify/jwt';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HealthResponse } from '@syncserver/shared';
import { registerAuthRoutes } from './auth/routes.js';
import { inProcessAttemptLimiter, type AttemptLimiter } from './auth/attempts.js';
import { registerBlobRoutes } from './blobs/routes.js';
import { inProcessRateLimiter } from './blobs/rate.js';
import { openStore } from './blobs/store.js';
import { BlobService } from './blobs/service.js';
import { registerDeltaRoutes } from './delta/routes.js';
import { registerVaultRoutes } from './vaults/routes.js';
import { registerHistoryRoutes } from './history/routes.js';
import { registerNodeRoutes } from './nodes/routes.js';
import { registerPairingRoutes } from './pairing/routes.js';
import { registerShareRoutes } from './shares/routes.js';
import { registerEventsRoutes } from './events-route.js';
import type { EventsHub } from './events.js';
import { hasActiveAdministrator, rearmBootstrapInvitation, registerBootstrapGuard } from './bootstrap.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { SERVER_VERSION } from './version.js';

/**
 * Seams a test may replace. Nothing here changes behaviour by default — each is a thing a
 * suite otherwise has to wait for in real time, or share unwillingly with its neighbours.
 */
export interface AppDeps {
  events?: EventsHub;
  /**
   * The recovery attempt limiter. Counted per login **and per source**, and every injected
   * request arrives from the same address — so one suite's deliberate failures would lock
   * out the next suite's honest ones unless it can bring its own.
   */
  attempts?: AttemptLimiter;
}

export const buildApp = async (db: Db, cfg: Config, deps: EventsHub | AppDeps = {}): Promise<FastifyInstance> => {
  // The events hub used to be the only seam and was passed positionally; both shapes are
  // accepted so every existing caller keeps working.
  const { events, attempts } = 'subscribe' in deps ? { events: deps as EventsHub, attempts: undefined } : deps;
  const app = Fastify({ logger: false });

  await app.register(fastifyJwt, { secret: cfg.serverSecret });
  await app.register(import('@fastify/websocket'));

  // Registered before the routes so it runs before any of them: while there is no
  // administrator, the only thing this server does is let one be made (#107).
  // Answers whether this process can do its job, which means asking PostgreSQL — a
  // server that is listening but cannot reach the database is not healthy, and a port
  // check would call it so.
  // It also reports the release (#111). This is the only endpoint that does, and the
  // only one that can: it is open before authentication and before an administrator
  // exists, which is precisely when a client has to decide whether it can talk to this
  // server at all. The version is reported on the unhealthy path too — it is a fact about
  // the process, not about the database, and a mismatch is likeliest to be diagnosed at a
  // moment when something else is already wrong.
  app.get('/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
    } catch {
      return reply.code(503).send({ status: 'database_unreachable', version: SERVER_VERSION });
    }
    return {
      status: 'ok',
      bootstrap_pending: !(await hasActiveAdministrator(db)),
      version: SERVER_VERSION,
    } satisfies HealthResponse;
  });

  registerBootstrapGuard(app, db);
  registerAuthRoutes(app, db, cfg, attempts ?? inProcessAttemptLimiter());
  registerPairingRoutes(app, db, cfg);
  const blobStore = openStore(cfg.blobStorePath);
  const blobService = new BlobService(db, blobStore, inProcessRateLimiter(cfg.limits.uploadBytesPerMinute), cfg.limits);
  registerBlobRoutes(app, db, blobStore, blobService);
  registerNodeRoutes(app, db);
  registerHistoryRoutes(app, db);
  registerVaultRoutes(app, db);
  registerShareRoutes(app, db, cfg);
  registerDeltaRoutes(app, db, cfg);

  if (events) registerEventsRoutes(app, events);

  // A seeded invitation that expired unredeemed would otherwise leave the installation
  // with no way in at all.
  await rearmBootstrapInvitation(db);

  return app;
};
