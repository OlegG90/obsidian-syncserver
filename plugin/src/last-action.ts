/**
 * The last thing this plugin did, kept on screen with the time it happened (#130).
 *
 * **It does not replace the notices, and the mockup's version would have.** Several of them
 * are deliberately long — what leaving a share did, whether a revoke ended it for everybody,
 * where a recovery code should not be kept — and they were written to be read once, at the
 * moment they are news. A settings row cannot carry those, and a phone has no other surface
 * for them at all (docs/02).
 *
 * So this is the *record* of what was said, not the saying of it: the same call raises the
 * notice and files it here, and the settings screen shows the most recent one with a clock
 * time. That answers the question a notice cannot, because it has gone: "did that work?"
 *
 * One entry, not a list. A log of everything the plugin has ever said is a thing nobody reads;
 * what somebody wants at the top of a screen is the last thing that happened.
 */
export interface Action {
  /** `Date.now()` when it was said. */
  at: number;
  message: string;
}

/** Every notice this plugin raises is prefixed for the notification area. A row on its own screen is not. */
const PREFIX = /^SyncServer:\s*/;

/**
 * The line, or nothing when nothing has happened yet.
 *
 * Empty rather than "nothing yet": a screen that has done nothing has nothing to report, and a
 * row saying so is a row somebody has to read before ignoring.
 */
export const lastActionLine = (action: Action | undefined): string | undefined => {
  if (!action) return undefined;
  const said = action.message.replace(PREFIX, '');
  return `${new Date(action.at).toLocaleTimeString()} · ${said}`;
};
