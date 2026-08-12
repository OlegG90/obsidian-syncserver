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
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

import { SyncEngine } from './engine/engine.js';
import { emptyState, type StateStore, type VaultState } from './engine/state.js';
import { ObsidianVaultAdapter } from './obsidian/adapter.js';
import { deviceLabel } from './obsidian/device.js';
import { PushListener } from './obsidian/push.js';
import { shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { obsidianTransport } from './obsidian/transport.js';
import { session, type Connection, type Session } from './session/index.js';

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
  private push: PushListener | undefined;

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.addSettingTab(new SyncServerSettings(this.app, this));

    // Desktop only — Obsidian does not render a status bar on a phone (docs/02), which is
    // exactly why the same state is a command as well, and not only here.
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addEventListener('click', () => this.showStatus());

    // If a connection exists from a previous run, the session is locked — the seed was
    // never written down, so the passphrase has to come from the person again.
    if (this.data.connection) {
      this.sess = session.create(this.data.connection, obsidianTransport);
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

  private setPhase(phase: SyncPhase): void {
    this.phase = phase;
    this.statusBar?.setText(shortStatus(phase));
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
        // Skip when locked (the passphrase would be asked for a background hint) and when a
        // sync is already running (it will see the change anyway).
        if (this.sess?.state === 'open' && this.phase.kind !== 'syncing') void this.syncNow();
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
      obsidianTransport,
    );
    this.sess = s;
    this.data.connection = s.connection;
    this.data.state = emptyState();
    await this.save();
    this.setPhase({ kind: 'idle' });
    this.startPush();
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
   * Turn the session into an authenticated client and run one pass.
   *
   * The session module owns the lifecycle: `open()` unlocks (Argon2id, once), `use()` lends
   * the client for the length of the sync, and `lock()` can only refuse while one is out.
   */
  async syncNow(): Promise<void> {
    try {
      if (!this.sess) {
        new Notice('SyncServer: not connected. Open the plugin settings first.');
        return;
      }

      const state = this.sess.state;
      if (state === 'locked') {
        const passphrase = await askPassphrase(this.app);
        if (!passphrase) return; // dismissed
        const unlocked = await this.sess.open(passphrase);
        if (unlocked === 'locked') return; // the modal was dismissed with an empty field
      }

      this.setPhase({ kind: 'syncing' });

      const report = await this.sess.use(async ({ client, kv }) => {
        const engine = new SyncEngine(
          client,
          this.sess!.connection.vaultId,
          kv,
          new ObsidianVaultAdapter(this.app.vault),
          this.stateStore(),
          deviceLabel(),
          this.data.syncObsidian === true,
        );
        return engine.sync();
      });

      this.setPhase({ kind: 'idle', at: Date.now(), report });

      const parts = [`${report.pushed.length} up`, `${report.pulled.length} down`];
      if (report.matched.length) parts.push(`${report.matched.length} already in sync`);
      if (report.deleted.length) parts.push(`${report.deleted.length} deleted here`);
      if (report.removed.length) parts.push(`${report.removed.length} removed after the server`);
      if (report.renamed.length) parts.push(`${report.renamed.length} moved`);
      if (report.conflicts.length) parts.push(`${report.conflicts.length} conflict${report.conflicts.length === 1 ? '' : 's'}`);
      if (report.errors.length) parts.push(`${report.errors.length} failed`);
      // `scanned` belongs in the summary because a pass that moved nothing is the one result
      // that says nothing about itself: "0 up, 0 down" reads as success whether the vault
      // was already in step or the plugin never saw it.
      new Notice(`SyncServer: ${parts.join(', ')} — ${report.scanned} local files seen.`);

      // Named individually, because "3 failed" — or "3 conflicts" — is not something
      // anybody can act on without knowing which files.
      for (const e of report.errors.slice(0, 5)) new Notice(`SyncServer: ${e.path} — ${e.message}`, 10000);
      for (const c of report.conflicts.slice(0, 5)) {
        new Notice(`SyncServer: conflict — ${c.path}\nyour copy: ${c.conflictPath}`, 15000);
      }
      // A reset on another device moves the user's unsynced work aside. That is the one thing
      // the user must be told about directly, not left in a list — the cost of missing it is data.
      for (const q of report.quarantined.slice(0, 5)) {
        new Notice(`SyncServer: vault was reset elsewhere — ${q.from} was kept as ${q.to}`, 15000);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setPhase({ kind: 'failed', message, at: Date.now() });
      new Notice(`SyncServer: ${message}`, 10000);
    }
  }
}

/** A one-field modal, resolving to the passphrase or `undefined` if dismissed. */
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
  }
}
