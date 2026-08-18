/**
 * The administration surface: `/admin`, behind a guard that reads the database rather than
 * the token, so a role taken away an hour ago is taken away now.
 *
 * Every route here acts on **somebody else's** account, which is the line [11] draws between
 * the two zones and the reason each one leaves a record. Nothing in this file browses a
 * vault: with E2EE always on there is no key to do it with, so the absence is cryptographic
 * rather than a permission somebody could grant later.
 */
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { deleteAccount, deletionProgress } from './deletion.js';
import { requireAdmin } from './guard.js';
import {
  invite,
  listAccounts,
  listAudit,
  reissue,
  revokeInvitation,
  setEnabled,
  setQuota,
  storage,
} from './service.js';
import { listBackups, runBackup, verifyBackup, type Legs } from '../backup.js';
import { openStore } from '../blobs/store.js';
import { confirmRestore, restoreStatus } from '../restore.js';

/** What the console's backup and restore surface needs, supplied by the composition root. */
export interface BackupDeps {
  /**
   * Build the legs for one run. Called per backup, so each run lands in its own
   * subdirectory; a fresh run dir is what keeps two backups from writing into each other.
   */
  makeLegs?(runDir: string): Legs;
  destination?: string;
  /** Where the restore epoch lives — see `restore.ts`. */
  restoreStateFile?: string;
}

