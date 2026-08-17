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
import {
  authSecret,
  deriveKek,
  kekVerifier,
  unwrapIdentity,
  vaultKey,
  type Account,
  type OpenedAccount,
} from '../crypto/account.js';
import type { KdfParams } from '@syncserver/shared';
import { encryptName } from '../crypto/scope.js';
import { newKeypair, openFrom, sealTo } from '../crypto/hpke.js';
import { open as openSealed, seal } from '../crypto/sealed.js';
import { normalisePairingCode } from '../crypto/pairing-code.js';
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
  /** This account's id. An invitation's envelope is bound to it (docs/06), so opening one needs it. */
  userId: string;
  /** The account identity, wrapped. Worthless on its own — `openIdentity` is what opens it. */
  encPrivkey: string;
  /**
   * The account's X25519 private half, unwrapped.
   *
   * A function rather than the seed itself, so the seed stays where it is. Receiving a
   * share needs the identity and nothing else of it, and handing out the seed to satisfy
   * that would widen this on-purpose-narrow surface for no reason.
   */
  openIdentity(): Uint8Array;
}

/** The derivation seam, mirroring account creation and account opening as two operations. */
export interface Derivation {
  create(passphrase: string, params?: KdfParams): Account;
  open(passphrase: string, accountSalt: Uint8Array, kdfParams: KdfParams, wrappedSeed: string): OpenedAccount;
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

/** What `recover()` needs: where, who, and the passphrase — everything the user carries in their head. */
export interface RecoverArgs {
  serverUrl: string;
  login: string;
  passphrase: string;
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

/**
 * What a device holds once it can read a vault: the client, the vault key, and the account
 * identity in both forms.
 *
 * Built in one place because it was built in four — after pairing, after recovery, after
 * claiming an invitation, and after every unlock — and a field added to one of them is a
 * field three others silently do without. `openIdentity` in particular closes over the seed,
 * which is the one thing this module exists to keep from travelling.
 */
const handleFor = (
  client: SyncClient,
  seed: Uint8Array,
  vaultId: string,
  userId: string,
  encPrivkey: string,
): Handle => ({
  client,
  kv: vaultKey(seed, vaultId),
  userId,
  encPrivkey,
  openIdentity: () => unwrapIdentity(seed, encPrivkey),
});

/** What proves who is logging in, and what would repair an account that cannot be recovered. */
interface LoginIdentity {
  login: string;
  deviceId: string;
  /** The account seed, which `auth_secret = HKDF(seed, "auth")` is derived from. */
  seed: Uint8Array;
  /** `KEK = Argon2id(passphrase, salt)` — only ever here, and only while the phrase is in hand. */
  kek: Uint8Array;
  accountSalt: Uint8Array;
}

/**
 * Log in, hold both tokens on the client, and repair the account if it needs it.
 *
 * Three entrances reach this — unlocking, pairing, recovering — and each wrote the same five
 * lines: log in, set the access token, set the refresh token. Written three times they drift,
 * and this pair had already begun to: the repair below existed on the unlock path alone.
 *
 * **The repair.** An account made before recovery existed (#112) has no `kek_verifier`, and
 * nothing on the server can make one — it takes the KEK, which exists only on a device
 * holding the passphrase, and only while it is held. Left undone, such an account is
 * unrecoverable forever with nobody told. Every entrance here has the KEK in hand by the time
 * it logs in, so every one of them can file it; doing it on only one meant an old account
 * stayed unrecoverable until somebody happened to unlock on the original device.
 *
 * Failure is swallowed on purpose. This is a repair, and refusing to open a vault because a
 * repair could not be filed would be the worse trade — offline, or a server too old to have
 * the endpoint, and it is tried again on the next login either way.
 */
const loginAndHold = async (client: SyncClient, who: LoginIdentity) => {
  const session = await client.login({
    login: who.login,
    auth_secret: authSecret(who.seed),
    device_id: who.deviceId,
  });
  client.setAccessToken(session.access);
  client.setRefreshToken(session.refresh);

  if (session.needs_kek_verifier) {
    try {
      await client.setKekVerifier(kekVerifier(who.kek, who.login, who.accountSalt));
    } catch {
      // Offline, or an older server that has no such endpoint. Tried again next login.
    }
  }
  return session;
};

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
   * Which vault this device is for, when the account may hold several (AC-10).
   *
   * One is the ordinary case and choosing it silently is right; several without being told
   * is a question, not a default — and the question is the caller's, since only they know
   * what this device is being set up to do. `purpose` is in the message because "name the
   * one to sync" and "name the one to recover into" are asked at different moments, and a
   * person reading it is in the middle of one of them.
   */
  private static async chooseVault(client: SyncClient, wanted: string | undefined, purpose: string): Promise<string> {
    const vaults = await client.listVaults();
    const vaultId = wanted ?? (vaults.length === 1 ? vaults[0]!.id : undefined);
    if (vaultId) return vaultId;
    throw new Error(
      `this account has ${vaults.length} vaults; name the one to ${purpose}: ${vaults.map((v) => v.id).join(', ')}`,
    );
  }

