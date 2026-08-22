/**
 * The settings screen: every question this plugin asks before it can do anything, and every
 * answer it can show afterwards.
 *
 * Separate from `main.ts` for one reason, and it is not size. This file changes when a
 * sentence is reworded or a button moves; that one changes when the protocol does. They had
 * been the same file, so a rewrite of a description arrived in the same diff as the session
 * lifecycle — and the file that holds the seed became the most-edited in the repository.
 *
 * It reaches the plugin only through what the plugin makes public. The import is
 * **type-only**, so nothing circular exists at runtime: the composition root imports this
 * screen, and this screen imports nothing back.
 */
import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from 'obsidian';
import { whatIsMissing, type ConnectDraft, type Route } from '../connect-form.js';
import { newestFirst } from '../history-flow.js';
import { lastActionLine } from '../last-action.js';
import { matching, showing } from '../trash-filter.js';
import { removalWarning } from '../vault-removal.js';
import { deviceLabel } from './device.js';
import { shortStatus } from './status.js';
import { busyLine } from '../gate.js';
import { recoveryRow } from '../recovery-row.js';
import { wayBack, whatIsWrong, type PassphraseDraft } from '../passphrase-form.js';

import { SyncClient } from '../api/client.js';
import { transport } from './net.js';
import { newHumanCode } from '../crypto/human-code.js';
import { installWarning, PLUGIN_VERSION, versionWarning } from '../version.js';
import { ConfirmModal } from './modals.js';
import type SyncServerPlugin from '../main.js';
import type { ShareFlow, ShareRow } from '../share-flow.js';

