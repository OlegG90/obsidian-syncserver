/**
 * What the engine needs from a server — declared by the engine, not by the client.
 *
 * The engine used to depend on the whole `SyncClient`, which meant two things. Its tests had
 * to satisfy a class they only partly used, and did so with a cast — `as unknown as
 * SyncClient` — which is a type checker being told to stop looking rather than a seam. And
 * every method added to the client for some other caller became, on paper, part of what the
 * engine could reach.
 *
 * Naming the nine operations it actually crosses fixes both: `SyncClient` satisfies this
 * structurally with no change to itself, a test double implements it natively, and the
 * protocol can grow without widening what synchronisation is coupled to.
 *
 * The types come from the shared package because they ARE the wire's shapes — a second set
 * of identical interfaces here would be the duplication this file exists to argue against.
 * The client-only shapes (`Envelope`, the parsed `PutConflict`/`CursorRejected`) stay on
 * the client, which is where the parsing happens.
 */
import type { Change, Delta, Material, NodeType } from '@syncserver/shared';
import type { CursorRejected, Envelope, PutConflict, CursorUnverifiable } from '../api/client.js';

export interface VaultWire {
  /** Where a client starts: the root, the head, and the key scope per scope (docs/06). */
  openVault(vaultId: string): Promise<{
    root_node_id: string;
    head_rev: number;
    /**
     * The vault's own scope, and every share scope this caller can open.
     *
     * `share_id` is what pairs a share with the key its interior is named under: a share
     * root's own label stays under `KV` (SH-01), so that pairing cannot be read off the
     * tree and has to be reported here.
     */
    scopes: { scope: string; key_id: string; share_id?: string; wrapped_key?: string; wrapping?: string }[];
  }>;

  /** The whole tree as it stands, with the cursor it was taken at. */
  listNodes(vaultId: string, under?: string): Promise<{ nodes: Change[]; snapshot: string }>;

  /** Which of these content tags this vault's own scope already knows (docs/07, adoption). */
  dedupLookup(vaultId: string, tags: string[]): Promise<Map<string, string>>;

  putBlob(
    sealed: { sha256: string; bytes: Uint8Array; keyId: string },
    encAlg?: string,
  ): Promise<{ sha256: string; size: number }>;

  /** `undefined` means the caller holds no live reference (#20), not that it is missing. */
  getBlob(sha256: string): Promise<Uint8Array | undefined>;

  /** The content keys for these addresses, wrapped to the scopes this caller holds. */
  blobKeys(vaultId: string, addresses: string[]): Promise<Map<string, Envelope[]>>;

  createNode(
    vaultId: string,
    body: Material & {
      parent_id: string;
      type: NodeType;
      sha256?: string;
      size?: number;
      mtime: string;
      name_enc: string;
      name_hmac: string;
      name_key_id: string;
    },
  ): Promise<{ node_id: string; rev: number }>;

  /** A `409` comes back as a value: it is the conflict path, not a failure (#52). */
  putContent(
    vaultId: string,
    nodeId: string,
    body: Material & { sha256: string; size: number; mtime: string; base_sha256: string | null },
  ): Promise<{ rev: number } | PutConflict>;

  /** Here the revision IS the precondition: the subject of the write is placement. */
  moveNode(
    vaultId: string,
    nodeId: string,
    ifMatchRev: number,
    body: { parent_id: string; name_enc: string; name_hmac: string; name_key_id: string },
  ): Promise<{ rev: number }>;

  /**
   * A soft delete: the row becomes the trash entry (docs/03). The revision precondition —
   * a delete that raced a write must lose, not silently win.
   */
  deleteNode(vaultId: string, nodeId: string, ifMatchRev: number): Promise<{ rev: number }>;

  /**
   * One question, asked before every walk: can this cursor still be answered?
   *
   * The engine passes `limit: 1` because it is after provenance, not pages — a 200 proves
   * the server is continuous with what the client last saw (so an absence in the tree is a
   * genuine deletion), and a 410 names the epoch that moved (docs/04). The changes
   * themselves are re-read through the full walk; incremental application is M2.
   *
   * **Three answers, and all three are declared.** A `400` about the cursor used to arrive
   * as a thrown `ApiError` that the engine caught by status — a policy decision read out of
   * an exception the seam never mentioned, which the second consumer of this interface
   * would have had to learn by reading `client.ts`.
   */
  delta(vaultId: string, cursor?: string, limit?: number): Promise<Delta | CursorRejected | CursorUnverifiable>;
}
