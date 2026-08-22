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
import { registerAdminRoutes } from './admin/routes.js';
import { registerConsoleRoutes, CONSOLE_PATHS } from './console.js';
import { backupInProgress } from './backup.js';
import { backupLegs, serverVersionLine } from './backup-legs.js';
import { checkRestoreState, restoreHalted } from './restore.js';
import { registerEventsRoutes } from './events-route.js';
import type { EventsHub } from './events.js';
import { hasActiveAdministrator, registerBootstrapGuard } from './bootstrap.js';
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
  // administrator, the only thing this server does is let one be made (D-107).
  // Answers whether this process can do its job, which means asking PostgreSQL — a
  // server that is listening but cannot reach the database is not healthy, and a port
  // check would call it so.
  // It also reports the release (D-111). This is the only endpoint that does, and the
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

  // The PostgreSQL major a backup's dump must match (docs/10). Read through the one reader
  // that owns the fact, so this and `index.ts` cannot ask separately and disagree (D-89).
  const versionLine = cfg.backup ? await serverVersionLine(db) : '';
  registerAdminRoutes(app, db, {
    restoreStateFile: cfg.restoreStateFile,
    ...(cfg.backup
      ? {
          destination: cfg.backup.destination,
          // The legs are built per run, so each backup lands in its own subdirectory and
          // two runs never write into each other. The server's PostgreSQL version is read
          // once, here, and carried into every run's `assertReady` — which `runBackup` calls
          // before the lock, the row and the window, so a dump whose major disagrees is
          // refused with none of them taken (docs/10, D-73).
          makeLegs: (runDir: string) =>
            backupLegs(
              cfg.backup!.destination,
              cfg.backup!.dumpCommand,
              cfg.backup!.blobSource,
              runDir,
              versionLine,
            ),
        }
      : {}),
  });
  await registerConsoleRoutes(app);

  // The halt after an unconfirmed restore (docs/11). The database is behind the state
  // file, so a restore happened and nobody confirmed it — and the silent divergence the
  // epoch exists to prevent would otherwise begin. Everything except the health check, the
  // console (which carries the confirm screen) and the restore endpoints answers
  // `restore_pending`, so the one way out stays reachable.
  //
  // Established here and held, not asked per request (D-87). It was a database round-trip plus
  // a `readFile` on every call, to learn something that changes once — and could not have
  // changed in between, since a restore replaces the database under a STOPPED server. The
  // check belongs to this function rather than to the boot script because an app carrying the
  // hook is the app that has to know whether it is halted; left to a caller, the default is
  // "fine" and the halt is one forgotten line away from never happening.
  await checkRestoreState(db, cfg.restoreStateFile);
  const RESTORE_OPEN = new Set(['/health', '/auth/console', '/admin/restore', '/admin/restore/confirm', ...CONSOLE_PATHS]);
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (RESTORE_OPEN.has(path)) return;
    if (!restoreHalted()) return;
    return reply.code(503).send({
      error: 'restore_pending',
      message:
        'This database is older than this server has ever run with — a restore happened and ' +
        'was not confirmed. Open the console and confirm it, or investigate.',
    });
  });

  // The refusal window (D-114). One hook rather than a check in every write path: what the
  // window turns away is *new* requests, and this is the one place all of them pass. It is
  // deliberately not a freeze — a request already inside a handler goes on to commit, which
  // is exactly why a backup dumps the database before it copies the blobs.
  app.addHook('onRequest', async (req, reply) => {
    if (!backupInProgress()) return;
    if (req.method === 'GET' || req.method === 'HEAD') return;
    return reply.code(503).send({
      error: 'backup_in_progress',
      message: 'This server is being backed up. Reads are unaffected; try the write again shortly.',
    });
  });
  registerDeltaRoutes(app, db, cfg);

  if (events) registerEventsRoutes(app, events);

  return app;
};
