/**
 * The four questions this plugin asks a person, and the one screen it uses to answer with.
 *
 * They live at the Obsidian edge because a `Modal` cannot exist without the application —
 * which is precisely why they are not in `main.ts`: everything there that is not Obsidian has
 * spent this project being moved out to where it can be tested, and a dialog is the part that
 * genuinely cannot be. Keeping them together says which is which.
 *
 * Each resolves a promise rather than taking a callback into the caller's flow, and each
 * resolves `undefined` when dismissed — a person closing a box is an answer, not a hang.
 */
import { App, Modal, Setting } from 'obsidian';

/** A one-field modal, resolving to the passphrase or `undefined` if dismissed. */
/**
 * What to call a folder somebody shared with you.
 *
 * It has to be asked, because it cannot be known: the initiator's own label for that folder
 * is under THEIR vault key (SH-01), so the name they use is unreadable here and always will
 * be. The design says the joiner names their own copy, and until this existed the client
 * quietly invented "Shared folder" for everybody — which is not naming it, it is refusing to.
 *
 * A suggestion is offered rather than a blank box: the person accepting knows who shared it,
 * and that is the one fact this side actually holds.
 */
export const askFolderName = (app: App, suggestion: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    new TextPromptModal(
      app,
      'Name this shared folder',
      'It lands among your own folders, so the name is yours to choose. Whatever the person ' +
        'who shared it calls their copy is encrypted under their key and cannot be read here.',
      suggestion,
      resolve,
    ).open();
  });

export const askPassphrase = (app: App): Promise<string | undefined> =>
  new Promise((resolve) => {
    const modal = new PassphraseModal(app, resolve);
    modal.open();
  });

export class PassphraseModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly done: (value: string | undefined) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText('SyncServer passphrase');
    this.contentEl.createEl('p', {
      text: 'Unlocks this account’s keys. It is not stored, so it is asked for once per session.',
    });

    const input = this.contentEl.createEl('input', { type: 'password' });
    input.style.width = '100%';
    input.focus();

    const submit = (): void => {
      this.answered = true;
      this.done(input.value || undefined);
      this.close();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Unlock').setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
    // Dismissed with Escape or the close button rather than answered.
    if (!this.answered) this.done(undefined);
  }
}

/** One line of text, asked for with something already in the box. */
export class TextPromptModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly explanation: string,
    private readonly initial: string,
    private readonly done: (value: string | undefined) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.explanation });

    const input = this.contentEl.createEl('input', { type: 'text' });
    input.style.width = '100%';
    input.value = this.initial;
    input.focus();
    input.select();

    const submit = (): void => {
      this.answered = true;
      this.done(input.value.trim() || undefined);
      this.close();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') submit();
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText('Accept').setCta().onClick(submit));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(undefined);
  }
}

/**
 * A confirmation for the one action here that cannot be undone by pressing it again.
 *
 * The consequence goes in the body rather than the title, because "are you sure?" is not
 * information: what a person needs to decide is what they will need to come back.
 */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly consequence: string,
    private readonly confirmed: () => Promise<void>,
    /**
     * What the button says. Named rather than defaulted, because "OK" on the one dialogue
     * that cannot be undone tells a person nothing about what they are agreeing to — the
     * verb is the information.
     */
    private readonly verb = 'Confirm',
  ) {
    super(app);
  }

  override onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl('p', { text: this.consequence });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.verb)
          .setWarning()
          .onClick(async () => {
            this.close();
            await this.confirmed();
          }),
      );
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Ask before something irreversible, and resolve to what the person chose.
 *
 * `false` for a dismissal as well as for Cancel: closing a dialogue is not consent, and a
 * promise that never settled would leave the caller holding a lock for the rest of the
 * session.
 */
export const askConfirmation = (app: App, question: string, verb = 'Discard'): Promise<boolean> =>
  new Promise((resolve) => {
    let answered = false;
    const modal = new ConfirmModal(
      app,
      'This cannot be undone',
      question,
      async () => {
        answered = true;
        resolve(true);
      },
      verb,
    );
    const close = modal.onClose.bind(modal);
    modal.onClose = (): void => {
      close();
      if (!answered) resolve(false);
    };
    modal.open();
  });

/** The complete status, on every platform — see `status.ts` for why the status bar is not enough. */
export class StatusModal extends Modal {
  private pre: HTMLElement | undefined;

  constructor(
    app: App,
    private lines: string[],
  ) {
    super(app);
  }

  /** Rewrite the body: what only the server can answer arrives after the modal is up. */
  replace(lines: string[]): void {
    this.lines = lines;
    this.pre?.setText(lines.join('\n'));
  }

  override onOpen(): void {
    this.titleEl.setText('SyncServer');
    const pre = this.contentEl.createEl('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.userSelect = 'text';
    pre.setText(this.lines.join('\n'));
    this.pre = pre;
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}