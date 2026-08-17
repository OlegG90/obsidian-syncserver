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

/**
 * Every code that carries a **decision** — the `{ "error": … }` a caller is expected to
 * read and act on, rather than merely show.
 *
 * One home, because both sides name these: the server builds them, the client branches on
 * them, and a pair that disagrees compiles perfectly on each side alone. That is not
 * hypothetical here — `restore.lifted` was declared twice and had already drifted.
 *
 * **Request-validation codes are deliberately absent.** `bad_address`, `login_required`,
 * `key_id_required` and their two dozen siblings say a request was malformed; no client
 * branches on them and none should, so naming them here would be twenty entries with no
 * second reader to drift from. A code earns a place in this union by being *decided* rather
 * than *diagnosed*.
 */
export type RefusalCode =
  // The subject does not exist, or the caller may not know that it does (#20).
  | 'not_found'
  | 'no_such_version'
  // Authentication and the device behind it (#33, #90).
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'device_revoked'
  // Quota and its limits (AC-Q2, docs/04).
  | 'frozen'
  | 'over_quota'
  | 'too_large'
  | 'part_too_large'
  | 'too_many_unfinished'
  | 'rate_limited'
  // A write the schema or a precondition refused.
  | 'invalid_write'
  | 'base_mismatch'
  | 'rev_mismatch'
  | 'share_boundary'
  | 'name_taken'
  // Blob upload, whole and resumable.
  | 'address_mismatch'
  | 'size_mismatch'
  | 'parts_missing'
  // Device pairing (docs/07).
  | 'already_settled'
  | 'not_approved'
  // A vault that is not the caller's to remove yet.
  | 'not_empty'
  | 'named_by_a_share'
  | 'vault_exists'
  // Sharing (docs/05).
  | 'share_not_preparing'
  | 'share_not_active'
  | 'share_not_prepared'
  | 'invite_failed'
  | 'console_account'
  | 'initiator_cannot_be_removed'
  | 'finalization_incomplete';

/**
 * One item of preparation's work list: a node that is not ready to be shared, and why.
 *
 * Here rather than in the server because the client reads it — the whole reason the server
 * computes a list instead of answering "not prepared" is that the other side is the one who
 * can fix it.
 *
 * A type alias rather than an interface, and not by taste: the server reads it straight out
 * of `db.query<T>`, whose `Row` constraint an interface cannot satisfy — it has no implicit
 * index signature.
 */
export type PreparationGap = {
  nodeId: string;
  /** `name` — still under `KV`; `content` — no `KS` envelope for bytes it references. */
  missing: string;
};

/**
 * What each refusal carries **besides** its code.
 *
 * The codes have been a shared union with a compile-time guard since M2; the fields beside
 * them were not, and the asymmetry mattered more than it looked. Several refusals exist
 * precisely to hand back a work list the server went to trouble to compute — which nodes are
 * unprepared, which the finalization pass missed, what the schema actually objected to — and
 * on the client those arrived as `unknown` and were read by hand.
 *
 * A field renamed on one side then compiles on both, and deletes the only sentence a person
 * sees. That is not hypothetical: `detail` reaching the screen is what turned `400
 * invalid_write` into a message naming the node and the rule, and it is a string read out of
 * an untyped object.
 *
 * Codes absent from this map carry nothing but the code.
 */
export interface RefusalDetails {
  invalid_write: { detail: string };
  base_mismatch: { sha256?: string; rev?: number };
  rev_mismatch: { rev?: number };
  name_taken: { blocked_by: string };
  rate_limited: { retry_after: number };
  parts_missing: { have: number[] };
  share_not_active: { state: string };
  share_not_preparing: { state: string };
  share_not_prepared: { gaps: PreparationGap[] };
  finalization_incomplete: { missing: string[] };
}

/** Why a write was refused with 409. The server emits all four; the client resolves three as a conflict. */
export type WriteConflict = Extract<RefusalCode, 'base_mismatch' | 'rev_mismatch' | 'share_boundary' | 'name_taken'>;

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

/**
 * A key scope this caller can open, as `GET /vaults/{id}` reports it.
 *
 * It lives here because it is the answer to "which key opens what", and both sides act on
 * it: the server decides which scopes a caller may see, the client turns them into keys.
 * It had been written by hand in three places with three different degrees of fidelity —
 * the engine's copy knew nothing of `share_id`, which is the field that pairs a share with
 * the scope its interior is named under.
 */
export interface Scope {
  /** `vault` or `share`. */
  scope: string;
  key_id: string;
  /** Present for a share scope: which share this key belongs to. */
  share_id?: string;
  /** The key itself, wrapped. Absent for the vault's own scope, which needs no delivery. */
  wrapped_key?: string;
  /**
   * How `wrapped_key` is sealed: `vault` under `KV` (the initiator's own copy), `account`
   * as an HPKE envelope to the account's public key (a participant's). The two are opened
   * with different keys, so the client is told rather than left to try both.
   */
  wrapping?: 'vault' | 'account';
}

/**
 * A state the client must show or act on, delivered with the delta rather than pushed.
 *
 * These are **states, not a log**. The server recomputes them on every delta from what is
 * true now, so a client that missed one gets it again and a client that has caught up stops
 * being told — which is the same shape docs/02 gives everything else here: the server holds
 * states, the client renders them, and nothing waits for an answer.
 *
 * A freeze names no share, because being over quota is an ACCOUNT state (SH-20).
 */
export type DeltaEvent =
  | { type: 'share_ended'; share_id: string; at: string }
  | { type: 'account_frozen'; at: string };

/**
 * A vault as it stands when a client opens it: where its tree starts, how far it has got,
 * and which key scopes this caller may read (docs/06).
 *
 * One value per operation, not per question. Every part of it is a fact about the same
 * instant, and the client used to ask for it again for each half it needed — the vault scope
 * for one call, a share's key for the next — which is five requests for one leave and two
 * for every sync, each answering the same thing.
 */
export interface OpenedVault {
  root_node_id: string;
  head_rev: number;
  scopes: Scope[];
}

/** The delta response: the changes since the cursor, and the cursor to carry next (#24). */
export interface Delta {
  changes: Change[];
  events: DeltaEvent[];
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

// ---- release version ------------------------------------------------------------

/**
 * The release the whole solution ships as: server, plugin, shared and — once it exists —
 * the management console all carry **one** number, bumped together (#111).
 *
 * It appears here because it appears literally in a response: `/health` reports the
 * server's, and that is the only way a client can learn it. The **comparison** is not
 * here. Only the client ever asks "can I talk to this?", so the rule that answers it lives
 * on the client, next to the other version it needs — see `plugin/src/version.ts`.
 */
export interface HealthResponse {
  status: string;
  bootstrap_pending: boolean;
  /**
   * The server's release, `major.minor.patch`.
   *
   * Optional because a client may be pointed at a server older than this field: absence
   * means "before 0.1.0", which is a version answer rather than a missing one.
   */
  version?: string;
}