  /**
   * The last step of every bootstrap: an open session, holding what it needs and nothing more.
   *
   * The three ways in differ entirely at the front — a pairing envelope, a recovery proof, a
   * fresh account — and were identical from here on, written out three times. Written three
   * times they drift, and the drift is not visible: a session that forgets to keep its seed
   * still works until the first lock, and one whose handle lacks a field fails only where
   * that field is read.
   */
  private static finishBootstrap(
    conn: Connection,
    deps: { derivation: Derivation; transport: Transport },
    parts: { client: SyncClient; seed: Uint8Array; userId: string; encPrivkey: string },
  ): Session {
    const session = new Session(conn, deps);
    session.seed = parts.seed;
    session.handle = handleFor(parts.client, parts.seed, conn.vaultId, parts.userId, parts.encPrivkey);
    return session;
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

    // The AEAD says "invalid tag", which is true and useless: it is what a wrong passphrase
    // produces, and the person holding a right one cannot act on it. The marker in the
    // wrapping format already separated "this client cannot read that version" from this
    // case (#109), so what is left here has exactly one ordinary cause and should say so.
    let account: OpenedAccount;
    try {
      account = this.derivation.open(
        passphrase,
        fromBase64(this.conn.accountSalt),
        this.conn.kdfParams,
        this.conn.wrappedSeed,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // A version or algorithm the client does not know is a different sentence and keeps
      // its own; only the tag failure is rephrased.
      if (/unknown (wrapping version|algorithm)/.test(reason)) throw e;
      throw new Error(
        'that passphrase does not open this account. It must be the one used when this vault was connected — ' +
          'the server cannot check it and cannot reset it.',
      );
    }
    this.seed = account.seed;

    const client = new SyncClient(this.conn.serverUrl, this.transport);
    const session = await loginAndHold(client, {
      login: this.conn.login,
      deviceId: this.conn.deviceId,
      seed: account.seed,
      kek: account.kek,
      accountSalt: fromBase64(this.conn.accountSalt),
    });
    this.handle = handleFor(client, account.seed, this.conn.vaultId, session.user_id, session.enc_privkey);
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
    // Normalised HERE, not by the caller. The code crosses a human on the way to this
    // method and a screen on the way out of `pair()`, so both ends must agree what it is
    // before either hashes it — see the constant below.
    const code = normalisePairingCode(pairingCode);

    await this.use(async (h) => {
      // Two calls, and they cannot be one: sealing needs the key, and the key is what the
      // waiting device registered. The lookup is authenticated for the same reason the
      // approval is — only a device that already holds the seed has any business asking.
      const { device_pubkey } = await h.client.lookupPairing({ pairing_secret: code });

      const envelope = sealTo(
        fromBase64(device_pubkey),
        utf8(PAIRING_INFO),
        new Uint8Array(0),
        seed,
      );

      await h.client.approvePairing({
        pairing_secret: code,
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

    // The canonical form of the code, which is what BOTH sides hash. The UI shows a
    // grouped, dashed version because that is what a person can read and type; the dashes
    // are presentation and must never reach a hash. Registering the displayed form here
    // and normalising on the other side is exactly the bug this line exists to prevent —
    // two hashes of one code, and a pairing nobody can find.
    const code = normalisePairingCode(args.pairingCode);

    const { pairing_id } = await client.beginPairing({
      device_pubkey: toBase64(ephemeral.publicKey),
      pairing_token_hash: toHex(sha256(utf8(code))),
    });

    let claimed = await client.claimPairing(pairing_id, {
      pairing_secret: code,
      name: args.deviceName ?? 'obsidian',
      platform: args.devicePlatform ?? 'unknown',
    });
    while (!claimed) {
      if (!(await poll())) throw new Error('pairing was cancelled before it was approved');
      claimed = await client.claimPairing(pairing_id, {
        pairing_secret: code,
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

    await loginAndHold(client, {
      login: args.login,
      deviceId: claimed.device_id,
      seed,
      kek,
      accountSalt,
    });

    const vaultId = await Session.chooseVault(client, args.vaultId, 'sync');

    return Session.finishBootstrap(
      {
        serverUrl: args.serverUrl,
        login: args.login,
        deviceId: claimed.device_id,
        vaultId,
        wrappedSeed: seal(kek, seed),
        accountSalt: claimed.account_salt,
        kdfParams: claimed.kdf_params,
      },
      deps,
      { client, seed, userId: claimed.user_id, encPrivkey: claimed.enc_privkey },
    );
  }


  /**
   * Take the account back on a device that holds nothing at all (docs/07, #112).
   *
   * The flow `pair()` cannot be, because there is nobody left to approve anything: the last
   * device is gone, and what remains is the address, the login and the passphrase. It is the
   * difference between a server that stores a vault and a server that can give it back.
   *
   * **The proof goes first and the envelope comes second.** This derives the same KEK it
   * would derive to unlock, sends only a verifier of it, and receives `wrapped_seed` — which
   * that KEK then opens. The server never sees the phrase, and hands the envelope to nobody
   * who cannot already open it.
   *
   * Past this point nothing is special: the device logs in, picks a vault and enters
   * adoption like any other freshly bootstrapped one. The seed envelope is stored exactly as
   * it arrived, because it is already wrapped under this passphrase — unlike pairing, which
   * has to re-wrap what it was handed.
   */
  static async recover(
    args: RecoverArgs,
    deps: { derivation: Derivation; transport: Transport },
  ): Promise<Session> {
    const client = new SyncClient(args.serverUrl, deps.transport);

    // Answered before authentication, and answered for unknown logins too — a deterministic
    // fake (#73). So a wrong login gets this far and fails at the proof, which is exactly
    // where every other wrong thing fails.
    const { account_salt, kdf_params } = await client.kdf(args.login);
    const accountSalt = fromBase64(account_salt);
    const kek = deriveKek(args.passphrase, accountSalt, kdf_params);

    const recovered = await client.recover({
      login: args.login,
      kek_verifier: kekVerifier(kek, args.login, accountSalt),
      device_name: args.deviceName ?? 'obsidian',
      device_platform: args.devicePlatform ?? 'unknown',
    });

    // The AEAD's "invalid tag" would be the only thing separating a wrong passphrase from a
    // corrupted envelope here, and the person holding a right one cannot act on either.
    let seed: Uint8Array;
    try {
      seed = openSealed(kek, recovered.seed_envelope);
    } catch {
      throw new Error(
        'the server returned this account, but that passphrase does not open it — which should be impossible, ' +
          'since the same passphrase produced the proof it accepted. Report this rather than retrying.',
      );
    }

    // The verifier is what the server just authenticated this call with, so the repair inside
    // is a no-op here by construction — which is the honest shape of "every login files it",
    // rather than a fourth caller deciding it knows better.
    await loginAndHold(client, {
      login: args.login,
      deviceId: recovered.device_id,
      seed,
      kek,
      accountSalt,
    });

    const vaultId = await Session.chooseVault(client, args.vaultId, 'recover into');

    return Session.finishBootstrap(
      {
        serverUrl: args.serverUrl,
        login: args.login,
        deviceId: recovered.device_id,
        vaultId,
        // Stored as it arrived: this envelope is already the one this passphrase opens.
        wrappedSeed: recovered.seed_envelope,
        accountSalt: recovered.account_salt,
        kdfParams: recovered.kdf_params,
      },
      deps,
      { client, seed, userId: recovered.user_id, encPrivkey: recovered.enc_privkey },
    );
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
      // Sent so the server can REFUSE it. The account's name belongs to the invitation, and
      // this side has already bound `kek_verifier` to the one it was given — so a mismatch
      // has to fail here, while the person is still looking at the form, rather than
      // becoming a device that syncs once and can never log in again.
      login: args.login,
      auth_secret: authSecret(account.seed),
      account_salt: toBase64(account.accountSalt),
      kdf_params: account.kdfParams,
      pubkey: account.pubkey,
      enc_privkey: account.encPrivkey,
      wrapped_seed: account.wrappedSeed,
      // What makes this account recoverable at all (#112). The recovery PAIR is deliberately
      // not sent: it answers a forgotten passphrase, is not built yet, and null is the honest
      // way to say an account has none — the placeholder that used to sit here made every
      // account claim a way back it did not have.
      kek_verifier: kekVerifier(account.kek, args.login, account.accountSalt),
      initial_vault_id: vaultId,
      initial_vault_name_enc: encryptName(vaultKey(account.seed, vaultId), args.vaultName),
      device_name: args.deviceName ?? 'obsidian',
      device_platform: args.devicePlatform ?? 'desktop',
    });
    client.setAccessToken(out.access);
    client.setRefreshToken(out.refresh);

    // No vault to choose: this flow just made the only one there is.
    return Session.finishBootstrap(
      {
        serverUrl: args.serverUrl,
        login: args.login,
        deviceId: out.device_id,
        vaultId: out.vault_id,
        wrappedSeed: account.wrappedSeed,
        accountSalt: toBase64(account.accountSalt),
        kdfParams: account.kdfParams,
      },
      deps,
      {
        client,
        seed: account.seed,
        userId: out.user_id,
        // This device MADE the identity, so it holds both halves already; the wrapped form
        // is carried anyway so every handle looks the same to whoever borrows one.
        encPrivkey: account.encPrivkey,
      },
    );
  }

  /** A session from a persisted record. Locked: the seed was never written down. */
  static create(
    conn: Connection,
    deps: { derivation: Derivation; transport: Transport },
  ): Session {
    return new Session(conn, deps);
  }
}
