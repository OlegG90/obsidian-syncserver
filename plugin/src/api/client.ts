/**
 * The protocol of docs/04, as functions.
 *
 * Nothing here encrypts, decides or remembers anything: names arrive already encrypted and
 * blobs already sealed. That is deliberate — the one place that knows plaintext is the
 * engine above it, and a client that took a `string` name would eventually be handed one.
 *
 * Statuses that mean something are RETURNED, not thrown. `409` on a stale base, `410` with
 * its reason, `404` on a blob the caller does not hold — each is an instruction to the
 * engine, and an exception would only be caught to read the status back out.
 */
import type {
  Change,
  CursorFault,
  CursorFaultBody,
  CursorRejection,
  CursorStaleBody,
  Delta,
  HealthResponse,
  KdfParams,
  Material,
  NodeType,
  Scope,
  RefusalCode,
  RestoreResult,
  WriteConflict,
} from '@syncserver/shared';
import { BLOB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, withTimeout, type HttpRequest, type HttpResponse, type Transport } from './transport.js';

/**
 * The client's parsed result of a refused write: the wire body is `{ error: <code> }`, this
 * is the three codes a PUT can produce, read from the `error` field rather than assumed from
 * the shape (docs/04). `name_taken` (restore) is a thrown `ApiError`, not a conflict to resolve.
 */
export interface PutConflict {
  conflict: Extract<RefusalCode, 'base_mismatch' | 'rev_mismatch' | 'share_boundary'>;
  /** What the content actually is now — the difference between "same text reached twice" and a real conflict. */
  sha256?: string;
  rev?: number;
}

/** The client's marker for a 410: the wire body is just `{ reason }`; `rejected` is this side's flag. */
export interface CursorRejected {
  rejected: true;
  reason: CursorRejection;
}

/**
 * The client's marker for the **400** a cursor can draw: it is not a token this server can
 * verify, or it was issued for another subject (#100).
 *
 * Returned rather than thrown, unlike every other 400, and the difference is which side
 * owns the decision. A malformed request is the caller's mistake; this is a *policy* — the
 * engine's answer is "resync from an empty cursor, applying no deletions", and a policy
 * that arrives as an exception is one the seam does not declare and the next consumer of
 * `VaultWire` would have to learn by reading this file.
 */
export interface CursorUnverifiable {
  unverifiable: true;
  fault: CursorFault;
}

/** One envelope: the content key wrapped to a scope. A blob may have several — one per scope that sees it. */
export interface Envelope {
  scopeId: string;
  wrappedKey: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** docs/04: 8 MB per part, and the same number is the threshold for using parts at all. */
const PART_BYTES = 8 * 1024 * 1024;


/** One node converted to the share key, with the material its bytes need under it. */
export interface PrepareItem {
  node_id: string;
  name_enc: string;
  name_hmac: string;
  name_key_id: string;
  blob_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
  dedup_tags?: { sha256: string; scope_id: string; content_tag: string }[];
}

/** One node converted back to the vault key, when a participant leaves. */
export interface FinalizeNode {
  node_id: string;
  name_enc: string;
  name_hmac: string;
  name_key_id: string;
  vault_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
  vault_dedup_tags?: { sha256: string; scope_id: string; content_tag: string }[];
}

export interface ShareMember {
  user_id: string;
  login: string;
  is_initiator: boolean;
  invited_at: string;
  joined_at: string | null;
  finalizing: boolean;
}

export class SyncClient {
  private access: string | undefined;
  /**
   * From the most recent `login` or `redeem`. Its whole purpose is to outlive the access
   * token WITHOUT the passphrase: `send` spends it to mint a new access token in place when
   * a request meets an expired one. The access token lives 15 minutes (docs/04); a sync of a
   * vault with enough files runs longer than that, and without this it would die partway
   * through with `401 unauthenticated` and have to be started over by hand.
   */
  private refresh: string | undefined;
  /** One `/auth/refresh` in flight at a time, so several requests hitting 401 together do not send several. */
  private refreshing: Promise<boolean> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly transport: Transport,
    /** Overridable mainly so a test can prove a hung call is bounded without waiting 30 real seconds for it. */
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    /**
     * The part size of a resumable upload, and by that fact the threshold above which one
     * is used at all — docs/04 makes them one number, because a one-part resumable upload
     * costs a retry exactly what a retried `POST` costs.
     *
     * The server enforces this as a **ceiling**, so a smaller value is always legal; a test
     * lowers it to exercise several parts without moving megabytes.
     */
    private readonly partBytes = PART_BYTES,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setAccessToken(token: string | undefined): void {
    this.access = token;
  }

