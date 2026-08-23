/**
 * What a file's bytes become on the way to the server: an address, and the material that opens it.
 *
 * Two outcomes, and the difference between them is the whole of deduplication:
 *
 * - **this scope already holds these bytes** — the tag matched, so the existing address is reused and
 *   **no material is produced at all**. There is nothing to wrap: the envelope and the tag the first
 *   upload wrote are already there, and writing them again would be the same rows a second time;
 * - **it does not** — the bytes are sealed under a fresh content key, uploaded once, and the material
 *   says how to open them: one envelope wrapping that key to this scope, one tag so the next file with
 *   the same bytes takes the branch above.
 *
 * **The tag is per scope, and that is a privacy property rather than an implementation detail.** It is
 * derived from the scope key and the plaintext, so two vaults holding the same file produce different
 * tags and the server cannot tell they match (docs/07). Which also means the scope passed here has to be
 * the scope the node is named under — hand it the vault's scope for a file inside a share and the
 * envelope wraps to a key the share's readers do not have.
 *
 * Extracted so that last sentence can be asserted. It was three branches inside a method that needed a
 * whole pass to reach, and the only way to ask "does a dedup hit avoid re-wrapping" was to run one.
 */
import { sealBlob } from '../crypto/blob.js';
import type { Material } from '@syncserver/shared';
import { dedupTag, wrapContentKey } from '../crypto/scope.js';

/**
 * The `material` half of a node write, **both halves always present**.
 *
 * `shared`'s `Material` has them optional, because a caller may send neither — and this is not a second
 * version of that type but a narrowing of it: what comes out of here always says both, even when both
 * are empty, so no caller has to ask whether the arrays exist before reading them.
 */
type WrittenMaterial = Required<Material>;

/** Uploading is the one thing here that leaves this device, so it is the one thing injected. */
export type PutBlob = (sealed: { sha256: string; bytes: Uint8Array; keyId: string }) => Promise<unknown>;

export const resolveContent = async (
  plain: Uint8Array,
  scope: { id: string; key: Uint8Array },
  /** Content tag → address, for what this scope is already known to hold. */
  dedup: Map<string, string>,
  putBlob: PutBlob,
): Promise<{ sha256: string; material: WrittenMaterial }> => {
  const tag = dedupTag(scope.key, plain);
  const known = dedup.get(tag);
  if (known) return { sha256: known, material: { blob_envelopes: [], dedup_tags: [] } };

  const sealed = sealBlob(plain);
  await putBlob(sealed);
  return {
    sha256: sealed.sha256,
    material: {
      blob_envelopes: [{ sha256: sealed.sha256, scope_id: scope.id, wrapped_key: wrapContentKey(scope.key, sealed.contentKey) }],
      dedup_tags: [{ sha256: sealed.sha256, scope_id: scope.id, content_tag: tag }],
    },
  };
};
