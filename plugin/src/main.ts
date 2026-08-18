/**
 * The Obsidian plugin (M0.5).
 *
 * It owns the UI and the file (`data.json`), and delegates everything else. The lifecycle —
 * unlock, lock, redeem, tokens, the seed — is the **session module** (`session/`), which is
 * where the passphrase turns into keys and where they die. The protocol is in `api/`, the
 * keys in `crypto/`, the decisions in `engine/` — none of which imports Obsidian, which is
 * what lets all of them be tested against a real server without launching an editor.
 *
 * **The passphrase is never written down.** Everything else here is: the server URL, the
 * login, the device and vault ids, and `wrapped_seed` — which is the account's seed sealed
 * under a key derived from the passphrase, so a copy of `data.json` is worth nothing without
 * the person. That asymmetry is the entire point of the key model (docs/06), and it is the
 * reason the plugin asks again after every restart instead of remembering.
 */
import { Notice, Platform, Plugin, setIcon } from 'obsidian';

import { SyncClient } from './api/client.js';
import { SyncEngine } from './engine/engine.js';
import { emptyState, type StateStore, type VaultState } from './engine/state.js';
import { ObsidianVaultAdapter } from './obsidian/adapter.js';
import { deviceLabel } from './obsidian/device.js';
import { PushListener } from './obsidian/push.js';
import { newPairingCode } from './crypto/pairing-code.js';
import { sharedFolderCss } from './obsidian/shared-marks.js';
import { phaseIcon, shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { transport } from './obsidian/net.js';
import { askConfirmation, askFolderName, askPassphrase, StatusModal } from './obsidian/modals.js';
import { SyncServerSettings } from './obsidian/settings.js';

import { session, type Connection, type Handle, type Session } from './session/index.js';
import { openPairingFlow, type PairingFlow } from './pairing-flow.js';
import { openShareFlow, type ShareFlow } from './share-flow.js';
import { openHistoryFlow, type HistoryFlow } from './history-flow.js';
import { decryptName } from './crypto/scope.js';
import { shareKeyFor, VaultScopes, type ShareKeyDeps } from './share-keys.js';
import {
  acceptInvitation, freeName, inviteTo, leaveShare, requireEveryNameReadable, shareFolder, type SharedNode,
} from './sharing.js';
import { openSyncCoordinator, type SyncCoordinator } from './sync.js';
import { installWarning, PLUGIN_VERSION, versionWarning } from './version.js';


/**
 * The stylesheet that marks shared folders in the file tree.
 *
 * Named as a constant because two places need it: the one that writes it, and the teardown
 * that takes it away. It lives in `document.head` rather than anywhere Obsidian owns, which
 * is exactly why unloading has to say so.
 */
const SHARED_MARKS_STYLE = 'syncserver-shared-folders';

interface PluginData {
  connection?: Connection;
  state?: VaultState;
  /**
   * Which local folder each live share is, keyed by share id.
   *
   * Persisted because the file tree is drawn long before anything is unlocked, and resolving
   * it properly needs the vault key: the server holds no paths, and the names it does hold
   * are ciphertext. Written when this device shares or joins a folder, and reconciled
   * against the server whenever the share list is read.
   */
  sharedFolders?: Record<string, string>;
  /** Synchronise `.obsidian/` configuration — off by default (#7, docs/01). */
  syncObsidian?: boolean;
}

const DEFAULT_DATA: PluginData = {};

export default class SyncServerPlugin extends Plugin {
  data: PluginData = DEFAULT_DATA;

  /** The session, once a connection exists. Its state drives the phase — the UI never tracks it. */
  private sess: Session | undefined;

  private phase: SyncPhase = { kind: 'disconnected' };
  private statusBar: HTMLElement | undefined;
  /** The glanceable surface that renders on a phone, which the status bar does not. */
  private ribbon: HTMLElement | undefined;
  private push: PushListener | undefined;
  /** The sync coordinator (sync.ts) — owns unlock → one pass → render, and the re-entry guard. */
  private sync: SyncCoordinator | undefined;
  /** Kept so a finished pairing can rebuild the screen that was showing its code. */
  private settingsTab: SyncServerSettings | undefined;
  /** One unlock in flight at a time, so a screen that asks for three things asks once. */
  private unlocking: Promise<Session> | undefined;

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.settingsTab = new SyncServerSettings(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Everything Obsidian is bound here, at the edge; the coordinator itself is a module.
    this.sync = openSyncCoordinator({
      sessionState: () => (this.sess ? this.sess.state : 'none'),
      unlock: async (passphrase) => (await this.sess!.open(passphrase)) === 'open',
      askPassphrase: () => askPassphrase(this.app),
      runPass: async () => {
        const report = await this.sess!.use(async (h) => {
          const scopes = await this.openVault(h);
          const out = await this.engineFor(h, scopes).sync();
          // Asked here because the session is already open and the folder this pass may
          // have just created is now on disk. A shared folder somebody ACCEPTED does not
          // exist locally until then, so its badge was filtered out as a path that is not
          // there and nothing ever came back for it — which the initiator never saw, their
          // folder having been on disk before they shared it.
          await this.refreshSharedFolders(h, scopes);
          return out;
        });
        this.applySharedMarks();
        return report;
      },
      setPhase: (phase) => this.setPhase(phase),
      notify: (message, durationMs) => new Notice(message, durationMs),
    });

    // Desktop only — Obsidian does not render a status bar on a phone (docs/02), which is
    // exactly why the same state is a command as well, and not only here.
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addEventListener('click', () => this.showStatus());

    // The ribbon is the glanceable surface that DOES render on a phone, and it is where
    // Obsidian's own sync puts its state — so it is where someone will look. Both this and
    // the status bar are fed by `setPhase` and by nothing else: two surfaces, one source.
    //
    // Clicking it **syncs**, and does not open the status. Obsidian's own sync icon opens a
    // panel because that sync runs by itself; this one does not run until asked, so the
    // obvious gesture on it has to be the asking. The status stays one command away, and on
    // a desktop one click of the status bar away.
    this.ribbon = this.addRibbonIcon(phaseIcon(this.phase), shortStatus(this.phase), () => void this.syncNow());

    // If a connection exists from a previous run, the session is locked — the seed was
    // never written down, so the passphrase has to come from the person again.
    if (this.data.connection) {
      this.sess = session.create(this.data.connection, transport);
      this.setPhase({ kind: 'locked' });
      this.startPush();
    } else {
      this.setPhase({ kind: 'disconnected' });
    }

    // Drawn from what was written down, so a shared folder looks shared from the moment the
    // tree appears — not only after something is unlocked.
    this.app.workspace.onLayoutReady(() => this.applySharedMarks());

    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => void this.syncNow(),
    });

    this.addCommand({
      id: 'show-status',
      name: 'Show sync status',
      callback: () => this.showStatus(),
    });

    this.addCommand({
      id: 'lock',
      name: 'Forget the passphrase until next unlock',
      callback: () => this.lock(),
    });
  }

  /**
   * Everything `onload` switched on that Obsidian does not switch off.
   *
   * The base class undoes what it was told about — a ribbon icon, a status bar item, a
   * command, a settings tab. It knows nothing about a WebSocket this plugin opened or a
   * `<style>` it put in `document.head`, and both outlive an unload without this: the socket
   * keeps reconnecting on its own backoff, and shared folders keep their badges in a vault
   * that has stopped syncing.
   *
   * **This runs on every update**, not only when somebody disables the plugin — which is how
   * a second copy of the same listener ends up in the same window.
   *
   * The rule the next addition has to keep: anything switched on outside `register*` is
   * switched off here, in the same order it went on.
   */
  override async onunload(): Promise<void> {
    await this.stopPush();
    document.getElementById(SHARED_MARKS_STYLE)?.remove();
  }

  async save(): Promise<void> {
    await this.saveData(this.data);
  }

  /** One pass, asked for by a person: the ribbon, the settings button and the command all land here. */
  syncNow(): Promise<void> {
    return this.sync?.run() ?? Promise.resolve();
  }

  private setPhase(phase: SyncPhase): void {
    this.phase = phase;
    const text = shortStatus(phase);
    this.statusBar?.setText(text);
    if (this.ribbon) {
      setIcon(this.ribbon, phaseIcon(phase));
      // The sentence, not just the glyph: on a phone this is what a long press shows, and
      // it is the same line the status bar carries on a desktop.
      this.ribbon.setAttribute('aria-label', text);
    }
  }

  /**
   * The long status, and the account's usage with it.
   *
   * Asked for here rather than remembered: it is a fact about the server that changes
   * without this device doing anything — somebody else writing into a shared folder is
   * enough to freeze the account — so a kept figure would be a stale one. The modal opens
   * immediately and gains the line when the answer lands; a status screen that waited for
   * the network before showing the state of a device would have the priorities backwards.
   */
  showStatus(): void {
    const modal = new StatusModal(this.app, statusLines(this.phase, this.sess?.connection));
    modal.open();

    if (this.sess?.state !== 'open') return;
    void this.sess
      .use((h) => h.client.usage())
      .then((usage) => modal.replace(statusLines(this.phase, this.sess?.connection, usage)))
      .catch(() => {
        // Offline, or the token expired between opening and asking. The status is about this
        // device first, and it is already on screen.
      });
  }

  /**
   * Open the change-notification channel (docs/04): the server tells this device when the
   * vault gained a revision, so the user does not have to press the button. A hint, not an
   * order — a lost or late notification costs nothing, because the next sync finds the
   * change anyway. It connects once the session is unlocked; until then it waits.
   */
  private startPush(): void {
    const conn = this.data.connection;
    if (!conn || this.push) return;
    const url = conn.serverUrl.replace(/^http/, 'ws') + '/events';
    this.push = new PushListener({
      url,
      vaultId: conn.vaultId,
      tokenSource: () => this.sess?.accessToken,
      refresh: () => this.sess?.refreshAccessToken() ?? Promise.resolve(false),
      onNotify: () => {
        // A hint: the coordinator's `runIfIdle` skips when locked (a background hint must
        // not prompt for the passphrase) and when a sync is already running (it will see
        // the change anyway).
        void this.sync?.runIfIdle();
      },
    });
    this.push.start();
  }

  private async stopPush(): Promise<void> {
    await this.push?.stop();
    this.push = undefined;
  }

  /** The state store the engine writes through — `data.json`, beside the connection. */
  private stateStore(): StateStore {
    return {
      load: async () => this.data.state ?? emptyState(),
      save: async (state) => {
        this.data.state = state;
        await this.save();
      },
    };
  }

  /**
   * First run: claim an invitation, generate the account's key material here, and keep only
   * what is useless without the passphrase. The session returns an open session — the caller
   * has just typed the passphrase; asking for it again would be theatre.
   */
  async connect(serverUrl: string, login: string, invitationToken: string, passphrase: string): Promise<void> {
    const s = await session.connect(
      {
        serverUrl,
        login,
        invitationToken,
        passphrase,
        vaultName: this.app.vault.getName(),
        deviceName: 'obsidian',
        devicePlatform: 'desktop',
      },
      transport,
    );
    this.sess = s;
    this.data.connection = s.connection;
    this.data.state = emptyState();
    await this.save();
    this.setPhase({ kind: 'idle' });
    this.startPush();
  }

  /**
   * Take the account back on a device that holds nothing (docs/07, #112).
   *
   * Not a second device joining a first — there is no first left. The passphrase proves
   * itself to the server, the account's own envelope comes back, and what follows is
   * ordinary adoption: the vault on the server materialises into whatever is on disk here,
   * which is the same branch a paired device takes.
   */
  async recover(args: { serverUrl: string; login: string; passphrase: string }): Promise<void> {
    const s = await session.recover(
      { ...args, deviceName: 'obsidian', devicePlatform: Platform.isMobile ? 'mobile' : 'desktop' },
      transport,
    );
    this.sess = s;
    this.data.connection = s.connection;
    // Empty, so adoption runs: this vault may hold nothing, or an old copy of everything,
    // and only reconciliation can tell which.
    this.data.state = emptyState();
    await this.save();
    this.setPhase({ kind: 'idle' });
    this.startPush();
  }

  /**
   * Join an account that already exists, as a second device (docs/07).
   *
   * The counterpart of `connect()`: nothing is generated here, because the account's seed
   * exists and the whole flow is about receiving it. `onCode` is called once the pairing is
   * registered, so the UI can show the code the person carries to the other device, and
   * `waiting` is polled between attempts so they can give up.
   */
  async pair(
    args: { serverUrl: string; login: string; passphrase: string; pairingCode: string },
    waiting: () => Promise<boolean>,
  ): Promise<void> {
    const s = await session.pair(
      {
        ...args,
        deviceName: 'obsidian',
        devicePlatform: Platform.isMobile ? 'mobile' : 'desktop',
      },
      transport,
      waiting,
    );
    this.sess = s;
    this.data.connection = s.connection;
    // A paired device meets a vault that already has contents on both sides, which is
    // adoption's own case (docs/07) — an empty state is exactly right to start it from.
    this.data.state = emptyState();
    await this.save();
    this.setPhase({ kind: 'idle' });
    this.startPush();
  }

  /**
   * The pairing coordinator, bound to the element it may draw into.
   *
   * **One flow, held for the lifetime of the plugin** — the change from "built per call".
   * Two things follow:
   *
   * - `cancel()` finally has an address. The settings tab is rebuilt on every `display()`,
   *   and a flow created per call was discarded on the same line it was used, so the wait
   *   it began could never be stopped; a rebuilt tab then started a SECOND pairing, because
   *   the `running` guard belonged to the discarded instance too.
   * - a rebuilt tab does not lose the code: `pairing()` re-binds the render target and asks
   *   the held flow to draw its live state back in.
   *
   * The flow is created once; every call after the first just re-binds the element and
   * redraws. That is what makes the settings tab's rebuilds harmless instead of fatal.
   */
  private pairingFlow: PairingFlow | undefined;
  private pairingTarget: HTMLElement | undefined;

  pairing(target: HTMLElement): PairingFlow {
    this.pairingTarget = target;
    this.pairingFlow ??= openPairingFlow({
      newCode: () => newPairingCode(),
      join: (args, waiting) => this.pair(args, waiting),
      approve: (code) => this.approvePairing(code),
      showCode: (code) => this.renderPairingCode(code),
      setStatus: (text) => this.renderPairingStatus(text),
      notify: (message, durationMs) => new Notice(message, durationMs),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      done: () => this.settingsTab?.display(),
    });
    this.pairingFlow.redraw();
    return this.pairingFlow;
  }

  /** The code, plus a button that can actually stop the wait it starts. */
  private renderPairingCode(code: string): void {
    const target = this.pairingTarget;
    if (!target) return;
    target.empty();
    target.createEl('p', { text: 'Type this on the device that is already connected:' });
    // Set apart rather than left in a paragraph: it is read off one screen and typed
    // into another, and 26 characters are hard enough to follow without prose around
    // them.
    target.createEl('pre', { text: code });
    // The whole reason the flow is held: a cancel only exists if something can reach it.
    target.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.pairingFlow?.cancel());
  }

  private renderPairingStatus(text: string): void {
    const target = this.pairingTarget;
    if (!target) return;
    const line = target.querySelector('p.syncserver-pairing-status') ?? target.createEl('p');
    line.addClass('syncserver-pairing-status');
    line.setText(text);
  }

  /**
   * Run something with an open session, asking for the passphrase once if it is locked.
   *
   * The alternative is what every sharing operation would otherwise do separately: check
   * the state, prompt, unlock, then act — four steps repeated six times, and the prompt
   * arriving partway through a sequence that has already changed the server.
   */
  private async withSession<T>(fn: (h: Handle) => Promise<T>): Promise<T> {
    return (await this.unlocked()).use(fn);
  }

  /**
   * The session, open — asking for the passphrase once if it is not.
   *
   * Separate from `withSession` because one caller does not want a handle: approving a
   * pairing needs the seed and takes the session's own method, which borrows a handle
   * itself. Wrapping that in a borrow of its own would nest two for no reason.
   */
  private async unlocked(): Promise<Session> {
    if (!this.sess) throw new Error('this vault is not connected');
    if (this.sess.state !== 'locked') return this.sess;

    // **One question, however many callers.** A screen fills itself in from several places
    // at once — the settings tab asks for the shares, the trash and the usage without
    // waiting for any of them — and each would find the session locked, because Argon2id
    // takes about a second and the state does not move until it finishes. A live walk met
    // that as three passphrase prompts to open one page. `SyncClient` already solves the
    // same shape for token refresh; this is that, for the unlock.
    this.unlocking ??= this.askAndOpen().finally(() => {
      this.unlocking = undefined;
    });
    return this.unlocking;
  }

  /** The question itself, held by `unlocked` so that concurrent callers share one asking. */
  private async askAndOpen(): Promise<Session> {
    const passphrase = await askPassphrase(this.app);
    if (!passphrase) throw new Error('the passphrase is needed to open this account');
    if ((await this.sess!.open(passphrase)) !== 'open') throw new Error('that passphrase does not open this account');
    // The screen still said "locked", which stopped being true a line ago.
    this.setPhase({ kind: 'idle' });
    return this.sess!;
  }

  /** The vault adapter, built the same way the sync pass builds it. */
  private vault(): ObsidianVaultAdapter {
    return new ObsidianVaultAdapter(this.app.vault);
  }

  /**
   * The engine, built the one way there is to build it.
   *
   * Nine arguments assembled twice is nine chances for the two to differ, and they already
   * did: one call built its own `ObsidianVaultAdapter` where the other went through
   * `vault()`, and a tenth dependency would have had to be remembered in both places. So a
   * sync uses this too, and there is exactly one signature to keep true.
   *
   * **With the share keys**, and that is not optional: reading the tree means decrypting
   * every name, and the interior of any share this vault is in is named under `KS`. An
   * engine built without them fails on the first such name — which is exactly what happened
   * on the first live share, one press after preparation had re-keyed two nodes. Every
   * sharing operation here meets those names, and so does a pass.
   *
   * The vault id is read from the same field `openVault` reads, so the engine is built for
   * the vault whose scopes it was handed.
   */
  private engineFor(h: Handle, scopes: VaultScopes): SyncEngine {
    return new SyncEngine(
      h.client,
      this.data.connection!.vaultId,
      scopes,
      this.vault(),
      this.stateStore(),
      deviceLabel(),
      this.data.syncObsidian === true,
    );
  }

  /**
   * The vault, opened once for an operation and passed to everything the operation needs.
   *
   * A share whose key did not arrive is **not** announced here, though this is where it is
   * discovered. It used to be: a notice, once per operation, about a state that lasts until
   * somebody delivers a key — so pressing anything three times said it three times, and a
   * sync said nothing about the folder it had just left alone. The pass reports it now, once,
   * naming the folder rather than counting scopes (`SyncReport.unreadable`).
   */
  private async openVault(h: Handle): Promise<VaultScopes> {
    return VaultScopes.open(await h.client.openVault(this.data.connection!.vaultId), this.keyDeps(h));
  }

  /**
   * Where each node of this vault lives, by node id.
   *
   * The engine reads the tree the other way round — paths are what a sync compares — and
   * both callers here start from a node id the server named: the root of a shared folder,
   * and every node a departure has to convert. Turning the map around is one expression,
   * which is exactly why it was written twice.
   */
  private async pathsByNode(h: Handle, scopes: VaultScopes): Promise<Map<string, string>> {
    const tree = await this.engineFor(h, scopes).readTree();
    return new Map([...tree.entries()].map(([path, n]) => [n.nodeId, path]));
  }

  /**
   * What opening a wrapped share key takes, from the session that holds it.
   *
   * `openIdentity` stays a function all the way down, so the seed never leaves the session
   * to satisfy a share that may not even need the account form.
   */
  private keyDeps(h: Handle): ShareKeyDeps {
    return { vaultKey: h.kv, openIdentity: () => h.openIdentity(), userId: h.userId };
  }

  /**
   * The sharing coordinator, bound to this vault's session.
   *
   * Every one of these needs the vault key, so every one needs an open session — the
   * passphrase is asked for exactly as a sync asks, and once, before the first request.
   */
  /**
   * The trash and the version list, bound to this vault's session.
   *
   * Every one of these needs the vault key: the listing's names are ciphertext, and a
   * trashed node of a shared folder is still named under `KS`. So the scopes are opened
   * once per operation and the right key is chosen per row — which is a decision only this
   * side can make, since the server holds no key and says only which scope each name is in.
   */
  history(): HistoryFlow {
    return openHistoryFlow({
      trash: () =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);
          const vaultScope = scopes.vaultScopeId;

          const page = await h.client.trash(this.data.connection!.vaultId);
          const rows = page.entries.map((n) => {
            // The key follows the scope the server names. A node this device holds no key
            // for still gets a row — named as unreadable, and discardable — because an
            // unreadable name is a worse reason to hide something than to show it plainly.
            return {
              nodeId: n.node_id,
              name: scopes.readName(n.name_key_id, n.name_enc),
              type: n.type,
              deletedAt: n.deleted_at,
              versions: n.versions,
              shared: n.share_id !== null,
            };
          });
          return { rows, total: page.total };
        }),

      versions: (nodeId) =>
        this.withSession(async (h) =>
          (await h.client.versions(this.data.connection!.vaultId, nodeId)).map((v) => ({
            rev: v.rev,
            size: v.size,
            at: v.at,
          })),
        ),

      restore: (nodeId, rev) =>
        this.withSession(async (h) => {
          await h.client.restore(this.data.connection!.vaultId, nodeId, rev);
        }),

      discard: (nodeId) =>
        this.withSession((h) => h.client.purgeTrash(this.data.connection!.vaultId, nodeId)),

      usage: () => this.withSession((h) => h.client.usage()),

      confirm: (question) => askConfirmation(this.app, question),
      notify: (message, durationMs) => new Notice(message, durationMs),
      done: () => this.settingsTab?.display(),
    });
  }

  sharing(): ShareFlow {
    return openShareFlow({
      list: () =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);
          const out = await h.client.shares();

          // Which FOLDER each share is, which the server cannot say in words: it holds no
          // paths and could not read the names if it did. Resolved once, here, and stored —
          // two rows reading "Shared by you" and a uuid each are two rows nobody can tell
          // apart, and the buttons beside them are not the same buttons.
          const rootOf = await this.resolveSharedFolders(h, scopes, out.joined);

          return {
            joined: out.joined.map((s) => {
              const folder = rootOf.get(s.share_id);
              return {
                shareId: s.share_id,
                isInitiator: s.is_initiator,
                state: s.state,
                ...(folder === undefined ? {} : { folder }),
              };
            }),
            invitations: out.invitations.map((i) => ({
              shareId: i.share_id,
              initiatorLogin: i.initiator_login,
            })),
          };
        }),

      share: (folderPath) =>
        this.withSession(async (h) => {
          // The tree comes from the engine, which is the one place that turns encrypted
          // names back into paths — and a share is rooted at a node id.
          const scopes = await this.openVault(h);
          const engine = this.engineFor(h, scopes);
          const tree = await engine.readTree();
          const nodes: SharedNode[] = [...tree.entries()].map(([path, n]) => ({
            path,
            nodeId: n.nodeId,
            address: n.address,
            nameKeyId: n.nameKeyId ?? '',
          }));
          const out = await shareFolder(
            {
              client: h.client,
              read: (p) => this.vault().read(p),
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId: scopes.vaultScopeId,
              newScopeId: () => crypto.randomUUID(),
            },
            folderPath,
            nodes,
          );
          await this.rememberShared(out.shareId, folderPath);
          return { shareId: out.shareId };
        }),

      invite: (shareId, login) =>
        this.withSession(async (h) => {
          const key = shareKeyFor((await this.openVault(h)).opened.scopes, shareId, this.keyDeps(h)).key;
          await inviteTo({ client: h.client }, shareId, login, key);
        }),

      accept: (shareId) =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);
          const engine = this.engineFor(h, scopes);
          const tree = await engine.readTree();
          const siblings = new Set([...tree.keys()].filter((p) => !p.includes('/')));

          // Asked, not invented. The initiator's own label for that folder is under THEIR
          // vault key (SH-01) and cannot be read here — so the joiner names their copy, as
          // docs/05 says they do. Offering who shared it is the one fact this side holds.
          const from = (await h.client.shares()).invitations.find((i) => i.share_id === shareId);
          const chosen = await askFolderName(this.app, freeName(`Shared by ${from?.initiator_login ?? 'someone'}`, siblings));
          if (!chosen) throw new Error('a name is needed for the folder before it can land here');

          const name = freeName(chosen, siblings);
          await acceptInvitation(
            {
              client: h.client,
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId: scopes.vaultScopeId,
            },
            shareId,
            scopes.opened.root_node_id,
            name,
          );
          // The replica's root lands directly under the vault root, so its path is its name.
          await this.rememberShared(shareId, name);
        }),

      decline: (shareId) => this.withSession((h) => h.client.declineShare(shareId)),

      leave: (shareId) =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);
          const { key, keyId: scopeId } = shareKeyFor(scopes.opened.scopes, shareId, this.keyDeps(h));
          // Asked of the server rather than assembled from the tree: the set that must be
          // converted includes nodes no listing this client has would show — a folder in
          // the trash carries the mark, has no versions, and appears in neither.
          // Where each node actually LIVES, which the replica listing cannot say: the server
          // has no paths at all. The dedup tag is over a file's plaintext, so leaving reads
          // it from disk — and a bare name is not a path. `Baby.md` was looked for at the
          // vault root while it sat inside the shared folder.
          const pathOfNode = await this.pathsByNode(h, scopes);

          const rows = await h.client.shareReplica(shareId);

          // Before anything starts, and it has to be before: `leaveShare` opens by stopping
          // propagation, and past that point there is no unaltered share left to refuse on
          // behalf of.
          requireEveryNameReadable(rows, scopes);

          const replica = rows.map((n) => {
            // A node can carry the mark without ever having been converted — the trash of a
            // folder shared later, for one. Its name is under `KV` already, and there is no
            // `KS` envelope for its content to move back, so the only thing it needs is the
            // mark gone. Asking for a conversion it never had is how leaving got stuck.
            //
            // One question, asked of the scopes rather than of a two-way test: `KV` and this
            // share's `KS` are both in there, so which key a name wants is a lookup rather
            // than an assumption about how many scopes can exist.
            // `unreadable` was empty, so both of these resolve. `keyFor` is what makes that
            // a fact rather than a comment: if the check above ever stopped covering a case,
            // this refuses instead of naming a file something it is not.
            const name = decryptName(scopes.keyFor(n.name_key_id), n.name_enc!);
            return {
              nodeId: n.node_id,
              // A trashed node has no path and needs none: nothing reads it.
              path: pathOfNode.get(n.node_id) ?? name,
              name,
              // The server says which bytes still need converting; guessing from the name's
              // scope was wrong in both directions. It names the head and the history
              // separately because they are owed different things — an envelope each, but a
              // dedup tag only where there is a plaintext to compute it over.
              address: n.needs_vault_material ? n.sha256 : null,
              history: n.history_needing_material,
              deleted: n.deleted,
            };
          });

          const out = await leaveShare(
            {
              client: h.client,
              read: (p) => this.vault().read(p),
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId: scopes.vaultScopeId,
            },
            shareId,
            key,
            scopeId,
            replica,
          );
          // The folder stays and keeps its name (SH-05); what ends is its being shared, so
          // the badge is what has to go.
          await this.forgetShared(shareId);
          return out;
        }),

      members: (shareId) => this.withSession((h) => h.client.shareMembers(shareId)),

      // The initiator's half of a departure, which the server has had all along and no
      // button reached: withdrawing an invitation, and revoking somebody who joined.
      remove: (shareId, userId) => this.withSession((h) => h.client.removeMember(shareId, userId)),

      // A folder the server knows is one this device has already synced; its node id is
      // what a share is rooted at.
      isSynced: (folderPath) =>
        Object.keys(this.data.state?.nodes ?? {}).some((p) => p === folderPath || p.startsWith(`${folderPath}/`)),

      notify: (message, durationMs) => new Notice(message, durationMs),
      done: () => this.settingsTab?.display(),
    });
  }

  /**
   * Approve another device's pairing from here. Needs the seed, so it needs an open
   * session — the passphrase is asked for exactly as a sync would ask.
   *
   * Through `withSession` like everything else. Its own copy of that sequence had drifted in
   * the way a copy does: it never checked whether the unlock succeeded, so a wrong
   * passphrase fell through to the approval and failed there instead — with a sentence about
   * pairing, for a mistake about a passphrase.
   */
  async approvePairing(code: string): Promise<void> {
    await (await this.unlocked()).approvePairing(code);
  }

  /**
   * Forget the passphrase. The session drops the seed, the client, and both tokens — an
   * access token is the right to read and write the vault's ciphertext, and leaving one
   * behind would be theatre.
   *
   * While a sync is running the session answers 'busy', and the UI says so rather than
   * clearing the client out from under it.
   */
  private lock(): void {
    if (!this.sess) return;
    const result = this.sess.lock();
    if (result === 'busy') {
      new Notice('SyncServer: a sync is running — lock after it finishes.');
      return;
    }
    this.setPhase({ kind: 'locked' });
    void this.stopPush();
    new Notice('SyncServer: locked.');
  }

  /**
   * Turn each share into the path of its folder **in this vault**, and remember the answer.
   *
   * The server says which node is the root of the caller's own copy — a different node in
   * every participant's vault — and the client is the only side that can turn a node into a
   * path, because it is the only side that can read a name.
   */
  private async resolveSharedFolders(
    h: Handle,
    scopes: VaultScopes,
    joined: readonly { share_id: string; root_node_id: string | null }[],
  ): Promise<Map<string, string>> {
    const pathOfNode = await this.pathsByNode(h, scopes);

    const rootOf = new Map<string, string>();
    for (const s of joined) {
      const folder = s.root_node_id ? pathOfNode.get(s.root_node_id) : undefined;
      if (folder !== undefined) rootOf.set(s.share_id, folder);
    }

    this.data.sharedFolders = Object.fromEntries(rootOf);
    await this.save();
    this.applySharedMarks();
    return rootOf;
  }

  /**
   * Keep the marks true after a sync, without paying for a tree listing every time.
   *
   * `GET /shares` is small; resolving paths is not, so the tree is only read when the two
   * disagree — a share joined on another device, one ended while this one was closed, or a
   * vault whose map predates this feature entirely, which is how the participant in a live
   * test ended up with no badge while the initiator had one.
   */
  private async refreshSharedFolders(h: Handle, scopes: VaultScopes): Promise<void> {
    const { joined } = await h.client.shares();
    const known = Object.keys(this.data.sharedFolders ?? {}).sort().join(',');
    const now = joined.map((s) => s.share_id).sort().join(',');
    if (known === now) return;

    await this.resolveSharedFolders(h, scopes, joined);
  }

  /**
   * Show, in the file tree, which folders are shared.
   *
   * The whole point is that it renders **without a session**: the tree is drawn at startup,
   * long before anything is unlocked, and a person deciding where to drop a note is not
   * going to open the plugin's settings first. So the paths come from what was written down,
   * not from the server.
   *
   * Paths that no longer exist are dropped rather than styled — a folder renamed since it
   * was shared would otherwise leave a badge on nothing, and the settings screen puts the
   * map right the next time it is opened.
   */
  applySharedMarks(): void {
    const paths = Object.values(this.data.sharedFolders ?? {}).filter(
      (p) => this.app.vault.getAbstractFileByPath(p) !== null,
    );

    document.getElementById(SHARED_MARKS_STYLE)?.remove();
    const css = sharedFolderCss(paths);
    if (!css) return;

    const style = document.createElement('style');
    style.id = SHARED_MARKS_STYLE;
    style.textContent = css;
    document.head.appendChild(style);
  }

  /** This device has just shared or joined a folder, and knows which one it is. */
  private async rememberShared(shareId: string, folderPath: string): Promise<void> {
    this.data.sharedFolders = { ...this.data.sharedFolders, [shareId]: folderPath };
    await this.save();
    this.applySharedMarks();
  }

  /** The share is over for this device; the folder is not, and keeps everything but the badge. */
  private async forgetShared(shareId: string): Promise<void> {
    if (!this.data.sharedFolders) return;
    const { [shareId]: _gone, ...rest } = this.data.sharedFolders;
    this.data.sharedFolders = rest;
    await this.save();
    this.applySharedMarks();
  }

  /**
   * Point this connection at a different address (#113).
   *
   * An edit of one field, not a reconnection: the account, the seed, the device and every
   * key belong to the account and the vault, never to a URL. Moving from an IP to a host
   * name or through a tunnel changes where this device talks, and nothing about what it
   * says. The session is rebuilt because the client holds the base address, and rebuilding
   * it **locks** — a running session cannot be pointed elsewhere mid-request, and asking for
   * the passphrase again is the honest price of that.
   */
  async changeServerUrl(serverUrl: string): Promise<void> {
    const conn = this.data.connection;
    if (!conn || serverUrl === conn.serverUrl) return;

    await this.stopPush();
    this.data.connection = { ...conn, serverUrl };
    await this.save();
    this.sess = session.create(this.data.connection, transport);
    this.setPhase({ kind: 'locked' });
    this.startPush();
  }

  /**
   * Leave this server, keeping every file (#113).
   *
   * What it ends is *this device's* participation: the local record goes, and the device is
   * revoked so a copy of it left running cannot mint another token. Nothing is deleted — not
   * a note here, not a byte on the server — because a disconnect that also destroyed data
   * would be the one button in this product nobody could undo.
   *
   * Revocation is attempted and not insisted on: it needs a live session and a reachable
   * server, and neither is guaranteed at the moment somebody decides to leave.
   */
  async disconnect(): Promise<void> {
    const conn = this.data.connection;
    if (!conn) return;

    try {
      await this.sess?.use(async (h) => h.client.revokeDevice(conn.deviceId));
    } catch {
      // Offline, locked, or already revoked. The local half is what disconnecting means.
    }

    await this.stopPush();
    this.sess = undefined;
    delete this.data.connection;
    delete this.data.state;
    // Nothing is shared with anybody from here any more, whatever the badges said.
    delete this.data.sharedFolders;
    await this.save();
    this.applySharedMarks();
    this.setPhase({ kind: 'disconnected' });
  }
}
