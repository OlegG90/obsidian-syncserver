/**
 * The administration surface: `/admin`, behind a guard that reads the database rather than
 * the token, so a role taken away an hour ago is taken away now.
 *
 * Every route here acts on **somebody else's** account, which is the line [11] draws between
 * the two zones and the reason each one leaves a record. Nothing in this file browses a
 * vault: with E2EE always on there is no key to do it with, so the absence is cryptographic
 * rather than a permission somebody could grant later.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { OperatorRefusalCode } from '@syncserver/shared';
import { copyAt } from '../backup-copy.js';
import { join } from 'node:path';
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
import { deleteAccount, deletionProgress } from './deletion.js';
import { requireAdmin } from './guard.js';
import {
  auditSize,
  invite,
  listAccounts,
  listAudit,
  listDevices,
  reissue,
  revokeDevice,
  revokeInvitation,
  setEnabled,
  setQuota,
  storage,
} from './service.js';
import { listBackups, runBackup, verifyBackup, type Legs } from '../backup.js';
import { insideDestination } from '../backup-remove.js';
import { record } from './audit.js';
import { writeRestoreRequest } from '../restore-request.js';
import { removeBackupCopy } from '../backup-remove.js';
import { backupRunDir, runDirOf } from '../backup-legs.js';
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
  /**
   * How this server stops itself once a restore has been asked for.
   *
   * Injected for one reason and it is not elegance: the real one is `process.exit`, and a test that
   * exercised this route without it would end the run rather than assert anything.
   */
  stop?(): void;
}

/** A week to redeem an invitation, matching the one the schema seeds for the first administrator. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The one sentence a missing configuration answers with, wherever it is asked.
 *
 * The same refusal at four call sites, and the details drifted while the meaning did not. So
 * the prose lives here — and so does the **code**, which is the half that was still leaking:
 * the routes passed `'backup_not_configured'` as a string and this branched on it to choose a
 * sentence, which is the caller knowing the spelling AND this knowing the caller. The docblock
 * already claimed the routes "only have to know whether the thing is configured, not how to
 * say it is not"; two named refusals make that true (D-89).
 */
const noBackup = (reply: FastifyReply): unknown =>
  refuseWith(reply, 503, 'backup_not_configured',
    'set BACKUP_DESTINATION, BACKUP_DB_COMMAND and BACKUP_BLOB_SOURCE to enable backups');

const noRestoreFile = (reply: FastifyReply): unknown =>
  refuseWith(reply, 503, 'restore_not_configured', 'no restore state file configured');

/**
 * Refuse with a code `shared` declares, and nothing else.
 *
 * This exists so a route cannot invent one. Every operator refusal used to be a string literal typed
 * straight into `send()`, which meant a rename on this side reached the console as an identifier printed
 * on screen — the console maps codes to sentences, and an unmapped one falls through as itself.
 *
 * The union is the seam; this is the only way through it. A new refusal has to be declared before it can
 * be sent, and declaring it makes the console fail to compile until it has words.
 */
