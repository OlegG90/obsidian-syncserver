import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { callerHoldsBlob, envelopesFor, mayAccept, recordUpload, storageKeyOf } from './service.js';
import type { RateLimiter } from './rate.js';
import { HashMismatch, type BlobStore } from './store.js';

const HEX64 = /^[0-9a-f]{64}$/;

export const registerBlobRoutes = (
  app: FastifyInstance,
  db: Db,
  store: BlobStore,
  cfg: Config,
  rate: RateLimiter,
): void => {
  // The body is the blob. Fastify would otherwise try to parse it.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  /**
   * The content keys for blobs this caller holds, wrapped to a scope they hold.
   *
   * A pull needs this and could not be written without it: the delta says which blob a node
   * points at, `GET /blobs` returns ciphertext, and the key that opens it is in `blob_keys`.
   *
   * **Batched, by address list**, because applying a delta means opening every file that
   * changed, and one request per file is a round trip per note over a home connection. The
   * answer omits rather than errors on an address the caller cannot open — an envelope they
   * do not hold is indistinguishable from one that does not exist, which is the same
   * `404`-not-`403` rule the blob routes follow (#20).
   */
  app.get<{ Params: { vaultId: string }; Querystring: { sha256?: string } }>(
    '/vaults/:vaultId/blob-keys',
    { preHandler: requireAuth },
    async (req, reply) => {
      const raw = (req.query.sha256 ?? '').split(',').filter(Boolean);
      if (raw.length === 0) return reply.code(400).send({ error: 'sha256_required' });
      if (raw.length > 500) return reply.code(400).send({ error: 'too_many_addresses' });
      if (!raw.every((h) => HEX64.test(h))) return reply.code(400).send({ error: 'bad_address' });

      const rows = await envelopesFor(
        db,
        req.caller!.userId,
        req.params.vaultId,
        raw.map((h) => Buffer.from(h, 'hex')),
      );
      return {
        keys: rows.map((r) => ({ sha256: r.sha256, scope_id: r.scopeId, wrapped_key: r.wrappedKey })),
      };
    },
  );

  /**
   * "Do I have this", not "does the server have this" (#26).
   *
   * No reference means **404, not 403**: a 403 would confirm that a file with that address
   * exists, which is the same oracle the rule exists to close.
   */
  app.head<{ Params: { sha256: string } }>('/blobs/:sha256', { preHandler: requireAuth }, async (req, reply) => {
    const hex = req.params.sha256;
    if (!HEX64.test(hex)) return reply.code(400).send();
    const held = await callerHoldsBlob(db, req.caller!.userId, Buffer.from(hex, 'hex'));
    return reply.code(held ? 200 : 404).send();
  });

  app.get<{ Params: { sha256: string } }>('/blobs/:sha256', { preHandler: requireAuth }, async (req, reply) => {
    const hex = req.params.sha256;
    if (!HEX64.test(hex)) return reply.code(400).send({ error: 'bad_address' });

    const sha = Buffer.from(hex, 'hex');
    if (!(await callerHoldsBlob(db, req.caller!.userId, sha))) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const key = await storageKeyOf(db, sha);
    if (!key) return reply.code(404).send({ error: 'not_found' });

    const total = await store.size(key);
    if (total === undefined) return reply.code(404).send({ error: 'not_found' });

    const range = parseRange(req.headers.range, total);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${total}`).send();
    }

    reply.header('content-type', 'application/octet-stream').header('accept-ranges', 'bytes');
    if (!range) return reply.header('content-length', total).send(store.read(key));

    return reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${total}`)
      .header('content-length', range.end - range.start + 1)
      .send(store.read(key, range));
  });

  /**
   * Upload. Possessing the content proves possession of the content, so this needs no
   * rights to a specific address — but it does need limits, because without them it is the
   * simplest way to fill a disk, and that takes no attacker, just a client stuck in a
   * retry loop (#33).
   *
   * **There is deliberately no short circuit.** Answering "already have it, skip the
   * upload" would reintroduce the existence oracle the `404` rule closes: the client
   * declares the address up front, so anyone with a copy of a file could test for it. The
   * server accepts the bytes and deduplicates internally (#46).
   *
   * Resumability is M2. What is here is the mechanism it will build on — a temp name
   * renamed into place — not a placeholder for it.
   */
  app.post<{ Querystring: { sha256?: string; size?: string; enc_alg?: string; key_id?: string } }>(
    '/blobs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const hex = req.query.sha256;
      const declaredSize = Number(req.query.size);
      const encAlg = req.query.enc_alg ?? 'xchacha20-poly1305';
      const keyId = req.query.key_id;

      if (!hex || !HEX64.test(hex)) return reply.code(400).send({ error: 'bad_address' });
      if (!Number.isInteger(declaredSize) || declaredSize <= 0) return reply.code(400).send({ error: 'bad_size' });
      if (!keyId) return reply.code(400).send({ error: 'key_id_required' });
      if (declaredSize > cfg.limits.unfinishedUploadBytes) {
        return reply.code(413).send({ error: 'too_large' });
      }
      const sha = Buffer.from(hex, 'hex');

      // "An authenticated session AND a registered device" (#33). The access token names a
      // device, but a token outlives the row: signing a device out has to mean something
      // before the token expires, or "sign out this device" is advice rather than an act
      // (#90). Checked here rather than on every request — this is the path where being
      // wrong costs disk.
      const device = await db.one<{ id: string }>(
        `SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [req.caller!.deviceId, req.caller!.userId],
      );
      if (!device) return reply.code(401).send({ error: 'device_revoked' });

      const verdict = await mayAccept(db, req.caller!.userId, sha, declaredSize);
      if (!verdict.ok) return reply.code(413).send({ error: verdict.reason });

      // Charged from the DECLARED size, before a byte arrives. A volume limit applied
      // afterwards is one checked once the disk it protects already holds the data.
      const allowance = rate.reserve(req.caller!.userId, declaredSize);
      if (!allowance.ok) {
        return reply
          .code(429)
          .header('retry-after', String(allowance.retryAfterSeconds))
          .send({ error: 'rate_limited', retry_after: allowance.retryAfterSeconds });
      }

      let stored;
      try {
        stored = await store.put(hex, req.raw);
      } catch (e) {
        if (e instanceof HashMismatch) return reply.code(400).send({ error: 'address_mismatch' });
        throw e;
      }

      // The declared size is what quota was reserved against; bytes that disagree with it
      // were never authorised, so the blob does not stay.
      if (stored.size !== declaredSize) {
        await store.remove(stored.storageKey);
        return reply.code(400).send({ error: 'size_mismatch' });
      }

      await recordUpload(db, {
        userId: req.caller!.userId,
        deviceId: req.caller!.deviceId,
        sha256: sha,
        size: stored.size,
        storageKey: stored.storageKey,
        encAlg,
        keyId,
      });

      return reply.code(201).send({ sha256: hex, size: stored.size });
    },
  );
};

const parseRange = (
  header: string | undefined,
  total: number,
): { start: number; end: number } | undefined | 'unsatisfiable' => {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'unsatisfiable';

  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;

  if (rawStart === '') {
    // "bytes=-N" — the last N bytes.
    const n = Number(rawEnd);
    if (!Number.isInteger(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= total) return 'unsatisfiable';
  return { start, end: Math.min(end, total - 1) };
};
