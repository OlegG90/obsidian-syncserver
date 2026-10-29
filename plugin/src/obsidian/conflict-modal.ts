/**
 * The conflict, on one screen, with the three ways out of it (#448).
 *
 * A modal rather than a pane of the SyncServer window: it is one act on one pair of files, it takes
 * the whole screen on a phone where two columns would not fit, and it closes when the act is done.
 * The comparison is one column for the same reason — what was removed and what was added, in the
 * order they come — rather than two panes side by side.
 *
 * Every way out is an ordinary act on the vault, which the next sync carries like any other: the
 * server's history keeps what either side had, so none of them loses anything for good.
 */
import { Modal, Notice, Setting, type App, type TFile } from 'obsidian';
import { folded, isText, lineDiff } from '../conflict.js';
import { errorText } from '../error-text.js';

/** What the screen says each side is. The note holds the server's version; the copy holds this device's. */
const SERVER = 'the server’s version — in the note';
const MINE = 'this device’s version — in the copy';

export class ConflictModal extends Modal {
  constructor(
    app: App,
    private readonly note: TFile,
    private readonly copy: TFile,
  ) {
    super(app);
  }

  override async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`Conflict in ${this.note.basename}`);
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `Both changed while apart. The note became the server’s version; yours was kept as “${this.copy.name}”.`,
    });

    if (isText(this.note.path)) {
      const [server, mine] = await Promise.all([this.app.vault.read(this.note), this.app.vault.read(this.copy)]);
      this.drawDiff(server, mine);
    } else {
      // A PDF or an image cannot be compared line by line, and pretending otherwise would show noise.
      contentEl.createEl('p', {
        text: `Not text, so not compared line by line: the note is ${this.note.stat.size} bytes, the copy ${this.copy.stat.size}.`,
      });
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Keep the server’s')
          .setTooltip('Delete the copy; the note stays as it is.')
          .onClick(() => {
            void this.settle(() => this.trash(this.copy), 'The server’s version kept; the copy is in the trash.');
          }),
      )
      .addButton((b) =>
        b
          .setButtonText('Keep mine')
          .setCta()
          .setTooltip('Put the copy’s text into the note, then delete the copy.')
          .onClick(() => {
            void this.settle(async () => {
              await this.app.vault.modifyBinary(this.note, await this.app.vault.readBinary(this.copy));
              await this.trash(this.copy);
            }, 'Your version kept; it goes up with the next sync, and the server’s stays in the history.');
          }),
      )
      .addButton((b) =>
        b
          .setButtonText('Merge by hand')
          .setTooltip('Open both; delete the copy when you are done, and the conflict is resolved.')
          .onClick(() => {
            this.close();
            void this.app.workspace.getLeaf('tab').openFile(this.note);
            void this.app.workspace.getLeaf('split').openFile(this.copy);
          }),
      );
  }

  /** The two texts as one column: the server's lines that went, this device's that came. */
  private drawDiff(server: string, mine: string): void {
    const diff = lineDiff(server, mine);
    if (!diff) {
      this.contentEl.createEl('p', { text: 'The two differ in too many places to compare line by line. Merge by hand opens both.' });
      return;
    }
    const rows = folded(diff);
    if (!rows.some((r) => r.kind === 'removed' || r.kind === 'added')) {
      this.contentEl.createEl('p', { text: 'The two are identical. Keeping either one settles it.' });
      return;
    }
    const legend = this.contentEl.createDiv();
    legend.style.cssText = 'font-size: var(--font-ui-smaller); margin: 0.5em 0;';
    legend.createSpan({ text: `− ${SERVER}` }).style.color = 'var(--text-error)';
    legend.createEl('br');
    legend.createSpan({ text: `+ ${MINE}` }).style.color = 'var(--text-success)';

    const box = this.contentEl.createDiv();
    box.style.cssText =
      'font-family: var(--font-monospace); font-size: var(--font-ui-small); max-height: 60vh; overflow: auto; border: 1px solid var(--background-modifier-border); border-radius: 4px;';
    for (const row of rows) {
      const line = box.createDiv();
      line.style.cssText = 'white-space: pre-wrap; word-break: break-word; padding: 0 0.5em;';
      if (row.kind === 'skipped') {
        line.setText(`… ${row.count} unchanged line${row.count === 1 ? '' : 's'}`);
        line.style.color = 'var(--text-faint)';
        continue;
      }
      line.setText(`${row.kind === 'removed' ? '−' : row.kind === 'added' ? '+' : ' '} ${row.text}`);
      if (row.kind === 'removed') line.style.background = 'rgba(var(--color-red-rgb), 0.15)';
      if (row.kind === 'added') line.style.background = 'rgba(var(--color-green-rgb), 0.15)';
    }
  }

  /**
   * To the trash the person chose in Obsidian's settings — `trashFile` honours it, and is `@since 1.6.6`.
   * This plugin's floor is 1.5.0, where the system trash is what deleting a file did.
   */
  private async trash(file: TFile): Promise<void> {
    if (typeof this.app.fileManager.trashFile === 'function') await this.app.fileManager.trashFile(file);
    else await this.app.vault.trash(file, true);
  }

  /** One way out: do it, say so, and close — or say what stopped it and stay open. */
  private async settle(act: () => Promise<void>, said: string): Promise<void> {
    try {
      await act();
      new Notice(`SyncServer: ${said}`, 8000);
      this.close();
    } catch (e) {
      new Notice(`SyncServer: the conflict could not be settled — ${errorText(e)}`, 10000);
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
