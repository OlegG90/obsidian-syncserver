/**
 * The session: the whole of what it means to be connected and unlocked, behind four words.
 *
 * `main.ts` used to hold this in pieces — the seed in a field, the redeem body inline in
 * `connect`, Argon2id in `open`, tokens set by hand on a client the engine then borrowed.
 * Each piece was right; what was missing was a module. The session owns the lifecycle and
 * nothing else: no persistence (the plugin owns `data.json`), no UI (the plugin owns the
 * passphrase modal), no wire vocabulary (`SyncClient` keeps that, and `tryRefresh` stays in
 * it — the seam is tested there).
 *
 * Two entry points, bound to the real derivation at the edge (see `index.ts`):
 *
 *     connect(args) — claim an invitation: generate keys, redeem, derive, hold the session.
 *     create(conn)  — a session from a persisted record (re-start): locked until `open()`.
 *
 * Then two words for the lifecycle, and one for work:
 *
 *     open(passphrase?) → 'locked' | 'open'   — unlock once, reuse until lock()
 *     lock()            → 'locked' | 'busy'   — drop seed, client and both tokens
 *     use(fn)           → T                    — the ONLY way a caller touches the client
 *
 * and `state` answers the same vocabulary as `open()`, because there is exactly one state to
 * have two spellings of, and we already paid for one (`CursorFault`).
 *
 * What this module deliberately does NOT do:
 *
 * - **persist.** It returns the record; the plugin stores it. `data.json` is worthless
 *   without the passphrase, and a persisted refresh token would quietly change that (docs/06).
 * - **re-login on refresh failure.** `tryRefresh` already distinguishes `device_revoked`;
 *   building a hook here would repeat it one layer up. A sync that cannot be re-logged-in
 *   surfaces its own 401.
 * - **check the passphrase.** `open()` on an already-open session ignores the phrase. That is
 *   honest behaviour — the module answers state — but it means the UI must never use
 *   `open()` to confirm identity ("prove the phrase before changing it"). That check needs a
 *   separate, non-caching call; it is not this one.
 */

import { authSecret, vaultKey, type Account, type KdfParams } from '../crypto/account.js';
import { encryptName } from '../crypto/scope.js';
import { SyncClient } from '../api/client.js';
import type { Transport } from '../api/transport.js';
import { fromBase64, toBase64 } from '../crypto/bytes.js';

/** What the plugin persists in `data.json`. Everything a `create()` needs to be a session. */
export interface Connection {
  serverUrl: string;
  login: string;
  deviceId: string;
  vaultId: string;
  /** `wrapped_seed` — sealed under the passphrase; worthless without it (docs/06). */
  wrappedSeed: string;
  accountSalt: string;
  kdfParams: KdfParams;
}

/**
 * What a caller may do with the client. Narrow on purpose: the engine wants a `VaultWire`
 * (it names its own nine) and the vault key to encrypt names with. Both come from the same
 * seed, which is why the session is the only place that can hand them out together.
 */
export interface Handle {
  client: SyncClient;
  /** `KV = HKDF(seed, vault_id)` — the vault's own key scope (docs/06). */
  kv: Uint8Array;
}

/** The derivation seam, mirroring account creation and account opening as two operations. */
export interface Derivation {
  create(passphrase: string, params?: KdfParams): Account;
  open(passphrase: string, accountSalt: Uint8Array, kdfParams: KdfParams, wrappedSeed: string): Account;
}

/** What connect() needs that the plugin cannot know: the raw vault name, device strings, and the passphrase itself. */
export interface ConnectArgs {
  serverUrl: string;
  login: string;
  invitationToken: string;
  passphrase: string;
  vaultName: string;
  deviceName?: string;
  devicePlatform?: string;
}

export class Session {
  private readonly derivation: Derivation;
  private readonly transport: Transport;

  /** 'locked' until `open()` proves the passphrase, or connect() mints a fresh account. */
  private seed: Uint8Array | undefined;
  /** The long-lived authenticated client. Only ever assigned with `seed`, cleared together by `lock()`. */
  private handle: Handle | undefined;
  /** How many `use()` callbacks are in flight right now. `lock()` refuses while non-zero. */
  private inFlight = 0;

  /** Private: the real paths come from the factory, which binds the real derivation. */
  private constructor(
    private readonly conn: Connection,
    deps: { derivation: Derivation; transport: Transport },
  ) {
    this.derivation = deps.derivation;
    this.transport = deps.transport;
  }

  /** The state the UI renders. `'locked'` | 'open'` — the same vocabulary `open()` returns. */
  get state(): 'locked' | 'open' {
    return this.handle ? 'open' : 'locked';
  }

  /** The record the plugin persists. Read-only: the session owns it, the plugin stores it. */
  get connection(): Connection {
    return this.conn;
  }

