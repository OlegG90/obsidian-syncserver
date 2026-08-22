/**
 * The screens that are tables, lists and multi-step acts — the half a `PluginSettingTab` was never for.
 *
 * D-116 settled why they cannot leave the plugin at all: a page the server serves holds no keys, so it
 * can show `name_enc` and never a name. The heavy half stays where the seed is; what it gets is a better
 * room (#163). These are the panels that room hosts, and the settings tab keeps only what somebody sets
 * once and looks for where every other plugin puts it.
 *
 * Each takes a host element and draws into it. They share one `Surface`, which owns the gate — a panel
 * registering a control is the same act wherever the panel is drawn, and that was the part with nowhere
 * to live while the tab was the only surface.
 */
import { ButtonComponent, Notice, Setting } from 'obsidian';
import { newestFirst } from '../history-flow.js';
import { matching, showing } from '../trash-filter.js';
import { removalWarning } from '../vault-removal.js';
import { deviceLabel } from './device.js';
import { mib } from './format.js';
import { section, type Surface } from './surface.js';
import { ConfirmModal } from './modals.js';
import type { ShareFlow, ShareRow } from '../share-flow.js';

/**
 * A list the server has to answer before it can be drawn (#182).
 *
 * The vault list and the device list had this shape each, written out twice: a placeholder while the
 * network call is out, empty the placeholder and draw rows, a line for the empty case, and one sentence
 * if the call fails. Two copies of a shape is two places to remember when the shape changes — and it did
 * change, twice, once for what a row says about a vault and once for how fresh `last_seen_at` is.
 *
 * **The placeholder is not decoration.** Both lists arrive over the network after the surface is drawn,
 * and a section that renders empty for a moment is one somebody reads as "you have none".
 *
 * **A failure is a sentence and not an empty list**, for the same reason: "the list could not be read"
 * and "there is nothing in it" are different facts, and only one of them is worth acting on.
 */
const asked = <T>(
  host: HTMLElement,
  what: string,
  fetch: () => Promise<readonly T[]>,
  row: (item: T, list: HTMLElement) => void,
  empty?: string,
): HTMLElement => {
  const list = host.createEl('div');
  list.createEl('p', { text: 'Asking the server…', cls: 'setting-item-description' });
  void fetch()
    .then((items) => {
      list.empty();
      for (const item of items) row(item, list);
      if (items.length === 0 && empty) list.createEl('p', { text: empty });
    })
    .catch(() => list.setText(`The ${what} could not be read.`));
  return list;
};

export class Panels {
  constructor(private readonly s: Surface) {}

