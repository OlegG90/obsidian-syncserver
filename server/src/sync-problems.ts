/**
 * What went wrong for which device, as the server saw it answered (#355, D-134).
 *
 * A refused write used to be visible in one place: the pass report on the device that made it. The
 * server's own log said `listening` and nothing else, so an operator had no view of sync failures at
 * all — #351 was found only because PostgreSQL happened to log the constraint it hit.
 *
 * Every refusal already passes through the server, so the server writes it down: one `onSend` hook sees
 * each answer of 400 or above to a request from an authenticated device, **counts** it into
 * `sync_problems`, and puts one line in the log. Nothing new is asked of the plugin.
 *
 * **Counted, not listed.** A row is one device, method, route template, status and refusal code; a repeat
 * moves its count and time. The table grows with the number of different problems rather than with how
 * often one recurs, which is what makes a client stuck in a retry loop harmless to it.
 *
 * **What is kept is what the request already told the server in the clear**: which route, which answer.
 * The route is the template Fastify matched (`/vaults/:vaultId/nodes/:nodeId/move`), never the URL; the
 * code is the refusal's name. No body, and no path or name, which the server never has.
 *
 * **The `detail` is kept, masked** (#433). A schema refusal's sentence names the rule that was broken, and
 * without it a row read `invalid_write` sixty-nine times and said nothing else — the one fact that would
 * have explained a device's loop was the one thrown away. It also names node ids, so every id and hash in
 * it is replaced before it reaches the log or the table: the rule stays, the node does not.
 */
import type { FastifyInstance } from 'fastify';
import type { SyncProblemRow } from '@syncserver/shared';
import type { Db } from './db.js';

/**
 * Answers that are the ordinary course of syncing rather than something going wrong.
 *
 * The list is D-134's; this is where it is enforced. Without it the view drowns: every conflict a pass
 * resolves is a `409 rev_mismatch`, every pairing poll a `409 not_approved`. An expired access token needs
 * no entry — it has no authenticated device behind it, so the hook has already let it go.
 */
export const EXPECTED_CODES: ReadonlySet<string> = new Set([
  'rev_mismatch',
  'base_mismatch',
  'not_approved',
  'rate_limited',
]);

/** How long a problem that has stopped recurring stays in the view. */
export const PROBLEM_TTL_DAYS = 30;

/** A refusal's name, from the body the server sent. `unknown` when there is none to read. */
export const refusalCode = (payload: unknown): string => {
  if (typeof payload !== 'string') return 'unknown';
  try {
    const code = (JSON.parse(payload) as { error?: unknown }).error;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';
  } catch {
    return 'unknown';
  }
};

/** Longest `detail` kept — `sync_problems_detail_is_short`. A schema's sentence is well under it. */
export const DETAIL_MAX = 300;

const MASKS: [RegExp, string][] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>'],
  [/\\x[0-9a-f]+/gi, '<bytes>'],
  [/\b[0-9a-f]{32,}\b/gi, '<hash>'],
];

/** A refusal's `detail`, with every id and hash masked, or nothing when the answer carried none. */
export const refusalDetail = (payload: unknown): string | null => {
  if (typeof payload !== 'string') return null;
  try {
    const detail = (JSON.parse(payload) as { detail?: unknown }).detail;
    if (typeof detail !== 'string' || detail === '') return null;
    return MASKS.reduce((s, [re, mask]) => s.replace(re, mask), detail).slice(0, DETAIL_MAX);
  } catch {
    return null;
  }
};

export interface SeenProblem {
  userId: string;
  deviceId: string;
  method: string;
  route: string;
  status: number;
  code: string;
  detail: string | null;
}

/** Count one refusal against its device: a new row, or one more on the row it already has. */
export const recordProblem = async (db: Pick<Db, 'query'>, p: SeenProblem): Promise<void> => {
  await db.query(
    `INSERT INTO sync_problems (user_id, device_id, method, route, status, code, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (device_id, method, route, status, code)
     DO UPDATE SET count = sync_problems.count + 1, last_at = now(), detail = EXCLUDED.detail`,
    [p.userId, p.deviceId, p.method, p.route, p.status, p.code, p.detail],
  );
};

/**
 * Watch every answer, and write down the refusals.
 *
 * **Awaited, and never allowed to fail the answer.** Awaited because a refusal is rare and one small write
 * beside it is cheap, and because an unawaited one would race whatever asks next — a test, or an operator
 * refreshing the view. Never failing because a problem that cannot be recorded (the device row deleted a
 * moment ago) is still an answer the client is owed: the failure goes to the log instead.
 *
 * Registered before the routes, since a Fastify hook applies to the routes declared after it.
 */
export const registerProblemRecorder = (app: FastifyInstance, db: Db, log: (m: string) => void = console.log): void => {
  app.addHook('onSend', async (req, reply, payload) => {
    const status = reply.statusCode;
    const route = req.routeOptions.url;
    // A device's refusals only: the console signs in with a device too, and `backup_not_ready` is not a sync
    // problem of anybody's.
    if (status < 400 || !req.caller || req.admin || !route) return payload;

    const code = refusalCode(payload);
    if (EXPECTED_CODES.has(code)) return payload;

    const detail = refusalDetail(payload);
    const seen: SeenProblem = { userId: req.caller.userId, deviceId: req.caller.deviceId, method: req.method, route, status, code, detail };
    log(
      `refused ${seen.method} ${seen.route} → ${status} ${code}${detail ? `: ${detail}` : ''} (account ${seen.userId}, device ${seen.deviceId})`,
    );
    await recordProblem(db, seen).catch((e: unknown) => {
      log(`could not record that refusal: ${e instanceof Error ? e.message : String(e)}`);
    });
    return payload;
  });
};

/** Every recorded problem, newest first, with the account and device named. */
export const listProblems = (db: Db): Promise<SyncProblemRow[]> =>
  db.query<SyncProblemRow>(
    `SELECT p.user_id::text AS "userId", u.login, p.device_id::text AS "deviceId", d.name AS "deviceName",
            d.platform, p.method, p.route, p.status, p.code, p.detail, p.count::text AS count,
            p.first_at AS "firstAt", p.last_at AS "lastAt"
       FROM sync_problems p
       JOIN users u ON u.id = p.user_id
       JOIN devices d ON d.id = p.device_id
      ORDER BY p.last_at DESC
      LIMIT 500`,
  );

/** Remove the problems that stopped recurring. Answers how many went. */
export const pruneProblems = async (db: Db): Promise<number> =>
  (
    await db.query(`DELETE FROM sync_problems WHERE last_at < now() - make_interval(days => $1) RETURNING 1 AS gone`, [
      PROBLEM_TTL_DAYS,
    ])
  ).length;
