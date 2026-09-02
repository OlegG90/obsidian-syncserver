/**
 * The one surface a phone has for a long pass, and the rules that keep it from being a nuisance (#320).
 *
 * `addStatusBarItem` says "Not available on mobile" in Obsidian's own API, and the ribbon on a phone
 * is an action sheet rather than something on screen. So a notice is the only place a person holding a
 * phone can learn that the first upload of their vault is a third of the way through — which is the
 * case this exists for, and very nearly the only one.
 *
 * Three rules, and each of them is a way this feature could have been an irritant instead:
 *
 * - **Nothing until the pass has earned it.** `pass-progress.ts` holds the threshold; a pass that
 *   finishes under it is never mentioned at all. Automatic sync runs after every settling of the
 *   vault, so without this the notice would flash on every save somebody makes.
 * - **One notice, updated in place.** `Notice.setMessage` exists for this. A notice per update would
 *   stack a thousand toasts up the side of the screen for a vault of a thousand files.
 * - **Dismissible, and it stays dismissed.** A person who does not want to watch a ten-minute upload
 *   taps it away, and it does not come back for that pass. Keyed on `startedAt`, so the next pass
 *   starts with a clean slate rather than inheriting somebody's impatience from an hour ago.
 *
 * The `Notice` itself is behind `NoticeSurface` so the rules above can be tested without Obsidian.
 * What is left on the other side is a constructor call and `hide()`.
 */
import { counterText, displayFor } from './pass-progress.js';
import type { SyncPhase } from './obsidian/status.js';

export interface NoticeSurface {
  /** Put this line on screen, creating the notice if there is not one yet, updating it if there is. */
  show(text: string): void;
  /** Take it away. Called when there is nothing to say, and again when the plugin unloads. */
  hide(): void;
}

export interface PassNotice {
  /** A phase arrived, or the ticker asked again. Cheap, and safe to call at any rate. */
  onPhase(phase: SyncPhase): void;
  /** The person tapped it away: say nothing more about THIS pass. */
  dismiss(): void;
  /** The plugin is unloading. */
  stop(): void;
}

export const openPassNotice = (deps: { surface: NoticeSurface; now(): number }): PassNotice => {
  /** The pass a notice is currently on screen for, by `startedAt`. */
  let showing: number | undefined;
  /** The pass the person told us to be quiet about. */
  let dismissed: number | undefined;

  const clear = (): void => {
    if (showing === undefined) return;
    showing = undefined;
    deps.surface.hide();
  };

  return {
    onPhase: (phase) => {
      if (phase.kind !== 'syncing' || !phase.progress) return clear();

      const { startedAt } = phase.progress;
      if (dismissed === startedAt) return;

      const display = displayFor(phase.progress, deps.now());
      if (display.kind === 'quiet') return clear();

      showing = startedAt;
      deps.surface.show(`SyncServer: syncing… ${counterText(display)}`);
    },

    dismiss: () => {
      // The pass on screen, not the pass running: they are the same thing whenever there is anything
      // to dismiss, and reading it off `showing` means this needs no argument and cannot be given a
      // wrong one.
      dismissed = showing;
      clear();
    },

    stop: clear,
  };
};
