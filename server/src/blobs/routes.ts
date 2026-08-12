import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { callerHoldsBlob, envelopesFor, mayAccept, recordUpload, storageKeyOf } from './service.js';
import type { RateLimiter } from './rate.js';
import { HashMismatch, PartsMissing, type BlobStore } from './store.js';

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
   * What both upload paths must clear before a byte is written (docs/04).
   *
   * "An authenticated session AND a registered device" (#33). The access token names a
   * device, but a token outlives the row: signing a device out has to mean something before
   * the token expires, or "sign out this device" is advice rather than an act (#90). Checked
   * here rather than on every request — this is the path where being wrong costs disk.
   *
   * Quota is answered from the blob's WHOLE size, not from what this request carries, so a
   * resumable upload that cannot fit is refused at its first part rather than at its last.
   */
  const admit = async (
    userId: string,
    deviceId: string,
    sha: Buffer,
    totalBytes: number,
  ): Promise<{ code: number; body: { error: string } } | undefined> => {
    const device = await db.one<{ id: string }>(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [deviceId, userId],
    );
    if (!device) return { code: 401, body: { error: 'device_revoked' } };

    if (totalBytes > cfg.limits.unfinishedUploadBytes) return { code: 413, body: { error: 'too_large' } };

    const verdict = await mayAccept(db, userId, sha, totalBytes);
    if (!verdict.ok) return { code: 413, body: { error: verdict.reason! } };
    return undefined;
  };

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
   * This is the whole-blob path, for anything at or below the part size. Above it a client
   * uses the resumable calls below, which end in the same `recordUpload` (docs/04).
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
      const sha = Buffer.from(hex, 'hex');

      const refusal = await admit(req.caller!.userId, req.caller!.deviceId, sha, declaredSize);
      if (refusal) return reply.code(refusal.code).send(refusal.body);

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

  /**
   * One part of a resumable upload (docs/04).
   *
   * Idempotent by index: a client that does not know whether a part landed resends it. That
   * is the whole reason the parts are addressed rather than appended — an append protocol
   * has to know exactly how much arrived, which is precisely what a dropped connection does
   * not tell either side.
   *
   * **No row is written here.** A `user_blobs` row is a claim on content, and creating one
   * from a declared hash before any bytes arrive would let anyone who has merely LEARNED an
   * address claim a blob somebody else then uploads — under deduplication that is somebody
   * else's file. Quota is still reserved before the upload starts, from `total`; the claim
   * is written by `complete`, after the assembled bytes hash to the address.
   */
  app.put<{ Params: { sha256: string; n: string }; Querystring: { total?: string; size?: string } }>(
    '/blobs/:sha256/parts/:n',
    { preHandler: requireAuth },
    async (req, reply) => {
      const hex = req.params.sha256;
      const index = Number(req.params.n);
      const total = Number(req.query.total);
      const declaredSize = Number(req.query.size);

      if (!HEX64.test(hex)) return reply.code(400).send({ error: 'bad_address' });
      if (!Number.isInteger(index) || index < 1) return reply.code(400).send({ error: 'bad_part' });
      if (!Number.isInteger(total) || total <= 0) return reply.code(400).send({ error: 'bad_size' });
      if (!Number.isInteger(declaredSize) || declaredSize <= 0) return reply.code(400).send({ error: 'bad_size' });
      if (declaredSize > cfg.limits.uploadPartBytes) return reply.code(413).send({ error: 'part_too_large' });

      const sha = Buffer.from(hex, 'hex');
      const refusal = await admit(req.caller!.userId, req.caller!.deviceId, sha, total);
      if (refusal) return reply.code(refusal.code).send(refusal.body);

      // The in-flight ceiling, measured from the staging area rather than from rows —
      // parts have no rows, so this directory is where "unfinished" is written down.
      const inFlight = await store.stagedBytes(req.caller!.userId);
      if (inFlight + declaredSize > cfg.limits.unfinishedUploadBytes) {
        return reply.code(413).send({ error: 'too_many_unfinished' });
      }

      const allowance = rate.reserve(req.caller!.userId, declaredSize);
      if (!allowance.ok) {
        return reply
          .code(429)
          .header('retry-after', String(allowance.retryAfterSeconds))
          .send({ error: 'rate_limited', retry_after: allowance.retryAfterSeconds });
      }

      const { size } = await store.stagePart(req.caller!.userId, hex, index, req.raw);
      if (size !== declaredSize) {
        // What arrived is not what was charged against the ceiling, so it does not stay —
        // but only this part goes. Discarding the whole upload over one bad part would
        // throw away everything already sent, which is the opposite of resumable.
        await store.discardPart(req.caller!.userId, hex, index);
        return reply.code(400).send({ error: 'size_mismatch' });
      }

      return reply.code(204).send();
    },
  );

  /**
   * What this caller has already staged, so a reconnecting client can skip it.
   *
   * **Never a 404, and never a word about the finished blob.** An address the caller never
   * started answers `{parts: []}`, exactly as an address that does not exist would: any
   * other answer would make this the existence oracle that the `404`-not-`403` rule (#20)
   * and the missing short circuit on `POST /blobs` both exist to close. It reads the
   * caller's own staging directory and nothing else, so there is no other answer to give.
   */
  app.get<{ Params: { sha256: string } }>(
    '/blobs/:sha256/parts',
    { preHandler: requireAuth },
    async (req, reply) => {
      const hex = req.params.sha256;
      if (!HEX64.test(hex)) return reply.code(400).send({ error: 'bad_address' });
      return store.stagedParts(req.caller!.userId, hex);
    },
  );

  /**
   * Assemble the parts into the blob, and only then record the claim.
   *
   * The verification is the single-shot one, on the same code path: `assemble` concatenates
   * `1..k` through `store.put`, which hashes and refuses an address the bytes do not
   * produce. A resumable upload therefore cannot store what a `POST` could not.
   *
   * A failure discards the staging. The server cannot tell which part was wrong, so leaving
   * them would let the client retry into the same wall for ever.
   */
  app.post<{ Params: { sha256: string }; Querystring: { size?: string; enc_alg?: string; key_id?: string } }>(
    '/blobs/:sha256/complete',
    { preHandler: requireAuth },
    async (req, reply) => {
      const hex = req.params.sha256;
      const declaredSize = Number(req.query.size);
      const encAlg = req.query.enc_alg ?? 'xchacha20-poly1305';
      const keyId = req.query.key_id;

      if (!HEX64.test(hex)) return reply.code(400).send({ error: 'bad_address' });
      if (!Number.isInteger(declaredSize) || declaredSize <= 0) return reply.code(400).send({ error: 'bad_size' });
      if (!keyId) return reply.code(400).send({ error: 'key_id_required' });

      const sha = Buffer.from(hex, 'hex');
      const refusal = await admit(req.caller!.userId, req.caller!.deviceId, sha, declaredSize);
      if (refusal) return reply.code(refusal.code).send(refusal.body);

      let stored;
      try {
        stored = await store.assemble(req.caller!.userId, hex);
      } catch (e) {
        if (e instanceof PartsMissing) {
          // The only refusal that does NOT discard: a hole is what a resume is for, and
          // throwing the upload away here would make an early `complete` destructive.
          return reply.code(409).send({ error: 'parts_missing', have: e.have });
        }
        await store.discardStaging(req.caller!.userId, hex);
        if (e instanceof HashMismatch) return reply.code(400).send({ error: 'address_mismatch' });
        throw e;
      }

      if (stored.size !== declaredSize) {
        await store.remove(stored.storageKey);
        await store.discardStaging(req.caller!.userId, hex);
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

      await store.discardStaging(req.caller!.userId, hex);
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