/** Bytes as something a person reads. Mebibytes throughout, because quotas are set in them. */
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export class SyncServerSettings extends PluginSettingTab {
  /**
   * The buttons the shared gate would refuse, and the line that says why.
   *
   * Rebuilt with the tab: `display()` throws the old elements away, so holding the previous
   * ones would be disabling buttons nobody can see. Rows arrive after their network call, so
   * each registers itself and takes the current state at that moment rather than waiting for
   * a sweep that has already run.
   */
  private waiting: ButtonComponent[] = [];
  private busyNote: HTMLElement | undefined;
  /** How to stop hearing about the gate. Called before the next display, and on hide. */
  private unwatch: (() => void) | undefined;

  constructor(
    app: App,
    private readonly plugin: SyncServerPlugin,
  ) {
    super(app, plugin);
  }

  /**
   * A control that cannot work while an operation is running — disabled with the reason on
   * screen, instead of refusing after the press (#125).
   *
   * It is the same rule `gate.ts` enforces, said before it refuses rather than after. The
   * gate stays the authority: this only mirrors it, so a press that slips through a redraw
   * still meets the real guard.
   */
  private waits(b: ButtonComponent): ButtonComponent {
    this.waiting.push(b);
    if (this.plugin.busyWith() !== undefined) b.setDisabled(true);
    return b;
  }

  /** Mirror the gate onto every registered control, and show or hide the reason. */
  private showBusy(holding: string | undefined): void {
    for (const b of this.waiting) b.setDisabled(holding !== undefined);
    if (!this.busyNote) return;
    this.busyNote.setText(holding === undefined ? '' : busyLine(holding));
    this.busyNote.style.display = holding === undefined ? 'none' : '';
  }

  /** Obsidian closes the tab; the gate must not keep a listener writing into dead elements. */
  override hide(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    super.hide();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Both belong to the elements about to be discarded.
    this.unwatch?.();
    this.waiting = [];
    this.busyNote = undefined;

    const conn = this.plugin.data.connection;
    if (conn) {
      containerEl.createEl('h3', { text: 'Connected' });

      // Above everything it explains, and before the sections that fill in over the network:
      // the reason has to be readable at the moment the buttons go grey, not below them.
      this.busyNote = containerEl.createEl('p');
      this.busyNote.style.display = 'none';
      this.busyNote.style.color = 'var(--text-accent)';
      this.busyNote.style.fontSize = 'var(--font-ui-smaller)';
      this.statusHeader(containerEl, conn);

      /**
       * Everything about the connection that is not an act — where, who, and the two
       * switches — behind one closed row (#130).
       *
       * Closed by default and summarised on its own row, because it is read once and then
       * never again: an address is set when a server moves, and `.obsidian/` is decided once.
       * The screen opens on what somebody came to do instead.
       */
      const options = this.section(
        containerEl,
        'Server and sync options',
        `${conn.serverUrl} · .obsidian ${this.plugin.data.syncObsidian === true ? 'on' : 'off'}`,
      );

      const list = options.createEl('dl');
      const rows: [string, string][] = [
        ['Login', conn.login],
        ['Vault', conn.vaultId],
        ['Device', conn.deviceId],
      ];
      for (const [label, value] of rows) {
        list.createEl('dt', { text: label });
        list.createEl('dd', { text: value });
      }
      options.createEl('p', {
        text: 'The passphrase is not stored. It is asked for once per session, the first time a sync runs.',
      });

      // Editable, because moving an address is an ordinary thing to do and nothing else in
      // the record depends on it (D-113). The alternative people expect — disconnect, then
      // connect again — would cost a full bootstrap to undo, since the invitation that made
      // this account is one-time and spent.
      let url = conn.serverUrl;
      new Setting(options)
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

      new Setting(options)
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
      this.vaultSection(containerEl);
      this.passphraseSection(containerEl);
      this.recoverySection(containerEl);
      this.shareSection(containerEl);
      this.trashSection(containerEl);
      this.resetSection(containerEl);
      this.disconnectSection(containerEl);
      this.versionSection(containerEl);

      // Last, so the sections have registered what they own — and applied straight away,
      // because an operation may already be running when the tab is opened.
      this.unwatch = this.plugin.watchBusy((holding) => this.showBusy(holding));
      this.showBusy(this.plugin.busyWith());
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

    const draft: ConnectDraft = { serverUrl: '', login: '', token: '', passphrase: '', again: '', code: '' };

    new Setting(containerEl)
      .setName('Server URL')
      .addText((t) => t.setPlaceholder('http://host:8087').onChange((v) => (draft.serverUrl = v.trim())));
    new Setting(containerEl)
      .setName('Login')
      .addText((t) => t.setPlaceholder('your login on that server').onChange((v) => (draft.login = v.trim())));
    // Revealable, because a passphrase somebody is CHOOSING is one they have to proofread —
    // and on the claim route, what they type is what the account's keys are made from. Hidden
    // by default: the ordinary case is typing one they already know, next to somebody.
    const secrets: HTMLInputElement[] = [];
    const passphrase = new Setting(containerEl).setName('Passphrase');
    passphrase.addText((t) => {
      t.inputEl.type = 'password';
      secrets.push(t.inputEl);
      t.onChange((v) => (draft.passphrase = v));
    });
    passphrase.addExtraButton((b) =>
      b
        .setIcon('eye')
        .setTooltip('Show the passphrase')
        .onClick(() => {
          const hidden = secrets[0]?.type === 'password';
          for (const input of secrets) input.type = hidden ? 'text' : 'password';
        }),
    );

    /** A transport failure names a category, never an address — and the address is the likeliest mistake. */
    const explain = (e: unknown): string => {
      const reason = e instanceof Error ? e.message : String(e);
      return /ERR_|network|fetch|refused|timeout/i.test(reason)
        ? `nothing answered at ${draft.serverUrl} — ${reason}`
        : reason;
    };

    /**
     * One route at a time, chosen before anything is filled in (#130).
     *
     * It was four headings down one page, each with its own button, and the fields they all
     * share sitting above the lot. Which meant the answer to "what do I press" was four
     * paragraphs long, and two of the four — the recoveries — read almost identically at a
     * glance, where choosing wrong costs an attempt against a rate-limited endpoint.
     *
     * Segmented, so the four are visibly ONE choice, and only the chosen one's extra field and
     * button are on screen. The shared fields stay above: they are the same details in all
     * four cases, which is the reason they were merged in the first place.
     */
    containerEl.createEl('h3', { text: 'What this vault is doing' });

    const routes: { key: Route; label: string; desc: string }[] = [
      {
        key: 'claim',
        label: 'New account',
        desc: 'A new account on this server, from an invitation. Its keys are generated here, from the passphrase above.',
      },
      {
        key: 'pair',
        label: 'Add this device',
        desc: 'Shows a code to type on a device that is already connected. It seals the account key to this one.',
      },
      {
        key: 'recover',
        label: 'Re-connect',
        desc: 'No device left to pair with, and you still have the passphrase. It proves itself to the server, which returns the account key it has always held sealed.',
      },
      {
        key: 'code',
        label: 'Recovery code',
        desc: 'The passphrase itself is what was lost. The code opens the account key, and the passphrase above becomes this account’s from now on.',
      },
    ];

    const picker = containerEl.createEl('div');
    picker.style.display = 'flex';
    picker.style.gap = '0.25rem';
    picker.style.flexWrap = 'wrap';
    const panel = containerEl.createEl('div');
    // Held here rather than inside the pairing panel: the flow is the plugin's for the tab's
    // lifetime, and the element it draws into has to survive a route being re-chosen.
    const pairingTarget = containerEl.createEl('div');
    // Re-bound on every rebuild, which is what makes a live pairing survive one: the flow is
    // held by the plugin precisely so the wait it began outlives the element it drew into.
    this.plugin.pairing(pairingTarget);

    let chosen: Route = 'claim';

    const drawPanel = (): void => {
      panel.empty();
      // Hidden with the route, EXCEPT while it holds something: a pairing already waiting must
      // not be hidden by a rebuild that reset the chosen route to the first one — its code is
      // on the other device's screen and the person is walking back with it.
      pairingTarget.style.display =
        chosen === 'pair' || pairingTarget.childElementCount > 0 ? '' : 'none';
      const route = routes.find((r) => r.key === chosen)!;
      panel.createEl('p', { text: route.desc, cls: 'setting-item-description' });

      // The second passphrase field, on the two routes where what is typed BECOMES the key:
      // claiming an account, and recovering with a code. On the other two it is proved against
      // something that exists, so a typo fails loudly and costs one retry (#126).
      if (chosen === 'claim' || chosen === 'code') {
        new Setting(panel)
          .setName('Passphrase again')
          .setDesc('Nothing checks it afterwards, so it is checked here.')
          .addText((t) => {
            t.inputEl.type = 'password';
            secrets.push(t.inputEl);
            t.setValue(draft.again).onChange((v) => (draft.again = v));
          });
      }

      if (chosen === 'claim') {
        new Setting(panel)
          .setName('Invitation token')
          .addText((t) => t.setValue(draft.token).setPlaceholder('invitation token').onChange((v) => (draft.token = v.trim())));
      }
      if (chosen === 'code') {
        new Setting(panel)
          .setName('Recovery code')
          .addText((t) => t.setValue(draft.code).setPlaceholder('recovery code').onChange((v) => (draft.code = v)));
      }

      new Setting(panel).addButton((b) => {
        b.setButtonText(chosen === 'pair' ? 'Show pairing code' : 'Connect');
        if (chosen === 'claim' || chosen === 'pair') b.setCta();
        else b.setWarning();
        b.onClick(async () => {
          const need = whatIsMissing(draft, chosen);
          if (need) return void new Notice(`SyncServer: ${need}`, 10000);
          b.setDisabled(true);
          try {
            await this.attemptRoute(chosen, draft, pairingTarget);
          } catch (e) {
            new Notice(`SyncServer: ${explain(e)}`, 12000);
          } finally {
            b.setDisabled(false);
          }
        });
      });
    };

    for (const route of routes) {
      const button = picker.createEl('button', { text: route.label });
      button.onclick = (): void => {
        chosen = route.key;
        for (const el of Array.from(picker.children)) el.removeClass('mod-cta');
        button.addClass('mod-cta');
        drawPanel();
      };
      if (route.key === chosen) button.addClass('mod-cta');
    }
    drawPanel();

    this.versionSection(containerEl);
  }

  /**
   * The two release numbers, and whether they agree (D-111).
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
  private approveSection(host: HTMLElement): void {
    // Summarised by the count now that there is one to count (#156). It was summarised by the ACT —
    // "add another device" — because nothing asked the server for the account's devices and a row
    // promising "mbp-14, iphone" would have been inventing them. The list is what changed, not the taste.
    const containerEl = this.section(host, 'Devices', 'what can reach this account, and adding another');
    this.deviceList(containerEl);
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
   * What each route actually does, once the form has agreed it has what it needs.
   *
   * Separate from the button so the four are one list rather than four copies of
   * disable-try-notice-enable, and so the differences between them are the only thing on
   * screen here: what they take, and what they say afterwards.
   */
  private async attemptRoute(route: Route, draft: ConnectDraft, pairingTarget: HTMLElement): Promise<void> {
    if (route === 'pair') {
      // The held flow, re-bound to this element: the tab is rebuilt constantly and a live
      // pairing's code and cancel button have to be drawn back into the fresh one.
      await this.plugin.pairing(pairingTarget).join({
        serverUrl: draft.serverUrl,
        login: draft.login,
        passphrase: draft.passphrase,
      });
      return;
    }

    new Notice('SyncServer: deriving keys…');
    if (route === 'claim') {
      await this.plugin.connect(draft.serverUrl, draft.login, draft.token, draft.passphrase);
      new Notice('SyncServer: connected.');
    } else if (route === 'recover') {
      await this.plugin.recover({ serverUrl: draft.serverUrl, login: draft.login, passphrase: draft.passphrase });
      new Notice('Recovered. Sync to bring the vault down.', 8000);
    } else {
      await this.plugin.recoverWithCode({
        serverUrl: draft.serverUrl,
        login: draft.login,
        code: draft.code,
        passphrase: draft.passphrase,
      });
      // Said here and nowhere else, because nothing later has a reason to mention it: the code
      // still opens this account. It was not spent, and it has now been out of wherever it was
      // kept.
      new Notice(
        'Recovered, and the passphrase you typed is now this account’s. That recovery code still ' +
          'works — replace it in the settings if it has been anywhere it should not stay.',
        15000,
      );
    }
    this.display();
  }

  /**
   * A section that opens when somebody wants it, summarised on its closed row (#130).
   *
   * `<details>` rather than a toggle this file implements: it is what the platform gives, it
   * survives a rebuilt tab without state to keep in step, and it is what a keyboard and a
   * screen reader already know how to work.
   *
   * **The summary is the point, not the collapsing.** A closed row that says only "Devices"
   * makes somebody open it to find out whether they need to; one that says "mbp-14, iphone ·
   * add another" has already answered. A section whose summary cannot say anything useful
   * should not be a section.
   */
  private section(containerEl: HTMLElement, title: string, summary: string, open = false): HTMLElement {
    const details = containerEl.createEl('details');
    if (open) details.setAttribute('open', '');
    const line = details.createEl('summary');
    line.createEl('strong', { text: title });
    line.createEl('span', { text: ` — ${summary}` }).style.opacity = '0.7';
    details.style.margin = '0.75rem 0';
    const body = details.createEl('div');
    body.style.margin = '0.5rem 0 0 0.5rem';
    return body;
  }

  /**
   * The block at the top: what the sync is doing, what it last said, and how full the account
   * is (#130).
   *
   * Three facts in one place because they are asked as one question — "is this working?" —
   * and they were three separate rows down three separate parts of the screen. The usage bar
   * is drawn rather than written because "how close am I" is the only thing anybody wants
   * from it, and a percentage makes that a subtraction.
   */
  private statusHeader(containerEl: HTMLElement, conn: { login: string; vaultId: string; deviceId: string }): void {
    const header = containerEl.createEl('div');
    header.style.margin = '0 0 1rem';

    const phase = header.createEl('p', { text: shortStatus(this.plugin.phaseNow()) });
    phase.style.fontWeight = 'bold';
    phase.style.margin = '0 0 0.25rem';

    // The last thing said, with the time. A notice has gone by the time somebody looks up, and
    // "did that work?" is the question it leaves behind (#130).
    const said = lastActionLine(this.plugin.lastAction());
    if (said) {
      const line = header.createEl('p', { text: said });
      line.style.fontSize = 'var(--font-ui-smaller)';
      line.style.opacity = '0.8';
      line.style.margin = '0 0 0.5rem';
    }

    // Identity as one line rather than a three-row table: it is a thing to recognise, not to
    // read. The vault id is shortened for the same reason — nobody compares 36 characters.
    const who = header.createEl('p', {
      text: `${conn.login} · vault ${conn.vaultId.slice(0, 4)}…${conn.vaultId.slice(-3)} · this device ${deviceLabel()}`,
    });
    who.style.fontSize = 'var(--font-ui-smaller)';
    who.style.opacity = '0.7';
    who.style.margin = '0 0 0.5rem';

    const bar = header.createEl('div');
    bar.style.height = '6px';
    bar.style.borderRadius = '3px';
    bar.style.background = 'var(--background-modifier-border)';
    bar.style.overflow = 'hidden';
    const fill = bar.createEl('div');
    fill.style.height = '100%';
    fill.style.width = '0%';
    fill.style.background = 'var(--interactive-accent)';
    const usage = header.createEl('p');
    usage.style.fontSize = 'var(--font-ui-smaller)';
    usage.style.opacity = '0.8';
    usage.style.margin = '0.25rem 0 0';

    void this.plugin
      .history()
      .usage()
      .then((u) => {
        if (!u) return;
        const share = u.quota > 0 ? Math.min(1, u.used / u.quota) : 0;
        fill.style.width = `${Math.round(share * 100)}%`;
        // Over the limit is not the same as frozen, and the difference cost a live walk: an
        // account syncing on its own can sit at 210% with `frozen` false for ever.
        const over = u.used > u.quota;
        if (over) fill.style.background = 'var(--text-error)';
        usage.setText(
          `${mib(u.used)} of ${mib(u.quota)}` +
            (over ? ' — over the limit. Discarding from the trash is what frees space.' : ''),
        );
        if (over) usage.style.color = 'var(--text-error)';
      })
      .catch(() => usage.setText('The account’s usage could not be read.'));

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc('Also on the ribbon icon, and in the command palette.')
      .addButton((b) =>
        this.waits(b)
          .setButtonText('Sync now')
          .setCta()
          .onClick(() => void this.plugin.syncNow()),
      );
  }

  /**
   * The vaults this account holds, and removing one (#157, #161).
   *
   * `GET /vaults` was called in exactly one place — the chooser, at pairing or recovery — so once a
   * device was connected, nobody could see what the account held. That is how a vault created **by
   * mistake** stays invisible, which is the thing #117 exists because of.
   *
   * The names are read **here**, with this session's seed. The server stores them encrypted and holds no
   * key, so a list from anywhere else would be a column of uuids.
   *
   * **Removal is offered only where it is possible**, and the row says why when it is not: the server
   * refuses a vault that still holds anything, one named by a share, and this device's own. Each of those
   * is read from the list rather than discovered by pressing the button — a refusal arriving after a
   * confirmation that promised nothing would be lost is worse than no button at all (#176). Which makes
   * the honest use of this screen narrow and real — the empty vault somebody made by accident.
   */
  private vaultSection(host: HTMLElement): void {
    const containerEl = this.section(host, 'Vaults', 'what this account holds, beyond this one');
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Asking the server…', cls: 'setting-item-description' });

    void this.plugin
      .vaults()
      .then((vaults) => {
        list.empty();
        for (const v of vaults) {
          // What it is USING, not only how many rows it has (#178) — which is the number somebody
          // reads when they are deciding which vault to remove to make room.
          const held = v.nodes === 0 ? 'empty' : `${v.nodes} item${v.nodes === 1 ? '' : 's'}, ${mib(v.bytes)}`;
          const row = new Setting(list)
            .setName(v.current ? `${v.name} — this device` : v.name)
            .setDesc(`${held} · ${v.id.slice(0, 8)}…`);

          if (v.current) continue;
          if (v.shared) {
            // Before the act, not after it (#176). This refusal used to arrive as `named_by_a_share`
            // once somebody had already read a confirmation promising that nothing would be lost — and
            // what a share holds is other people's access, which is not this account's to tidy away.
            row.setDesc(`${held} · ${v.id.slice(0, 8)}… — a share names this vault, so it stays`);
            continue;
          }
          row.addButton((b) =>
            this.waits(b)
              .setButtonText('Remove')
              .setWarning()
              .onClick(() => {
                new ConfirmModal(
                  this.app,
                  `Remove ${v.name}?`,
                  removalWarning(v.nodes),
                  async () => {
                    try {
                      await this.plugin.deleteVault(v.id);
                      new Notice(`SyncServer: ${v.name} was removed.`);
                      this.display();
                    } catch (e) {
                      new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
                    }
                  },
                  'Remove',
                ).open();
              }),
          );
        }
      })
      .catch(() => list.setText('The vault list could not be read.'));
  }

  /**
   * What can reach this account, and taking one away (#156).
   *
   * The gap this closes is not cosmetic: `POST /auth/devices` and `DELETE /auth/devices/:id` both
   * existed, and **nothing listed them** — so the only device anybody could revoke was the one they were
   * sitting at, whose id its own `data.json` carries. A phone left in a taxi stayed authorised for ever.
   *
   * **This device is marked and cannot be revoked from here.** Revoking it would kill the refresh token
   * under a plugin that still believes it is connected, and the failure would arrive at the next unlock
   * as something unrelated. Disconnect is the act that means "this one", and it says what it keeps.
   */
  private deviceList(containerEl: HTMLElement): void {
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Asking the server…', cls: 'setting-item-description' });

    void this.plugin
      .devices()
      .then((devices) => {
        list.empty();
        for (const d of devices) {
          const when = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'not since it was added';
          const row = new Setting(list)
            .setName(d.current ? `${d.name} — this device` : d.name)
            // "Signed in", not "synced": the time is written when a token is issued or renewed, and a
            // label that claimed more than the column holds would be read as more precise than it is.
            .setDesc(`${d.platform} · last signed in ${when}`);

          if (d.current) {
            row.addExtraButton((b) => b.setIcon('check').setTooltip('Disconnect removes this one').setDisabled(true));
            continue;
          }
          row.addButton((b) =>
            this.waits(b)
              .setButtonText('Revoke')
              .setWarning()
              .onClick(() => {
                new ConfirmModal(
                  this.app,
                  `Revoke ${d.name}?`,
                  'It stops syncing at once and cannot sign in again. Nothing on it is deleted — the files it ' +
                    'already holds stay where they are, and this account simply stops answering it.',
                  async () => {
                    await this.plugin.revokeDevice(d.id);
                    new Notice(`SyncServer: ${d.name} can no longer reach this account.`, 8000);
                    this.display();
                  },
                  'Revoke',
                ).open();
              }),
          );
        }
        if (devices.length === 0) list.createEl('p', { text: 'No devices — which should be impossible from one.' });
      })
      .catch(() => list.setText('The device list could not be read.'));
  }

  /**
   * Changing the passphrase, and catching up with a change made on another device (#138).
   *
   * **Two different things on one heading, because they are two sides of one fact:** every
   * device holds its own copy of the envelope and unwraps it locally, so a change made here
   * does not reach the others and a change made there does not reach here. The screen says
   * both rather than letting a person discover the asymmetry at a restart.
   *
   * The stale case is offered first when it applies, since a device that is behind should not
   * be invited to change anything until it has caught up — changing from here would put the
   * account behind a phrase the OTHER devices have never heard of either.
   */
  private passphraseSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Passphrase' });

    if (this.plugin.passphraseChangedElsewhere()) {
      containerEl.createEl('p', {
        text:
          'The passphrase was changed on another device. This one still opens with the old one, and will ' +
          'keep doing so until it is told the new one — nothing is broken, and nothing is syncing wrongly.',
      });

      let phrase = '';
      new Setting(containerEl)
        .setName('The new passphrase')
        .setDesc('Proved to the server, which then hands this device the envelope that phrase opens.')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.onChange((v) => (phrase = v));
        })
        .addButton((b) =>
          this.waits(b)
            .setButtonText('Catch up')
            .setCta()
            .onClick(async () => {
              if (!phrase) return void new Notice('SyncServer: the new passphrase is needed.');
              b.setDisabled(true);
              try {
                await this.plugin.adoptPassphrase(phrase);
                new Notice('SyncServer: this device is on the account’s current passphrase.', 8000);
                this.display();
              } catch (e) {
                new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
              } finally {
                b.setDisabled(false);
              }
            }),
        );
      return;
    }

    const draft: PassphraseDraft = { current: '', next: '', again: '' };
    const warning = containerEl.createEl('p');
    warning.style.fontSize = 'var(--font-ui-smaller)';

    // Asked because the answer decides what this screen is allowed to promise. Until it
    // arrives the line stays empty rather than guessing in either direction.
    void this.plugin
      .hasRecoveryCode()
      .then((has) => {
        const said = wayBack(has);
        if (!said) return;
        warning.setText(said);
        if (!has) warning.style.color = 'var(--text-error)';
      })
      .catch(() => undefined);

    const field = (name: string, desc: string, take: (v: string) => void): void => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = 'password';
          t.onChange(take);
        });
    };

    field('Current passphrase', 'An open vault is not proof of the person.', (v) => (draft.current = v));
    field('New passphrase', 'Every vault of this account is behind it, not only this one.', (v) => (draft.next = v));
    field('New passphrase again', 'Nothing checks it afterwards, so it is checked here.', (v) => (draft.again = v));

    new Setting(containerEl)
      .setDesc('Other devices keep opening with the old passphrase until each is told the new one.')
      .addButton((b) =>
        this.waits(b)
          .setButtonText('Change the passphrase')
          .setWarning()
          .onClick(async () => {
            const wrong = whatIsWrong(draft);
            if (wrong) return void new Notice(`SyncServer: ${wrong}`, 10000);
            b.setDisabled(true);
            try {
              new Notice('SyncServer: deriving keys…');
              await this.plugin.changePassphrase(draft.current, draft.next);
              new Notice(
                'SyncServer: changed. Your other devices still open with the old one — each will say so ' +
                  'the next time it unlocks.',
                12000,
              );
              this.display();
            } catch (e) {
              new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 12000);
            } finally {
              b.setDisabled(false);
            }
          }),
      );
  }

  /**
   * The recovery code: the only thing that opens this account if the passphrase is forgotten.
   *
   * **Offered, and never demanded.** A code asked for during registration lands in the same
   * password manager as the passphrase, where it is a second key to the same door — all of
   * the cost, none of the protection. It pays only when it is kept somewhere else, and where
   * that is belongs to the person and not to this plugin. So the screen does one thing: shows
   * the code, once, and says plainly what it is for. Where it goes next is not a question
   * with a button.
   *
   * Shown once because there is no second showing: the server holds a hash, and a code it
   * could show again would be a code it could use.
   */
  private recoverySection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Recovery code' });
    containerEl.createEl('p', {
      text:
        'The passphrase is the only thing that opens this account, and the server never sees it — ' +
        'so nobody can reset it. A recovery code is a second way in, and the only one there is.',
    });

    const setting = new Setting(containerEl).setName('This account').setDesc('Asking the server…');
    // The code lands here, below the row that made it, and stays until the screen is rebuilt.
    const shown = containerEl.createEl('div');

    const button = new ButtonComponent(setting.controlEl).setButtonText('Create a recovery code');
    button.setDisabled(true);

    /**
     * The row, drawn from one fact: does this account have a code.
     *
     * **A function rather than a one-time render, because the act on the row changes the
     * fact.** It was written once, from the server's answer at page load, and never again —
     * so after making a code the line still read "has no recovery code", and the button still
     * believed it was creating one. Pressing it a second time would have gone down the
     * creating path: no confirmation, and the code just written down replaced in silence.
     * That is the exact warning the replacing path exists to give.
     *
     * Found by a person walking it (2026-08-21), which is where this class of defect is
     * always found: nothing was wrong with either branch, only with which one the screen
     * thought it was in.
     */
    const paint = (present: boolean): void => {
      const row = recoveryRow(present);
      setting.setDesc(row.desc);
      button.setButtonText(row.button);
      button.setDisabled(false);
      button.onClick(() => this.makeRecoveryCode(shown, row.confirms, () => paint(true)));
    };

    // What the button means depends on whether there is already a code, and only the server
    // knows — this device may not be the one that made it. Until the answer arrives the
    // button says nothing it might have to take back.
    void this.plugin
      .hasRecoveryCode()
      .then(paint)
      .catch(() => setting.setDesc('The server could not be asked whether this account has one.'));
  }

  /**
   * Make the code and put it on screen — the one moment it exists anywhere but in a hash.
   *
   * Replacing is confirmed and creating is not, because they are different acts: one adds a
   * way in, the other takes one away. Somebody who still holds the old code on paper is
   * about to find it stops working, and that is worth a sentence before rather than a notice
   * after.
   */
  private makeRecoveryCode(shown: HTMLElement, replacing: boolean, made: () => void): void {
    const make = async (): Promise<void> => {
      shown.empty();
      shown.createEl('p', { text: 'Making it…' });
      try {
        const { code, replaced } = await this.plugin.createRecoveryCode();
        this.showRecoveryCode(shown, code, replaced);
        // The row is now describing an account that has changed under it: from here on, this
        // button replaces, and must say so and ask before it does.
        made();
      } catch (e) {
        shown.empty();
        const failed = shown.createEl('p', {
          text: `The code was not made — ${e instanceof Error ? e.message : String(e)}`,
        });
        failed.style.color = 'var(--text-error)';
      }
    };

    if (!replacing) return void make();
    new ConfirmModal(
      this.app,
      'Replace the recovery code?',
      'The code this account has now stops working the moment the new one is made. If it is written down somewhere, that copy becomes waste paper.',
      make,
      'Replace it',
    ).open();
  }

  /**
   * The code itself, and the one thing worth saying about where it goes.
   *
   * Copy is offered because a clipboard is how a code reaches a password manager or a file,
   * and typing 26 characters by hand invites an error nobody would notice until the day it
   * mattered. What is NOT offered is saving it into this vault, and the sentence says why
   * rather than leaving the absence to be read as an oversight: a copy in here survives
   * forgetting the passphrase and does not survive losing the device — and losing the device
   * is half of what this exists for.
   */
  private showRecoveryCode(shown: HTMLElement, code: string, replaced: boolean): void {
    shown.empty();
    shown.createEl('p', {
      text: replaced
        ? 'Done. The previous code no longer works. This is the new one, and it is shown once:'
        : 'This is the code, and it is shown once — the server keeps only a hash of it:',
    });
    shown.createEl('pre', { text: code });

    const copy = shown.createEl('button', { text: 'Copy' });
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(code)
        .then(() => new Notice('SyncServer: recovery code copied. A clipboard is not somewhere to keep it.', 8000))
        .catch(() =>
          new Notice('SyncServer: could not reach the clipboard — the code above is still the code.', 8000),
        );
    });

    const where = shown.createEl('p', {
      text:
        'Keep it away from the passphrase — the two together are one key, not two. Keeping it inside this ' +
        'vault is worth saying no to: it would survive forgetting the passphrase and not survive losing the device.',
    });
    where.style.fontSize = 'var(--font-ui-smaller)';
    where.style.opacity = '0.8';
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
    // Filled in once the share list has answered, because what may be shared depends on what
    // already is — and drawn above that list, where it was.
    const offer = containerEl.createEl('div');

    void flow.list().then((out) => {
      list.empty();
      if (!out) {
        list.createEl('p', { text: 'The share list could not be read.' });
        // No offer either: without knowing what is already shared, every folder here would be
        // a guess, and the one that overlaps fails inside a database trigger.
        return;
      }
      this.shareControl(offer, flow, out.joined);
      if (out.joined.length === 0 && out.invitations.length === 0) {
        list.createEl('p', { text: 'No shared folders yet.' });
      }

      for (const inv of out.invitations) {
        const row = new Setting(list)
          .setName(`Invitation from ${inv.initiatorLogin}`)
          .setDesc('Accepting materialises a copy in this vault; it arrives on the next sync.');
        row.addButton((b) =>
          this.waits(b)
            .setButtonText('Accept')
            .setCta()
            .onClick(() => void flow.accept(inv.shareId)),
        );
        row.addButton((b) => this.waits(b).setButtonText('Decline').onClick(() => void flow.decline(inv.shareId)));
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
          row.addButton((b) =>
            this.waits(b)
              .setButtonText('Invite')
              .onClick(() => void flow.invite(share.shareId, login)),
          );
        }
        // Leaving is everybody's, the initiator included — for them it ends the share, and
        // the coordinator says which happened rather than guessing here.
        row.addButton((b) =>
          this.waits(b)
            .setButtonText('Leave')
            .setWarning()
            .onClick(() => void flow.leave(share.shareId)),
        );

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
              this.waits(b)
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
   * Choosing the folder to share, from the ones that could be.
   *
   * It was a text field, `Folder/path`, which made a misspelling and a real refusal read the
   * same — "the server does not know that folder yet" — with nothing to tell a person which
   * of the two had happened to them (#125). A list has no spelling.
   *
   * It also enforces, by omission, a rule the screen had no way to express: **a share may not
   * overlap another in either direction.** `nodes_check_share_membership` refuses a marked
   * node whose parent belongs to a different share, and refuses one whose child carries a
   * different mark — so a folder inside a share cannot start one, and neither can a folder
   * containing one. That refusal arrives as a check violation from a trigger, which is the
   * worst place a person can meet a rule.
   *
   * Folders of shares that have **ended** are held back too, and that is not an oversight:
   * their nodes keep the mark until leaving is finalized, so the folder is not free yet.
   */
  private shareControl(host: HTMLElement, flow: ShareFlow, joined: readonly ShareRow[]): void {
    host.empty();
    const { offered, reason } = flow.shareable(joined.flatMap((s) => (s.folder ? [s.folder] : [])));

    const setting = new Setting(host).setName('Share a folder');
    if (offered.length === 0) {
      // The reason, not an empty dropdown. A control with nothing in it and no sentence beside
      // it reads as a broken screen rather than as an answer.
      setting.setDesc(reason ?? 'There is no folder to share.');
      return;
    }

    let folder = offered[0]!;
    setting
      .setDesc('Its contents are re-keyed so participants can read them. Synced folders only.')
      .addDropdown((d) => {
        for (const f of offered) d.addOption(f, f);
        d.setValue(folder).onChange((v) => (folder = v));
      })
      .addButton((b) =>
        this.waits(b)
          .setButtonText('Share')
          .onClick(async () => {
            b.setDisabled(true);
            try {
              await flow.share(folder);
            } finally {
              b.setDisabled(false);
            }
          }),
      );
  }

  /**
   * The trash, the history behind each row, and the only button in the product that frees
   * space.
   *
   * Rendered from the server rather than from anything remembered: the trash is the one
   * listing this device does not keep a copy of, and a stale one here would offer to restore
   * something another device discarded.
   */
  private trashSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Trash and history' });

    // The filter is drawn before the listing arrives and stays put while it does: a control
    // that appears when the data does is one somebody has already started typing past.
    let query = '';
    const search = new Setting(containerEl)
      .setName('Find')
      .setDesc('Searches what this page carried, which is the most recently deleted — not the whole trash.');

    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.plugin.history();

    void flow.trash().then((page) => {
      list.empty();
      if (!page) {
        list.createEl('p', { text: 'The trash could not be read.' });
        return;
      }
      if (page.total === 0) {
        list.createEl('p', { text: 'Nothing has been deleted.' });
        return;
      }

      // Wired only now, because until the page is here there is nothing to filter — and a box
      // that accepts typing and does nothing is worse than one that is not there yet.
      search.addText((t) =>
        t.setPlaceholder('part of a name').onChange((v) => {
          query = v;
          draw();
        }),
      );

      const draw = (): void => {
        list.empty();
        const rows = matching(page.rows, query);
        if (rows.length === 0) {
          // Says which kind of nothing it is: the file may be absent, or merely not on this
          // page, and those have different next steps.
          list.createEl('p', {
            text: `Nothing here matches “${query.trim()}”.`,
          });
        }
        render(rows);
        const line = showing(rows.length, page.rows.length, page.total);
        if (line) {
          const p = list.createEl('p', { text: line });
          p.style.fontSize = 'var(--font-ui-smaller)';
        }
        list.append(emptyRow);
      };

      const render = (rows: typeof page.rows): void => {
      for (const row of rows) {
        const setting = new Setting(list)
          .setName(row.name)
          .setDesc(
            `${row.type} · deleted ${new Date(row.deletedAt).toLocaleString()} · ` +
              `${row.versions} version${row.versions === 1 ? '' : 's'}` +
              (row.shared ? ' · was in a shared folder' : ''),
          );

        /**
         * Restoring takes a revision, and until now the screen chose one and threw the rest
         * away: it fetched every version and restored `versions[0]` (#125). The list was
         * already in hand.
         *
         * **A choice is offered only when there is one.** One version means the picker is a
         * list of one and a press spent on a decision nobody has — so that row restores
         * directly and says so with its label. More than one opens them, newest first and
         * marked, because that is what most people mean by "restore" and the rest are why
         * this is a list rather than a button.
         */
        const picker = list.createEl('div');
        picker.style.display = 'none';
        picker.style.margin = '0 0 0.75rem 1rem';

        setting.addButton((b) =>
          this.waits(b)
            .setButtonText(row.versions === 1 ? 'Restore' : 'Restore…')
            .onClick(async () => {
              const versions = await flow.versions(row.nodeId);
              if (!versions || versions.length === 0) return;
              const ordered = newestFirst(versions);
              if (ordered.length === 1) return void (await flow.restore(row.nodeId, ordered[0]!.rev));

              if (picker.style.display !== 'none') {
                picker.style.display = 'none';
                return;
              }
              picker.empty();
              picker.createEl('p', {
                text: 'Pick what comes back. The newest is what most people mean by restore.',
                cls: 'setting-item-description',
              });
              ordered.forEach((v, i) => {
                new Setting(picker)
                  .setName(`r${v.rev} · ${new Date(v.at).toLocaleString()}`)
                  // The size is here because it is the one thing that tells two revisions of the
                  // same note apart at a glance when the timestamps are minutes from each other.
                  .setDesc(`${mib(v.size)}${i === 0 ? ' · newest' : ''}`)
                  .addButton((r) =>
                    this.waits(r)
                      .setButtonText('Restore')
                      .setCta()
                      .onClick(async () => {
                        picker.style.display = 'none';
                        await flow.restore(row.nodeId, v.rev);
                      }),
                  );
              });
              picker.style.display = '';
            }),
        );

        setting.addButton((b) =>
          this.waits(b)
            .setButtonText('Discard')
            .setWarning()
            .onClick(() => void flow.discard(row.nodeId, row.name)),
        );
      }

      };

      /**
       * Built once and re-appended, not rebuilt with the rows.
       *
       * It discards **everything the server holds**, not what is on screen — and a filtered
       * list is the one moment somebody could read it as "empty these". Keeping it out of the
       * redraw is also what keeps its count honest: `page.total`, never the rows in front of
       * it (the screen that showed 200 rows and discarded 3,000 was telling the truth twice
       * and lying once).
       */
      const emptyRow = createEl('div');
      new Setting(emptyRow)
        .setName('Empty the trash')
        .setDesc(
          'Discards every deleted file and all of its history, for good — the whole trash, not ' +
            'the rows shown. This is the only action that lowers what the account is using.',
        )
        .addButton((b) =>
          this.waits(b)
            .setButtonText('Empty')
            .setWarning()
            .onClick(() => void flow.empty(page.total)),
        );

      draw();
    });
  }

  /**
   * "My copy is the truth" — starting a reset (#158).
   *
   * The receiving half of this has been built and walked since M1: a device answered `410 reset` resyncs
   * from the winning tree and quarantines what it displaced, keeping every byte. The **beginning** half
   * had no screen at all, so the act `docs/07` describes as a person's decision could only be performed
   * with `curl`.
   *
   * Beside Disconnect, and behind the same kind of confirmation, because they are the two acts on this
   * screen that change what other devices see. The confirmation is written in consequences rather than
   * in mechanism: what happens to the other devices, what happens to shared folders, and what happens
   * next here.
   *
   * **Shared folders are not swept, and saying so is the point.** A reset removes this vault's own tree
   * and leaves every replica alone (SH-27) — a participant's replica IS their own nodes in their own
   * vault, so a reset that took "everything of mine" would empty the shared folders of up to seven other
   * people. Somebody about to press this deserves to know which half is theirs to give away.
   */
  private resetSection(containerEl: HTMLElement): void {
    const body = this.section(containerEl, 'Replace what the server holds', 'when this copy is the right one');
    body.createEl('p', {
      text:
        'Removes this vault from the server and uploads what is on this device instead. For the case ' +
        'where the server’s copy has become something nobody wants — a bad merge, a half-finished ' +
        'migration — and this Obsidian window has the version you trust.',
    });

    new Setting(body)
      .setName('Make this device the source of truth')
      .setDesc(
        'Every other device resyncs on its next pass. Anything they hold that this copy does not is moved ' +
          'into a “_Reset” folder on their side — kept, never deleted. Shared folders are left alone: ' +
          'those replicas are other people’s copies.',
      )
      .addButton((b) =>
        this.waits(b)
          .setButtonText('Reset the server’s copy')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.app,
              'Replace the server’s copy with this one?',
              'The server keeps nothing of what it holds for this vault except shared folders. Your other ' +
                'devices keep their files — anything this copy lacks is set aside on those devices rather ' +
                'than removed. This device then uploads everything, which can take a while.',
              // Everything past the question belongs to the flow: what it says, when the state may be
              // forgotten, and which of the two acts holds the gate (`reset-flow.ts`).
              async () => {
                await this.plugin.reset().start();
              },
              'Reset it',
            ).open();
          }),
      );
  }

  /**
   * Leaving the server, and saying what it will take to come back (D-113).
   *
   * Last on the screen, and behind a confirmation, because for an account whose only device
   * this is, disconnect and recovery are the same door in opposite directions: the way back
   * is the passphrase, and somebody who does not have it should learn that here rather than
   * afterwards.
   */
  private disconnectSection(host: HTMLElement): void {
    const containerEl = this.section(host, 'Disconnect', 'files stay, here and on the server');
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
            'Disconnect',
          ).open();
        }),
    );
  }
}