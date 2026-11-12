/**
 * A suggestion list under a text field, drawn where Obsidian draws its own: the folder to share
 * (issue #455) and the login to invite. What appears, and in what order, is the caller's
 * `suggest`; this only draws it and hands a pick back to the field.
 */
import { AbstractInputSuggest, type App } from 'obsidian';

export class PickSuggest extends AbstractInputSuggest<string> {
  /**
   * Whether the list is on screen. Enter there picks a suggestion, and a field that also acts on
   * Enter would otherwise act on the half-typed text the pick was about to replace.
   */
  private open_ = false;

  get shown(): boolean {
    return this.open_;
  }

  constructor(
    app: App,
    private readonly input: HTMLInputElement,
    private readonly suggest: (query: string) => string[],
  ) {
    super(app, input);
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
    this.open_ = true;
  }

  override close(): void {
    super.close();
    this.open_ = false;
  }

  protected getSuggestions(query: string): string[] {
    return this.suggest(query);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
}