  setRefreshToken(token: string | undefined): void {
    this.refresh = token;
  }

  /** The current access token, for the change-notification channel (docs/04). */
  getAccessToken(): string | undefined {
    return this.access;
  }

  /** Refresh the access token now; `false` when the refresh token is spent or revoked. */
  refreshToken(): Promise<boolean> {
    return this.tryRefresh();
  }

  private async send(
    req: Omit<HttpRequest, 'url'> & { path: string; auth?: boolean; timeoutMs?: number },
    retried = false,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { ...req.headers };
    if (req.auth !== false && this.access) headers['authorization'] = `Bearer ${this.access}`;

    const res = await withTimeout(
      this.transport({ method: req.method, url: this.baseUrl + req.path, headers, body: req.body }),
      req.timeoutMs ?? this.defaultTimeoutMs,
    );

    // Refreshed and retried ONCE, and only for the one 401 that refreshing can fix: an
    // expired or otherwise invalid access token. `device_revoked` is also a 401 (on the
    // upload path) and refreshing would not help it — `/auth/refresh` excludes a revoked
    // device's token by the same condition — so retrying it would only trade one failure
    // for a less specific one. `auth === false` requests (kdf, redeem, login, refresh
    // itself) are never retried, which is what stops this from recursing into itself.
    if (res.status === 401 && req.auth !== false && !retried && this.refresh) {
      if (errorIs(res.text(), 'unauthenticated') && (await this.tryRefresh())) {
        return this.send(req, true);
      }
    }

    return res;
  }

