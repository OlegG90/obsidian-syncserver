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
import { newHumanCode } from './crypto/human-code.js';
import { phaseIcon, shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { transport } from './obsidian/net.js';
import { askConfirmation, askFolderName, askPassphrase, askVaultChoice, StatusModal } from './obsidian/modals.js';
import { SyncServerSettings } from './obsidian/settings.js';

import { session, type Connection, type Handle, type Session, type VaultChoice } from './session/index.js';
import { openPairingFlow, type PairingFlow } from './pairing-flow.js';
import { openShareFlow, type ShareFlow } from './share-flow.js';
import { openHistoryFlow, type HistoryFlow } from './history-flow.js';
import { shareKeyFor, VaultScopes, type ShareKeyDeps } from './share-keys.js';
import { replicaForLeave } from './departure.js';
import { trashRows } from './trash-map.js';
import {
  acceptInvitation, freeName, inviteTo, leaveShare, requireEveryNameReadable, shareFolder, type SharedNode,
} from './sharing.js';
import { openSyncCoordinator, type SyncCoordinator } from './sync.js';
import { openGate } from './gate.js';
import { openSharedFolderMarks, type SharedFolderMarks } from './shared-folder-marks.js';
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
  /** One operation at a time across sync, sharing and the trash — created once, shared by all three. */
  private gate = openGate();
  /** Which local folder each share is, and the badge that says so — see `shared-folder-marks.ts`. */
  private marks: SharedFolderMarks | undefined;

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.settingsTab = new SyncServerSettings(this.app, this);
    this.addSettingTab(this.settingsTab);

    // The shared-folder subsystem, bound at the edge exactly like the coordinators: the
    // module owns the map and the reconcile guard, and Obsidian or the session is a port.
    this.marks = openSharedFolderMarks({
      load: () => this.data.sharedFolders ?? {},
      save: async (map) => {
        this.data.sharedFolders = map;
        await this.save();
      },
      resolve: (joined) =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);
          const pathOfNode = await this.pathsByNode(h, scopes);
          const rootOf = new Map<string, string>();
          for (const s of joined) {
            const folder = s.root_node_id ? pathOfNode.get(s.root_node_id) : undefined;
            if (folder !== undefined) rootOf.set(s.share_id, folder);
          }
          return rootOf;
        }),
      existing: (paths) => paths.filter((p) => this.app.vault.getAbstractFileByPath(p) !== null),
      render: (css) => {
        document.getElementById(SHARED_MARKS_STYLE)?.remove();
        if (!css) return;
        const style = document.createElement('style');
        style.id = SHARED_MARKS_STYLE;
        style.textContent = css;
        document.head.appendChild(style);
      },
    });

    // Everything Obsidian is bound here, at the edge; the coordinator itself is a module.
    this.sync = openSyncCoordinator({
      gate: this.gate,
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
          await this.marks!.reconcile((await h.client.shares()).joined);
          return out;
        });
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
    this.app.workspace.onLayoutReady(() => this.marks!.applyMarks());

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

  /**
   * What is holding the one-at-a-time gate, and how to hear it change (#125).
   *
   * Exposed so the settings tab can disable what the gate would refuse and say why, rather
   * than letting somebody press Invite and learn afterwards that a sync was running. The
   * gate itself stays private: a screen may watch it, and may not take it.
   */
  busyWith(): string | undefined {
    return this.gate.holding();
  }

  watchBusy(listener: (holding: string | undefined) => void): () => void {
    return this.gate.watch(listener);
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
   * The question a device answers before it binds to a vault (#117, #116).
   *
   * Named vaults, because the point is that the person recognises the answer — the connected
   * screen has shown a raw `vaultId` since M1 and nobody has ever recognised one of those.
   * And the choice includes making a new one, which is the only route there is: the vault an
   * account starts with is made at redeem, and an invitation is one-time and spent.
   *
   * The Obsidian vault's own name is offered as the suggestion, since that is what somebody
   * setting up a second vault almost always means to call it, and the two ending up with the
   * same name is a feature rather than a collision — nothing keys on it.
   */
  private askVault(vaults: { id: string; name: string }[]): Promise<VaultChoice> {
    return askVaultChoice(this.app, this.app.vault.getName(), vaults);
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
    await this.adopt(
      await session.recover(
        {
          ...args,
          deviceName: 'obsidian',
          devicePlatform: Platform.isMobile ? 'mobile' : 'desktop',
          // The same hazard as pairing, through the same branch: recovering into an Obsidian
          // vault other than the original merges the two. #117 names pairing; the code path is
          // one, and asking here costs a caller nothing.
          askVault: (v) => this.askVault(v),
        },
        transport,
      ),
    );
  }

  /**
   * The other recovery: the code, for an account whose PASSPHRASE is what was lost (#34).
   *
   * Identical from here on — a session is a session — which is why both end in `adopt`. The
   * difference is entirely inside the session: this one sets the account's passphrase on the
   * way through, because somebody arriving with a code does not have one.
   */
  async recoverWithCode(args: {
    serverUrl: string;
    login: string;
    code: string;
    passphrase: string;
  }): Promise<void> {
    await this.adopt(
      await session.recoverWithCode(
        {
          ...args,
          deviceName: 'obsidian',
          devicePlatform: Platform.isMobile ? 'mobile' : 'desktop',
          askVault: (v) => this.askVault(v),
        },
        transport,
      ),
    );
  }

  /** What both recoveries do with the session they end up holding. */
  private async adopt(s: Session): Promise<void> {
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
        askVault: (v) => this.askVault(v),
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
      newCode: () => newHumanCode(),
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

  /** The code, a way to carry it, and a button that can actually stop the wait it starts. */
  private renderPairingCode(code: string): void {
    const target = this.pairingTarget;
    if (!target) return;
    target.empty();
    target.createEl('p', { text: 'Enter this on the device that is already connected:' });
    // Set apart rather than left in a paragraph: it is read off one screen and entered
    // into another, and 26 characters are hard enough to follow without prose around
    // them.
    target.createEl('pre', { text: code });

    /**
     * Copy, because the second screen is not always a second device.
     *
     * This flow was written for a person walking between two machines, and typing was the
     * only way a code could cross that gap. #116 made the ordinary case something else: two
     * Obsidian vaults on ONE computer, where the approving window is a keystroke away and
     * transcribing 26 characters by hand is friction the situation does not call for. The
     * feature created the need, and a live walk was where it showed.
     *
     * The button stays either way — it costs a person on a phone nothing, and it says what
     * happened rather than silently succeeding.
     */
    const copy = target.createEl('button', { text: 'Copy' });
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(code)
        .then(() => new Notice('SyncServer: pairing code copied.'))
        // A refused clipboard is not a failed pairing: the code is still on screen and still
        // typable, so this says so rather than looking like the pairing broke.
        .catch(() => new Notice('SyncServer: could not reach the clipboard — the code above still works.', 8000));
    });

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
   * The trash and the version list, bound to this vault's session.
   *
   * Every one of these needs the vault key: the listing's names are ciphertext, and a
   * trashed node of a shared folder is still named under `KS`. So the scopes are opened
   * once per operation and the right key is chosen per row — which is a decision only this
   * side can make, since the server holds no key and says only which scope each name is in.
   */
  history(): HistoryFlow {
    return openHistoryFlow({
      gate: this.gate,
      trash: () =>
        this.withSession(async (h) => {
          const scopes = await this.openVault(h);

          const page = await h.client.trash(this.data.connection!.vaultId);
          return { rows: trashRows(page.entries, scopes), total: page.total };
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

  /**
   * The sharing coordinator, bound to this vault's session.
   *
   * Every one of these needs the vault key, so every one needs an open session — the
   * passphrase is asked for exactly as a sync asks, and once, before the first request.
   */
  sharing(): ShareFlow {
    return openShareFlow({
      gate: this.gate,
      list: () =>
        this.withSession(async (h) => {
          const out = await h.client.shares();

          // Which FOLDER each share is, which the server cannot say in words: it holds no
          // paths and could not read the names if it did. The module resolves the roots
          // once, guarding on whether the share list changed, and stores the answer — two
          // rows reading "Shared by you" and a uuid each are two rows nobody can tell
          // apart, and the buttons beside them are not the same buttons.
          const joined = await this.marks!.reconcile(out.joined);

          return {
            joined,
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
          await this.marks!.remember(out.shareId, folderPath);
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
          await this.marks!.remember(shareId, name);
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

          const replica = replicaForLeave(rows, scopes, pathOfNode);

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
          await this.marks!.forget(shareId);
          return out;
        }),

      members: (shareId) => this.withSession((h) => h.client.shareMembers(shareId)),

      // The initiator's half of a departure, which the server has had all along and no
      // button reached: withdrawing an invitation, and revoking somebody who joined.
      remove: (shareId, userId) => this.withSession((h) => h.client.removeMember(shareId, userId)),

      // The two facts the offer of a folder is made from, each read where it lives: what the
      // server knows is in the sync state, and what exists is Obsidian's. Deciding which of
      // them may be shared is `shareable-folders.ts` — the rule it applies is the schema's,
      // and belongs somewhere a test can reach it.
      syncedPaths: () => Object.keys(this.data.state?.nodes ?? {}),
      folders: () => this.app.vault.getAllFolders().map((f) => f.path),

      notify: (message, durationMs) => new Notice(message, durationMs),
      done: () => this.settingsTab?.display(),
    });
  }

  /**
   * Whether this account has a recovery code, and making one (M7).
   *
   * Both go through the session for the same reason `/auth/recovery-code` is authenticated at
   * all: the proof that may file a way into an account is being able to open it. Neither takes
   * the shared gate — one row in `users`, nothing a sync touches, and no vault key moves
   * (#131 settled the same question for pairing).
   */
  async hasRecoveryCode(): Promise<boolean> {
    return (await this.withSession((h) => h.client.recoveryCodeState())).present;
  }

  async createRecoveryCode(): Promise<{ code: string; replaced: boolean }> {
    return (await this.unlocked()).createRecoveryCode();
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
    await this.marks!.clear();
    this.setPhase({ kind: 'disconnected' });
  }
}
