/**
 * The pairing screen: a code to read off, a way to carry it, and the line underneath.
 *
 * The flow that decides *what* to show is `pairing-flow.ts`; this is the drawing, and it lived in
 * `main.ts` because that is where the plugin holds the element a surface hands it. Fifteen other
 * surfaces live here, and every `createEl` in the composition root belonged to this one screen.
 *
 * It owns the element between calls. Two surfaces open this flow — the settings tab to connect, the
 * window to approve a second device — and each re-binds before the flow redraws, which is why the
 * target is set rather than passed: the flow is held across rebuilds and calls back without knowing
 * which screen is currently listening.
 */
import { Notice } from 'obsidian';

export interface PairingView {
  /** Take the element a surface just built. A redraw follows; nothing is drawn here. */
  bindTo(target: HTMLElement): void;
  /** The code, its buttons, and the empty line the status will fill. */
  showCode(code: string): void;
  /** Fill that line in place. */
  setStatus(text: string, failed: boolean): void;
}

export const openPairingView = (deps: { cancel: () => void }): PairingView => {
  let target: HTMLElement | undefined;

  return {
    bindTo: (el) => {
      target = el;
    },

    showCode: (code) => {
      if (!target) return;
      target.empty();
      target.createEl('p', { text: 'Enter this on the device that is already connected:' });
      // Set apart rather than left in a paragraph: it is read off one screen and entered
      // into another, and 26 characters are hard enough to follow without prose around
      // them.
      target.createEl('pre', { text: code });

      // **The status line is created here, under the code and above the buttons** (issue #255). It used
      // to be appended by `setStatus` when the first status arrived, which put it last — below Copy and
      // Cancel, at the bottom of a pane that scrolls, off the screen of the person staring at the code.
      // `Waiting for approval…` was out of sight from the first second, and so was the sentence
      // explaining a refusal. Drawn empty here, it is filled in place instead of appended.
      target.createEl('p', { cls: 'syncserver-pairing-status' });

      /**
       * Copy, because the second screen is not always a second device.
       *
       * This flow was written for a person walking between two machines, and typing was the
       * only way a code could cross that gap. Issue #116 made the ordinary case something else: two
       * Obsidian vaults on ONE computer, where the approving window is a keystroke away and
       * transcribing 26 characters by hand is friction the situation does not call for. The
       * feature created the need, and a live walk was where it showed.
       *
       * The button stays either way — it costs a person on a phone nothing, and it says what
       * happened rather than silently succeeding.
       */
      const copy = target.createEl('button', { text: 'Copy' });
      copy.addEventListener('click', () => {
        void navigator.clipboard
          .writeText(code)
          .then(() => new Notice('SyncServer: pairing code copied.'))
          // A refused clipboard is not a failed pairing: the code is still on screen and still
          // typable, so this says so rather than looking like the pairing broke.
          .catch(() => new Notice('SyncServer: could not reach the clipboard — the code above still works.', 8000));
      });

      // The whole reason the flow is held: a cancel only exists if something can reach it.
      target.createEl('button', { text: 'Cancel' }).addEventListener('click', () => deps.cancel());
    },

    /**
     * The `??` stays as the honest fallback: a status can be set before any code has been drawn — a join
     * refused for a missing passphrase never reaches `showCode` — and appending is the right answer when
     * there is nothing to sit under. What it must not be is the ordinary path (#255).
     *
     * **A refusal looks like one.** Waiting and failing shared a grey paragraph, and a person who has
     * been reading a code off the screen for a minute does not re-read the line below it word by word.
     * The flow says which this is; nothing here guesses from the text.
     */
    setStatus: (text, failed) => {
      if (!target) return;
      const line = target.querySelector('p.syncserver-pairing-status') ?? target.createEl('p');
      line.addClass('syncserver-pairing-status');
      line.setText(text);
      (line as HTMLElement).style.color = failed ? 'var(--text-error)' : '';
    },
  };
};
