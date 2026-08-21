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
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { whatIsMissing, type ConnectDraft } from '../connect-form.js';
import { newestFirst } from '../history-flow.js';

import { SyncClient } from '../api/client.js';
import { transport } from './net.js';
import { newPairingCode } from '../crypto/pairing-code.js';
import { installWarning, PLUGIN_VERSION, versionWarning } from '../version.js';
import { ConfirmModal } from './modals.js';
import type SyncServerPlugin from '../main.js';
import type { ShareFlow, ShareRow } from '../share-flow.js';

/** Bytes as something a person reads. Mebibytes throughout, because quotas are set in them. */
const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export class SyncServerSettings extends PluginSettingTab {
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
      this.trashSection(containerEl);
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

    const draft: ConnectDraft = { serverUrl: '', login: '', token: '', passphrase: '', again: '' };

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

    /**
     * The second field, which exists for one route and is drawn for all of them.
     *
     * Beside the first, because that is where a person proofreads: putting it inside the claim
     * row would separate the two halves of one act by the width of the other two routes. It
     * says whose question it is, so nobody pairing a phone wonders whether they have to.
     */
    new Setting(containerEl)
      .setName('Passphrase again')
      .setDesc('For a new account only: a typo here becomes that account’s passphrase for good, and nobody can reset it.')
      .addText((t) => {
        t.inputEl.type = 'password';
        secrets.push(t.inputEl);
        t.onChange((v) => (draft.again = v));
      });

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
            const need = whatIsMissing(draft, 'claim');
            if (need) return void new Notice(`SyncServer: ${need}`, 10000);
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
    // Re-bind the held pairing flow to THIS element on every display: the tab was rebuilt,
    // and a live pairing's code and cancel button must be drawn back in (pairing-flow is
    // held by the plugin precisely so a rebuild does not orphan the wait it began).
    this.plugin.pairing(shown);
    new Setting(containerEl)
      .setName('Add this device to an account')
      .setDesc('Shows a code to type on a device that is already connected. It seals the account key to this one.')
      .addButton((b) =>
        b.setButtonText('Show pairing code').onClick(async () => {
          const need = whatIsMissing(draft, 'pair');
          if (need) return void new Notice(`SyncServer: ${need}`, 8000);
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
            const need = whatIsMissing(draft, 'recover');
            if (need) return void new Notice(`SyncServer: ${need}`, 8000);
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
        b.setButtonText('Share').onClick(async () => {
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
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.plugin.history();

    const usage = containerEl.createEl('p');
    usage.style.fontSize = 'var(--font-ui-smaller)';
    void flow.usage().then((u) => {
      if (!u) return;
      const pct = u.quota > 0 ? Math.round((u.used / u.quota) * 100) : 0;
      // Marked on being OVER the limit, not on being frozen. They are not the same state and
      // the difference cost a live walk: the freeze flag is raised where somebody else's
      // write crosses your boundary, so an account syncing on its own can sit at 210% with
      // `frozen` false for ever. A number that says 210% and looks like every other line
      // tells a person nothing is wrong.
      const over = u.used > u.quota;
      usage.setText(
        `Using ${mib(u.used)} of ${mib(u.quota)} (${pct}%)` +
          (over ? ' — over the limit. Discarding from the trash is what frees space.' : ''),
      );
      if (over) usage.style.color = 'var(--text-error)';
    });

    void flow.trash().then((page) => {
      list.empty();
      if (!page) {
        list.createEl('p', { text: 'The trash could not be read.' });
        return;
      }
      const rows = page.rows;
      if (page.total === 0) {
        list.createEl('p', { text: 'Nothing has been deleted.' });
        return;
      }

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
          b.setButtonText(row.versions === 1 ? 'Restore' : 'Restore…').onClick(async () => {
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
                  r
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
          b
            .setButtonText('Discard')
            .setWarning()
            .onClick(() => void flow.discard(row.nodeId, row.name)),
        );
      }

      // Said rather than left to be inferred: the list is a page, and the button below it is
      // not. A screen that showed 200 rows and then discarded 3,000 would be telling the
      // truth twice and lying once.
      if (page.total > rows.length) {
        const more = list.createEl('p', {
          text: `Showing the ${rows.length} most recently deleted of ${page.total}.`,
        });
        more.style.fontSize = 'var(--font-ui-smaller)';
      }

      new Setting(list)
        .setName('Empty the trash')
        .setDesc(
          'Discards every deleted file and all of its history, for good. This is the only ' +
            'action that lowers what the account is using.',
        )
        .addButton((b) =>
          b
            .setButtonText('Empty')
            .setWarning()
            .onClick(() => void flow.empty(page.total)),
        );
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
            'Disconnect',
          ).open();
        }),
    );
  }
}