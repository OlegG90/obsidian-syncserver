/**
 * The suggestion list under the share field (issue #455). Which folders appear, and in what order,
 * is `folder-pick.ts`; this only draws them where Obsidian draws its own.
 */
import { AbstractInputSuggest, type App } from 'obsidian';
import { suggestFolders } from '../folder-pick.js';

export class FolderSuggest extends AbstractInputSuggest<string> {
  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly offered: readonly string[],
  ) {
    super(app, input);
    this.onSelect((folder) => {
      this.setValue(folder);
      // `setValue` writes the element and says nothing, so a refusal still shown for the previous
      // text would sit beside a folder that is now valid. The event is what the field listens to.
      this.input.dispatchEvent(new Event('input'));
      this.close();
    });
  }

  protected getSuggestions(query: string): string[] {
    return suggestFolders(this.offered, query);
  }

  renderSuggestion(folder: string, el: HTMLElement): void {
    el.setText(folder);
  }
}
