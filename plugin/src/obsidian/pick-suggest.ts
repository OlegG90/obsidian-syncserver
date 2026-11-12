/**
 * A suggestion list under a text field, drawn where Obsidian draws its own: the folder to share
 * (issue #455) and the login to invite. What appears, and in what order, is the caller's
 * `suggest`; this only draws it, hands a pick back to the field, and keeps Enter from meaning
 * both a pick and the field's own `onEnter`.
 */
import { AbstractInputSuggest, type App } from 'obsidian';

export class PickSuggest extends AbstractInputSuggest<string> {
  /** Whether the list is on screen, which decides whose Enter it is. */
  private shown = false;

  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly suggest: (query: string) => string[],
    onEnter?: () => void,
  ) {
    super(app, input);
    // Enter while the list is open picks a suggestion; acting on it as well would act on the
    // half-typed text the pick is about to replace. Which listener hears the key first is
    // Obsidian's, so both signs that the list took it are checked.
    if (onEnter) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.defaultPrevented && !this.shown) onEnter();
      });
    }
    this.onSelect((value) => {
      this.setValue(value);
      // `setValue` writes the element and says nothing, so whatever the field derives from its
      // text would still describe the previous text. The event is what the field listens to.
      this.input.dispatchEvent(new Event('input'));
      this.close();
    });
  }

  override open(): void {
    super.open();
    this.shown = true;
  }

  override close(): void {
    super.close();
    this.shown = false;
  }

  protected getSuggestions(query: string): string[] {
    return this.suggest(query);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}
