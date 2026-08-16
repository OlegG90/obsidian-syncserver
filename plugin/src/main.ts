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
import { sharedFolderCss } from './obsidian/shared-marks.js';
import { phaseIcon, shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { makeObsidianTransport } from './obsidian/transport.js';

import { session, type Connection, type Handle, type Session } from './session/index.js';
import type { OpenedVault } from '@syncserver/shared';
import { openPairingFlow, type PairingFlow } from './pairing-flow.js';
import { openShareFlow, type ShareFlow } from './share-flow.js';
import { decryptName } from './crypto/scope.js';
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
          const opened = await this.openVault(h);
          const engine = new SyncEngine(
            h.client,
            this.sess!.connection.vaultId,
            opened,
            h.kv,
            new ObsidianVaultAdapter(this.app.vault),
            this.stateStore(),
            deviceLabel(),
            this.data.syncObsidian === true,
            this.openShareKeys(h, opened),
          );
          const out = await engine.sync();
          // Asked here because the session is already open and the folder this pass may
          // have just created is now on disk. A shared folder somebody ACCEPTED does not
          // exist locally until then, so its badge was filtered out as a path that is not
          // there and nothing ever came back for it — which the initiator never saw, their
          // folder having been on disk before they shared it.
          await this.refreshSharedFolders(h, opened);
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
  private engineFor(h: Handle, opened: OpenedVault): SyncEngine {
    return new SyncEngine(
      h.client,
      this.data.connection!.vaultId,
      opened,
      h.kv,
      this.vault(),
      this.stateStore(),
      deviceLabel(),
      this.data.syncObsidian === true,
      this.openShareKeys(h, opened),
    );
  }

  /** The vault, opened once for an operation and passed to everything the operation needs. */
  private openVault(h: Handle): Promise<OpenedVault> {
    return h.client.openVault(this.data.connection!.vaultId);
  }

  /**
   * The share keys this device can open, from the vault this operation opened.
   *
   * Not cached across operations: a share can be ended by somebody else between two syncs,
   * and a key kept from before would be offered for a scope nothing is named under any more.
   * Within one operation the opposite holds — the scopes cannot change under it — which is
   * why the value is opened once and passed, rather than asked for by each helper that
   * wants a piece of it.
   *
   * A scope this device cannot open is dropped and said out loud rather than thrown: one
   * unreadable share must not stop the vault from syncing, and the engine still refuses at
   * the one place it matters — meeting a name under a key it does not hold.
   */
  private openShareKeys(h: Handle, opened: OpenedVault): Map<string, Uint8Array> | undefined {
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

  private vaultScopeId(opened: OpenedVault): string {
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
  private shareKeyOf(h: Handle, opened: OpenedVault, shareId: string): Uint8Array {
    const scope = opened.scopes.find((sc) => sc.share_id === shareId);
    if (!scope?.wrapped_key) throw new Error('this device holds no key for that share');

    // Both wrappings, through the one module that knows how to open either. This used to
    // refuse an account envelope — written before the account identity existed and left
    // behind once it did — which meant a PARTICIPANT could never leave: theirs is the
    // envelope form by definition, since it had to cross to somebody who will never hold
    // the initiator's seed.
    const { keys } = shareKeysFrom([scope], {
      vaultKey: h.kv,
      openIdentity: () => h.openIdentity(),
      userId: h.userId,
    });
    const key = keys.get(scope.key_id);
    if (!key) throw new Error('this device cannot open the key for that share');
    return key;
  }

  private shareScopeIdOf(opened: OpenedVault, shareId: string): string {
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
          const opened = await this.openVault(h);
          const out = await h.client.shares();

          // Which FOLDER each share is, which the server cannot say in words: it holds no
          // paths and could not read the names if it did. Resolved once, here, and stored —
          // two rows reading "Shared by you" and a uuid each are two rows nobody can tell
          // apart, and the buttons beside them are not the same buttons.
          const rootOf = await this.resolveSharedFolders(h, opened, out.joined);

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
          const opened = await this.openVault(h);
          const engine = this.engineFor(h, opened);
          const tree = await engine.readTree();
          const nodes: SharedNode[] = [...tree.entries()].map(([path, n]) => ({
            path,
            nodeId: n.nodeId,
            address: n.address,
            nameKeyId: n.nameKeyId ?? '',
          }));
          const vaultScopeId = this.vaultScopeId(opened);
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
          await this.rememberShared(out.shareId, folderPath);
          return { shareId: out.shareId };
        }),

      invite: (shareId, login) =>
        this.withSession(async (h) => {
          const key = this.shareKeyOf(h, await this.openVault(h), shareId);
          await inviteTo({ client: h.client }, shareId, login, key);
        }),

      accept: (shareId) =>
        this.withSession(async (h) => {
          const opened = await this.openVault(h);
          const engine = this.engineFor(h, opened);
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
              vaultScopeId: this.vaultScopeId(opened),
            },
            shareId,
            opened.root_node_id,
            name,
          );
          // The replica's root lands directly under the vault root, so its path is its name.
          await this.rememberShared(shareId, name);
        }),

      decline: (shareId) => this.withSession((h) => h.client.declineShare(shareId)),

      leave: (shareId) =>
        this.withSession(async (h) => {
          const opened = await this.openVault(h);
          const engine = this.engineFor(h, opened);
          const tree = await engine.readTree();
          const key = this.shareKeyOf(h, opened, shareId);
          const scopeId = this.shareScopeIdOf(opened, shareId);
          // Asked of the server rather than assembled from the tree: the set that must be
          // converted includes nodes no listing this client has would show — a folder in
          // the trash carries the mark, has no versions, and appears in neither.
          // Where each node actually LIVES, which the replica listing cannot say: the server
          // has no paths at all. The dedup tag is over a file's plaintext, so leaving reads
          // it from disk — and a bare name is not a path. `Baby.md` was looked for at the
          // vault root while it sat inside the shared folder.
          const pathOfNode = new Map([...tree.entries()].map(([path, n]) => [n.nodeId, path]));

          const replica = (await h.client.shareReplica(shareId)).map((n) => {
            // A node can carry the mark without ever having been converted — the trash of a
            // folder shared later, for one. Its name is under `KV` already, and there is no
            // `KS` envelope for its content to move back, so the only thing it needs is the
            // mark gone. Asking for a conversion it never had is how leaving got stuck.
            const underShare = n.name_key_id === scopeId;
            const name = n.name_enc ? decryptName(underShare ? key : h.kv, n.name_enc) : n.node_id;
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
              vaultScopeId: this.vaultScopeId(opened),
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

  /**
   * Turn each share into the path of its folder **in this vault**, and remember the answer.
   *
   * The server says which node is the root of the caller's own copy — a different node in
   * every participant's vault — and the client is the only side that can turn a node into a
   * path, because it is the only side that can read a name.
   */
  private async resolveSharedFolders(
    h: Handle,
    opened: OpenedVault,
    joined: readonly { share_id: string; root_node_id: string | null }[],
  ): Promise<Map<string, string>> {
    const engine = this.engineFor(h, opened);
    const pathOfNode = new Map([...(await engine.readTree()).entries()].map(([p, n]) => [n.nodeId, p]));

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
  private async refreshSharedFolders(h: Handle, opened: OpenedVault): Promise<void> {
    const { joined } = await h.client.shares();
    const known = Object.keys(this.data.sharedFolders ?? {}).sort().join(',');
    const now = joined.map((s) => s.share_id).sort().join(',');
    if (known === now) return;

    await this.resolveSharedFolders(h, opened, joined);
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

    const id = 'syncserver-shared-folders';
    document.getElementById(id)?.remove();
    const css = sharedFolderCss(paths);
    if (!css) return;

    const style = document.createElement('style');
    style.id = id;
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

/**
 * A confirmation for the one action here that cannot be undone by pressing it again.
 *
 * The consequence goes in the body rather than the title, because "are you sure?" is not
 * information: what a person needs to decide is what they will need to come back.
 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly consequence: string,
    private readonly confirmed: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.consequence });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('Disconnect')
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.confirmed();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** The complete status, on every platform — see `status.ts` for why the status bar is not enough. */
class StatusModal extends Modal {
  private pre: HTMLElement | undefined;

  constructor(
    app: App,
    private lines: string[],
  ) {
    super(app);
  }

  /** Rewrite the body: what only the server can answer arrives after the modal is up. */
  replace(lines: string[]): void {
    this.lines = lines;
    this.pre?.setText(lines.join('\n'));
  }

  override onOpen(): void {
    this.titleEl.setText('SyncServer');
    const pre = this.contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.userSelect = 'text';
    pre.setText(this.lines.join('\n'));
    this.pre = pre;
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

      // Editable, because moving an address is an ordinary thing to do and nothing else in
      // the record depends on it (#113). The alternative people expect — disconnect, then
      // connect again — would cost a full bootstrap to undo, since the invitation that made
      // this account is one-time and spent.
      let url = conn.serverUrl;
      new Setting(containerEl)
        .setName('Server address')
        .setDesc('An IP, a host name, a tunnel — only where this device talks. Changing it locks the session.')
        .addText((t) => t.setValue(conn.serverUrl).onChange((v) => (url = v.trim())))
        .addButton((b) =>
          b.setButtonText('Save').onClick(async () => {
            if (!url || url === conn.serverUrl) return;
            await this.plugin.changeServerUrl(url);
            new Notice('SyncServer: address changed. Unlock on the next sync.', 8000);
            this.display();
          }),
        );

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
      this.disconnectSection(containerEl);
      this.versionSection(containerEl);
      return;
    }

    /**
     * One set of details, three things that can be done with them.
     *
     * They were three forms, each with its own copy of the address, the login and the
     * passphrase — and one of them prefilled with a developer's localhost. Which meant the
     * fields a person had filled in belonged to a heading two screens up from the button
     * they then pressed, and a recovery attempt went to an address nobody had chosen.
     *
     * The details are the same details in all three cases. Only what happens next differs,
     * so only that is offered separately.
     */
    containerEl.createEl('h3', { text: 'Connect this vault' });
    containerEl.createEl('p', {
      text:
        'Everything below needs the same three things: where the server is, who you are on ' +
        'it, and the passphrase. The passphrase never leaves this device, and the server ' +
        'cannot recover it — lose it and every vault goes with it.',
    });

    const draft = { serverUrl: '', login: '', token: '', passphrase: '' };

    new Setting(containerEl)
      .setName('Server URL')
      .addText((t) => t.setPlaceholder('http://host:8087').onChange((v) => (draft.serverUrl = v.trim())));
    new Setting(containerEl)
      .setName('Login')
      .addText((t) => t.setPlaceholder('your login on that server').onChange((v) => (draft.login = v.trim())));
    new Setting(containerEl)
      .setName('Passphrase')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.onChange((v) => (draft.passphrase = v));
      });

    /** Shared by all three: the fields are one form, so their check is one function. */
    const missing = (needsToken = false): string | undefined => {
      if (!draft.serverUrl) return 'the server address';
      if (!draft.login) return 'a login';
      if (!draft.passphrase) return 'the passphrase';
      if (needsToken && !draft.token) return 'an invitation token';
      return undefined;
    };

    /** A transport failure names a category, never an address — and the address is the likeliest mistake. */
    const explain = (e: unknown): string => {
      const reason = e instanceof Error ? e.message : String(e);
      return /ERR_|network|fetch|refused|timeout/i.test(reason)
        ? `nothing answered at ${draft.serverUrl} — ${reason}`
        : reason;
    };

    containerEl.createEl('h3', { text: 'Then one of these' });

    // 1 — a brand-new account, the only case that needs a token.
    new Setting(containerEl)
      .setName('Claim an invitation')
      .setDesc('A new account on this server. Its keys are generated here, from the passphrase above.')
      .addText((t) =>
        t.setPlaceholder('invitation token').onChange((v) => (draft.token = v.trim())),
      )
      .addButton((b) =>
        b
          .setButtonText('Connect')
          .setCta()
          .onClick(async () => {
            const need = missing(true);
            if (need) return void new Notice(`SyncServer: ${need} is needed to connect.`, 8000);
            try {
              b.setDisabled(true);
              new Notice('SyncServer: deriving keys…');
              await this.plugin.connect(draft.serverUrl, draft.login, draft.token, draft.passphrase);
              new Notice('SyncServer: connected.');
              this.display();
            } catch (e) {
              new Notice(`SyncServer: ${explain(e)}`, 12000);
              b.setDisabled(false);
            }
          }),
      );

    // 2 — an account that exists, and a device of it that still works to approve this one.
    const shown = containerEl.createEl('div');
    new Setting(containerEl)
      .setName('Add this device to an account')
      .setDesc('Shows a code to type on a device that is already connected. It seals the account key to this one.')
      .addButton((b) =>
        b.setButtonText('Show pairing code').onClick(async () => {
          const need = missing();
          if (need) return void new Notice(`SyncServer: ${need} is needed to pair.`, 8000);
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

    // 3 — an account that exists with no device left to ask.
    new Setting(containerEl)
      .setName('Recover this account')
      .setDesc(
        'When no device is left to pair with. The passphrase proves itself to the server, which returns ' +
          'the account key it has always held sealed — it cannot read it, and never sees the passphrase.',
      )
      .addButton((b) =>
        b
          .setButtonText('Recover')
          .setWarning()
          .onClick(async () => {
            const need = missing();
            if (need) return void new Notice(`SyncServer: ${need} is needed to recover.`, 8000);
            b.setDisabled(true);
            try {
              new Notice('SyncServer: deriving keys…');
              await this.plugin.recover({
                serverUrl: draft.serverUrl,
                login: draft.login,
                passphrase: draft.passphrase,
              });
              new Notice('Recovered. Sync to bring the vault down.', 8000);
              this.display();
            } catch (e) {
              new Notice(`SyncServer: recovery failed — ${explain(e)}`, 12000);
            } finally {
              b.setDisabled(false);
            }
          }),
      );

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
        // The folder, and what is true of it. No id: a person never needs one, and two rows
        // identified by uuid are two rows nobody can tell apart — which is exactly what
        // happened the first time somebody had to choose between them.
        const label = share.folder ? `“${share.folder}”` : 'A folder not synced here yet';
        const state =
          share.state === 'active'
            ? share.isInitiator
              ? 'Shared by you.'
              : 'Shared with you.'
            : 'This share is over — finish leaving to return the folder to your own key.';
        const row = new Setting(list).setName(label).setDesc(state);

        if (share.isInitiator) {
          let login = '';
          row.addText((t) => t.setPlaceholder('login to invite').onChange((v) => (login = v)));
          row.addButton((b) => b.setButtonText('Invite').onClick(() => void flow.invite(share.shareId, login)));
        }
        // Leaving is everybody's, the initiator included — for them it ends the share, and
        // the coordinator says which happened rather than guessing here.
        row.addButton((b) => b.setButtonText('Leave').setWarning().onClick(() => void flow.leave(share.shareId)));

        // Who is in it, under the row it belongs to. Shown for everybody and not only the
        // initiator: "who can read this folder" is the question a shared folder raises, and
        // a participant who cannot answer it is being asked to trust a list they never see.
        const people = list.createEl('div');
        people.style.margin = '0 0 1em 1em';
        void flow.members(share.shareId).then((members) => {
          if (!members) return;
          for (const m of members) {
            // Three states, and they are not decoration: an invitation has been sent and not
            // answered, a member holds a copy, and somebody finalizing is on their way out
            // and cannot be removed again.
            const state = m.finalizing
              ? 'leaving — their copy is being converted back'
              : m.joined_at
                ? m.is_initiator
                  ? 'shared this folder'
                  : 'holds a copy'
                : 'invited, no answer yet';

            const who = new Setting(people).setName(m.login).setDesc(state);

            // Only the initiator may remove, and never themselves: their way out is Leave,
            // which ends the share, and offering both would be offering the same act twice
            // under two names.
            if (!share.isInitiator || m.is_initiator || m.finalizing) continue;
            who.addButton((b) =>
              b
                .setButtonText(m.joined_at ? 'Revoke' : 'Withdraw')
                .setWarning()
                .onClick(() => void flow.remove(share.shareId, m.user_id, m.login)),
            );
          }
        });
      }
    });
  }

  /**
   * Leaving the server, and saying what it will take to come back (#113).
   *
   * Last on the screen, and behind a confirmation, because for an account whose only device
   * this is, disconnect and recovery are the same door in opposite directions: the way back
   * is the passphrase, and somebody who does not have it should learn that here rather than
   * afterwards.
   */
  private disconnectSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Disconnect' });
    containerEl.createEl('p', {
      text:
        'Stops this device syncing and forgets the connection. Every file stays — here and ' +
        'on the server. To connect this vault again you will need the passphrase, or another ' +
        'device that is still connected.',
    });

    new Setting(containerEl).addButton((b) =>
      b
        .setButtonText('Disconnect')
        .setWarning()
        .onClick(() => {
          new ConfirmModal(
            this.app,
            'Disconnect from the server?',
            'Files are kept, here and on the server. Coming back needs the passphrase or another connected device.',
            async () => {
              await this.plugin.disconnect();
              new Notice('SyncServer: disconnected. Files were left as they are.', 8000);
              this.display();
            },
          ).open();
        }),
    );
  }
}
