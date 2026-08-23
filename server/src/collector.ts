/**
 * The TTL sweeps docs/04 promises (abandoned parts, unbound blobs, the delta journal).
 *
 * This is deliberately the *sweeps*, not the full nightly mark-and-sweep of
 * docs/03 (`refcount` reconciliation, node-row removal, quarantine) — M0 has no
 * resumable parts and no deleted-node GC to run against, and inventing the machinery
 * before the thing it collects exists would be code with no path to exercise it.
 *
 * What M0 does have, and what this collects:
 *
 *   - **abandoned parts** (`abandonedPartTtlSeconds`): a `.part` temp file left by an
 *     interrupted `store.put`. Nothing is ever served from a temp name, so deleting by
 *     age cannot touch live content.
 *   - **unbound blobs** (`unboundBlobTtlSeconds`): a `user_blobs` row with
 *     `refs_pending > 0` and no `refs_own` — uploaded, never bound by a node. It counts
 *     against quota while it lives (docs/04) and is dropped on its TTL.
 *   - **stale pending claims** on a blob that *is* bound: the same expiry, on a row that
 *     must not be deleted. Without it the counter only ever grows.
 *   - **orphan blobs** after that: a `blobs` row nobody references (no `user_blobs`, no
 *     node, no version) is removed together with its file. The `DELETE` re-checks the
 *     references at statement time, so a blob bound between two passes is never swept —
 *     the same protection the quarantine exists for, earned here by the delete being the
 *     re-check.
 *   - **the delta journal** (`journalTtlSeconds`): append-only, 90-day TTL. Pruning the
 *     oldest rows is what advances `oldestJournalRev`, so a stale cursor eventually gets
 *     `410 journal_ttl` instead of being answered from a gap (docs/04).
 *
 * One pass is a single transaction for the database half, then the file deletions that
 * could not be part of it. A crash between the two leaves files, not corruption: an
 * orphan file is found by the next pass, and the re-checking `DELETE` means a missing
 * file never takes a live blob down with it. Rows are deleted before their files are
 * unlinked, never after — an unlink that races a re-upload could otherwise erase a
 * freshly-committed row's file.
 *
 * A pass holds an advisory lock for its duration, which is both mutual exclusion between
 * collectors and the switch docs/08 needs to keep one out of a backup window.
 */
import type { Config } from './config.js';
import { holdForCollector } from './interlock.js';
import type { Db } from './db.js';
import type { BlobStore } from './blobs/store.js';
import { dropSpentClaims, markUnreferenced, REFERENCED, removeSpentTrash, thinVersions } from './retention.js';

export interface CollectorResult {
  /** Version rows the retention ladder no longer keeps. */
  versionsThinned: number;
  /** Trashed nodes whose history had all been thinned away. */
  trashRemoved: number;
  /** `user_blobs` rows nothing of the account references any more. */
  claimsDropped: number;
  /** Blobs newly put into quarantine, and blobs taken back out of it. */
  blobsMarked: number;
  blobsUnmarked: number;
  partsSwept: number;
  unboundDropped: number;
  pendingCleared: number;
  blobsRemoved: number;
  journalPruned: number;
  /** True when another holder of the lock was collecting, or an operator was holding it off. */
  skipped: boolean;
}


const EMPTY: CollectorResult = {
  versionsThinned: 0, trashRemoved: 0, claimsDropped: 0, blobsMarked: 0, blobsUnmarked: 0,
  partsSwept: 0, unboundDropped: 0, pendingCleared: 0, blobsRemoved: 0, journalPruned: 0, skipped: false,
};

export const runCollector = async (
  db: Db,
  store: BlobStore,
  cfg: Config,
  log: (s: string) => void = console.log,
): Promise<CollectorResult> =>
  // The lock is held across several transactions and released by the connection that took
  // it, so the whole pass runs inside one session.
  db.session(async (lock) => {
    const release = await holdForCollector(lock);
    if (!release) return { ...EMPTY, skipped: true };
    try {
      return await sweep(db, store, cfg, log);
    } finally {
      await release();
    }
  });

