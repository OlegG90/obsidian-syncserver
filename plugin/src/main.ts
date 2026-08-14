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
import { App, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';

import { SyncEngine } from './engine/engine.js';
import { emptyState, type StateStore, type VaultState } from './engine/state.js';
import { ObsidianVaultAdapter } from './obsidian/adapter.js';
import { deviceLabel } from './obsidian/device.js';
import { PushListener } from './obsidian/push.js';
import { newPairingCode, normalisePairingCode } from './crypto/pairing-code.js';
import { phaseIcon, shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { obsidianTransport } from './obsidian/transport.js';
import { session, type Connection, type Session } from './session/index.js';
import { openSyncCoordinator, type SyncCoordinator } from './sync.js';

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

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.addSettingTab(new SyncServerSettings(this.app, this));

    // Everything Obsidian is bound here, at the edge; the coordinator itself is a module.
    this.sync = openSyncCoordinator({
      sessionState: () => (this.sess ? this.sess.state : 'none'),
      unlock: async (passphrase) => (await this.sess!.open(passphrase)) === 'open',
      askPassphrase: () => askPassphrase(this.app),
      runPass: async () =>
        this.sess!.use(async ({ client, kv }) => {
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
    this.ribbon = this.addRibbonIcon(phaseIcon(this.phase), shortStatus(this.phase), () => this.showStatus());

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
      callback: () => void this.sync?.run(),
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
      obsidianTransport,
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

      this.approveSection(containerEl);
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
        const typed = normalisePairingCode(code);
        if (!typed) {
          new Notice('SyncServer: enter the code shown on the other device.');
          return;
        }
        try {
          b.setDisabled(true);
          await this.plugin.approvePairing(typed);
          new Notice('SyncServer: approved. The other device should finish on its own.');
        } catch (e) {
          new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
        } finally {
          b.setDisabled(false);
        }
      }),
    );
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

    // Filled in once the pairing exists, so the code is never shown before it is real.
    const shown = containerEl.createEl('div');
    let cancelled = false;

    new Setting(containerEl).addButton((b) =>
      b.setButtonText('Show pairing code').onClick(async () => {
        if (!draft.passphrase) {
          new Notice('SyncServer: the account’s passphrase is required.');
          return;
        }
        const code = newPairingCode();
        cancelled = false;
        shown.empty();
        shown.createEl('p', { text: 'Type this on the device that is already connected:' });
        // A code is read off one screen and typed into another, so it is set apart rather
        // than left in a paragraph to be squinted at.
        shown.createEl('pre', { text: code });
        const status = shown.createEl('p', { text: 'Waiting for approval…' });
        const cancel = shown.createEl('button', { text: 'Cancel' });
        cancel.onclick = () => {
          cancelled = true;
          status.setText('Cancelled.');
        };

        try {
          b.setDisabled(true);
          await this.plugin.pair(
            { serverUrl: draft.serverUrl, login: draft.login, passphrase: draft.passphrase, pairingCode: code },
            async () => {
              if (cancelled) return false;
              // A second between attempts: the wait is a person walking to another device,
              // not a machine, and a tighter loop would only make more requests.
              await new Promise((r) => setTimeout(r, 1000));
              return true;
            },
          );
          new Notice('SyncServer: paired.');
          this.display();
        } catch (e) {
          status.setText(e instanceof Error ? e.message : String(e));
          new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
          b.setDisabled(false);
        }
      }),
    );
  }
}