const refuseWith = (
  reply: FastifyReply,
  status: number,
  error: OperatorRefusalCode,
  detail?: string,
): unknown => reply.code(status).send(detail === undefined ? { error } : { error, detail });

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
      // The size of the whole thing, beside a page of it (D-117).
      size: await auditSize(db),
    }),
  );

  app.post<{ Body: { login: string; quota_bytes: string; ttl_seconds?: number } }>(
    '/admin/invitations',
    admin,
    async (req, reply) => {
      const { login, quota_bytes: quota } = req.body ?? {};
      if (!login || typeof login !== 'string') return refuseWith(reply, 400, 'login_required');
      if (!quota || !/^\d+$/.test(String(quota)) || BigInt(quota) <= 0n) {
        return refuseWith(reply, 400, 'quota_bytes_required', 'a positive number of bytes');
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
      if (typeof req.body?.enabled !== 'boolean') return refuseWith(reply, 400, 'enabled_required');
      const out = await setEnabled(db, req.admin!, req.params.userId, req.body.enabled);
      if (out) return refuse(reply, out);
      return reply.code(204).send();
    },
  );

  // A procedure, not a button (D-55). POST advances it as far as it can go and says what is
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

  // The devices of one account, and taking one away. For the person the owner cannot be: their only
  // device is the one that is gone, so nobody but the operator can revoke it (#156).
  app.get<{ Params: { userId: string } }>('/admin/accounts/:userId/devices', admin, async (req, reply) => {
    const out = await listDevices(db, req.params.userId);
    if ('kind' in out) return refuse(reply, out);
    return {
      devices: out.map((d) => ({ id: d.id, name: d.name, platform: d.platform, last_seen_at: d.lastSeenAt })),
    };
  });

  app.delete<{ Params: { userId: string; deviceId: string } }>(
    '/admin/accounts/:userId/devices/:deviceId',
    admin,
    async (req, reply) => {
      const out = await revokeDevice(db, req.admin!, req.params.userId, req.params.deviceId);
      if (out) return refuse(reply, out);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { userId: string }; Body: { quota_bytes: string } }>(
    '/admin/accounts/:userId/quota',
    admin,
    async (req, reply) => {
      const quota = req.body?.quota_bytes;
      if (!quota || !/^\d+$/.test(String(quota)) || BigInt(quota) <= 0n) {
        return refuseWith(reply, 400, 'quota_bytes_required', 'a positive number of bytes');
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
    if (!backup.makeLegs || !backup.destination) return noBackup(reply);
    const runDir = backupRunDir(new Date().toISOString().replace(/[:.]/g, '-'));
    // The destination recorded on the row is THIS run's directory, so verify knows where
    // the copy lives. `backupLegs` puts it under `destination/<runDir>/`.
    const runDestination = runDirOf(backup.destination, runDir);
    const out = await runBackup(db, backup.makeLegs(runDir), runDestination, {
      triggeredBy: req.admin!.id,
      // The self-check: reopen the copy just written and confirm it is whole, so a backup
      // nobody can restore from is flagged on the row instead of at restore time (docs/10).
      openCopy: (dest) => openStore(copyAt(dest).blobs),
    });
    // Refused is not failed and not busy: nothing ran, so there is no row and nothing to
    // retry until the deployment is fixed. 503, like `unconfigured` — the same family of
    // answer, "this installation cannot do this yet", with the sentence that says what to fix.
    if (out.status === 'refused') return refuseWith(reply, 503, 'backup_not_ready', out.error);
    if (out.status === 'skipped') return refuseWith(reply, 409, 'backup_in_progress', out.error);
    if (out.status === 'failed') return refuseWith(reply, 500, 'backup_failed', out.error);
    return {
      id: out.id,
      status: out.status,
      bytes: out.bytes,
      blob_count: out.blobCount,
      destination: runDestination,
      ...(out.error ? { self_check: out.error } : {}),
    };
  });

  app.get('/admin/backups', admin, async () => ({ backups: await listBackups(db) }));

  /**
   * Remove one backup's copy from disk, keeping the run in the history (#136).
   *
   * **The row stays and `destination` becomes null.** Dropping the row would leave the files
   * behind with nothing referencing them, so an operator watching free space disappear would
   * have nothing left that explains where it went; keeping the row with no destination says
   * exactly what happened — this backup ran, and its copy is gone.
   *
   * Four refusals, each of which is a decision rather than a check
   * (`backup-remove.ts` argues them): a destination outside this deployment's backup
   * directory, the newest successful copy, a run still in progress, and a copy already
   * removed. The first is the one that matters: `destination` is a text column, and a value
   * from a restored dump or another host would otherwise become a recursive delete of
   * whatever that path names here.
   */
  app.delete<{ Params: { id: string } }>('/admin/backups/:id', admin, async (req, reply) => {
    if (!backup.destination) return noBackup(reply);
    const refused = await removeBackupCopy(db, backup.destination, req.params.id);
    if (refused === 'not_found') return refuseWith(reply, 404, 'not_found');
    if (refused === 'already_gone') return reply.code(204).send();
    if (refused) {
      // 409 for all three: the request is well formed and the server is refusing THIS one,
      // for a reason the console prints as a sentence rather than a code.
      return refuseWith(reply, 409, refused);
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/admin/backups/:id/verify', admin, async (req, reply) => {
    if (!backup.destination) return noBackup(reply);
    const run = await db.one<{ destination: string }>(
      `SELECT destination FROM backup_runs WHERE id = $1`, [req.params.id]);
    if (!run?.destination) return refuseWith(reply, 404, 'not_found');

    // The COPY, not the live store: the run's destination names its own blob directory,
    // and verifying against the live data would always answer yes.
    const copy = openStore(copyAt(run.destination).blobs);
    const out = await verifyBackup(db, copy, req.params.id);
    return { checked: out.checked, missing: out.missing, whole: out.missing.length === 0 };
  });

  /**
   * Ask for this copy to be restored, and stop the server so it can be.
   *
   * **This does not restore anything.** It writes the request beside the restore epoch and exits; the
   * restore itself runs on the way back up, before this server opens a connection for serving, which is
   * the only moment `pg_restore --clean` is safe (`restore-request.ts`). The old instruction to run
   * `docker compose stop server` first said the same thing in a form somebody had to remember.
   *
   * The half of D-92 that does the work is untouched: the epoch guard still notices the database went
   * backwards, still halts, and still waits for a person to confirm. What the button removes is the
   * typing, not the deciding.
   *
   * Recorded before the server goes, because after it goes there is nobody to record it.
   */
  app.post<{ Params: { id: string } }>('/admin/backups/:id/restore', admin, async (req, reply) => {
    if (!backup.destination) return noBackup(reply);
    if (!backup.restoreStateFile) return noRestoreFile(reply);

    const run = await db.one<{ destination: string | null; status: string }>(
      `SELECT destination, status::text AS status FROM backup_runs WHERE id = $1`, [req.params.id]);
    if (!run) return refuseWith(reply, 404, 'not_found');
    if (run.status !== 'ok') return refuseWith(reply, 409, 'not_a_good_copy');
    if (!run.destination) return refuseWith(reply, 409, 'already_gone');
    // The same guard the removal uses, and for the same reason: `destination` is a text column, and a
    // value from a restored dump or another deployment would otherwise name a path on THIS host.
    if (!insideDestination(backup.destination, run.destination)) {
      return refuseWith(reply, 409, 'outside_destination');
    }

    await db.tx(async (c) => {
      await record(c, { actor: req.admin!, action: 'restore.request', details: { run: req.params.id } });
    });
    await writeRestoreRequest(backup.restoreStateFile, {
      runId: req.params.id,
      destination: run.destination,
      by: req.admin!.login,
      at: new Date().toISOString(),
    });

    // After the reply is on the wire, not before: the console has to be able to say what is happening,
    // and a socket closed by a process that has already gone says nothing at all.
    const stop = backup.stop ?? ((): void => process.exit(0));
    // `once`, not `on`: the raw response can emit `finish` more than once, and a second stop is a second
    // exit — harmless against `process.exit` and not against anything else somebody wires here later.
    reply.raw.once('finish', () => {
      setTimeout(() => {
        console.log('restore: stopping so the request can be carried out on the next start');
        stop();
      }, 250);
    });
    return reply.code(202).send({ status: 'restarting' });
  });

  // The restore surface: what the server knows, and the one act that resolves it. Both are
  // reachable even in the halt state, because a restore nobody can confirm is a restore
  // nobody can leave.
  app.get('/admin/restore', admin, async (req, reply) => {
    if (!backup.restoreStateFile) return noRestoreFile(reply);
    return restoreStatus(db, backup.restoreStateFile);
  });

  app.post('/admin/restore/confirm', admin, async (req, reply) => {
    if (!backup.restoreStateFile) return noRestoreFile(reply);
    // Refuse to confirm when nothing is pending: the act is audited and irreversible, and
    // there is nothing to resolve.
    const status = await restoreStatus(db, backup.restoreStateFile);
    if (!status.pending) {
      return refuseWith(reply, 409, 'nothing_to_confirm', 'the database is not behind its state file');
    }
    const out = await confirmRestore(db, req.admin!, backup.restoreStateFile);
    return { epoch: out.epoch };
  });
};
