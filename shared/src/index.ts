/**
 * The wire contract, and only that.
 *
 * This package exists for one reason: the server and the plugin both have to know the
 * shape of what passes between them, and two independent copies of that knowledge drift.
 * It is the same rule the documentation follows — one description of one thing.
 *
 * What belongs here: values that appear literally in a request or a response. What does
 * not: server configuration, storage layout, anything cryptographic (keys never leave the
 * client), and anything either side can decide on its own.
 *
 * Normative source: docs/04-sync-protocol.md.
 */

/** A node is a file or a folder, and never changes from one to the other (#102). */
export type NodeType = 'file' | 'folder';

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
  | 'cursor_unverifiable';

/** Why a write was refused with 409. */
export type WriteConflict =
  /** The content precondition failed: someone else wrote first (#52). */
  | 'base_mismatch'
  /** A move may not cross into or out of a shared folder; copy/put then delete the source. */
  | 'share_boundary'
  /** Restoring into a name that has since been taken; no automatic renaming (#36). */
  | 'name_taken';

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
