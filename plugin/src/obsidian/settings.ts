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
import { App, ButtonComponent, Notice, Platform, PluginSettingTab, Setting } from 'obsidian';
import { whatIsMissing, type ConnectDraft, type Route } from '../connect-form.js';
import { newestFirst } from '../history-flow.js';
import { autoSyncByDefault, QUIET_MS } from '../local-changes.js';
import { lastActionLine } from '../last-action.js';
import { matching, showing } from '../trash-filter.js';
import { removalWarning } from '../vault-removal.js';
import { deviceLabel } from './device.js';
import { shortStatus } from './status.js';
import { mib } from './format.js';
import { statusHeader } from './status-header.js';
import { Surface, section } from './surface.js';
import { recoveryRow } from '../recovery-row.js';
import { wayBack, whatIsWrong, type PassphraseDraft } from '../passphrase-form.js';

import { SyncClient } from '../api/client.js';
import { transport } from './net.js';
import { newHumanCode } from '../crypto/human-code.js';
import { installWarning, PLUGIN_VERSION, versionWarning } from '../version.js';
import { ConfirmModal } from './modals.js';
import type SyncServerPlugin from '../main.js';
import type { ShareFlow, ShareRow } from '../share-flow.js';

export class SyncServerSettings extends PluginSettingTab {
  /**
   * The buttons the shared gate would refuse, and the line that says why.
   *
   * Rebuilt with the tab: `display()` throws the old elements away, so holding the previous
   * ones would be disabling buttons nobody can see. Rows arrive after their network call, so
   * each registers itself and takes the current state at that moment rather than waiting for
   * a sweep that has already run.
   */
  private readonly surface: Surface;

  constructor(
    app: App,
    private readonly plugin: SyncServerPlugin,
  ) {
    super(app, plugin);
    this.surface = new Surface(app, plugin, () => this.display());
  }

  /** Obsidian closes the tab; the gate must not keep a listener writing into dead elements. */
  override hide(): void {
    this.surface.stop();
    super.hide();
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Everything it holds belongs to the elements about to be discarded.
    this.surface.reset();

    const conn = this.plugin.data.connection;
    if (conn) {
      containerEl.createEl('h3', { text: 'Connected' });

      // Above everything it explains, and before the sections that fill in over the network:
      // the reason has to be readable at the moment the buttons go grey, not below them.
      this.surface.reasonLine(containerEl);
      statusHeader(containerEl, this.surface, conn);

      /**
       * Everything about the connection that is not an act — where, who, and the two
       * switches — behind one closed row (#130).
       *
       * Closed by default and summarised on its own row, because it is read once and then
       * never again: an address is set when a server moves, and `.obsidian/` is decided once.
       * The screen opens on what somebody came to do instead.
       */
      const options = section(
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

      // **The last sentence is not a detail.** Obsidian raises no event when configuration changes, so
      // nothing here can start a pass the way editing a note does (#304). Somebody who changes a
      // hotkey, watches the vault sit still and concludes the switch is broken has been told the
      // truth by the software, just not on this screen — which is where they are standing.
      new Setting(options)
        .setName('Synchronise .obsidian/ configuration')
        .setDesc(
          'Plugins and appearance, not per-device state: workspace layout, the graph view, plugin caches and this plugin stay on this device (docs/01). Off by default. Changes here travel with the next sync rather than starting one.',
        )
        .addToggle((t) =>
          t
            .setValue(this.plugin.data.syncObsidian === true)
            .onChange(async (v) => {
              this.plugin.data.syncObsidian = v;
              await this.plugin.save();
            }),
        );

      // The delay is said out loud, because a sync that happens "eventually" is one a person checks up
      // on — which costs more attention than the button it replaces. The default is `local-changes.ts`'s
      // to state, not this screen's to repeat (#238).
      new Setting(options)
        .setName('Sync after local changes')
        .setDesc(
          `Runs a sync once the vault has been still for ${Math.round(QUIET_MS / 1000)} seconds. ` +
            'Incoming changes always arrive on their own; this is for your own edits. ' +
            `Default: ${autoSyncByDefault(Platform.isMobile) ? 'on at a desk' : 'off on a phone'}.`,
        )
        .addToggle((t) =>
          t
            .setValue(this.plugin.data.autoSync ?? autoSyncByDefault(Platform.isMobile))
            .onChange(async (v) => {
              this.plugin.data.autoSync = v;
              await this.plugin.save();
            }),
        );

      // The heavy half is a window now (#163). What is left here is what somebody sets once and
      // looks for where every other plugin puts it — and one way in, so the window is findable from
      // the place people already open when they want this plugin.
      new Setting(containerEl)
        .setName('The SyncServer window')
        .setDesc('Trash and history, shared folders, vaults and devices — the lists a settings tab cannot hold.')
        .addButton((b) =>
          b
            .setButtonText('Open')
            .setCta()
            .onClick(() => void this.plugin.openWindow()),
        );

      this.passphraseSection(containerEl);
      this.recoverySection(containerEl);
      this.disconnectSection(containerEl);
      this.versionSection(containerEl);

      // Last, so the sections have registered what they own — and applied straight away,
      // because an operation may already be running when the tab is opened.
      this.surface.watch();
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
    this.plugin.pairing(pairingTarget, () => this.display());

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
      await this.plugin.pairing(pairingTarget, () => this.display()).join({
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
  private passphraseSection(host: HTMLElement): void {
    // **Open when this device is behind, folded otherwise.** Folding is right for something set once and
    // rarely revisited — but a device that has not heard the new passphrase has something to do, and a
    // thing to do hidden behind a triangle is a thing nobody does.
    const behind = this.plugin.passphraseChangedElsewhere();
    const containerEl = section(
      host,
      'Passphrase',
      behind ? 'this device is still on the old one' : 'the only thing that opens this account',
      behind,
    );

    if (behind) {
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
          this.surface.waits(b)
            .setButtonText('Catch up')
            .setCta()
            .onClick(async () => {
              if (!phrase) return void new Notice('SyncServer: the new passphrase is needed.');
              b.setDisabled(true);
              try {
                await this.plugin.account.adoptPassphrase(phrase);
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
    void this.plugin.account
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
        this.surface.waits(b)
          .setButtonText('Change the passphrase')
          .setWarning()
          .onClick(async () => {
            const wrong = whatIsWrong(draft);
            if (wrong) return void new Notice(`SyncServer: ${wrong}`, 10000);
            b.setDisabled(true);
            try {
              new Notice('SyncServer: deriving keys…');
              await this.plugin.account.changePassphrase(draft.current, draft.next);
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
  private recoverySection(host: HTMLElement): void {
    // Folded like the rest. Not opened when there is no code: that is a state, not a task — the account
    // works without one — and a section that insisted on itself every visit would be nagging rather than
    // informing. The row inside says plainly whether there is one.
    const containerEl = section(host, 'Recovery code', 'a second way in, if the passphrase is lost');
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
    void this.plugin.account
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
        const { code, replaced } = await this.plugin.account.createRecoveryCode();
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
   * Leaving the server, and saying what it will take to come back (D-113).
   *
   * Last on the screen, and behind a confirmation, because for an account whose only device
   * this is, disconnect and recovery are the same door in opposite directions: the way back
   * is the passphrase, and somebody who does not have it should learn that here rather than
   * afterwards.
   */
  private disconnectSection(host: HTMLElement): void {
    const containerEl = section(host, 'Disconnect', 'files stay, here and on the server');
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