const sweep = async (db: Db, store: BlobStore, cfg: Config, log: (s: string) => void): Promise<CollectorResult> => {
  const out: CollectorResult = { ...EMPTY };

  // Steps 1 and 2 of docs/03, and they are first for the reason it gives: **thinning
  // precedes marking, in the same pass**, because the reverse order leaves a window in which
  // a version row exists and the blob it names is already gone. The trash follows it in the
  // same transaction — a node whose history the ladder just took is exactly what step 2 is
  // looking for, and a crash between the two would leave a row describing nothing.
  const aged = await db.tx(async (c) => {
    const versionsThinned = await thinVersions(c);
    const trashRemoved = await removeSpentTrash(c);
    return { versionsThinned, trashRemoved };
  });
  out.versionsThinned = aged.versionsThinned;
  out.trashRemoved = aged.trashRemoved;

  // Unbound blobs: uploaded, never bound by a node, past their TTL. Only rows with no
  // `refs_own` — a pending upload the client is still binding must not be swept, which
  // is also why the parts TTL stays strictly below this one (checked at startup).
  const unbound = await db.tx(async (c) => {
    const dropped = await c.query(
      `DELETE FROM user_blobs ub
        WHERE ub.refs_own = 0 AND ub.refs_pending > 0
          AND ub.pending_since < now() - make_interval(secs => $1::double precision)`,
      [cfg.limits.unboundBlobTtlSeconds],
    );
    return dropped.rowCount ?? 0;
  });
  out.unboundDropped = unbound;

  // The other half of the same expiry, and the one the sweep above cannot see: a stale
  // pending claim on a blob that IS bound. `refs_own > 0` excludes it from the delete —
  // correctly, the row must stay — but nothing then ever clears the counter, so a vault
  // that uploads more often than it binds drifts `refs_pending` upward for ever and keeps
  // a `pending_since` that no longer describes anything.
  //
  // Cleared rather than decremented, because `pending_since` records the OLDEST pending
  // claim and there is no per-claim timestamp to age them off one at a time. Nothing
  // depends on the count once `refs_own` holds the row up: quota counts the row, not the
  // claims, and binding already decrements through `GREATEST(… - 1, 0)`, so a later
  // binding of one of these finds zero and stays at zero.
  //
  // The single UPDATE has a coarse edge, taken deliberately: a row that carries BOTH a
  // stale claim and a fresh one loses the fresh claim too — there is no per-claim
  // timestamp to tell them apart, and `pending_since` only remembers the oldest. That is
  // accepted because `refs_own` still holds the row, so the row is not swept, and the
  // count itself is nothing the rest of the system depends on once `refs_own > 0` (quota
  // counts the row, not its claims; the bind path re-adds the claim if one is still
  // pending elsewhere). Worst case the fresh claim's `pending_device_id` is lost, which
  // only affects attribution of an in-flight pending upload, not its survival.
  const cleared = await db.tx(async (c) => {
    const r = await c.query(
      `UPDATE user_blobs
          SET refs_pending = 0, pending_since = NULL, pending_device_id = NULL
        WHERE refs_own > 0 AND refs_pending > 0
          AND pending_since < now() - make_interval(secs => $1::double precision)`,
      [cfg.limits.unboundBlobTtlSeconds],
    );
    return r.rowCount ?? 0;
  });
  out.pendingCleared = cleared;

  // Blobs nobody references any more. The DELETE re-checks the references, so the row
  // set can only shrink between the collection and the deletion — never grow into it.
  //
  // The files go **after the commit**, never inside it. Inside, a failed COMMIT would roll
  // the rows back onto files that are already gone, which is the one outcome this whole
  // ordering exists to avoid: a reference pointing at nothing is data loss a client sees,
  // while a file nobody references is disk nobody misses.
  //
  // The commit gap is not free of races, though: between it and the unlink below, an
  // upload of the same content can re-create the row and the file. The upload writes the
  // file first (`store.put`) and the row second (`recordUpload`), so the dangerous
  // interleaving is one where the file is already on disk but the row is not yet
  // committed — the gap between those two steps. Every key is therefore re-checked against
  // the blobs table after the delete: an upload whose row committed first is seen as a
  // live row and its file is left alone. The remaining gap (file written, row committed
  // between the check and the unlink) is accepted deliberately: closing it would need the
  // upload to hold a database lock across its whole streamed write, a connection per
  // in-flight upload — a worse price than the window. What the window costs is bounded:
  // it can only take a *duplicate* upload whose bytes the client still holds, so a 404 on
  // it sends the same bytes again, and the row without a file is swept again once its
  // pending claim expires — it does not accumulate.
  // Steps 4 and 5, and they must come after the TTL sweeps above rather than before them:
  // an unbound claim dropped for age is a reference disappearing, and a mark taken before it
  // went would find the blob still held and leave it alive for another whole pass.
  const claims = await db.tx(async (c) => {
    const claimsDropped = await dropSpentClaims(c);
    const { marked, unmarked } = await markUnreferenced(c);
    return { claimsDropped, marked, unmarked };
  });
  out.claimsDropped = claims.claimsDropped;
  out.blobsMarked = claims.marked;
  out.blobsUnmarked = claims.unmarked;

  //
  // **It sweeps what the mark condemned, not what it finds unreferenced now.** The
  // quarantine is the difference: a blob loses its last reference the moment a claim is
  // dropped — which emptying the trash now makes an ordinary event — and deleting on the
  // spot races an upload of the same content, which writes its file before it commits its
  // row. The `NOT REFERENCED` half is still asked here, and asking it twice is the point:
  // the mark says "this looked dead a week ago", this says "and it still is".
  const orphans = await db.tx(async (c) => {
    const keys = await c.query<{ storageKey: string }>(
      `DELETE FROM blobs b
        WHERE b.gc_marked_at IS NOT NULL
          AND b.gc_marked_at < now() - make_interval(secs => $1::double precision)
          AND NOT ${REFERENCED}
        RETURNING b.storage_key AS "storageKey"`,
      [cfg.limits.gcQuarantineSeconds],
    );
    return keys.rows.map((r) => r.storageKey);
  });
  // One query for every orphan, not one per file: the collector must scale to tens of
  // thousands of blobs, and a pass that becomes N round-trips would not.
  const claimed = orphans.length
    ? await db.one<{ claimed: string[] }>(
        `SELECT array_agg(storage_key) AS claimed FROM blobs WHERE storage_key = ANY($1::text[])`,
        [orphans],
      )
    : undefined;
  const claimedSet = new Set(claimed?.claimed ?? []);

  let filesRemoved = 0;
  for (const storageKey of orphans) {
    if (claimedSet.has(storageKey)) continue; // something re-claimed this address — keep its file
    try {
      await store.remove(storageKey);
      filesRemoved++;
    } catch (e) {
      // One unremovable file must not fail the whole pass: the row is already gone, so
      // the file is an orphan the next sweep will find again. Logged and moved on.
      log(`collector: failed to remove ${storageKey}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  out.blobsRemoved = filesRemoved;

  out.partsSwept = await store.sweepParts(cfg.limits.abandonedPartTtlSeconds * 1000);

  const pruned = await db.tx(async (c) => {
    const r = await c.query(`DELETE FROM journal WHERE at < now() - make_interval(secs => $1::double precision)`, [
      cfg.limits.journalTtlSeconds,
    ]);
    return r.rowCount ?? 0;
  });
  out.journalPruned = pruned;

  return out;
};

/**
 * Run one pass now, then one every `sweepIntervalSeconds`. Unref'd so the timer never
 * keeps the process alive on its own.
 */
export const startCollector = (db: Db, store: BlobStore, cfg: Config, log = console.log): () => void => {
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pass = async (): Promise<void> => {
    if (running) return; // a slow pass must not pile up behind itself
    running = true;
    try {
      const r = await runCollector(db, store, cfg, log);
      // Said out loud, because from the outside a skipped pass and an empty one look the
      // same, and the operator holding the lock wants to see that it took effect.
      if (r.skipped) {
        log('collector: skipped, the advisory lock is held elsewhere');
      } else if (
        r.partsSwept || r.unboundDropped || r.pendingCleared || r.blobsRemoved || r.journalPruned ||
        r.versionsThinned || r.trashRemoved || r.claimsDropped || r.blobsMarked || r.blobsUnmarked
      ) {
        log(
          `collector: ${r.versionsThinned} versions thinned, ${r.trashRemoved} trashed nodes, ` +
            `${r.claimsDropped} claims dropped, ${r.blobsMarked} marked, ${r.blobsUnmarked} unmarked, ` +
            `${r.unboundDropped} unbound, ${r.pendingCleared} pending cleared, ` +
            `${r.blobsRemoved} blobs, ${r.partsSwept} parts, ${r.journalPruned} journal rows`,
        );
      }
    } catch (e) {
      log(`collector failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  void pass();
  timer = setInterval(() => void pass(), cfg.sweepIntervalSeconds * 1000);
  timer.unref?.();

  return () => clearInterval(timer);
};