/** A week to redeem an invitation, matching the one the schema seeds for the first administrator. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const registerAdminRoutes = (app: FastifyInstance, db: Db, backup: BackupDeps = {}): void => {
  const admin = { preHandler: requireAdmin(db) };

  app.get('/admin/accounts', admin, async () => ({ accounts: await listAccounts(db) }));

  app.get('/admin/storage', admin, async () => storage(db));

  app.get<{ Querystring: { target?: string; limit?: string } }>(
    '/admin/audit',
    admin,
    async (req) => ({
      entries: await listAudit(db, {
        targetUserId: req.query.target,
        // Bounded here rather than trusted: the log is the one table that only grows.
        limit: Math.min(Number(req.query.limit) || 100, 500),
      }),
    }),
  );

  app.post<{ Body: { login: string; quota_bytes: string; ttl_seconds?: number } }>(
    '/admin/invitations',
    admin,
    async (req, reply) => {
      const { login, quota_bytes: quota } = req.body ?? {};
      if (!login || typeof login !== 'string') return reply.code(400).send({ error: 'login_required' });
      if (!quota || !/^\d+$/.test(String(quota)) || BigInt(quota) <= 0n) {
        return reply.code(400).send({ error: 'quota_bytes_required', detail: 'a positive number of bytes' });
      }

      const out = await invite(db, req.admin!, {
        login,
        quotaBytes: String(quota),
        ttlSeconds: req.body.ttl_seconds ?? INVITE_TTL_SECONDS,
      });
      if ('kind' in out) return refuse(reply, out);

      // The token is in this response and nowhere else — only its hash was stored, so there
      // is no second chance to read it and reissuing is the honest way to get another.
      return reply.code(201).send({ user_id: out.userId, token: out.token, expires_at: out.expiresAt });
    },
  );

  app.post<{ Params: { userId: string }; Body: { ttl_seconds?: number } }>(
    '/admin/invitations/:userId/reissue',
    admin,
    async (req, reply) => {
      const out = await reissue(db, req.admin!, req.params.userId, req.body?.ttl_seconds ?? INVITE_TTL_SECONDS);
      if ('kind' in out) return refuse(reply, out);
      return { token: out.token, expires_at: out.expiresAt };
    },
  );

  app.delete<{ Params: { userId: string } }>('/admin/invitations/:userId', admin, async (req, reply) => {
    const out = await revokeInvitation(db, req.admin!, req.params.userId);
    if (out) return refuse(reply, out);
    return reply.code(204).send();
  });

  // Disable and delete are different operations and must not share a control ([11]); this
  // is the reversible one, and the only one that exists yet.
  app.post<{ Params: { userId: string }; Body: { enabled: boolean } }>(
    '/admin/accounts/:userId/enabled',
    admin,
    async (req, reply) => {
      if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled_required' });
      const out = await setEnabled(db, req.admin!, req.params.userId, req.body.enabled);
      if (out) return refuse(reply, out);
      return reply.code(204).send();
    },
  );

  // A procedure, not a button (#55). POST advances it as far as it can go and says what is
  // outstanding; GET only looks, because a poll that moved the state would make watching a
  // deletion indistinguishable from driving one.
  app.post<{ Params: { userId: string } }>('/admin/accounts/:userId/deletion', admin, async (req, reply) => {
    const out = await deleteAccount(db, req.admin!, req.params.userId);
    if ('kind' in out) return refuse(reply, out);
    return { state: out.state, awaiting: out.awaiting, finished: out.finished };
  });

  app.get<{ Params: { userId: string } }>('/admin/accounts/:userId/deletion', admin, async (req, reply) => {
    const out = await deletionProgress(db, req.params.userId);
    if ('kind' in out) return refuse(reply, out);
    return { state: out.state, awaiting: out.awaiting, finished: out.finished };
  });

  app.put<{ Params: { userId: string }; Body: { quota_bytes: string } }>(
    '/admin/accounts/:userId/quota',
    admin,
    async (req, reply) => {
      const quota = req.body?.quota_bytes;
      if (!quota || !/^\d+$/.test(String(quota)) || BigInt(quota) <= 0n) {
        return reply.code(400).send({ error: 'quota_bytes_required', detail: 'a positive number of bytes' });
      }
      const out = await setQuota(db, req.admin!, req.params.userId, String(quota));
      if ('kind' in out) return refuse(reply, out);

      // What the next write will find, said before it finds it: lowering a limit below
      // usage deletes nothing and freezes the account (SH-20).
      return { used_bytes: out.usedBytes, freezes: out.freezes };
    },
  );

  // The backup surface. Trigger is a POST because it starts work; list and verify are GETs
  // because they only look — a poll that moved the state would make watching a backup
  // indistinguishable from driving one.
  app.post('/admin/backups', admin, async (req, reply) => {
    if (!backup.makeLegs || !backup.destination) {
      return reply.code(503).send({
        error: 'backup_not_configured',
        detail: 'set BACKUP_DESTINATION, BACKUP_DB_COMMAND and BACKUP_BLOB_SOURCE to enable backups',
      });
    }
    const runDir = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    // The destination recorded on the row is THIS run's directory, so verify knows where
    // the copy lives. `backupLegs` puts it under `destination/<runDir>/`.
    const runDestination = `${backup.destination}/${runDir}`;
    const out = await runBackup(db, backup.makeLegs(runDir), runDestination, {
      triggeredBy: req.admin!.id,
    });
    if (out.status === 'skipped') return reply.code(409).send({ error: 'backup_in_progress', detail: out.error });
    if (out.status === 'failed') return reply.code(500).send({ error: 'backup_failed', detail: out.error });
    return { id: out.id, status: out.status, bytes: out.bytes, blob_count: out.blobCount, destination: runDestination };
  });

  app.get('/admin/backups', admin, async () => ({ backups: await listBackups(db) }));

  app.post<{ Params: { id: string } }>('/admin/backups/:id/verify', admin, async (req, reply) => {
    if (!backup.destination) {
      return reply.code(503).send({ error: 'backup_not_configured', detail: 'no backup destination configured' });
    }
    const run = await db.one<{ destination: string }>(
      `SELECT destination FROM backup_runs WHERE id = $1`, [req.params.id]);
    if (!run?.destination) return reply.code(404).send({ error: 'not_found' });

    // The COPY, not the live store: the run's destination names its own blob directory,
    // and verifying against the live data would always answer yes.
    const copy = openStore(join(run.destination, 'blobs'));
    const out = await verifyBackup(db, copy, req.params.id);
    return { checked: out.checked, missing: out.missing, whole: out.missing.length === 0 };
  });

  // The restore surface: what the server knows, and the one act that resolves it. Both are
  // reachable even in the halt state, because a restore nobody can confirm is a restore
  // nobody can leave.
  app.get('/admin/restore', admin, async (req, reply) => {
    if (!backup.restoreStateFile) {
      return reply.code(503).send({ error: 'restore_not_configured', detail: 'no restore state file' });
    }
    return restoreStatus(db, backup.restoreStateFile);
  });

  app.post('/admin/restore/confirm', admin, async (req, reply) => {
    if (!backup.restoreStateFile) {
      return reply.code(503).send({ error: 'restore_not_configured', detail: 'no restore state file' });
    }
    // Refuse to confirm when nothing is pending: the act is audited and irreversible, and
    // there is nothing to resolve.
    const status = await restoreStatus(db, backup.restoreStateFile);
    if (!status.pending) {
      return reply.code(409).send({ error: 'nothing_to_confirm', detail: 'the database is not behind its state file' });
    }
    const out = await confirmRestore(db, req.admin!, backup.restoreStateFile);
    return { epoch: out.epoch };
  });
};
