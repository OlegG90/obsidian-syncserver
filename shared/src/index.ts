/**
 * The wire contract, and only that.
 *
 * This package exists for one reason: the server and the plugin both have to know the
 * shape of what passes between them, and two independent copies of that knowledge drift.
 * It is the same rule the documentation follows — one description of one thing.
 *
 * What belongs here: values that appear literally in a request or a response. What does
 * not: server configuration, storage layout, anything cryptographic (raw keys never leave
 * the client — the wrapped envelope is exactly what a request does carry), and anything
 * either side can decide on its own.
 *
 * Normative source: docs/04-sync-protocol.md.
 */

/** A node is a file or a folder, and never changes from one to the other (#102). */
export type NodeType = 'file' | 'folder';

/** The Argon2id parameters a redeem carries, and the floor the server enforces (#62). */
export interface KdfParams {
  v: number;
  m: number;
  t: number;
  p: number;
}

/** Why a write was refused with 409. The server emits all four; the client resolves three as a conflict. */
export type WriteConflict =
  /** The content precondition failed: someone else wrote first (#52). */
  | 'base_mismatch'
  /** The revision precondition failed: placement moved on, and it is the subject of the write. */
  | 'rev_mismatch'
  /** A move may not cross into or out of a shared folder; copy/put then delete the source. */
  | 'share_boundary'
  /** Restoring into a name that has since been taken; no automatic renaming (#36). */
  | 'name_taken';

/** One node as the delta (or the listing) describes it. */
export interface Change {
  node_id: string;
  parent_id: string | null;
  name_enc: string | null;
  name_hmac: string | null;
  name_key_id: string | null;
  op: 'put' | 'del' | 'move' | string;
  rev: number;
  sha256: string | null;
  size: number | null;
  mtime: string;
  share_id: string | null;
  author_id: string | null;
}

/** The delta response: the changes since the cursor, and the cursor to carry next (#24). */
export interface Delta {
  changes: Change[];
  events: { type: string; [k: string]: unknown }[];
  next_cursor: string;
  has_more: boolean;
}

/**
 * What a restore did: the revision it wrote, and the **ancestor folders it had to lift out
 * of the trash** to put the node back where it belongs (docs/04).
 *
 * `lifted` is a list of node ids, not a flag. It was declared here after the two sides had
 * already disagreed about it — the server returning ids, the client reading a boolean, and
 * an empty array being truthy, so "nothing was lifted" read as "something was". The whole
 * point of this package is that such a pair cannot compile.
 */
export interface RestoreResult {
  rev: number;
  lifted: string[];
}

/** Client-produced key material for a node: the sealed blob's envelopes and dedup tags (docs/06). */
export interface Material {
  blob_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
  dedup_tags?: { sha256: string; scope_id: string; content_tag: string }[];
}

/**
 * Why a cursor was rejected with 410. The reason is mandatory, because it decides whether
 * the resync that follows applies deletions — and two of the three do.
 *
 * - `restore`      the server was restored from a backup: it moved BACKWARDS, so a node
 *                  missing from the listing proves nothing. Deletions are NOT applied.
 * - `reset`        the user ran "my client is the source of truth" on this vault.
 *                  Deletions ARE applied.
 * - `journal_ttl`  the cursor is older than the oldest surviving journal row. The server
 *                  moved FORWARDS, so the listing is current. Deletions ARE applied.
 *
 * When a cursor is stale in both epochs at once the reason is `restore`: the protective
 * instruction never loses to the destructive one (#70).
 */
export type CursorRejection = 'restore' | 'reset' | 'journal_ttl';

/** Why a 400 was returned for a cursor rather than a 410 — a forged tag is malformed, not stale (#100). */
export type CursorFault =
  /** Not a token this server can verify: start again from an empty cursor, applying no deletions. */
  | 'cursor_unverifiable'
  /** Verifiable, but issued for another account or vault: the same restart, and never a hint of whose. */
  | 'cursor_wrong_subject';

/** The 410 body: a stale cursor, and the reason that decides how the resync reads absence (#70). */
export type CursorStaleBody = { reason: CursorRejection };

/** The 400 body: a cursor the server cannot verify (#100). */
export type CursorFaultBody = { error: CursorFault };

/**
 * The delta cursor payload. Opaque to the client — it is signed, and the client only
 * stores and returns it — but its shape is part of the contract because the server on the
 * other side of a version upgrade has to keep reading it.
 */
export interface CursorPayload {
  /** Format version. */
  v: 1;
  /** Account. A token cannot be replayed against another account… */
  uid: string;
  /** …nor against another vault of the same account. */
  vid: string;
  epoch: {
    /** server_meta.restore_epoch */
    restore: number;
    /** vaults.reset_epoch — per vault (AC-14) */
    reset: number;
  };
  /** Position in this vault's journal. */
  rev: number;
  /** High-watermark pinned on the first page of a series (#24). */
  hwm?: number;
}
