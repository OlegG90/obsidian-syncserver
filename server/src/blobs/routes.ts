import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { refuse } from '../refuse.js';
import { BlobService, callerHoldsBlob, envelopesFor, parseRange, storageKeyOf } from './service.js';
import { type BlobStore } from './store.js';

const HEX64 = /^[0-9a-f]{64}$/;

export const registerBlobRoutes = (
  app: FastifyInstance,
  db: Db,
  store: BlobStore,
  service: BlobService,
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

      const out = await service.acceptWhole({
        userId: req.caller!.userId,
        deviceId: req.caller!.deviceId,
        sha256: Buffer.from(hex, 'hex'),
        size: declaredSize,
        encAlg,
        keyId,
        body: req.raw,
      });
      if (!out.ok) return refuse(reply, out.refusal);
      return reply.code(201).send({ sha256: out.value.sha256, size: out.value.size });
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

      const out = await service.acceptPart({
        userId: req.caller!.userId,
        deviceId: req.caller!.deviceId,
        sha256: Buffer.from(hex, 'hex'),
        index,
        total,
        size: declaredSize,
        body: req.raw,
      });
      if (!out.ok) return refuse(reply, out.refusal);
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

      const out = await service.complete({
        userId: req.caller!.userId,
        deviceId: req.caller!.deviceId,
        sha256: Buffer.from(hex, 'hex'),
        size: declaredSize,
        encAlg,
        keyId,
      });
      if (!out.ok) return refuse(reply, out.refusal);
      return reply.code(201).send({ sha256: out.value.sha256, size: out.value.size });
    },
  );
};