  private async tryRefresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      try {
        const out = await this.refreshAccess(this.refresh!);
        this.access = out.access;
        return true;
      } catch {
        // The refresh token itself is spent, invalid, or its device was revoked. Cleared so
        // the next 401 does not retry a refresh that can only fail the same way again.
        this.refresh = undefined;
        return false;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** JSON in, JSON out, with the failure shape the server actually uses: `{error: "..."}`. */
  private async json<T>(
    method: HttpRequest['method'],
    path: string,
    body?: unknown,
    opts: { auth?: boolean; headers?: Record<string, string>; expect?: number[]; timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.send({
      method,
      path,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...opts.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(opts.auth === undefined ? {} : { auth: opts.auth }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    });

    const ok = opts.expect ?? [200, 201, 204];
    if (!ok.includes(res.status)) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return (res.text() ? JSON.parse(res.text()) : undefined) as T;
  }

  // ---- account -----------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.json('GET', '/health', undefined, { auth: false });
  }

  /**
   * Pre-auth, and it answers an unknown login with a deterministic fake rather than a 404
   * (#73) — so a caller cannot read "no such account" out of it, and must not try.
   */
  kdf(login: string): Promise<{ account_salt: string; kdf_params: KdfParams }> {
    return this.json('GET', `/auth/kdf?login=${encodeURIComponent(login)}`, undefined, { auth: false });
  }

  redeem(body: {
    invitation_token: string;
    auth_secret: string;
    account_salt: string;
    kdf_params: KdfParams;
    pubkey: string;
    enc_privkey: string;
    wrapped_seed: string;
    recovery_key: string;
    recovery_code_hash: string;
    initial_vault_id: string;
    initial_vault_name_enc: string;
    device_name?: string;
    device_platform?: string;
  }): Promise<{
    access: string;
    refresh: string;
    device_id: string;
    vault_id: string;
    root_node_id: string;
    user_id: string;
  }> {
    return this.json('POST', '/auth/redeem', body, { auth: false });
  }

  login(body: {
    login: string;
    auth_secret: string;
    device_id: string;
  }): Promise<{ access: string; refresh: string; user_id: string; enc_privkey: string }> {
    return this.json('POST', '/auth/login', body, { auth: false });
  }

  refreshAccess(refresh: string): Promise<{ access: string }> {
    return this.json('POST', '/auth/refresh', { refresh }, { auth: false });
  }

  // ---- pairing a second device (docs/07) ---------------------------------------

  /**
   * Anonymous by necessity: a device with no seed has no `auth_secret` and nothing to
   * authenticate with. It registers where to send the seed and a hash of the code the
   * human is about to carry — never the code itself (#110).
   */
  beginPairing(body: { device_pubkey: string; pairing_token_hash: string }): Promise<{ pairing_id: string }> {
    return this.json('POST', '/auth/pairings', body, { auth: false });
  }

  /** What to seal to. Precedes approval, because sealing needs the waiting device's key. */
  lookupPairing(body: { pairing_secret: string }): Promise<{ device_pubkey: string }> {
    return this.json('POST', '/auth/pairings/lookup', body);
  }

  /** From an authorised device, addressed by the secret alone — there is no id to carry. */
  approvePairing(body: { pairing_secret: string; seed_envelope: string }): Promise<{ device_pubkey: string }> {
    return this.json('POST', '/auth/pairings/approve', body);
  }

  /**
   * Take the envelope, once. `undefined` means **not yet approved** — the pairing is real
   * and the caller should keep asking, which is why that case is not an error here: a
   * polling loop written against exceptions would treat waiting as failure.
   */
  async claimPairing(
    pairingId: string,
    body: { pairing_secret: string; name: string; platform: string },
  ): Promise<
    | {
        seed_envelope: string;
        enc_privkey: string;
        account_salt: string;
        kdf_params: KdfParams;
        device_id: string;
        user_id: string;
      }
    | undefined
  > {
    try {
      return await this.json('POST', `/auth/pairings/${pairingId}/claim`, body, { auth: false });
    } catch (e) {
      if (e instanceof ApiError && isCode(e.code, 'not_approved')) return undefined;
      throw e;
    }
  }

  usage(): Promise<{ used: number; quota: number; frozen: boolean }> {
    return this.json('GET', '/usage');
  }

  // ---- vaults ------------------------------------------------------------------

  listVaults(): Promise<{ id: string; name_enc: string }[]> {
    return this.json('GET', '/vaults');
  }

  createVault(id: string, nameEnc: string): Promise<{ id: string; root_node_id: string }> {
    return this.json('POST', '/vaults', { id, name_enc: nameEnc });
  }

  /** Where a client starts syncing: the root, the head, and the key scope per scope (docs/06). */
  openVault(vaultId: string): Promise<{
    root_node_id: string;
    head_rev: number;
    scopes: Scope[];
  }> {
    return this.json('GET', `/vaults/${vaultId}`);
  }

  /**
   * "My client is the source of truth" (docs/07): hard-destroys the vault's own nodes and
   * bumps the reset epoch, so every other device is answered `410 reset` and resyncs.
   */
  resetVault(vaultId: string): Promise<{ reset_epoch: number; root_node_id: string; removed: number }> {
    return this.json('POST', `/vaults/${vaultId}/reset`);
  }

  /** Deleted nodes that can still be brought back — `deleted_at` with live versions. */
  trash(vaultId: string, under?: string): Promise<{ node_id: string; parent_id: string | null; name_enc: string | null; type: string; deleted_at: string; versions: number }[]> {
    const q = under ? `?under=${encodeURIComponent(under)}` : '';
    return this.json('GET', `/vaults/${vaultId}/trash${q}`);
  }

  /** One row per revision, newest first. A restore needs one of these `rev`s. */
  versions(vaultId: string, nodeId: string): Promise<{ rev: number; sha256: string; size: number; at: string; author_id: string }[]> {
    return this.json('GET', `/vaults/${vaultId}/versions/${nodeId}`);
  }

  /** Restore = a new write with an old hash (docs/04). `409 name_taken` names the blocker. */
  async restore(vaultId: string, nodeId: string, rev: number): Promise<RestoreResult> {
    const res = await this.send({
      method: 'POST',
      path: `/vaults/${vaultId}/restore`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, rev }),
    });
    if (res.status === 409) {
      const body = JSON.parse(res.text()) as { error?: string; blocked_by?: string };
      if (isCode(body.error, 'name_taken')) throw new ApiError(409, 'name_taken', `blocked by ${body.blocked_by}`);
    }
    if (res.status !== 200) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return JSON.parse(res.text()) as RestoreResult;
  }

