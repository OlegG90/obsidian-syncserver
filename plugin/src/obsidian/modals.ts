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
import type { VaultChoice } from '../session/index.js';

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
  /**
   * Set the instant the button is pressed, **before** `close()` runs.
   *
   * An `onClose` handler cannot otherwise tell a confirmation from a dismissal: the button
   * closes the dialogue first and does its work second, so anything that marked consent
   * inside that work marked it too late. A live walk found this as "the dialogue appears, I
   * agree, and nothing happens" — a yes arriving after the close had already been read as a no.
   */
  accepted = false;

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
            this.accepted = true;
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
export const askConfirmation = (
  app: App,
  question: string,
  verb = 'Discard',
  /**
   * The heading. Defaulted to the irreversible case because that is what this was written
   * for — but not every question worth asking is that one, and a dialogue titled "this
   * cannot be undone" above a choice that plainly can teaches somebody to stop reading the
   * heading.
   */
  title = 'This cannot be undone',
): Promise<boolean> =>
  new Promise((resolve) => {
    const modal = new ConfirmModal(app, title, question, async () => undefined, verb);
    const close = modal.onClose.bind(modal);
    // One place that settles it, on the way out, reading what the button recorded on the way
    // in. Resolving from the button instead means racing its own `close()`, which is the
    // shape that turned a yes into a no.
    modal.onClose = (): void => {
      close();
      resolve(modal.accepted);
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
/**
 * Which vault on the account this device should sync, and what each answer will do (issue #116).
 *
 * **One screen that reads two ways.** With one vault it is a confirmation with a way out —
 * the ordinary "second laptop, same notes" case, still one press (issue #117). With several it is
 * a list. Two dialogues for one question would drift, and the person is asking the same
 * thing either way: which of these, or none of them.
 *
 * **Each option carries its own consequence**, because they are opposites and a single
 * sentence at the top could only be true of one. Joining an existing vault MERGES what is
 * already in this Obsidian vault with what is in that one; making a new vault merges nothing
 * and uploads what is here. Somebody who reads only the button they are about to press still
 * reads the right thing.
 *
 * A dismissal is `cancel`, for `askConfirmation`'s reason: closing a dialogue is not consent,
 * and a promise that never settled would strand the pairing that is waiting on it.
 */
export const askVaultChoice = (
  app: App,
  here: string,
  vaults: { id: string; name: string }[],
): Promise<VaultChoice> =>
  new Promise((resolve) => {
    let answer: VaultChoice = { kind: 'cancel' };
    const modal = new Modal(app);

    modal.onOpen = (): void => {
      modal.titleEl.setText('Which vault should this connect to?');
      modal.contentEl.createEl('p', {
        text:
          vaults.length === 0
            ? `This account has no vaults yet. Name the one to create from “${here}”.`
            : `This Obsidian vault is “${here}”. Choose what it syncs with on the account.`,
      });

      const settle = (choice: VaultChoice): void => {
        answer = choice;
        modal.close();
      };

      for (const v of vaults) {
        new Setting(modal.contentEl)
          .setName(v.name)
          .setDesc(
            'Merges with what is here: identical files join up, different ones become conflict ' +
              'files, and nothing is deleted on either side.',
          )
          .addButton((b) => b.setButtonText('Connect').setCta().onClick(() => settle({ kind: 'use', id: v.id })));
      }

      const name = modal.contentEl.createEl('input', { type: 'text' });
      name.style.width = '100%';
      name.value = here;
      new Setting(modal.contentEl)
        .setName('Make a new vault')
        .setDesc('Uploads what is here as a vault of its own. Nothing is merged, and nothing else is touched.')
        .addButton((b) =>
          b.setButtonText('Create').onClick(() => {
            const chosen = name.value.trim();
            if (chosen) settle({ kind: 'create', name: chosen });
          }),
        );

      new Setting(modal.contentEl).addButton((b) => b.setButtonText('Cancel').onClick(() => modal.close()));
    };

    const close = modal.onClose.bind(modal);
    // Settled on the way out, reading what a button recorded on the way in — the same shape
    // `askConfirmation` uses, and for the same reason it had to.
    modal.onClose = (): void => {
      close();
      modal.contentEl.empty();
      resolve(answer);
    };
    modal.open();
  });
