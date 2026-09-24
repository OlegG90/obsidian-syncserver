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
import { ButtonComponent, Notice, Setting, TextComponent } from 'obsidian';
import { newestFirst } from '../history-flow.js';
import { matching, showing } from '../trash-filter.js';
import { removalWarning } from '../vault-removal.js';
import { deviceLabel } from './device.js';
import { askDeviceName } from './modals.js';
import { deviceName } from '../device-name.js';
import { seenLine, seenNote } from '../seen.js';
import { mib } from './format.js';
import { section, type Surface } from './surface.js';
import { ConfirmModal } from './modals.js';
import type { ShareFlow, ShareRow } from '../share-flow.js';
import { groupShares, memberState, peopleLine, whose } from '../share-list.js';
import type { ShareMember } from '../api/client.js';
import { errorText } from '../error-text.js';
import type { OwnDeviceRow } from '@syncserver/shared';

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

/** A run of secondary text inside a line — `setting-item-description` is a block, and this is not. */
const muted = (host: HTMLElement, text: string): HTMLElement => {
  const span = host.createSpan({ text });
  span.style.cssText = 'color: var(--text-muted); font-size: var(--font-ui-smaller);';
  return span;
};

/** One vault as the account asks list it. */
type VaultEntry = { id: string; name: string; nodes: number; bytes: number; shared: boolean; current: boolean };