  // ---- the tree ----------------------------------------------------------------

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
  ): Promise<{ node_id: string; rev: number }> {
    return this.json('POST', `/vaults/${vaultId}/nodes`, body);
  }

  /**
   * The precondition is CONTENT, not a revision (#52): `rev` moves on a rename too, so using
   * it would make "renamed here, edited there" a conflict between changes that do not
   * overlap. A `409` comes back as a value, because it is the conflict path, not a failure.
   *
   * **Which** 409 is read from the `error` field rather than assumed from the shape. Three
   * refusals share this status — `base_mismatch`, `rev_mismatch` and `share_boundary` — and
   * only the first carries a `sha256`. Today a `PUT` produces only that one, so reading the
   * body positionally would work; when M3 adds shared folders it would silently produce
   * `sha256: undefined` and send the engine to resolve a conflict that is not one.
   */
  async putContent(
    vaultId: string,
    nodeId: string,
    body: Material & { sha256: string; size: number; mtime: string; base_sha256: string | null },
  ): Promise<{ rev: number } | PutConflict> {
    const res = await this.send({
      method: 'PUT',
      path: `/vaults/${vaultId}/nodes/${nodeId}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const parsed = JSON.parse(res.text()) as { error?: WriteConflict; sha256?: string; rev?: number };
      if (parsed.error === 'base_mismatch' || parsed.error === 'rev_mismatch' || parsed.error === 'share_boundary') {
        const out: PutConflict = { conflict: parsed.error };
        if (parsed.sha256 !== undefined) out.sha256 = parsed.sha256;
        if (parsed.rev !== undefined) out.rev = parsed.rev;
        return out;
      }
      // A 409 this client does not know is not a conflict it can resolve.
      throw new ApiError(res.status, parsed.error ?? 'unknown_conflict', res.text());
    }

    if (res.status !== 200) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return JSON.parse(res.text()) as { rev: number };
  }

  /** Here the revision IS the right precondition: the subject of the operation is the node. */
  deleteNode(vaultId: string, nodeId: string, ifMatchRev: number): Promise<{ rev: number }> {
    return this.json('DELETE', `/vaults/${vaultId}/nodes/${nodeId}`, undefined, {
      headers: { 'if-match': String(ifMatchRev) },
    });
  }

  moveNode(
    vaultId: string,
    nodeId: string,
    ifMatchRev: number,
    body: { parent_id: string; name_enc: string; name_hmac: string; name_key_id: string },
  ): Promise<{ rev: number }> {
    return this.json('POST', `/vaults/${vaultId}/nodes/${nodeId}/move`, body, {
      headers: { 'if-match': String(ifMatchRev) },
    });
  }

  /**
   * The whole tree as it stands, with the cursor it was taken at.
   *
   * A first sync uses this rather than a delta from nothing: the delta describes changes,
   * and a client with no state needs the state. The `snapshot` it returns is the cursor to
   * carry from then on — pinned, so a resync of a large vault cannot lose a change that
   * happened mid-walk or apply it twice (#24).
   */
  listNodes(vaultId: string, under?: string): Promise<{ nodes: Change[]; snapshot: string }> {
    const q = under ? `?under=${encodeURIComponent(under)}` : '';
    return this.json('GET', `/vaults/${vaultId}/list${q}`);
  }

  // ---- delta -------------------------------------------------------------------

  async delta(vaultId: string, cursor?: string, limit?: number): Promise<Delta | CursorRejected | CursorUnverifiable> {
    const q = new URLSearchParams();
    if (cursor) q.set('cursor', cursor);
    if (limit) q.set('limit', String(limit));
    const suffix = q.toString() ? `?${q}` : '';

    const res = await this.send({ method: 'GET', path: `/vaults/${vaultId}/delta${suffix}`, headers: {} });
    if (res.status === 410) {
      return { rejected: true, reason: (JSON.parse(res.text()) as CursorStaleBody).reason };
    }
    if (res.status === 400) {
      // The only 400 this endpoint produces is about the cursor itself (#100), and the
      // engine has an answer for it. Anything else here would be a defect on one side or
      // the other, and still throws.
      const fault = (parsedBody(res.text()) as Partial<CursorFaultBody>).error;
      if (fault === 'cursor_unverifiable' || fault === 'cursor_wrong_subject') {
        return { unverifiable: true, fault };
      }
    }
    if (res.status !== 200) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return JSON.parse(res.text()) as Delta;
  }

  // ---- blobs -------------------------------------------------------------------

  /**
   * There is deliberately no "do you already have this" call before this one (#46): the
   * server never short-circuits, because answering "already have it" would turn the address
   * into an existence oracle. Sending twice is correct and costs the bytes.
   */
  /**
   * Upload a sealed blob, by whichever of the two paths its size calls for (docs/04).
   *
   * A note is a few kilobytes and an attachment is not. One `POST` is right for the first
   * and wrong for the second: a connection that dies at 90% of a large file costs the whole
   * file again, which on a phone is the ordinary case rather than the unlucky one.
   */
  async putBlob(
    sealed: { sha256: string; bytes: Uint8Array; keyId: string },
    encAlg = 'xchacha20-poly1305',
  ): Promise<{ sha256: string; size: number }> {
    if (sealed.bytes.length > this.partBytes) return this.putBlobResumable(sealed, encAlg);

    const q = new URLSearchParams({
      sha256: sealed.sha256,
      size: String(sealed.bytes.length),
      enc_alg: encAlg,
      key_id: sealed.keyId,
    });
    const res = await this.send({
      method: 'POST',
      path: `/blobs?${q}`,
      headers: { 'content-type': 'application/octet-stream' },
      body: sealed.bytes,
      // The metadata timeout would punish a large file on a slow home upload link for a
      // failure it did not have — "still sending" and "server is not there" are not the
      // same thing and must not share a clock.
      timeoutMs: BLOB_TIMEOUT_MS,
    });
    if (res.status !== 201) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return JSON.parse(res.text()) as { sha256: string; size: number };
  }

  /**
   * The resumable path: ask what is already there, send what is not, then complete.
   *
   * The first call is `GET /parts`, not the first part. On a first attempt it costs one
   * cheap round trip and answers `{parts: []}`; on a retry it is the entire point, because
   * it turns "upload this 200 MB file again" into "send the four parts that did not land".
   * Making it unconditional keeps one code path where a flag would give two.
   */
  private async putBlobResumable(
    sealed: { sha256: string; bytes: Uint8Array; keyId: string },
    encAlg: string,
  ): Promise<{ sha256: string; size: number }> {
    const total = sealed.bytes.length;
    const count = Math.ceil(total / this.partBytes);

    const staged = await this.send({
      method: 'GET',
      path: `/blobs/${sealed.sha256}/parts`,
      headers: {},
    });
    if (staged.status !== 200) throw new ApiError(staged.status, errorCode(staged.text()), staged.text());
    const have = new Set((JSON.parse(staged.text()) as { parts: number[] }).parts);

    for (let n = 1; n <= count; n++) {
      if (have.has(n)) continue;
      // Parts are numbered from 1, so part n covers [(n-1)·size, n·size).
      const slice = sealed.bytes.subarray((n - 1) * this.partBytes, Math.min(n * this.partBytes, total));
      const q = new URLSearchParams({ total: String(total), size: String(slice.length) });
      const res = await this.send({
        method: 'PUT',
        path: `/blobs/${sealed.sha256}/parts/${n}?${q}`,
        headers: { 'content-type': 'application/octet-stream' },
        body: slice,
        timeoutMs: BLOB_TIMEOUT_MS,
      });
      if (res.status !== 204) throw new ApiError(res.status, errorCode(res.text()), res.text());
    }

    const q = new URLSearchParams({ size: String(total), enc_alg: encAlg, key_id: sealed.keyId });
    const done = await this.send({
      method: 'POST',
      path: `/blobs/${sealed.sha256}/complete?${q}`,
      headers: {},
      timeoutMs: BLOB_TIMEOUT_MS,
    });
    if (done.status !== 201) throw new ApiError(done.status, errorCode(done.text()), done.text());
    return JSON.parse(done.text()) as { sha256: string; size: number };
  }

  /** `undefined` for 404, which here means "you hold no live reference to it" (#20), not "it is gone". */
  async getBlob(sha256: string): Promise<Uint8Array | undefined> {
    const res = await this.send({ method: 'GET', path: `/blobs/${sha256}`, headers: {}, timeoutMs: BLOB_TIMEOUT_MS });
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw new ApiError(res.status, errorCode(res.text()), res.text());
    return res.bytes;
  }

  /**
   * The content keys for these addresses, wrapped to the scopes this caller holds.
   *
   * Batched because applying a delta means opening every file that changed, and one request
   * per note is a round trip per note. An address the caller cannot open is **absent** from
   * the answer rather than an error — the same rule as a blob read (#20).
   *
   * A **list** per address, carrying the scope each envelope belongs to. One blob can hold
   * envelopes in several scopes — the owner's `KV` and the `KS` of every share that sees it
   * (docs/06) — so keeping only the wrapped key would mean picking one of them by accident.
   * Today a vault has one scope and the list has one entry; the caller still has to say
   * which key it is unwrapping with.
   */
  async blobKeys(vaultId: string, addresses: string[]): Promise<Map<string, Envelope[]>> {
    if (addresses.length === 0) return new Map();
    const q = new URLSearchParams({ sha256: addresses.join(',') });
    const out = await this.json<{ keys: { sha256: string; scope_id: string; wrapped_key: string }[] }>(
      'GET',
      `/vaults/${vaultId}/blob-keys?${q}`,
    );

    const byAddress = new Map<string, Envelope[]>();
    for (const k of out.keys) {
      const list = byAddress.get(k.sha256) ?? [];
      list.push({ scopeId: k.scope_id, wrappedKey: k.wrapped_key });
      byAddress.set(k.sha256, list);
    }
    return byAddress;
  }

  async hasBlob(sha256: string): Promise<boolean> {
    const res = await this.send({ method: 'HEAD', path: `/blobs/${sha256}`, headers: {} });
    return res.status === 200;
  }

  /**
   * Which of these content tags the vault's own scope already knows, and the address each
   * maps to now.
   *
   * This is what adoption asks BEFORE sealing a file: if the plaintext is already known here,
   * a node can bind to the existing address with no upload and no fresh envelope (docs/04,
   * docs/07). A tag with no match is simply absent from the result — not new content by
   * itself, only "not something this vault has tagged before."
   */
  async dedupLookup(vaultId: string, tags: string[]): Promise<Map<string, string>> {
    if (tags.length === 0) return new Map();
    const q = new URLSearchParams({ tags: tags.join(',') });
    const out = await this.json<{ matches: { content_tag: string; sha256: string }[] }>(
      'GET',
      `/vaults/${vaultId}/dedup?${q}`,
    );
    return new Map(out.matches.map((m) => [m.content_tag, m.sha256]));
  }

  // ---- sharing (docs/05) ---------------------------------------------------------

  /**
   * Open a share over one of this account's own folders.
   *
   * The scope id is the CLIENT's to choose, unlike a vault's, and the asymmetry is forced:
   * the answer carries a share id and nothing else, so a scope the server invented could
   * never be referenced by the `name_key_id` this client is about to write on every
   * interior node.
   */
  createShare(body: {
    vault_id: string;
    node_id: string;
    subtree_key_id: string;
    wrapped_key_initiator: string;
  }): Promise<{ share_id: string; state: string }> {
    return this.json('POST', '/shares', body, { expect: [201] });
  }

  /** One resumable batch of interior nodes converted to `KS`. */
  prepareShare(shareId: string, items: PrepareItem[]): Promise<void> {
    return this.json('POST', `/shares/${shareId}/prepare`, { items }, { expect: [204] });
  }

  /** Verify preparation and open the share for invitations. */
  activateShare(shareId: string): Promise<{ state: string }> {
    return this.json('POST', `/shares/${shareId}/activate`);
  }

  cancelShare(shareId: string): Promise<void> {
    return this.json('POST', `/shares/${shareId}/cancel`, undefined, { expect: [204] });
  }

  /**
   * The recipient's public key, for sealing `KS` to them.
   *
   * An unknown login gets a deterministic FAKE pair rather than a 404 (#73), so a caller
   * cannot read "no such account" out of it — and must not try.
   */
  recipientPubkey(shareId: string, login: string): Promise<{ user_id: string; pubkey: string }> {
    return this.json('GET', `/shares/${shareId}/recipients/${encodeURIComponent(login)}/pubkey`);
  }

  invite(shareId: string, body: { user_id: string; wrapped_key: string }): Promise<void> {
    return this.json('POST', `/shares/${shareId}/invite`, body, { expect: [204] });
  }

  /** What this account is in, and what is waiting for it. */
  shares(): Promise<{
    joined: { share_id: string; vault_id: string | null; is_initiator: boolean; state: string }[];
    invitations: { share_id: string; initiator_login: string; invited_at: string }[];
  }> {
    return this.json('GET', '/shares');
  }

  shareMembers(shareId: string): Promise<ShareMember[]> {
    return this.json('GET', `/shares/${shareId}/members`);
  }

  /**
   * Accept, materialising a copy in THIS vault — the one the client runs in, which is why
   * the vault is never asked of the user (AC-Q4).
   */
  joinShare(
    shareId: string,
    body: { vault_id: string; parent_id: string; name_enc: string; name_hmac: string; name_key_id: string },
  ): Promise<{ root_node_id: string }> {
    return this.json('POST', `/shares/${shareId}/join`, body, { expect: [201] });
  }

  declineShare(shareId: string): Promise<void> {
    return this.json('POST', `/shares/${shareId}/decline`, undefined, { expect: [204] });
  }

  /** Withdraw an invitation, or revoke a participant — the server decides which by their state. */
  removeMember(shareId: string, userId: string): Promise<{ outcome: 'withdrawn' | 'revoked' }> {
    return this.json('DELETE', `/shares/${shareId}/members/${userId}`);
  }

  /** Stop propagation and begin leaving. `ended` says whether this closed the share for everyone. */
  leaveShare(shareId: string): Promise<{ ended: boolean }> {
    return this.json('POST', `/shares/${shareId}/leave/begin`);
  }

  /** The metadata pass only this device can perform: the replica returns to `KV`. */
  finalizeLeave(shareId: string, nodes: FinalizeNode[]): Promise<void> {
    return this.json('POST', `/shares/${shareId}/finalize-leave`, { nodes }, { expect: [204] });
  }

}

/**
 * The most informative thing the body actually says.
 *
 * This server's own refusals are `{error: "over_quota"}` and that is the whole answer. But an
 * unhandled exception comes back in Fastify's default shape, where `error` is the generic
 * status name — "Internal Server Error" — and the sentence that identifies the fault is in
 * `message`. Reading only `error` turns every server bug into the same four useless words,
 * which is exactly what it did the first time one appeared.
 */
/**
 * A comparison against a code `shared` declares, rather than against a string literal.
 *
 * These are the codes this client acts on — refreshes a token, waits for an approval,
 * surfaces a blocked restore — and a typo in one of them used to be a branch that silently
 * never taken. `RefusalCode` makes it a compile error instead.
 */
const isCode = (value: string | undefined, code: RefusalCode): boolean => value === code;

const errorIs = (text: string, code: RefusalCode): boolean => isCode(parsedBody(text).error, code);

const parsedBody = (text: string): { error?: string; message?: string } => {
  try {
    return JSON.parse(text) as { error?: string; message?: string };
  } catch {
    return {};
  }
};

const errorCode = (text: string): string => {
  const body = parsedBody(text);
  if (body.error && body.error !== 'Internal Server Error') return body.error;
  return body.message ?? body.error ?? (text.slice(0, 200) || 'unknown');
};