  /** The current access token, or `undefined` when locked — the change-notification channel. */
  get accessToken(): string | undefined {
    return this.handle?.client.getAccessToken();
  }

  /** Refresh the access token now, so a stale notification channel can reconnect. */
  refreshAccessToken(): Promise<boolean> {
    if (!this.handle) return Promise.resolve(false);
    return this.handle.client.refreshToken();
  }

  /**
   * Unlock the session. Argon2id runs here and nowhere else (docs/06), once per `open()`.
   *
   * A wrong passphrase is a *thrown* error — the crypto cannot tell it apart from a corrupted
   * envelope (`crypto.test.ts` proves refusal, not distinction) — but the failure is visible
   * as an exception, whereas swallowing it would make it indistinguishable from a dismissed
   * modal. The session stays `'locked'` either way.
   */
  async open(passphrase?: string): Promise<'locked' | 'open'> {
    if (this.handle) return 'open';
    if (!passphrase) return 'locked';

    const account = this.derivation.open(
      passphrase,
      fromBase64(this.conn.accountSalt),
      this.conn.kdfParams,
      this.conn.wrappedSeed,
    );
    this.seed = account.seed;

    const client = new SyncClient(this.conn.serverUrl, this.transport);
    const session = await client.login({
      login: this.conn.login,
      auth_secret: authSecret(account.seed),
      device_id: this.conn.deviceId,
    });
    client.setAccessToken(session.access);
    client.setRefreshToken(session.refresh);
    this.handle = { client, kv: vaultKey(account.seed, this.conn.vaultId) };
    return 'open';
  }

  /**
   * The only way a caller touches the client. The handle is the session's to lend and take
   * back: `lock()` can only refuse while one is out, and the caller cannot forget to return
   * it — the bookkeeping lives in this `try/finally`, not in the caller's.
   */
  async use<T>(fn: (h: Handle) => Promise<T>): Promise<T> {
    if (!this.handle) throw new Error('session is locked');
    this.inFlight++;
    try {
      return await fn(this.handle);
    } finally {
      this.inFlight--;
    }
  }

  /**
   * Lock the session: drop the seed, the client, and both tokens — an access token is the
   * right to read and write the vault's ciphertext, and leaving one behind would be theatre.
   *
   * Returns `'busy'` rather than silently succeeding while a `use()` is in flight: the engine
   * holds the client for the length of a sync, and clearing it underneath would turn the sync
   * into a pile of 401s.
   */
  lock(): 'locked' | 'busy' {
    if (this.inFlight > 0) return 'busy';
    this.seed = undefined;
    this.handle?.client.setAccessToken(undefined);
    this.handle?.client.setRefreshToken(undefined);
    this.handle = undefined;
    return 'locked';
  }

  /**
   * Claim an invitation. Generates the account's keys on the device, mints the session's
   * vault, and returns an OPEN session — the caller has just typed the passphrase; asking
   * for it again would be theatre, and re-deriving would be a second 64 MiB Argon2 run.
   */
  static async connect(
    args: ConnectArgs,
    deps: { derivation: Derivation; transport: Transport },
  ): Promise<Session> {
    const account = deps.derivation.create(args.passphrase);
    const vaultId = crypto.randomUUID();

    const client = new SyncClient(args.serverUrl, deps.transport);
    const out = await client.redeem({
      invitation_token: args.invitationToken,
      auth_secret: authSecret(account.seed),
      account_salt: toBase64(account.accountSalt),
      kdf_params: account.kdfParams,
      pubkey: 'AQ==',
      enc_privkey: 'Ag==',
      wrapped_seed: account.wrappedSeed,
      recovery_key: 'BA==',
      recovery_code_hash: 'f'.repeat(64),
      initial_vault_id: vaultId,
      initial_vault_name_enc: encryptName(vaultKey(account.seed, vaultId), args.vaultName),
      device_name: args.deviceName ?? 'obsidian',
      device_platform: args.devicePlatform ?? 'desktop',
    });
    client.setAccessToken(out.access);
    client.setRefreshToken(out.refresh);

    const conn: Connection = {
      serverUrl: args.serverUrl,
      login: args.login,
      deviceId: out.device_id,
      vaultId: out.vault_id,
      wrappedSeed: account.wrappedSeed,
      accountSalt: toBase64(account.accountSalt),
      kdfParams: account.kdfParams,
    };
    const session = new Session(conn, deps);
    session.seed = account.seed;
    session.handle = { client, kv: vaultKey(account.seed, out.vault_id) };
    return session;
  }

  /** A session from a persisted record. Locked: the seed was never written down. */
  static create(
    conn: Connection,
    deps: { derivation: Derivation; transport: Transport },
  ): Session {
    return new Session(conn, deps);
  }
}
