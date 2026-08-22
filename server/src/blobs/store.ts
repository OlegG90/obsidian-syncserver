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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const storageKeyFor = (sha256Hex: string): string =>
  `${sha256Hex.slice(0, 2)}/${sha256Hex.slice(2, 4)}/${sha256Hex}`;

/**
 * Where the parts of a resumable upload wait (docs/04).
 *
 * Per **account**, because the 2 GB in-flight ceiling is per account and this directory is
 * the only place it is recorded — parts have no database row, deliberately: a row created
 * before the bytes arrive would be a claim on content the uploader has not proved it has.
 *
 * `staging` cannot collide with a blob: the first level of a storage key is two hex
 * characters, and this is seven letters.
 */
const STAGING = 'staging';

export interface BlobStore {
  /**
   * Write bytes to a temp name, verify they hash to the address they claim, then rename.
   *
   * The verification is not ceremony. Deduplication means one address is shared by
   * everyone who holds that content (D-42), so a client allowed to store arbitrary bytes
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

  /** Write one part of a resumable upload. Overwrites, so a client unsure of a part may resend it. */
  stagePart(userId: string, sha256Hex: string, index: number, body: Readable): Promise<{ size: number }>;
  /** What this caller has already staged for this address — the answer to a resume (docs/04). */
  stagedParts(userId: string, sha256Hex: string): Promise<{ parts: number[]; bytes: number }>;
  /** Unfinished bytes across every upload this account has in flight, for the 2 GB ceiling. */
  stagedBytes(userId: string): Promise<number>;
  /**
   * Concatenate `1..k` into the blob's address, through the same verified write a
   * single-shot upload uses — so a resumable upload cannot store bytes a `POST` could not.
   */
  assemble(userId: string, sha256Hex: string): Promise<{ storageKey: string; size: number }>;
  /** Drop one part, leaving a hole a retry of that index fills. */
  discardPart(userId: string, sha256Hex: string, index: number): Promise<void>;
  discardStaging(userId: string, sha256Hex: string): Promise<void>;
}

export class HashMismatch extends Error {
  constructor(readonly declared: string, readonly actual: string) {
    super(`blob does not hash to the address it claims`);
  }
}

/** The staged run from 1 has a hole, so there is nothing whole to assemble. */
export class PartsMissing extends Error {
  constructor(readonly have: number[]) {
    super(`the staged parts are not a contiguous run from 1`);
  }
}

export const openStore = (root: string): BlobStore => {
  const abs = (key: string) => join(root, key);
  const stagingDir = (userId: string, sha256Hex: string) => join(root, STAGING, userId, sha256Hex);

  /** The staged indices, ascending, with the byte count that answers the in-flight ceiling. */
  const listStaged = async (dir: string): Promise<{ parts: number[]; bytes: number }> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const parts: number[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // Anything not a plain part number is an incomplete write this same code left behind;
      // it is swept by age, and until then it is not a part.
      if (!/^[1-9][0-9]*$/.test(entry.name)) continue;
      const st = await stat(join(dir, entry.name)).catch(() => undefined);
      if (!st) continue;
      parts.push(Number(entry.name));
      bytes += st.size;
    }
    parts.sort((a, b) => a - b);
    return { parts, bytes };
  };

  const put: BlobStore['put'] = async (sha256Hex, body) => {
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
  };

  return {
    put,

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

      // The staging area is swept by upload, not by file: an upload is abandoned when its
      // NEWEST part is older than the cutoff, and a per-file rule would eat the early parts
      // of a slow but live migration while its later ones were still arriving.
      const staging = join(root, STAGING);
      for (const user of await readdir(staging, { withFileTypes: true }).catch(() => [])) {
        if (!user.isDirectory()) continue;
        const userDir = join(staging, user.name);
        for (const upload of await readdir(userDir, { withFileTypes: true }).catch(() => [])) {
          if (!upload.isDirectory()) continue;
          const dir = join(userDir, upload.name);
          const files = await readdir(dir).catch(() => []);
          let newest = 0;
          for (const name of files) {
            const st = await stat(join(dir, name)).catch(() => undefined);
            if (st && st.mtimeMs > newest) newest = st.mtimeMs;
          }
          if (files.length === 0 || newest < cutoff) {
            await rm(dir, { recursive: true, force: true });
            removed += files.length;
          }
        }
      }

      return removed;
    },

    async stagePart(userId, sha256Hex, index, body) {
      const dir = stagingDir(userId, sha256Hex);
      await mkdir(dir, { recursive: true });

      // Written beside its name and renamed, for the same reason a blob is: a part half
      // written under its final name would be read as complete by the next `complete`.
      const target = join(dir, String(index));
      const temp = `${target}.${process.pid}.part`;
      let size = 0;
      await pipeline(
        body,
        async function* (source) {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike);
            size += buf.length;
            yield buf;
          }
        },
        createWriteStream(temp),
      );
      await rename(temp, target);
      return { size };
    },

    async stagedParts(userId, sha256Hex) {
      return listStaged(stagingDir(userId, sha256Hex));
    },

    async stagedBytes(userId) {
      const userDir = join(root, STAGING, userId);
      let bytes = 0;
      for (const upload of await readdir(userDir, { withFileTypes: true }).catch(() => [])) {
        if (!upload.isDirectory()) continue;
        bytes += (await listStaged(join(userDir, upload.name))).bytes;
      }
      return bytes;
    },

    async assemble(userId, sha256Hex) {
      const dir = stagingDir(userId, sha256Hex);
      const { parts } = await listStaged(dir);

      // A run from 1 with no hole. `complete` names no part count, so the parts themselves
      // are the only statement of how long the blob is — a hole would silently truncate it,
      // and the address check would then refuse it with a much less useful message.
      if (parts.length === 0 || parts.some((n, i) => n !== i + 1)) throw new PartsMissing(parts);

      // Reuses `put`, which is the point: hashing, the address check and the rename are one
      // implementation, so the resumable path cannot drift into accepting what the
      // single-shot path refuses.
      const source = Readable.from(
        (async function* () {
          for (const n of parts) {
            yield* createReadStream(join(dir, String(n)));
          }
        })(),
      );
      return put(sha256Hex, source);
    },

    async discardPart(userId, sha256Hex, index) {
      await rm(join(stagingDir(userId, sha256Hex), String(index)), { force: true });
    },

    async discardStaging(userId, sha256Hex) {
      await rm(stagingDir(userId, sha256Hex), { recursive: true, force: true });
    },
  };
};
