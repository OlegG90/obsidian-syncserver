/**
 * The window this plugin never had (#163).
 *
 * Everything heavy lived in a `PluginSettingTab`, which is **a list of rows**: it was never a place for
 * a table, a filter, a revision list beside a row rather than under it, or a multi-step act. D-116
 * settled that the heavy half cannot move to a browser either — a page the server serves holds no keys,
 * so it can show `name_enc` and never a name. What it can have is a better room.
 *
 * **One view with sections, not a view per subject.** Four views would put four icons in the ribbon and
 * four copies of the same three things — the gate, the session, and what to say when the vault is gone —
 * in four places. One view keeps them in one, and a command per section still opens directly where
 * somebody meant to go.
 *
 * **The section is remembered on the instance and not persisted.** Reopening the window where it was left
 * is convenient; a setting for it would be a fifth thing to keep in `data.json` that nobody chose.
 *
 * **On a phone** the sections stack in one column and a detail is a modal rather than a side pane. That
 * is not a media query — the panels are single-column everywhere, because a plugin that has already been
 * surprised once by a phone (docs/02: the status bar does not render there at all) should not carry two
 * layouts and discover the second one in the field.
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type SyncServerPlugin from '../main.js';
import { Panels } from './panels.js';
import { statusHeader } from './status-header.js';
import { Surface } from './surface.js';

export const SYNCSERVER_VIEW = 'syncserver-view';

/** The sections, in the order somebody is likeliest to want them. */
export const SECTIONS = ['trash', 'shares', 'vaults', 'devices'] as const;
export type SectionName = (typeof SECTIONS)[number];

const TITLES: Record<SectionName, string> = {
  trash: 'Trash and history',
  shares: 'Shared folders',
  vaults: 'Vaults',
  devices: 'Devices',
};

export class SyncServerView extends ItemView {
  private readonly surface: Surface;
  private readonly panels: Panels;
  private current: SectionName = 'trash';

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: SyncServerPlugin,
  ) {
    super(leaf);
    this.surface = new Surface(this.app, plugin, () => this.draw());
    this.panels = new Panels(this.surface);
  }

  getViewType(): string {
    return SYNCSERVER_VIEW;
  }

  getDisplayText(): string {
    return `SyncServer — ${TITLES[this.current]}`;
  }

  override getIcon(): string {
    return 'refresh-cw';
  }

  /** Open the window already on the section a command asked for, rather than on the last one. */
  show(section: SectionName): void {
    this.current = section;
    this.draw();
  }

  override async onOpen(): Promise<void> {
    this.draw();
  }

  override async onClose(): Promise<void> {
    this.surface.stop();
  }

  private draw(): void {
    const host = this.contentEl;
    host.empty();
    this.surface.reset();

    if (!this.plugin.data.connection) {
      // Nothing here means anything without a connection, and the place to make one is the settings
      // tab — said rather than shown as an empty list somebody would take for "you have none".
      host.createEl('p', {
        text: 'This vault is not connected to a server yet. Settings → SyncServer to connect.',
      });
      return;
    }

    // **What this window is looking at, before what it lists.** The same block the settings tab opens
    // with, and the reason it is here: this view can be opened from the ribbon or a command and read on
    // its own, and a panel of lists with nothing above them does not say whose account it lists, on
    // which server, or whether the sync is working at all.
    statusHeader(host, this.surface, this.plugin.data.connection);

    const tabs = host.createEl('div');
    tabs.style.display = 'flex';
    tabs.style.gap = '0.25rem';
    tabs.style.flexWrap = 'wrap';
    tabs.style.margin = '0 0 0.75rem';
    for (const name of SECTIONS) {
      const b = tabs.createEl('button', { text: TITLES[name] });
      if (name === this.current) b.addClass('mod-cta');
      b.onclick = (): void => {
        this.current = name;
        // The leaf's title carries the section, so the tab strip says where somebody is without
        // needing the window itself to be visible.
        this.leaf.setViewState({ type: SYNCSERVER_VIEW, active: true }).catch(() => undefined);
        this.draw();
      };
    }

    // Above the panel, for the reason `Surface` gives: a reason read after wondering why nothing
    // happened is a reason that arrived too late.
    this.surface.reasonLine(host);

    const body = host.createEl('div');
    if (this.current === 'trash') this.panels.trashSection(body);
    else if (this.current === 'shares') this.panels.shareSection(body);
    else if (this.current === 'vaults') this.panels.vaultSection(body);
    else this.panels.approveSection(body);

    this.surface.watch();
  }
}
