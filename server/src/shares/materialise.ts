/**
 * Making a share's subtree exist in another vault, with its past — the act both arrival
 * paths perform.
 *
 * Joining and catching up are the same walk seen at two distances: order the source
 * parents-first, find or create each counterpart, and bring the versions behind it with the
 * people who wrote them. They used to be two loops that each did this by hand, and the
 * copies disagreed where it mattered. The one shared skeleton was `replica.ts` — ancestry —
 * which is the *easy* field; the walk that calls it stayed duplicated, and `recordVersion`'s
 * `ifAbsent` flag existed purely so one caller could behave differently from the other.
 *
 * This module owns the part of the walk that is the same in both, and names the difference
 * as a mode:
 *
 * - **`renumber`** is joining's: a fresh copy cannot collide, so history is written
 *   unconditionally under revisions the caller reserved **before** creating the head. The
 *   head is then the highest revision by construction — the invariant `retention.ts` reads
 *   when it decides what is history at all (`is_head = max(rev)` is what the ladder spares).
 * - **`keep`** is catching-up's: the replica may already hold some of these from an earlier
 *   pass, so a collision is absorbed rather than failed (`ifAbsent`), and only what was
 *   actually written is claimed.
 *
 * Both modes keep the **original author** (SH-19) and the **original moment** (SH-23): a
 * past that all happened at the instant of arrival is not a past. And both claim each blob
 * once for the account receiving the content — which the catch-up used to skip entirely,
 * leaving its member uncharged for bytes they now reference.
 */
import type { PoolClient } from 'pg';
import { claimBlob, recordVersion } from '../holdings.js';

/** How the copy places revisions: fresh, or the source's own. */
export type CopyMode = 'renumber' | 'keep';

/** One version to place in a counterpart, already resolved to the node it belongs to. */
export interface VersionToCopy {
  /** The counterpart node this history belongs to. */
  targetNodeId: string;
  /** `renumber`: a revision reserved below the head; `keep`: the source's own. */
  rev: number;
  sha256: string;
  size: number;
  authorId: string;
  /** When it was written — preserved, because history that all happened at arrival is not history. */
  at: string;
}

/**
 * Place versions into counterparts, keeping authorship and moments, claiming each blob once.
 *
 * `renumber` writes under the revisions the caller reserved, so the caller must reserve them
 * and create the head **after** this returns. `keep` writes under the source's own revisions
 * and absorbs collisions, so a repeat pass writes nothing and claims nothing — which is what
 * makes a second catch-up idempotent.
 *
 * @returns how many version rows were actually written.
 */
export const copyVersions = async (
  c: PoolClient,
  opts: { vaultId: string; userId: string; versions: VersionToCopy[]; mode: CopyMode },
): Promise<number> => {
  let written = 0;
  for (const v of opts.versions) {
    const out = await recordVersion(c, {
      vaultId: opts.vaultId,
      nodeId: v.targetNodeId,
      rev: v.rev,
      sha256: v.sha256,
      size: v.size,
      authorId: v.authorId,
      at: v.at,
      ifAbsent: opts.mode === 'keep',
    });
    // Nothing written means the replica already had it — an absorbed collision. Only a row
    // that was actually placed is claimed, or a repeat pass would charge the account twice.
    if (opts.mode === 'keep' && !out.written) continue;
    await claimBlob(c, opts.userId, v.sha256);
    written++;
  }
  return written;
};
