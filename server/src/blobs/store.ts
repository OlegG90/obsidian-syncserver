/**
 * Where a blob lives on disk, and the one property the rest of the system leans on.
 *
 * `storage_key` is `<first 2 hex>/<next 2 hex>/<full hex>` (docs/04). Two levels keep a
 * store of tens of thousands of blobs at hundreds of files per directory; the full address
 * is the filename, not a remainder of it, so a blob found in a backup identifies itself
 * without the database.
 *
 * **A blob is written to a temporary name and renamed into place.** That rename is the
 * commit point: a blob is either absent or complete at its address, never half-written
 * under it. It is what makes the collector's re-check safe, and what an interrupted upload
 * leaves behind — a temp file the parts TTL sweeps, not a corrupt blob.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const storageKeyFor = (sha256Hex: string): string =>
  `${sha256Hex.slice(0, 2)}/${sha256Hex.slice(2, 4)}/${sha256Hex}`;

export interface BlobStore {
  /**
   * Write bytes to a temp name, verify they hash to the address they claim, then rename.
   *
   * The verification is not ceremony. Deduplication means one address is shared by
   * everyone who holds that content (#42), so a client allowed to store arbitrary bytes
   * under an address of its choosing could poison what other accounts later resolve.
   */
  put(sha256Hex: string, body: Readable): Promise<{ storageKey: string; size: number }>;
  read(storageKey: string, range?: { start: number; end: number } | undefined): Readable;
  size(storageKey: string): Promise<number | undefined>;
  remove(storageKey: string): Promise<void>;
  /**
   * Remove temp files left behind by interrupted uploads (docs/04, parts TTL).
   *
   * A blob is written to a name beside its target and renamed into place, so the only
   * files this can delete by age are incomplete writes — nothing is ever served from a
   * temp name, and a live upload refreshes the file's mtime as it streams.
   */
  sweepParts(olderThanMs: number): Promise<number>;
}

export class HashMismatch extends Error {
  constructor(readonly declared: string, readonly actual: string) {
    super(`blob does not hash to the address it claims`);
  }
}

export const openStore = (root: string): BlobStore => {
  const abs = (key: string) => join(root, key);

  return {
    async put(sha256Hex, body) {
      const key = storageKeyFor(sha256Hex);
      const target = abs(key);
      // The temp name carries the address so a sweep can tell what was being written, and
      // sits beside the target so the rename stays on one filesystem — across a boundary
      // it would be a copy, and a copy is not atomic.
      const temp = `${target}.${process.pid}.part`;

      await mkdir(dirname(target), { recursive: true });

      // Streamed to disk while hashing, never accumulated: this is the path every byte in
      // the system travels, and a vault migration sends thousands of files through it.
      const hash = createHash('sha256');
      let size = 0;
      const out = createWriteStream(temp);
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
            hash.update(buf);
            size += buf.length;
            yield buf;
          }
        },
        out,
      );

      // Verified before the rename, so a mismatch never occupies the address — it stays a
      // temp file, which is what the parts TTL sweeps.
      const actual = hash.digest('hex');
      if (actual !== sha256Hex) {
        await rm(temp, { force: true });
        throw new HashMismatch(sha256Hex, actual);
      }

      await rename(temp, target);
      return { storageKey: key, size };
    },

    read(storageKey, range) {
      return range
        ? createReadStream(abs(storageKey), { start: range.start, end: range.end })
        : createReadStream(abs(storageKey));
    },

    async size(storageKey) {
      try {
        return (await stat(abs(storageKey))).size;
      } catch {
        return undefined;
      }
    },

    async remove(storageKey) {
      await rm(abs(storageKey), { force: true });
    },

    async sweepParts(olderThanMs) {
      const cutoff = Date.now() - olderThanMs;
      let removed = 0;

      // The store is exactly two fan-out levels plus the blob files themselves, but
      // nothing here depends on the depth: a walk deletes any *.part older than the
      // cutoff, wherever an interrupted upload left it.
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(p);
            continue;
          }
          if (!entry.name.endsWith('.part')) continue;
          const st = await stat(p).catch(() => undefined);
          if (st && st.mtimeMs < cutoff) {
            await rm(p, { force: true });
            removed++;
          }
        }
      };

      await walk(root);
      return removed;
    },
  };
};
