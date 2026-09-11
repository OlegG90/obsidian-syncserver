/**
 * Making a share's subtree exist in another vault, with its past — the version-copying
 * half of both arrival paths.
 *
 * Joining and catching up are **different walks**, not one walk duplicated: joining
 * *creates* an empty replica (a source-id → new-id mapping, every node inserted fresh),
 * while catching up *levels* an existing replica (correspondence by `share_item_id`, nodes
 * updated in place, only the history it lacks). What the two genuinely share is this module:
 * placing the version rows behind a counterpart, keeping authorship (SH-19) and moments
 * (SH-23), and claiming each blob once for the receiving account. That common core is
 * deliberately not a single "walk" abstraction — the iteration bodies differ enough that
 * merging them would be a module whose deletion test fails.
 *
 * **Revisions are the receiving vault's own**, reserved by the caller **before** the write
 * that creates or updates the head — so the head is the highest revision by construction,
 * the invariant `retention.ts` reads when it decides what is history at all (`is_head =
 * max(rev)` is what the ladder spares). The catch-up used to write under the SOURCE's
 * revision numbers instead, which duplicated every version a member already had by
 * propagation and could leave an old one numbered above the head (#340).
 *
 * Both keep the **original author** (SH-19) and the **original moment** (SH-23): a past that
 * all happened at the instant of arrival is not a past. And both claim each blob once for
 * the account receiving the content — which the catch-up used to skip entirely, leaving its
 * member uncharged for bytes they now reference.
 */
import type { PoolClient } from 'pg';
import { claimBlob, recordVersion } from '../holdings.js';

/** One version to place in a counterpart, already resolved to the node it belongs to. */
export interface VersionToCopy {
  /** The counterpart node this history belongs to. */
  targetNodeId: string;
  /** A revision of the receiving vault, reserved by the caller. */
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
 * Writes under the revisions the caller reserved. A collision is a failure, not something to
 * absorb: two writers claiming one revision is a defect, and absorbing it would hide one.
 *
 * @returns how many version rows were written.
 */
export const copyVersions = async (
  c: PoolClient,
  opts: { vaultId: string; userId: string; versions: VersionToCopy[] },
): Promise<number> => {
  for (const v of opts.versions) {
    await recordVersion(c, {
      vaultId: opts.vaultId,
      nodeId: v.targetNodeId,
      rev: v.rev,
      sha256: v.sha256,
      size: v.size,
      authorId: v.authorId,
      at: v.at,
    });
    await claimBlob(c, opts.userId, v.sha256);
  }
  return opts.versions.length;
};
