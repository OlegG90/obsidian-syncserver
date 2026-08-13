/**
 * The Obsidian plugin (M0.5).
 *
 * It owns three things and delegates everything else: what this vault is connected to, the
 * passphrase for the length of a session, and when a sync runs. The protocol is in `api/`,
 * the keys in `crypto/`, the decisions in `engine/` — none of which imports Obsidian, which
 * is what lets all three be tested against a real server without launching an editor.
 *
 * **The passphrase is never written down.** Everything else here is: the server URL, the
 * login, the device and vault ids, and `wrapped_seed` — which is the account's seed sealed
 * under a key derived from the passphrase, so a copy of `data.json` is worth nothing without
 * the person. That asymmetry is the entire point of the key model (docs/06), and it is the
 * reason the plugin asks again after every restart instead of remembering.
 */
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

import { SyncClient } from './api/client.js';
import type { KdfParams } from './api/client.js';
import { authSecret, createAccount, openAccount, vaultKey } from './crypto/account.js';
import { fromBase64, randomUuid, toBase64 } from './crypto/bytes.js';
import { encryptName } from './crypto/scope.js';
import { SyncEngine } from './engine/engine.js';
import { emptyState, type StateStore, type VaultState } from './engine/state.js';
import { ObsidianVaultAdapter } from './obsidian/adapter.js';
import { deviceLabel } from './obsidian/device.js';
import { shortStatus, statusLines, type SyncPhase } from './obsidian/status.js';
import { obsidianTransport } from './obsidian/transport.js';

interface Connection {
  serverUrl: string;
  login: string;
  deviceId: string;
  vaultId: string;
  /** The seed, sealed under the passphrase. Useless on its own — see the file comment. */
  wrappedSeed: string;
  accountSalt: string;
  kdfParams: KdfParams;
}

interface PluginData {
  connection?: Connection;
  state?: VaultState;
}

const DEFAULT_DATA: PluginData = {};

export default class SyncServerPlugin extends Plugin {
  data: PluginData = DEFAULT_DATA;

  /** Held for the session only, and never persisted anywhere. */
  private seed: Uint8Array | undefined;

  private phase: SyncPhase = { kind: 'disconnected' };
  private statusBar: HTMLElement | undefined;

  override async onload(): Promise<void> {
    this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());
    this.addSettingTab(new SyncServerSettings(this.app, this));

    // Desktop only — Obsidian does not render a status bar on a phone (docs/02), which is
    // exactly why the same state is a command as well, and not only here.
    this.statusBar = this.addStatusBarItem();
    this.statusBar.addEventListener('click', () => this.showStatus());
    this.setPhase(this.data.connection ? { kind: 'locked' } : { kind: 'disconnected' });

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
      callback: () => {
        this.seed = undefined;
        this.setPhase({ kind: 'locked' });
        new Notice('SyncServer: locked.');
      },
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
    new StatusModal(this.app, statusLines(this.phase, this.data.connection)).open();
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
   * what is useless without the passphrase.
   */
  async connect(serverUrl: string, login: string, invitationToken: string, passphrase: string): Promise<void> {
    const client = new SyncClient(serverUrl, obsidianTransport);
    const account = createAccount(passphrase);
    const vaultId = randomUuid();
    const kv = vaultKey(account.seed, vaultId);

    const out = await client.redeem({
      invitation_token: invitationToken,
      auth_secret: authSecret(account.seed),
      account_salt: toBase64(account.accountSalt),
      kdf_params: account.kdfParams,
      // X25519 for sharing is M3; a placeholder keeps the account shape valid until then.
      pubkey: 'AQ==',
      enc_privkey: 'Ag==',
      wrapped_seed: account.wrappedSeed,
      recovery_key: 'BA==',
      recovery_code_hash: 'f'.repeat(64),
      initial_vault_id: vaultId,
      initial_vault_name_enc: encryptName(kv, this.app.vault.getName()),
      device_name: 'obsidian',
      device_platform: 'desktop',
    });

    this.data.connection = {
      serverUrl,
      login,
      deviceId: out.device_id,
      vaultId: out.vault_id,
      wrappedSeed: account.wrappedSeed,
      accountSalt: toBase64(account.accountSalt),
      kdfParams: account.kdfParams,
    };
    this.data.state = emptyState();
    this.seed = account.seed;
    await this.save();
    this.setPhase({ kind: 'idle' });
  }

  /**
   * Turn a passphrase into an authenticated client.
   *
   * Argon2id runs here and nowhere else, once per unlock — 64 MiB and a second or two on a
   * desktop (docs/06). The seed it recovers stays in memory; what goes to the server is
   * `HKDF(seed, "auth")`, which is the only branch that ever leaves this process.
   */
  private async open(passphrase?: string): Promise<{ client: SyncClient; kv: Uint8Array; conn: Connection }> {
    const conn = this.data.connection;
    if (!conn) throw new Error('this vault is not connected to a server yet — see the plugin settings');

    if (!this.seed) {
      if (!passphrase) throw new Error('locked');
      const account = openAccount(passphrase, fromBase64(conn.accountSalt), conn.kdfParams, conn.wrappedSeed);
      this.seed = account.seed;
    }

    const client = new SyncClient(conn.serverUrl, obsidianTransport);
    const session = await client.login({
      login: conn.login,
      auth_secret: authSecret(this.seed),
      device_id: conn.deviceId,
    });
    client.setAccessToken(session.access);
    // The access token is good for 15 minutes (docs/04); a vault with enough files takes
    // longer than that to sync. The refresh token is what lets the client renew it mid-sync
    // without asking for the passphrase again — see SyncClient.send.
    client.setRefreshToken(session.refresh);

    return { client, kv: vaultKey(this.seed, conn.vaultId), conn };
  }

  async syncNow(): Promise<void> {
    try {
      if (!this.data.connection) {
        new Notice('SyncServer: not connected. Open the plugin settings first.');
        return;
      }
      const passphrase = this.seed ? undefined : await askPassphrase(this.app);
      if (!this.seed && !passphrase) return; // dismissed

      const { client, kv, conn } = await this.open(passphrase);
      const engine = new SyncEngine(
        client,
        conn.vaultId,
        kv,
        new ObsidianVaultAdapter(this.app.vault),
        this.stateStore(),
        deviceLabel(),
      );

      this.setPhase({ kind: 'syncing' });
      const report = await engine.sync();
      this.setPhase({ kind: 'idle', at: Date.now(), report });

      const parts = [`${report.pushed.length} up`, `${report.pulled.length} down`];
      if (report.matched.length) parts.push(`${report.matched.length} already in sync`);
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
