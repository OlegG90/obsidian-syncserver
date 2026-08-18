/**
 * Leaving a share: the decisions a departure makes about the replica it is converting.
 *
 * The actual conversion is `leaveShare` in `sharing.ts`; what this owns is the mapping
 * that feeds it. The replica listing the server returns is ciphertext and server-truth —
 * which scope each name is under, which blobs still owe material — and turning it into the
 * plan a departure performs is a decision only this side can make, since the server holds
 * no key and says only what a row carries.
 *
 * It used to live in a closure inside the Obsidian plugin class, where no test could reach
 * it — the one closure whose every comment cited a live-walk defect. Extracted here, the
 * mapping is pure: rows in, `PlannedItem[]` out, with a `VaultScopes`-shaped seam and a
 * path table the caller has already resolved.
 */
import { decryptName } from './crypto/scope.js';
import type { PlannedItem } from './sharing.js';

/** One row of the replica, as the server reports it (`GET /shares/:id/replica`). */
export interface ReplicaRow {
  node_id: string;
  name_enc: string | null;
  name_key_id: string | null;
  deleted: boolean;
  sha256: string | null;
  /** The server's answer to "does this still need KV material" — not the client's guess. */
  needs_vault_material: boolean;
  /** Superseded blobs of the same node that still owe an envelope; no tag is possible. */
  history_needing_material: string[];
}

/**
 * The key-opening half of `VaultScopes`, structurally — a real scopes value satisfies it,
 * and a test can fake it without opening a vault.
 */
export interface DepartureScopes {
  /** The key for a name this departure must be able to read, or a throw. */
  keyFor(nameKeyId: string | null | undefined): Uint8Array;
}

/**
 * Turn the replica listing into the plan a departure performs.
 *
 * Every row is converted — trash included, because the schema will not unmark a node whose
 * name is not yet under `KV`, and a name that is already there is not a reason to skip the
 * row. The caller has already established that every name is readable
 * (`requireEveryNameReadable`), so the strict `keyFor` is a fact rather than a risk.
 *
 * @param rows the server's replica listing.
 * @param scopes the vault's scopes — which key opens which name.
 * @param pathOfNode node id → path in THIS vault, so the conversion can read plaintext from
 *   disk. A trashed node has no path (nothing reads it) and falls back to its name.
 */
export const replicaForLeave = (
  rows: readonly ReplicaRow[],
  scopes: DepartureScopes,
  pathOfNode: ReadonlyMap<string, string>,
): PlannedItem[] =>
  rows.map((n) => {
    // A node can carry the mark without ever having been converted — the trash of a folder
    // shared later, for one. Its name is under `KV` already, and there is no `KS` envelope
    // for its content to move back, so the only thing it needs is the mark gone. Asking for
    // a conversion it never had is how leaving got stuck.
    //
    // One question, asked of the scopes rather than of a two-way test: `KV` and this share's
    // `KS` are both in there, so which key a name wants is a lookup rather than an
    // assumption about how many scopes can exist. `keyFor` is what makes that a fact rather
    // than a comment: if the readability check above ever stopped covering a case, this
    // refuses instead of naming a file something it is not.
    const name = decryptName(scopes.keyFor(n.name_key_id), n.name_enc!);
    return {
      nodeId: n.node_id,
      // A trashed node has no path and needs none: nothing reads it.
      path: pathOfNode.get(n.node_id) ?? name,
      name,
      // The server says which bytes still need converting; guessing from the name's scope
      // was wrong in both directions. It names the head and the history separately because
      // they are owed different things — an envelope each, but a dedup tag only where there
      // is a plaintext to compute it over.
      address: n.needs_vault_material ? n.sha256 : null,
      history: n.history_needing_material,
      deleted: n.deleted,
    };
  });