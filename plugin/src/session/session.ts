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

import { sha256 } from '@noble/hashes/sha2.js';
import { authSecret, deriveKek, vaultKey, type Account } from '../crypto/account.js';
import type { KdfParams } from '@syncserver/shared';
import { encryptName } from '../crypto/scope.js';
import { newKeypair, openFrom, sealTo } from '../crypto/hpke.js';
import { seal } from '../crypto/sealed.js';
import { SyncClient } from '../api/client.js';
import type { Transport } from '../api/transport.js';
import { concat, fromBase64, toBase64, toHex, utf8 } from '../crypto/bytes.js';

/**
 * The HPKE `info` for a seed envelope. It names what the envelope is for, so one made for
 * pairing cannot be presented as any other envelope this design produces (docs/06).
 */
const PAIRING_INFO = 'syncserver/pairing/seed';

/** An X25519 public key, which is what the envelope carries in front of its ciphertext. */
const PUBKEY_BYTES = 32;

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

/** What `pair()` needs: where, who, the code read off the other device, and the passphrase. */
export interface PairArgs {
  serverUrl: string;
  login: string;
  passphrase: string;
  pairingCode: string;
  /** Only needed when the account holds more than one vault. */
  vaultId?: string;
  deviceName?: string;
  devicePlatform?: string;
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
   * Approve a pairing from **this** device: seal the seed to the waiting public key.
   *
   * Only an open session can do it — the seed is the thing being sealed — which is why this
   * is an instance method and not a static one. The envelope is HPKE to the ephemeral key
   * the server hands back with the pairing, and `info` names what the envelope is for, so
   * it cannot be replayed as any other envelope this design makes (docs/06).
   *
   * The public key is fetched and used in one step deliberately: there is nothing useful the
   * caller could do by inspecting it first. A malicious server could substitute a key here,
   * which is a limitation of relaying through it at all — the mitigation is that the human
   * approving has just read the code off the device that generated the key, and a
   * substituted pairing would have to have been started by the attacker in the same
   * ten-minute window with a code the human never saw.
   */
  async approvePairing(pairingCode: string): Promise<void> {
    if (!this.seed) throw new Error('session is locked');
    const seed = this.seed;

    await this.use(async (h) => {
      // Two calls, and they cannot be one: sealing needs the key, and the key is what the
      // waiting device registered. The lookup is authenticated for the same reason the
      // approval is — only a device that already holds the seed has any business asking.
      const { device_pubkey } = await h.client.lookupPairing({ pairing_secret: pairingCode });

      const envelope = sealTo(
        fromBase64(device_pubkey),
        utf8(PAIRING_INFO),
        new Uint8Array(0),
        seed,
      );

      await h.client.approvePairing({
        pairing_secret: pairingCode,
        seed_envelope: toBase64(concat(envelope.enc, envelope.ciphertext)),
      });
    });
  }

  /**
   * Join an account that already exists, as a **second device** (docs/07).
   *
   * This is the flow `connect()` is not: nothing is generated, because the account's seed
   * already exists and is the one thing this device must end up holding. It makes an
   * ephemeral X25519 keypair, shows a code, and waits for an authorised device to seal the
   * seed to that key.
   *
   * **The device re-wraps the seed itself, and that is why it needs the passphrase.** Claim
   * returns `account_salt` and `kdf_params` but never `wrapped_seed` — the server declines
   * to hand a passphrase-wrapped seed to anyone who knows a login (docs/06). With the salt,
   * the parameters and the person, this device derives the same KEK and wraps the same seed
   * locally, producing a `Connection` indistinguishable from one `connect()` made. Without
   * that step the session could never lock: there would be nothing to unwrap on the way back.
   *
   * `poll` is called between attempts so a caller can show that it is waiting and stop.
   */
  static async pair(
    args: PairArgs,
    deps: { derivation: Derivation; transport: Transport },
    poll: () => Promise<boolean> = async () => true,
  ): Promise<Session> {
    const ephemeral = newKeypair();
    const client = new SyncClient(args.serverUrl, deps.transport);

    const { pairing_id } = await client.beginPairing({
      device_pubkey: toBase64(ephemeral.publicKey),
      pairing_token_hash: toHex(sha256(utf8(args.pairingCode))),
    });

    let claimed = await client.claimPairing(pairing_id, {
      pairing_secret: args.pairingCode,
      name: args.deviceName ?? 'obsidian',
      platform: args.devicePlatform ?? 'unknown',
    });
    while (!claimed) {
      if (!(await poll())) throw new Error('pairing was cancelled before it was approved');
      claimed = await client.claimPairing(pairing_id, {
        pairing_secret: args.pairingCode,
        name: args.deviceName ?? 'obsidian',
        platform: args.devicePlatform ?? 'unknown',
      });
    }

    const envelope = fromBase64(claimed.seed_envelope);
    const seed = openFrom(
      ephemeral.secretKey,
      { enc: envelope.subarray(0, PUBKEY_BYTES), ciphertext: envelope.subarray(PUBKEY_BYTES) },
      utf8(PAIRING_INFO),
      new Uint8Array(0),
    );

    const accountSalt = fromBase64(claimed.account_salt);
    const kek = deriveKek(args.passphrase, accountSalt, claimed.kdf_params);

    const session = await client.login({
      login: args.login,
      auth_secret: authSecret(seed),
      device_id: claimed.device_id,
    });
    client.setAccessToken(session.access);
    client.setRefreshToken(session.refresh);

    // Which vault: the account may hold several, and only the caller knows which this
    // device is for. One is the ordinary case and choosing it silently is right; more than
    // one without being told is a question, not a default.
    const vaults = await client.listVaults();
    const vaultId = args.vaultId ?? (vaults.length === 1 ? vaults[0]!.id : undefined);
    if (!vaultId) {
      throw new Error(
        `this account has ${vaults.length} vaults; name the one to sync: ${vaults.map((v) => v.id).join(', ')}`,
      );
    }

    const conn: Connection = {
      serverUrl: args.serverUrl,
      login: args.login,
      deviceId: claimed.device_id,
      vaultId,
      wrappedSeed: seal(kek, seed),
      accountSalt: claimed.account_salt,
      kdfParams: claimed.kdf_params,
    };
    const paired = new Session(conn, deps);
    paired.seed = seed;
    paired.handle = { client, kv: vaultKey(seed, vaultId) };
    return paired;
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
