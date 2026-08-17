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
import type { Db } from '../db.js';
import { refuse } from '../refuse-http.js';
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

/** A week to redeem an invitation, matching the one the schema seeds for the first administrator. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export const registerAdminRoutes = (app: FastifyInstance, db: Db): void => {
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
};
