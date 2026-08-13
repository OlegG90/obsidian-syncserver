import type { CursorPayload } from '@syncserver/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { listSubtree, readChanges, readPosition, rejectionFor } from './service.js';

const MAX_LIMIT = 500;

export const registerDeltaRoutes = (app: FastifyInstance, db: Db, cfg: Config): void => {
  const ownsVault = async (userId: string, vaultId: string): Promise<boolean> => {
    const row = await db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM vaults WHERE id = $1 AND user_id = $2) AS ok`,
      [vaultId, userId],
    );
    return row?.ok ?? false;
  };

  /** Where a client starts syncing this vault. */
  app.get<{ Params: { vaultId: string } }>('/vaults/:vaultId', { preHandler: requireAuth }, async (req, reply) => {
    if (!(await ownsVault(req.caller!.userId, req.params.vaultId))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const row = await db.one<{ rootNodeId: string; head: string; keyId: string }>(
      `SELECT root_node_id AS "rootNodeId", head_rev::text AS head, vault_key_id AS "keyId"
         FROM vaults WHERE id = $1`,
      [req.params.vaultId],
    );
    return {
      root_node_id: row!.rootNodeId,
      head_rev: Number(row!.head),
      scopes: [{ scope: 'vault', key_id: row!.keyId }],
    };
  });

  app.get<{ Params: { vaultId: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/vaults/:vaultId/delta',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { vaultId } = req.params;
      if (!(await ownsVault(req.caller!.userId, vaultId))) return reply.code(404).send({ error: 'not_found' });

      const at = await readPosition(db, vaultId);
      if (!at) return reply.code(404).send({ error: 'not_found' });

      let cursor: CursorPayload;
      if (req.query.cursor) {
        const decoded = decodeCursor(cfg.serverSecret, req.query.cursor, {
          userId: req.caller!.userId,
          vaultId,
        });
        if (decoded === 'unverifiable') {
          // Recoverable on purpose: "start again from an empty cursor, applying no
          // deletions". Without this a device offline across two key rotations is bricked.
          return reply.code(400).send({ error: 'cursor_unverifiable' });
        }
        if (decoded === 'wrong_subject') return reply.code(400).send({ error: 'cursor_wrong_subject' });
        cursor = decoded;
      } else {
        // No cursor is not a stale cursor: it is a client that has never synced this vault.
        cursor = {
          v: 1,
          uid: req.caller!.userId,
          vid: vaultId,
          epoch: { restore: at.restoreEpoch, reset: at.resetEpoch },
          rev: 0,
        };
      }

      const rejection = rejectionFor(cursor, at);
      if (rejection) return reply.code(410).send({ reason: rejection });

      // The snapshot is pinned on the FIRST request of a series and carried in the cursor;
      // later pages read below the same bound, so a change made mid-walk is neither lost
      // nor applied twice (#24).
      const hwm = cursor.hwm ?? at.headRev;
      const limit = Math.min(Number(req.query.limit ?? MAX_LIMIT) || MAX_LIMIT, MAX_LIMIT);

      const changes = await readChanges(db, vaultId, cursor.rev, hwm, limit + 1);
      const hasMore = changes.length > limit;
      const page = hasMore ? changes.slice(0, limit) : changes;

      // While paging, the position advances but the bound stays. When the series ends the
      // bound becomes the position, and the next series pins a fresh one.
      const nextRev = page.length > 0 ? page[page.length - 1]!.rev : hwm;
      const next: CursorPayload = {
        v: 1,
        uid: req.caller!.userId,
        vid: vaultId,
        epoch: { restore: at.restoreEpoch, reset: at.resetEpoch },
        rev: hasMore ? nextRev : hwm,
        ...(hasMore ? { hwm } : {}),
      };

      return {
        changes: page,
        events: [],
        next_cursor: encodeCursor(cfg.serverSecret, next),
        has_more: hasMore,
      };
    },
  );

  /**
   * The full walk, for a client that has no usable cursor.
   *
   * It returns the `snapshot` it was taken at, and the client uses that as its starting
   * cursor — the same pinning as `delta`, for the same reason.
   */
  app.get<{ Params: { vaultId: string }; Querystring: { under?: string } }>(
    '/vaults/:vaultId/list',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { vaultId } = req.params;
      if (!(await ownsVault(req.caller!.userId, vaultId))) return reply.code(404).send({ error: 'not_found' });

      const at = await readPosition(db, vaultId);
      if (!at) return reply.code(404).send({ error: 'not_found' });

      const nodes = await listSubtree(db, vaultId, req.query.under);
      const snapshot: CursorPayload = {
        v: 1,
        uid: req.caller!.userId,
        vid: vaultId,
        epoch: { restore: at.restoreEpoch, reset: at.resetEpoch },
        rev: at.headRev,
      };

      return { nodes, snapshot: encodeCursor(cfg.serverSecret, snapshot) };
    },
  );
};
