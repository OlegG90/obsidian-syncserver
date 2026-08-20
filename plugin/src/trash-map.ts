/**
 * The trash listing: server rows become the rows a screen can show, name decrypted per scope.
 *
 * The server returns each trashed node's name as ciphertext plus the scope it is named
 * under — a node of a shared folder is still under `KS` after it is deleted (SH-01 keeps the
 * root under `KV`, the interior under the share key). Choosing which key opens which name is
 * a decision only this side can make, and it used to live in a closure inside the Obsidian
 * plugin class where no test could reach it.
 *
 * The one rule this carries is the one worth stating twice: a node this device holds no key
 * for still gets a row, named as unreadable and still discardable — an unreadable name is a
 * worse reason to hide something than to show it plainly. `VaultScopes.readName` is the
 * lenient reader that answers "the name, or the stand-in".
 */
import type { VaultScopes } from './share-keys.js';

/** One entry of the trash, as the server reports it (`GET /vaults/:id/trash`). */
export interface TrashEntryRow {
  node_id: string;
  parent_id: string | null;
  name_enc: string | null;
  type: string;
  deleted_at: string;
  versions: number;
  name_key_id: string | null;
  share_id: string | null;
}

/** One row of the trash, as a screen shows it. */
export interface TrashRow {
  nodeId: string;
  /** Decrypted, or the stand-in when this device holds no key for the scope it is named under. */
  name: string;
  type: string;
  deletedAt: string;
  /** How many revisions are still behind it — what restoring has to choose from. */
  versions: number;
  /** True when this node belonged to a shared folder, which changes nothing but is worth seeing. */
  shared: boolean;
}

/**
 * Map a trash page into display rows, choosing the key that opens each name.
 *
 * `readName` is lenient on purpose: a missing key must not turn a discardable row into an
 * invisible one. The result is never written back, so the stand-in is safe to show.
 */
export const trashRows = (
  entries: readonly TrashEntryRow[],
  scopes: Pick<VaultScopes, 'readName'>,
): TrashRow[] =>
  entries.map((n) => ({
    nodeId: n.node_id,
    name: scopes.readName(n.name_key_id, n.name_enc),
    type: n.type,
    deletedAt: n.deleted_at,
    versions: n.versions,
    shared: n.share_id !== null,
  }));