  /**
   * On a device that already holds the seed: take the code from the one that does not.
   *
   * This is the half of pairing that needs the seed, which is why it lives only here and
   * why it may ask for the passphrase — the same question a sync asks, for the same reason.
   */
  approveSection(host: HTMLElement): void {
    // Summarised by the count now that there is one to count (#156). It was summarised by the ACT —
    // "add another device" — because nothing asked the server for the account's devices and a row
    // promising "mbp-14, iphone" would have been inventing them. The list is what changed, not the taste.
    const containerEl = section(host, 'Devices', 'what can reach this account, and adding another');
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
          await this.s.plugin.pairing(containerEl).approve(code);
        } finally {
          b.setDisabled(false);
        }
      }),
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
  vaultSection(host: HTMLElement): void {
    const containerEl = section(host, 'Vaults', 'what this account holds, beyond this one');
    asked(
      containerEl,
      'vault list',
      () => this.s.plugin.vaults(),
      (v, list) => {
        // What it is USING, not only how many rows it has (#178) — which is the number somebody reads
        // when they are deciding which vault to remove to make room.
        const held = v.nodes === 0 ? 'empty' : `${v.nodes} item${v.nodes === 1 ? '' : 's'}, ${mib(v.bytes)}`;
        const row = new Setting(list)
          .setName(v.current ? `${v.name} — this device` : v.name)
          .setDesc(`${held} · ${v.id.slice(0, 8)}…`);

        if (v.current) return;
        if (v.shared) {
          // Before the act, not after it (#176). This refusal used to arrive as `named_by_a_share` once
          // somebody had already read a confirmation promising that nothing would be lost — and what a
          // share holds is other people's access, which is not this account's to tidy away.
          row.setDesc(`${held} · ${v.id.slice(0, 8)}… — a share names this vault, so it stays`);
          return;
        }
        row.addButton((b) =>
          this.s
            .waits(b)
            .setButtonText('Remove')
            .setWarning()
            .onClick(() => {
              new ConfirmModal(
                this.s.app,
                `Remove ${v.name}?`,
                removalWarning(v.nodes),
                async () => {
                  try {
                    await this.s.plugin.deleteVault(v.id);
                    new Notice(`SyncServer: ${v.name} was removed.`);
                    this.s.refresh();
                  } catch (e) {
                    new Notice(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
                  }
                },
                'Remove',
              ).open();
            }),
        );
      },
    );
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
  deviceList(containerEl: HTMLElement): void {
    asked(
      containerEl,
      'device list',
      () => this.s.plugin.devices(),
      (d, list) => {
        const when = d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'not since it was added';
        const row = new Setting(list)
          .setName(d.current ? `${d.name} — this device` : d.name)
          // As fresh as the access token's lifetime and no fresher (D-118): written on every refresh,
          // never per request. Labelled as such rather than made to sound more precise than it is.
          .setDesc(`${d.platform} — last seen ${when}`);

        if (d.current) {
          row.addExtraButton((b) => b.setIcon('check').setTooltip('Disconnect removes this one').setDisabled(true));
          return;
        }
        row.addButton((b) =>
          this.s
            .waits(b)
            .setButtonText('Revoke')
            .setWarning()
            .onClick(() => {
              new ConfirmModal(
                this.s.app,
                `Revoke ${d.name}?`,
                'It stops syncing at once and cannot sign in again. Nothing on it is deleted — the files it ' +
                  'already holds stay where they are, and this account simply stops answering it.',
                async () => {
                  await this.s.plugin.revokeDevice(d.id);
                  new Notice(`SyncServer: ${d.name} can no longer reach this account.`, 8000);
                  this.s.refresh();
                },
                'Revoke',
              ).open();
            }),
        );
      },
      'No devices — which should be impossible from one.',
    );
  }

  /**
   * Folders shared with other people, and the invitations waiting for an answer.
   *
   * Drawn from what the server says rather than from anything remembered: a share can be
   * ended by somebody else while this screen is closed, and a list rebuilt from a cache
   * would offer actions on something that is already gone.
   */
  shareSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Shared folders' });
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.s.plugin.sharing();
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
          this.s.waits(b)
            .setButtonText('Accept')
            .setCta()
            .onClick(() => void flow.accept(inv.shareId)),
        );
        row.addButton((b) => this.s.waits(b).setButtonText('Decline').onClick(() => void flow.decline(inv.shareId)));
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
            this.s.waits(b)
              .setButtonText('Invite')
              .onClick(() => void flow.invite(share.shareId, login)),
          );
        }
        // Leaving is everybody's, the initiator included — for them it ends the share, and
        // the coordinator says which happened rather than guessing here.
        row.addButton((b) =>
          this.s.waits(b)
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
              this.s.waits(b)
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
  shareControl(host: HTMLElement, flow: ShareFlow, joined: readonly ShareRow[]): void {
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
        this.s.waits(b)
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
  trashSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Trash and history' });

    // The filter is drawn before the listing arrives and stays put while it does: a control
    // that appears when the data does is one somebody has already started typing past.
    let query = '';
    const search = new Setting(containerEl)
      .setName('Find')
      .setDesc('Searches what this page carried, which is the most recently deleted — not the whole trash.');

    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.s.plugin.history();

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
          this.s.waits(b)
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
                    this.s.waits(r)
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
          this.s.waits(b)
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
          this.s.waits(b)
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
  resetSection(containerEl: HTMLElement): void {
    const body = section(containerEl, 'Replace what the server holds', 'when this copy is the right one');
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
        this.s.waits(b)
          .setButtonText('Reset the server’s copy')
          .setWarning()
          .onClick(() => {
            new ConfirmModal(
              this.s.app,
              'Replace the server’s copy with this one?',
              'The server keeps nothing of what it holds for this vault except shared folders. Your other ' +
                'devices keep their files — anything this copy lacks is set aside on those devices rather ' +
                'than removed. This device then uploads everything, which can take a while.',
              // Everything past the question belongs to the flow: what it says, when the state may be
              // forgotten, and which of the two acts holds the gate (`reset-flow.ts`).
              async () => {
                await this.s.plugin.reset().start();
              },
              'Reset it',
            ).open();
          }),
      );
  }
}
