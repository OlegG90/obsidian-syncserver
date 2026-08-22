/**
 * The gate, and the two helpers every screen that carries an action needs (#163).
 *
 * It lived in `settings.ts` because that was the only surface there was. Now that the heavy half moves
 * into a view, both surfaces hold controls the one-at-a-time gate refuses, and neither is the natural
 * owner of the rule — so it belongs to neither and to a thing they both hold.
 *
 * **It mirrors the gate; it is not the gate.** `gate.ts` stays the authority and still refuses a press
 * that slips through a redraw. What this adds is saying so *before* the press instead of after (#125),
 * which is the whole of what a disabled button with a reason above it is for.
 *
 * **Rebuilt with its surface.** A redraw throws the old elements away, so a registration held across one
 * would be disabling buttons nobody can see. Rows arrive after their network call and register
 * themselves, each taking the state at that moment rather than waiting for a sweep that has already run.
 */
import type { App, ButtonComponent } from 'obsidian';
import { busyLine } from '../gate.js';
import type SyncServerPlugin from '../main.js';

export class Surface {
  private waiting: ButtonComponent[] = [];
  private busyNote: HTMLElement | undefined;
  private unwatch: (() => void) | undefined;

  constructor(
    readonly app: App,
    readonly plugin: SyncServerPlugin,
    /** How this surface redraws itself after an act that changes what it lists. */
    readonly refresh: () => void,
  ) {}

  /** Forget the previous draw's controls. Called first thing in a redraw, before anything registers. */
  reset(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.waiting = [];
    this.busyNote = undefined;
  }

  /**
   * Where the reason appears, and it goes **above** everything it explains.
   *
   * Below the buttons it would be a line somebody reads after wondering why nothing happened.
   */
  reasonLine(host: HTMLElement): void {
    this.busyNote = host.createEl('p');
    this.busyNote.style.display = 'none';
    this.busyNote.style.color = 'var(--text-accent)';
    this.busyNote.style.fontSize = 'var(--font-ui-smaller)';
  }

  /** A control that cannot work while an operation is running. */
  waits(b: ButtonComponent): ButtonComponent {
    this.waiting.push(b);
    if (this.plugin.busyWith() !== undefined) b.setDisabled(true);
    return b;
  }

  /** Start mirroring, and apply the state straight away — an operation may already be running. */
  watch(): void {
    this.unwatch = this.plugin.watchBusy((holding) => this.showBusy(holding));
    this.showBusy(this.plugin.busyWith());
  }

  /** The surface is going away; the gate must not keep a listener writing into dead elements. */
  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }

  private showBusy(holding: string | undefined): void {
    for (const b of this.waiting) b.setDisabled(holding !== undefined);
    if (!this.busyNote) return;
    this.busyNote.setText(holding === undefined ? '' : busyLine(holding));
    this.busyNote.style.display = holding === undefined ? 'none' : '';
  }
}

/**
 * A collapsed block with a title and a one-line summary of what is inside.
 *
 * Closed by default because a surface of open sections is a wall: the summary is what somebody reads to
 * decide whether to open it, and it has to say enough to make that decision without opening.
 */
export const section = (host: HTMLElement, title: string, summary: string, open = false): HTMLElement => {
  const details = host.createEl('details');
  if (open) details.setAttribute('open', '');
  const line = details.createEl('summary');
  line.createEl('strong', { text: title });
  line.createEl('span', { text: ` — ${summary}` }).style.opacity = '0.7';
  details.style.margin = '0.75rem 0';
  const body = details.createEl('div');
  body.style.margin = '0.5rem 0 0 0.5rem';
  return body;
};
