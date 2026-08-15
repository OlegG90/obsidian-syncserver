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
import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, requestUrl, setIcon } from 'obsidian';

import { SyncClient } from './api/client.js';
import { SyncEngine } from './engine/engine.js';
import { emptyState, type StateStore, type VaultState } from './engine/state.js';
import { ObsidianVaultAdapter } from './obsidian/adapter.js';
import { deviceLabel } from './obsidian/device.js';
import { PushListener } from './obsidian/push.js';
import { newPairingCode } from './crypto/pairing-code.js';
import { phaseIcon, shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { makeObsidianTransport } from './obsidian/transport.js';

import { session, type Connection, type Handle, type Session } from './session/index.js';
import { openPairingFlow, type PairingFlow } from './pairing-flow.js';
import { openShareFlow, type ShareFlow } from './share-flow.js';
import { decryptName } from './crypto/scope.js';
import { unwrapShareKey } from './crypto/share.js';
import { shareKeysFrom } from './share-keys.js';
import { acceptInvitation, freeName, inviteTo, leaveShare, shareFolder, type SharedNode } from './sharing.js';
import { openSyncCoordinator, type SyncCoordinator } from './sync.js';
import { installWarning, PLUGIN_VERSION, versionWarning } from './version.js';

/**
 * The composition root's one job that nothing else may do: hand Obsidian's own functions to
 * the modules that need them.
 *
 * `obsidian` ships declarations and no runtime, so a module that imports a VALUE from it
 * cannot be loaded outside the application — and therefore cannot be tested. Keeping those
 * imports here, and passing what they yield downwards, is what lets everything below have
 * a test surface.
 */
const transport = makeObsidianTransport(requestUrl);

interface PluginData {
  connection?: Connection;
  state?: VaultState;
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

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.settingsTab = new SyncServerSettings(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Everything Obsidian is bound here, at the edge; the coordinator itself is a module.
    this.sync = openSyncCoordinator({
      sessionState: () => (this.sess ? this.sess.state : 'none'),
      unlock: async (passphrase) => (await this.sess!.open(passphrase)) === 'open',
      askPassphrase: () => askPassphrase(this.app),
      runPass: async () =>
        this.sess!.use(async (h) => {
          const engine = new SyncEngine(
            h.client,
            this.sess!.connection.vaultId,
            h.kv,
            new ObsidianVaultAdapter(this.app.vault),
            this.stateStore(),
            deviceLabel(),
            this.data.syncObsidian === true,
            await this.openShareKeys(h),
          );
          return engine.sync();
        }),
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

  showStatus(): void {
    new StatusModal(this.app, statusLines(this.phase, this.sess?.connection)).open();
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
   * Built per call rather than held: the settings tab is rebuilt on every `display()`, so a
   * flow that outlived it would write the code into a detached element — visible to nobody
   * and impossible to cancel.
   */
  pairing(target: HTMLElement): PairingFlow {
    return openPairingFlow({
      newCode: () => newPairingCode(),
      join: (args, waiting) => this.pair(args, waiting),
      approve: (code) => this.approvePairing(code),
      showCode: (code) => {
        target.empty();
        target.createEl('p', { text: 'Type this on the device that is already connected:' });
        // Set apart rather than left in a paragraph: it is read off one screen and typed
        // into another, and 26 characters are hard enough to follow without prose around
        // them.
        target.createEl('pre', { text: code });
      },
      setStatus: (text) => {
        const line = target.querySelector('p.syncserver-pairing-status') ?? target.createEl('p');
        line.addClass('syncserver-pairing-status');
        line.setText(text);
      },
      notify: (message, durationMs) => new Notice(message, durationMs),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      done: () => this.settingsTab?.display(),
    });
  }

  /**
   * Run something with an open session, asking for the passphrase once if it is locked.
   *
   * The alternative is what every sharing operation would otherwise do separately: check
   * the state, prompt, unlock, then act — four steps repeated six times, and the prompt
   * arriving partway through a sequence that has already changed the server.
   */
  private async withSession<T>(fn: (h: Handle) => Promise<T>): Promise<T> {
    if (!this.sess) throw new Error('this vault is not connected');
    if (this.sess.state === 'locked') {
      const passphrase = await askPassphrase(this.app);
      if (!passphrase) throw new Error('the passphrase is needed to open this account');
      if ((await this.sess.open(passphrase)) !== 'open') throw new Error('that passphrase does not open this account');
    }
    return this.sess.use(fn);
  }

  /** The vault adapter, built the same way the sync pass builds it. */
  private vault(): ObsidianVaultAdapter {
    return new ObsidianVaultAdapter(this.app.vault);
  }

  /**
   * An engine for reading only — the tree, which is where node ids come from.
   *
   * **With the share keys**, and that is not optional: reading the tree means decrypting
   * every name, and the interior of any share this vault is in is named under `KS`. An
   * engine built without them fails on the first such name — which is exactly what happened
   * on the first live share, one press after preparation had re-keyed two nodes. Every
   * caller here is a sharing operation, so every one of them meets those names.
   */
  private async engineFor(h: Handle): Promise<SyncEngine> {
    return new SyncEngine(
      h.client,
      this.data.connection!.vaultId,
      h.kv,
      this.vault(),
      this.stateStore(),
      deviceLabel(),
      this.data.syncObsidian === true,
      await this.openShareKeys(h),
    );
  }

  /**
   * The share keys this device can open, read fresh each pass.
   *
   * Not cached: a share can be ended by somebody else between two syncs, and a key kept
   * from before would be offered for a scope nothing is named under any more. The server
   * reports exactly the live ones when the vault is opened, which makes "what can I read"
   * one question with one answer rather than a cache to invalidate.
   *
   * A scope this device cannot open is dropped and said out loud rather than thrown: one
   * unreadable share must not stop the vault from syncing, and the engine still refuses at
   * the one place it matters — meeting a name under a key it does not hold.
   */
  private async openShareKeys(h: Handle): Promise<Map<string, Uint8Array> | undefined> {
    const opened = await h.client.openVault(this.data.connection!.vaultId);
    const { keys, unopenable } = shareKeysFrom(opened.scopes, {
      vaultKey: h.kv,
      openIdentity: () => h.openIdentity(),
      userId: h.userId,
    });
    if (unopenable.length > 0) {
      new Notice(`SyncServer: ${unopenable.length} shared folder(s) could not be opened on this device.`, 10000);
    }
    return keys.size > 0 ? keys : undefined;
  }

  private async vaultScopeId(h: Handle): Promise<string> {
    const opened = await h.client.openVault(this.data.connection!.vaultId);
    const id = opened.scopes.find((s) => s.scope === 'vault')?.key_id;
    if (!id) throw new Error('the vault reports no key scope of its own');
    return id;
  }

  /**
   * `KS` for a share, from what the server reports when the vault is opened.
   *
   * Fetched rather than remembered: the wrapped form is the server's to hold and this
   * device's to open, and caching it would mean deciding when a cache is stale about a key
   * that can stop existing when somebody else ends the share.
   */
  private async shareKeyOf(h: Handle, shareId: string): Promise<Uint8Array> {
    const opened = await h.client.openVault(this.data.connection!.vaultId);
    const scope = opened.scopes.find((sc) => sc.share_id === shareId);
    if (!scope?.wrapped_key) throw new Error('this device holds no key for that share');
    if (scope.wrapping !== 'vault') {
      throw new Error('this share key arrived as an account envelope, which needs the account identity');
    }
    return unwrapShareKey(h.kv, scope.wrapped_key);
  }

  private async shareScopeIdOf(h: Handle, shareId: string): Promise<string> {
    const opened = await h.client.openVault(this.data.connection!.vaultId);
    const scope = opened.scopes.find((sc) => sc.share_id === shareId);
    if (!scope) throw new Error('this device holds no key for that share');
    return scope.key_id;
  }

  /**
   * The sharing coordinator, bound to this vault's session.
   *
   * Every one of these needs the vault key, so every one needs an open session — the
   * passphrase is asked for exactly as a sync asks, and once, before the first request.
   */
  sharing(): ShareFlow {
    return openShareFlow({
      list: () =>
        this.withSession(async (h) => {
          const out = await h.client.shares();
          return {
            joined: out.joined.map((s) => ({
              shareId: s.share_id,
              isInitiator: s.is_initiator,
              state: s.state,
            })),
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
          const engine = await this.engineFor(h);
          const tree = await engine.readTree();
          const nodes: SharedNode[] = [...tree.entries()].map(([path, n]) => ({
            path,
            nodeId: n.nodeId,
            address: n.address,
            nameKeyId: n.nameKeyId ?? '',
          }));
          const vaultScopeId = await this.vaultScopeId(h);
          const out = await shareFolder(
            {
              client: h.client,
              read: (p) => this.vault().read(p),
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId,
              newScopeId: () => crypto.randomUUID(),
            },
            folderPath,
            nodes,
          );
          return { shareId: out.shareId };
        }),

      invite: (shareId, login) =>
        this.withSession(async (h) => {
          const key = await this.shareKeyOf(h, shareId);
          await inviteTo({ client: h.client }, shareId, login, key);
        }),

      accept: (shareId) =>
        this.withSession(async (h) => {
          const engine = await this.engineFor(h);
          const tree = await engine.readTree();
          const siblings = new Set([...tree.keys()].filter((p) => !p.includes('/')));
          const opened = await h.client.openVault(this.data.connection!.vaultId);

          // Asked, not invented. The initiator's own label for that folder is under THEIR
          // vault key (SH-01) and cannot be read here — so the joiner names their copy, as
          // docs/05 says they do. Offering who shared it is the one fact this side holds.
          const from = (await h.client.shares()).invitations.find((i) => i.share_id === shareId);
          const chosen = await askFolderName(this.app, freeName(`Shared by ${from?.initiator_login ?? 'someone'}`, siblings));
          if (!chosen) throw new Error('a name is needed for the folder before it can land here');

          await acceptInvitation(
            {
              client: h.client,
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId: await this.vaultScopeId(h),
            },
            shareId,
            opened.root_node_id,
            freeName(chosen, siblings),
          );
        }),

      decline: (shareId) => this.withSession((h) => h.client.declineShare(shareId)),

      leave: (shareId) =>
        this.withSession(async (h) => {
          const engine = await this.engineFor(h);
          const tree = await engine.readTree();
          const key = await this.shareKeyOf(h, shareId);
          const scopeId = await this.shareScopeIdOf(h, shareId);
          // Asked of the server rather than assembled from the tree: the set that must be
          // converted includes nodes no listing this client has would show — a folder in
          // the trash carries the mark, has no versions, and appears in neither.
          const replica = (await h.client.shareReplica(shareId)).map((n) => {
            // A node can carry the mark without ever having been converted — the trash of a
            // folder shared later, for one. Its name is under `KV` already, and there is no
            // `KS` envelope for its content to move back, so the only thing it needs is the
            // mark gone. Asking for a conversion it never had is how leaving got stuck.
            const underShare = n.name_key_id === scopeId;
            const name = n.name_enc ? decryptName(underShare ? key : h.kv, n.name_enc) : n.node_id;
            return {
              nodeId: n.node_id,
              path: name,
              name,
              address: underShare ? n.sha256 : null,
              deleted: n.deleted,
            };
          });

          return leaveShare(
            {
              client: h.client,
              read: (p) => this.vault().read(p),
              vaultId: this.data.connection!.vaultId,
              vaultKey: h.kv,
              vaultScopeId: await this.vaultScopeId(h),
            },
            shareId,
            key,
            scopeId,
            replica,
          );
        }),

      members: (shareId) => this.withSession((h) => h.client.shareMembers(shareId)),

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
   */
  async approvePairing(code: string): Promise<void> {
    if (!this.sess) throw new Error('this vault is not connected');
    if (this.sess.state === 'locked') {
      const passphrase = await askPassphrase(this.app);
      if (!passphrase) throw new Error('a passphrase is required to approve a device');
      await this.sess.open(passphrase);
      this.setPhase({ kind: 'idle' });
    }
    await this.sess.approvePairing(code);
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
}

/** A one-field modal, resolving to the passphrase or `undefined` if dismissed. */
/**
 * What to call a folder somebody shared with you.
 *
 * It has to be asked, because it cannot be known: the initiator's own label for that folder
 * is under THEIR vault key (SH-01), so the name they use is unreadable here and always will
 * be. The design says the joiner names their own copy, and until this existed the client
 * quietly invented "Shared folder" for everybody — which is not naming it, it is refusing to.
 *
 * A suggestion is offered rather than a blank box: the person accepting knows who shared it,
 * and that is the one fact this side actually holds.
 */
const askFolderName = (app: App, suggestion: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    new TextPromptModal(
      app,
      'Name this shared folder',
      'It lands among your own folders, so the name is yours to choose. Whatever the person ' +
        'who shared it calls their copy is encrypted under their key and cannot be read here.',
      suggestion,
      resolve,
    ).open();
  });

const askPassphrase = (app: App): Promise<string | undefined> =>
  new Promise((resolve) => {
    const modal = new PassphraseModal(app, resolve);
    modal.open();
  });

class PassphraseModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly done: (value: string | undefined) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('SyncServer passphrase');
    this.contentEl.createEl('p', {
      text: 'Unlocks this account’s keys. It is not stored, so it is asked for once per session.',
    });

    const input = this.contentEl.createEl('input', { type: 'password' });
    input.style.width = '100%';
    input.focus();

    const submit = (): void => {
      this.answered = true;
      this.done(input.value || undefined);
      this.close();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Unlock').setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissed with Escape or the close button rather than answered.
    if (!this.answered) this.done(undefined);
  }
}

/** One line of text, asked for with something already in the box. */
class TextPromptModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly explanation: string,
    private readonly initial: string,
    private readonly done: (value: string | undefined) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.explanation });

    const input = this.contentEl.createEl('input', { type: 'text' });
    input.style.width = '100%';
    input.value = this.initial;
    input.focus();
    input.select();

    const submit = (): void => {
      this.answered = true;
      this.done(input.value.trim() || undefined);
      this.close();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Accept').setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(undefined);
  }
}

/** The complete status, on every platform — see `status.ts` for why the status bar is not enough. */
class StatusModal extends Modal {
  constructor(
    app: App,
    private readonly lines: string[],
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('SyncServer');
    const pre = this.contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.userSelect = 'text';
    pre.setText(this.lines.join('\n'));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

class SyncServerSettings extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: SyncServerPlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const conn = this.plugin.data.connection;
    if (conn) {
      containerEl.createEl('h3', { text: 'Connected' });
      const list = containerEl.createEl('dl');
      const rows: [string, string][] = [
        ['Server', conn.serverUrl],
        ['Login', conn.login],
        ['Vault', conn.vaultId],
        ['Device', conn.deviceId],
      ];
      for (const [label, value] of rows) {
        list.createEl('dt', { text: label });
        list.createEl('dd', { text: value });
      }
      containerEl.createEl('p', {
        text: 'The passphrase is not stored. It is asked for once per session, the first time a sync runs.',
      });

      // A button, because the command palette is not somewhere a person looks for the one
      // thing this plugin does. The ribbon icon syncs too; this is where someone who has
      // just finished connecting is already standing.
      new Setting(containerEl)
        .setName('Sync now')
        .setDesc('Also on the ribbon icon, and in the command palette.')
        .addButton((b) =>
          b
            .setButtonText('Sync now')
            .setCta()
            .onClick(() => void this.plugin.syncNow()),
        );

      new Setting(containerEl)
        .setName('Synchronise .obsidian/ configuration')
        .setDesc(
          'Plugins and appearance, not per-device state: workspace layout, the graph view and plugin caches stay on this device (docs/01). Off by default.',
        )
        .addToggle((t) =>
          t
            .setValue(this.plugin.data.syncObsidian === true)
            .onChange(async (v) => {
              this.plugin.data.syncObsidian = v;
              await this.plugin.save();
            }),
        );

      this.approveSection(containerEl);
      this.shareSection(containerEl);
      this.versionSection(containerEl);
      return;
    }

    containerEl.createEl('h3', { text: 'Connect this vault' });
    containerEl.createEl('p', {
      text:
        'Claims an invitation on a SyncServer and generates this account’s keys on this device. ' +
        'The passphrase cannot be recovered by the server — if it is lost, so is every vault.',
    });

    const draft = { serverUrl: 'http://127.0.0.1:8087', login: 'admin', token: 'admin', passphrase: '' };

    new Setting(containerEl)
      .setName('Server URL')
      .addText((t) => t.setValue(draft.serverUrl).onChange((v) => (draft.serverUrl = v.trim())));
    new Setting(containerEl)
      .setName('Login')
      .addText((t) => t.setValue(draft.login).onChange((v) => (draft.login = v.trim())));
    new Setting(containerEl)
      .setName('Invitation token')
      .setDesc('A fresh installation seeds one for the first administrator: admin.')
      .addText((t) => t.setValue(draft.token).onChange((v) => (draft.token = v.trim())));
    new Setting(containerEl)
      .setName('Passphrase')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.onChange((v) => (draft.passphrase = v));
      });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('Connect')
        .setCta()
        .onClick(async () => {
          if (!draft.passphrase) {
            new Notice('SyncServer: a passphrase is required.');
            return;
          }
          try {
            b.setDisabled(true);
            new Notice('SyncServer: deriving keys…');
            await this.plugin.connect(draft.serverUrl, draft.login, draft.token, draft.passphrase);
            new Notice('SyncServer: connected.');
            this.display();
          } catch (e) {
            new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
            b.setDisabled(false);
          }
        }),
    );

    this.pairSection(containerEl);
    this.versionSection(containerEl);
  }

  /**
   * The two release numbers, and whether they agree (#111).
   *
   * The plugin's is known here and now; the server's takes a request, so the line is
   * written twice — once immediately, so there is never a blank waiting for the network,
   * and again when `/health` answers. `display()` may rebuild the tab before that lands,
   * which leaves the callback writing into a detached element: harmless, and cheaper than
   * a cancellation token for one line of text.
   *
   * The mismatch is a warning and not a refusal, for the reason `version.ts` gives.
   */
  private versionSection(containerEl: HTMLElement): void {
    const line = containerEl.createEl('p', { text: `Plugin ${PLUGIN_VERSION}` });
    line.style.opacity = '0.7';
    line.style.fontSize = 'var(--font-ui-smaller)';

    // Before anything about the server, because a half-copied install is the more basic
    // fault and would otherwise show up only as two screens quietly disagreeing: Obsidian's
    // plugin list reads manifest.json, and every version this plugin reports is main.js's.
    const install = installWarning(this.plugin.manifest.version);
    if (install) {
      const el = containerEl.createEl('p', { text: install });
      el.style.color = 'var(--text-error)';
    }

    const conn = this.plugin.data.connection;
    if (!conn) return;

    void new SyncClient(conn.serverUrl, transport)
      .health()
      .then((health) => {
        // A server too old to report one is not an unknown — it is "before 0.1.0".
        line.setText(`Plugin ${PLUGIN_VERSION} · server ${health.version ?? 'before 0.1.0'}`);

        const warning = versionWarning(health.version);
        if (!warning) return;
        const el = containerEl.createEl('p', { text: warning });
        el.style.color = 'var(--text-error)';
      })
      .catch(() => {
        line.setText(`Plugin ${PLUGIN_VERSION} · server unreachable`);
      });
  }

  /**
   * On a device that already holds the seed: take the code from the one that does not.
   *
   * This is the half of pairing that needs the seed, which is why it lives only here and
   * why it may ask for the passphrase — the same question a sync asks, for the same reason.
   */
  private approveSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Add another device' });
    containerEl.createEl('p', {
      text:
        'On the other device, choose “Join an existing account” and read the code it shows. ' +
        'This device seals the account key to that one; the server relays it and cannot read it.',
    });

    let code = '';
    new Setting(containerEl)
      .setName('Pairing code')
      .setDesc('From the other device. Case and dashes do not matter.')
      .addText((t) => t.setPlaceholder('XXXX-XXXX-…').onChange((v) => (code = v)));

    new Setting(containerEl).addButton((b) =>
      b.setButtonText('Approve').onClick(async () => {
        b.setDisabled(true);
        try {
          await this.plugin.pairing(containerEl).approve(code);
        } finally {
          b.setDisabled(false);
        }
      }),
    );
  }


  /**
   * Folders shared with other people, and the invitations waiting for an answer.
   *
   * Drawn from what the server says rather than from anything remembered: a share can be
   * ended by somebody else while this screen is closed, and a list rebuilt from a cache
   * would offer actions on something that is already gone.
   */
  private shareSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Shared folders' });
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.plugin.sharing();
    let folder = '';

    new Setting(containerEl)
      .setName('Share a folder')
      .setDesc('Its contents are re-keyed so participants can read them. The folder must be synced first.')
      .addText((t) => t.setPlaceholder('Folder/path').onChange((v) => (folder = v.trim())))
      .addButton((b) =>
        b.setButtonText('Share').onClick(async () => {
          b.setDisabled(true);
          try {
            await flow.share(folder);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    void flow.list().then((out) => {
      list.empty();
      if (!out) {
        list.createEl('p', { text: 'The share list could not be read.' });
        return;
      }
      if (out.joined.length === 0 && out.invitations.length === 0) {
        list.createEl('p', { text: 'No shared folders yet.' });
      }

      for (const inv of out.invitations) {
        const row = new Setting(list)
          .setName(`Invitation from ${inv.initiatorLogin}`)
          .setDesc('Accepting materialises a copy in this vault; it arrives on the next sync.');
        row.addButton((b) => b.setButtonText('Accept').setCta().onClick(() => void flow.accept(inv.shareId)));
        row.addButton((b) => b.setButtonText('Decline').onClick(() => void flow.decline(inv.shareId)));
      }

      for (const share of out.joined) {
        const row = new Setting(list)
          .setName(share.isInitiator ? 'Shared by you' : 'Shared with you')
          .setDesc(`${share.state} · ${share.shareId}`);

        if (share.isInitiator) {
          let login = '';
          row.addText((t) => t.setPlaceholder('login to invite').onChange((v) => (login = v)));
          row.addButton((b) => b.setButtonText('Invite').onClick(() => void flow.invite(share.shareId, login)));
        }
        // Leaving is everybody's, the initiator included — for them it ends the share, and
        // the coordinator says which happened rather than guessing here.
        row.addButton((b) => b.setButtonText('Leave').setWarning().onClick(() => void flow.leave(share.shareId)));
      }
    });
  }

  /**
   * On a device with nothing: show a code and wait for the other one to approve.
   *
   * The passphrase is asked for here even though the seed is arriving sealed, because this
   * device must be able to lock and come back: it re-wraps the seed under the passphrase
   * itself, the server having declined to hand a wrapped one out (docs/06).
   */
  private pairSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Join an existing account' });
    containerEl.createEl('p', {
      text:
        'For a second device on an account that already exists. Nothing is created — this ' +
        'device receives the account key from one that already has it.',
    });

    const draft = { serverUrl: 'http://127.0.0.1:8087', login: 'admin', passphrase: '' };
    new Setting(containerEl)
      .setName('Server URL')
      .addText((t) => t.setValue(draft.serverUrl).onChange((v) => (draft.serverUrl = v.trim())));
    new Setting(containerEl)
      .setName('Login')
      .addText((t) => t.setValue(draft.login).onChange((v) => (draft.login = v.trim())));
    new Setting(containerEl)
      .setName('Passphrase')
      .setDesc('The account’s own passphrase. It never leaves this device.')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.onChange((v) => (draft.passphrase = v));
      });

    // Where the flow writes: the code, the line under it, and the cancel. The section
    // builds the surface; every decision about what appears on it is the coordinator's.
    const shown = containerEl.createEl('div');

    new Setting(containerEl).addButton((b) =>
      b.setButtonText('Show pairing code').onClick(async () => {
        b.setDisabled(true);
        try {
          await this.plugin.pairing(shown).join({
            serverUrl: draft.serverUrl,
            login: draft.login,
            passphrase: draft.passphrase,
          });
        } finally {
          b.setDisabled(false);
        }
      }),
    );
  }
}