/** A vault and the devices syncing it — or, with no vault, the devices whose vault is not known yet (#364). */
type VaultGroup = { vault: VaultEntry | undefined; devices: OwnDeviceRow[] };

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
    // The devices themselves are listed under the vault each one syncs (#364); what is left here is the
    // one device act that belongs to the account rather than to a vault — letting another one in.
    const containerEl = section(host, 'Add a device', 'approving another device into this account');
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
          await this.s.plugin.pairing(containerEl, () => this.s.refresh()).approve(code);
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
   * mistake** stays invisible, which is the thing issue #117 exists because of.
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
    const containerEl = section(host, 'Vaults', 'what this account holds, and the devices syncing each');
    asked(
      containerEl,
      'vault list',
      async (): Promise<VaultGroup[]> => {
        // Both lists, with each device put under the vault it syncs (#364, D-139). A device the server has
        // not yet seen open its vault — not opened since the server started asking — is grouped on its own
        // rather than guessed at.
        const [vaults, seen] = await Promise.all([this.s.plugin.account.vaults(), this.s.plugin.account.devices()]);
        const { devices } = seen;
        this.seenWithinSeconds = seen.seenWithinSeconds;
        const known = new Set(vaults.map((v) => v.id));
        const groups: VaultGroup[] = vaults.map((v) => ({ vault: v, devices: devices.filter((d) => d.vault_id === v.id) }));
        const unplaced = devices.filter((d) => !d.vault_id || !known.has(d.vault_id));
        if (unplaced.length > 0) groups.push({ vault: undefined, devices: unplaced });
        return groups;
      },
      (group, list) => {
        // **Read before anything is appended.** Both decisions below turn on "is this the first
        // group", and the note is itself an element: asking the list again after adding it would
        // put a separator above the first vault, which is exactly what the separator is not for.
        const first = list.childElementCount === 0;
        // Said once, above the first vault: every row below carries a reading whose freshness is
        // the session's, not the sync's (#386), and a row that says "seen in the last 15 minutes"
        // without that sentence still invites "why is it not syncing now".
        if (first) list.createEl('p', { cls: 'setting-item-description', text: seenNote(this.seenWithinSeconds) });
        // A line above every vault but the first: without it one vault's devices run straight into the next
        // vault's heading, and the whole section reads as a single list.
        if (!first) list.createEl('hr');
        if (group.vault) this.vaultRow(group.vault, list);
        else {
          new Setting(list)
            .setName('Vault not known yet')
            .setDesc('Devices that have not opened their vault since the server started keeping track. Each finds its place the next time it syncs.')
            .setHeading();
        }
        for (const d of group.devices) this.deviceRow(d, list);
      },
    );
  }

  /** One vault: what it holds, and removing it when it is not this device's own (#157, #178). */
  private vaultRow(v: VaultEntry, list: HTMLElement): void {
    // What it is USING, not only how many rows it has (#178) — which is the number somebody reads
    // when they are deciding which vault to remove to make room.
    const held = v.nodes === 0 ? 'empty' : `${v.nodes} item${v.nodes === 1 ? '' : 's'}, ${mib(v.bytes)}`;
    const row = new Setting(list)
      .setName(v.current ? `${v.name} — this device` : v.name)
      .setDesc(`${held} · ${v.id.slice(0, 8)}…`)
      .setHeading();

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
                const { thawed, revoked } = await this.s.plugin.account.deleteVault(v.id);
                // The sentence somebody who removed a vault to make room is waiting for (#247).
                // Said only when it is true: an account that was never frozen has nothing to hear,
                // and "and you are not over your limit" would be noise on every ordinary removal.
                const gone = revoked > 0 ? ` ${revoked} device${revoked === 1 ? '' : 's'} syncing it can no longer reach this account.` : '';
                new Notice(
                  thawed
                    ? `SyncServer: ${v.name} was removed — that freed enough, and the account is accepting writes again.${gone}`
                    : `SyncServer: ${v.name} was removed.${gone}`,
                  thawed || revoked > 0 ? 10000 : undefined,
                );
                this.s.refresh();
              } catch (e) {
                new Notice(`SyncServer: ${errorText(e)}`, 10000);
              }
            },
            'Remove',
          ).open();
        }),
    );
  }

  /**
   * How stale `last_seen_at` may be, as the server states it with the list (#386).
   *
   * Held on the panel rather than passed down every call: it describes the list, the rows are
   * drawn from that same answer, and the default is the server's own so a row drawn before the
   * list arrives still words itself sensibly.
   */
  private seenWithinSeconds = 15 * 60;

  /**
   * One device, under the vault it syncs: renaming it, and taking it away (#156, #356, #364).
   *
   * The gap #156 closed is not cosmetic: `POST /auth/devices` and `DELETE /auth/devices/:id` both existed,
   * and **nothing listed them** — so the only device anybody could revoke was the one they were sitting at.
   * A phone left in a taxi stayed authorised for ever.
   *
   * **This device is marked and cannot be revoked from here.** Revoking it would kill the refresh token
   * under a plugin that still believes it is connected, and the failure would arrive at the next unlock
   * as something unrelated. Disconnect is the act that means "this one", and it says what it keeps.
   */
  private deviceRow(d: OwnDeviceRow, list: HTMLElement): void {
    const row = new Setting(list)
      .setName(d.current ? `↳ ${d.name} — this device` : `↳ ${d.name}`)
      // **An interval, not an instant** (#386). The column is written on a refresh and never per
      // request (D-118), so it is the token's lifetime stale at worst — and a timestamp to the
      // second invited the reader to take it literally, which is how a device that was syncing
      // came to be read as one that had gone quiet.
      .setDesc(`${d.platform} — ${seenLine(d.last_seen_at, this.seenWithinSeconds)}`);
    if (d.last_seen_at) row.settingEl.title = new Date(d.last_seen_at).toLocaleString();

    // On every row, this one included: a name is how a person tells the rows apart, and changing one
    // changes nothing about what the device may do (#356).
    row.addExtraButton((b) =>
      b
        .setIcon('pencil')
        .setTooltip('Rename')
        .onClick(async () => {
          const typed = await askDeviceName(this.s.app, d.name);
          if (typed === undefined) return;
          const name = deviceName(typed, d.name);
          if (name === d.name) return;
          try {
            await this.s.plugin.account.renameDevice(d.id, name);
            this.s.refresh();
          } catch (e) {
            new Notice(`SyncServer: ${errorText(e)}`, 10000);
          }
        }),
    );

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
              await this.s.plugin.account.revokeDevice(d.id);
              new Notice(`SyncServer: ${d.name} can no longer reach this account.`, 8000);
              this.s.refresh();
            },
            'Revoke',
          ).open();
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
  shareSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Shared folders' });
    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.s.plugin.sharing(() => this.s.refresh());
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
          .setDesc('Accepting materialises a copy in this vault and syncs it down straight away.');
        row.addButton((b) =>
          this.s.waits(b)
            .setButtonText('Accept')
            .setCta()
            .onClick(() => void flow.accept(inv)),
        );
        row.addButton((b) => this.s.waits(b).setButtonText('Decline').onClick(() => void flow.decline(inv.shareId)));
      }

      // The parent said once, above its folders (#428). The top of the vault has no heading, and
      // neither do shares not synced here: their line already says so.
      for (const group of groupShares(out.joined)) {
        if (group.parent) {
          const heading = list.createDiv({ text: `${group.parent}/` });
          heading.style.cssText = 'margin-top: 0.75em; color: var(--text-muted); font-size: var(--font-ui-smaller);';
        }
        for (const { row, name } of group.shares) this.shareEntry(list, flow, row, name);
      }
    });
  }

  /**
   * The shares open in this view. Every act on one — an invitation, a revocation — redraws the
   * whole list, and a list that snapped shut after each would send a person looking for the share
   * they were just working in (#428).
   */
  private readonly openShares = new Set<string>();

  /**
   * One share: a line that says which folder, whose, and how many hold it, opening onto who they
   * are and what can be done (#428).
   *
   * **None of it is `Setting`.** `Setting` lays text and controls out in one row, sized for the
   * settings tab; in this sidebar leaf a text field and two buttons took the whole 336px and
   * squeezed the folder's name to a column zero pixels wide. Its rows are also a settings row's
   * height, which is how three shares came to fill several screens.
   */
  private shareEntry(list: HTMLElement, flow: ShareFlow, share: ShareRow, name: string): void {
    const ended = share.state !== 'active';
    const entry = list.createEl('details');
    // An ended share is open from the start: finishing the departure is still owed.
    entry.open = ended || this.openShares.has(share.shareId);
    entry.addEventListener('toggle', () => {
      if (entry.open) this.openShares.add(share.shareId);
      else this.openShares.delete(share.shareId);
    });

    const line = entry.createEl('summary');
    line.style.cssText = 'cursor: pointer; padding: 0.2em 0;';
    if (share.folder) line.title = share.folder;
    line.createSpan({ text: name });
    const about = muted(line, '');
    // Said before the members are read, and again once they are: whose it is does not wait on
    // the network, and the count cannot be had without it.
    const say = (members?: readonly ShareMember[]): void => {
      const parts = [ended ? 'ended' : whose(share, members)];
      if (members) parts.push(peopleLine(members));
      about.setText(` · ${parts.join(' · ')}`);
    };
    say();
    if (ended) about.style.color = 'var(--text-warning)';

    const body = entry.createDiv();
    body.style.cssText =
      'margin: 0.25em 0 0.75em 0.5em; padding-left: 0.75em; border-left: 1px solid var(--background-modifier-border);';
    if (ended) muted(body.createDiv(), 'This share is over — finish leaving to return the folder to your own key.');
    const people = body.createDiv();
    const actions = body.createDiv();
    actions.style.cssText = 'display: flex; flex-wrap: wrap; gap: 0.5em; margin-top: 0.5em;';

    if (share.isInitiator) {
      // The field only when it is wanted: shown on every share, it was a full row under each.
      const form = body.createDiv();
      form.style.cssText = 'display: none; gap: 0.5em; margin-top: 0.5em;';
      let login = '';
      const field = new TextComponent(form).setPlaceholder('login to invite').onChange((v) => (login = v));
      const send = (): void => void flow.invite(share.shareId, login);
      field.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') send();
      });
      this.s.waits(new ButtonComponent(form)).setButtonText('Invite').setCta().onClick(send);
      new ButtonComponent(actions).setButtonText('+ Invite').onClick(() => {
        form.style.display = form.style.display === 'none' ? 'flex' : 'none';
        if (form.style.display === 'flex') field.inputEl.focus();
      });
    }
    // Leaving is everybody's, the initiator included — for them it ends the share, and the
    // coordinator says which happened rather than guessing here.
    this.s
      .waits(new ButtonComponent(actions))
      .setButtonText('Leave')
      .setWarning()
      .onClick(() => void flow.leave(share.shareId));

    // Who is in it. Shown for everybody and not only the initiator: "who can read this folder" is
    // the question a shared folder raises, and a participant who cannot answer it is being asked
    // to trust a list they never see.
    void flow.members(share.shareId).then((members) => {
      // Said, not left blank. An empty list under a shared folder reads as "nobody is in it",
      // which is a worse claim than an error (#387).
      if (!members) {
        muted(people.createDiv(), 'Who is in this folder could not be read.');
        return;
      }
      say(members);
      for (const m of members) {
        const who = people.createDiv();
        who.style.cssText = 'display: flex; align-items: center; gap: 0.5em; min-height: 1.8em;';
        const text = who.createDiv();
        text.style.flex = '1';
        text.createSpan({ text: m.login });
        muted(text, ` · ${memberState(m)}`);

        // Only the initiator may remove, and never themselves: their way out is Leave, which ends
        // the share, and offering both would be offering the same act twice under two names.
        if (!share.isInitiator || m.is_initiator || m.finalizing) continue;
        const act = m.joined_at ? 'Revoke' : 'Withdraw';
        // An icon is a small target, so it asks first — a misclick here stops somebody's copy
        // receiving anything further.
        this.s
          .waits(new ButtonComponent(who))
          .setIcon('user-minus')
          .setTooltip(act)
          .setClass('clickable-icon')
          .onClick(() =>
            new ConfirmModal(
              this.s.app,
              m.joined_at ? `Revoke ${m.login}?` : `Withdraw the invitation to ${m.login}?`,
              m.joined_at
                ? 'Nothing further in this folder reaches them. The copy they already hold stays theirs.'
                : 'Nothing has been sent to them yet; the invitation simply goes.',
              () => flow.remove(share.shareId, m.user_id, m.login),
              act,
            ).open(),
          );
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

    // Where the Empty button goes, claimed BEFORE the listing so it lands above it. The trash
    // grows with ordinary editing, and an action that applies to the whole of it does not
    // belong past a scroll of the part of it that fits — the longer the list, the further the
    // one control that acts on all of it used to run away.
    const emptyHere = containerEl.createEl('div');

    const list = containerEl.createEl('div');
    list.createEl('p', { text: 'Loading…' });

    const flow = this.s.plugin.history(() => this.s.refresh());

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
       * Above the listing, and outside the redraw.
       *
       * It discards **everything the server holds**, not what is on screen — and a filtered
       * list is the one moment somebody could read it as "empty these". Sitting outside the
       * redraw is also what keeps its count honest: `page.total`, never the rows in front of
       * it (the screen that showed 200 rows and discarded 3,000 was telling the truth twice
       * and lying once).
       *
       * It used to be appended after the rows, which put it past however much trash ordinary
       * editing had accumulated. Pressing it is guarded by a confirmation naming the count, so
       * the reachable position costs nothing.
       */
      new Setting(emptyHere)
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
                await this.s.plugin.reset(() => this.s.refresh()).start();
              },
              'Reset it',
            ).open();
          }),
      );
  }
}
