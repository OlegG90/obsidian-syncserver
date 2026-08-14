/**
 * Client-produced key material, and the one place it is written.
 *
 * Two write families need it now — a node write carries the envelopes and tags its new
 * reference requires, and preparing a share adds `KS` material to a subtree that already
 * exists — and the second was about to be a second copy of the first. The `DO UPDATE`
 * below is the reason that would have been expensive: it is not a stylistic choice, and a
 * copy made without it produces a `500` the caller cannot avoid by sending correct data.
 *
 * The server never derives any of this. It stores what the client sealed, and the only
 * judgement it makes is which row an insert collides with.
 */
import type { PoolClient } from 'pg';

export interface Material {
  /** `blob_keys`: the content key wrapped for a scope allowed to read it. */
  envelopes: { sha256: string; scopeId: string; wrappedKey: string }[];
  /** `dedup_index`: HMAC(scope key, plaintext hash) → address. */
  dedupTags: { sha256: string; scopeId: string; contentTag: string }[];
}

export const writeMaterial = async (c: PoolClient, m: Material): Promise<void> => {
  for (const e of m.envelopes) {
    await c.query(
      `INSERT INTO blob_keys (sha256, scope_id, wrapped_key) VALUES (decode($1,'hex'), $2, decode($3,'base64'))
       ON CONFLICT (sha256, scope_id) DO NOTHING`,
      [e.sha256, e.scopeId, e.wrappedKey],
    );
  }
  for (const t of m.dedupTags) {
    // `DO UPDATE`, not `DO NOTHING`, and the difference is a 500 the client cannot avoid.
    //
    // The tag names the PLAINTEXT — `HMAC(scope key, sha256(plaintext))` — while the address
    // names one encryption of it. `KC` is random, so sealing the same file twice yields the
    // same tag and a NEW address. `DO NOTHING` then leaves the tag pointing at the old
    // address, and `nodes_check_private_material` refuses the write because the new one has
    // no tag: the caller sent correct material and is told the material is missing.
    //
    // Repointing is the right resolution rather than a workaround. Both addresses decrypt to
    // the same plaintext, so either is a truthful answer to "where is this content"; the
    // newest is the one a node is about to reference, and the older is left for the
    // collector once nothing holds it.
    await c.query(
      `INSERT INTO dedup_index (scope_id, content_tag, sha256) VALUES ($1, decode($2,'hex'), decode($3,'hex'))
       ON CONFLICT (scope_id, content_tag) DO UPDATE SET sha256 = EXCLUDED.sha256`,
      [t.scopeId, t.contentTag, t.sha256],
    );
  }
};
