import { Setting } from 'obsidian';
import { lastActionLine } from '../last-action.js';
import type { Connection } from '../session/session.js';
import { deviceLabel } from './device.js';
import { mib } from './format.js';
import { shortStatus } from './status.js';
import type { Surface } from './surface.js';

/**
 * What this vault's sync is doing, whose account it is, and how full — the block both surfaces open with.
 *
 * **Three facts in one place because they are asked as one question** — *is this working?* — and they
 * were three rows down three separate parts of the screen (#130). The usage bar is drawn rather than
 * written because "how close am I" is the only thing anybody wants from it, and a percentage makes that
 * a subtraction.
 *
 * It lived in the settings tab, which was fine while that was the only place anything happened. It is
 * not fine now: the window can be opened from the ribbon or a command and read on its own, and a panel
 * of lists with nothing above it does not say whose account it lists, on which server, or whether the
 * sync works at all. Somebody who closed the settings tab was left with rows and no context.
 *
 * **One block rather than two that agree today.** These are the same facts wherever they are read; a
 * second copy is a second wording waiting to happen, which is what the device row did while nobody was
 * looking.
 *
 * It takes a `Surface` and not the plugin because it carries a control the one-at-a-time gate refuses —
 * Sync now — and the gate belongs to whichever surface is drawing.
 *
 * **Identity as one line, not a table**: it is a thing to recognise, not to read. The vault id is
 * shortened for the same reason — nobody compares thirty-six characters.
 */
export const statusHeader = (containerEl: HTMLElement, s: Surface, conn: Connection): void => {
  const plugin = s.plugin;
  const header = containerEl.createEl('div');
  header.style.margin = '0 0 1rem';

  const phase = header.createEl('p');
  phase.style.fontWeight = 'bold';
  phase.style.margin = '0 0 0.25rem';

  // The last thing said, with the time. A notice has gone by the time somebody looks up, and
  // "did that work?" is the question it leaves behind (#130).
  //
  // **Always created, shown only when there is something to show.** It used to exist only if there was
  // a line at the moment of the draw, which meant the screen that had just done something could not
  // grow one — and the press somebody was waiting on is exactly when the first line appears (#233).
  const line = header.createEl('p');
  line.style.fontSize = 'var(--font-ui-smaller)';
  line.style.opacity = '0.8';
  line.style.margin = '0 0 0.5rem';

  /**
   * Both lines, from whatever is true now.
   *
   * Called on every phase change, which is what makes this header answer the button beside it. Pressing
   * **Sync now** here used to leave `Sync: locked` on screen through the sync that unlocked the vault:
   * the status bar and the ribbon were told, and both are behind this modal.
   */
  const paint = (): void => {
    phase.setText(shortStatus(plugin.phaseNow()));
    const said = lastActionLine(plugin.lastAction());
    line.setText(said ?? '');
    line.style.display = said ? '' : 'none';
  };
  paint();
  s.whileDrawn(plugin.watchPhase(() => paint()));

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

  void plugin
    // Only reads, so `done` never fires — but it is bound to the surface asking anyway rather than to a
    // no-op: a no-op is correct until somebody adds an act here, and then it is silently wrong.
    .history(() => s.refresh())
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
      s.waits(b)
        .setButtonText('Sync now')
        .setCta()
        .onClick(() => void plugin.syncNow()),
    );
};
