/**
 * The shell the console's screens sit in, and the DOM helpers they share.
 *
 * Every screen was drawn in `main.ts` until that file held them all (issue #480): the helpers
 * below are what the split is for, and each screen module imports them from here rather than
 * owning a copy. What stays in `main.ts` is the wiring — which screen goes where — and the
 * first render.
 */
import { currentLogin, forgetSession, health } from './api.js';
import { serverLine } from './format.js';
import { sessionEnded } from './screen.js';

/**
 * Where this console navigates, owned by `main.ts` and read here.
 *
 * The shell's sidebar and the session's end both change the screen, but neither module owns
 * the screens — so the destinations arrive once, up front, rather than as imports that would
 * tie this module to every screen it frames. A screen that navigates anywhere else takes the
 * navigator as a parameter, for the same reason.
 */
export interface Navigator {
  accounts(): void;
  backups(): void;
  problems(): void;
  audit(): void;
  /** The console password form, reached from the sidebar but not a destination. */
  password(): void;
  signIn(note?: string): void;
  /** Re-choose the screen by what the server says, as the first render does. */
  render(): void;
}

let nav: Navigator | undefined;

/** The wiring `main.ts` performs once, before the first render. */
export const setNavigator = (n: Navigator): void => {
  nav = n;
};

const requireNav = (): Navigator => {
  if (!nav) throw new Error('console navigator not set');
  return nav;
};

export const app = document.getElementById('app') as HTMLElement;

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

export const say = (message: string, bad = false): HTMLElement =>
  el('p', { className: bad ? 'bad' : 'ok', textContent: message });

/** The placeholder a list shows until `loads` fills it — or replaces it with why it could not. */
export const pending = (text = 'Loading…'): HTMLElement => el('p', { className: 'muted', textContent: text });

/**
 * A failure as the screen shows it: the sentence the server sent, not a status — or nothing,
 * when the session ended and the sign-in screen has already taken over. What `attempt` and
 * `loads` both do with a failure; they differ only in where they put it.
 */
export const failure = (e: unknown): HTMLElement | undefined =>
  endedSession(e) ? undefined : say(e instanceof Error ? e.message : String(e), true);

/** Every failure reaches the screen as the sentence the server sent, not as a status. */
export const attempt = async (where: HTMLElement, run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (e) {
    const shown = failure(e);
    if (shown) where.append(shown);
  }
};

/**
 * A session that has run out, handled as a change of screen rather than a message.
 *
 * `unauthenticated` is not something the person did; it is the console saying it no longer
 * has anything to act with. There is one thing to do about it and the sign-in screen is it,
 * so that is what happens — with the reason carried across, because arriving at a login form
 * unasked is otherwise indistinguishable from the page having crashed.
 */
export const endedSession = (e: unknown): boolean => {
  if (!sessionEnded(e)) return false;
  signOut(
    'Your session ended. Nothing about it is written down, so a reload or a closed tab means ' +
      'signing in again — and so does an administrator revoking this console.',
  );
  return true;
};

/** Forget this console's session and go to the sign-in screen, with the reason if there is one. */
export const signOut = (note?: string): void => {
  forgetSession();
  requireNav().signIn(note);
};

/**
 * Fill a list that is currently saying "Loading…".
 *
 * The placeholder is a promise the screen made, and it has to be kept on both paths. The live
 * walk found the other half: an expired token put `unauthenticated` on the page and left the
 * "Loading…" underneath it, waiting for something that was never coming. A failure replaces
 * the placeholder; it does not queue up behind it.
 */
export const loads = (list: HTMLElement, fill: () => Promise<void>): void => {
  void fill().catch((e: unknown) => {
    const shown = failure(e);
    if (shown) list.replaceChildren(shown);
  });
};

export const field = (label: string, type = 'text'): { row: HTMLElement; input: HTMLInputElement } => {
  const input = el('input', { type });
  return { row: el('div', {}, el('label', { textContent: label }), input), input };
};

/**
 * A button that does one thing and cannot be asked to do it twice at once.
 *
 * All three screens are the same shape — disable, call the API, put whatever it refused with
 * on the card, enable again — and each wrote it out. The disabling is the part that matters:
 * every act behind these buttons is once-only on the server (the first password, an
 * invitation), so a second click while the first is in flight asks for a refusal the person
 * did not earn.
 */
export const submits = (button: HTMLButtonElement, card: HTMLElement, run: () => Promise<void>): void => {
  button.onclick = (): void => {
    button.disabled = true;
    void attempt(card, run).finally(() => (button.disabled = false));
  };
};

/**
 * Where the sidebar says you are — or `'none'`, for a screen that is not a destination.
 *
 * Changing a password is reached from the sidebar and is not one of the three places this
 * console holds; marking Accounts as current while showing a password form would be the
 * navigation telling a small lie about where the reader is.
 */
export type Where = 'accounts' | 'backups' | 'problems' | 'audit' | 'none';

/**
 * The frame every signed-in screen sits in: where you are, and who you are (#123).
 *
 * A sidebar rather than a row of buttons above the heading, for the reason the mockups give
 * and a stack of cards made obvious: the navigation was competing with the content for the
 * top of the page, so the first thing a person read was three destinations rather than the
 * thing they had opened.
 *
 * **`#app` is the `<main>`**; the nav is its sibling, created once and reused. Redrawing the
 * navigation on every screen change would make the current-page marker flicker on the one
 * element whose job is to not move.
 *
 * The screens that are not part of the shell — the first run, signing in, a pending restore —
 * take it away entirely. Each is the only thing the server will talk about at that moment, and
 * a sidebar offering three destinations that all answer `restore_pending` is an offer the
 * server will refuse.
 */

let side: HTMLElement | undefined;

/**
 * The server's version, once it has been asked for.
 *
 * `undefined` means "not asked yet", `null` means "asked, and this server is old enough not to
 * report one" — two different states that a single optional string would have flattened into
 * one, leaving the console asking a server that had already answered.
 */
let serverVersion: string | null | undefined;

export const shell = (current: Where, ...content: Node[]): void => {
  const go = requireNav();
  side ??= el('nav', { className: 'side' });
  app.before(side);
  side.replaceChildren(el('div', { className: 'brand', textContent: 'SyncServer' }));

  const destinations: [Where, string, () => void][] = [
    ['accounts', 'Accounts', go.accounts],
    ['backups', 'Backups', go.backups],
    ['problems', 'Sync problems', go.problems],
    ['audit', 'Audit log', go.audit],
  ];
  for (const [key, label, to] of destinations) {
    const b = el('button', { textContent: label });
    if (key === current) b.setAttribute('aria-current', 'page');
    b.onclick = to;
    side.append(b);
  }

  // Who, and the way out. `forgetSession` has existed since M4 with nothing calling it (#123):
  // a console that can be signed into and not out of leaves a session on a shared machine with
  // no way to end it but closing the tab and hoping.
  const who = el('div', { className: 'who' });
  who.append(el('div', { className: 'muted', textContent: `Signed in as ${currentLogin()}` }));
  const out = el('button', { className: 'link', textContent: 'Sign out' });
  out.onclick = (): void => signOut();
  who.append(out);

  // Beside the way out, because both are about the person using the console rather than the
  // accounts it manages — and because there was no way to do this at all until #137.
  const change = el('button', { className: 'link', textContent: 'Change password' });
  change.onclick = (): void => go.password();
  who.append(change);

  // Which server this is, under the way out (#135). Asked once per page load and remembered:
  // `/health` answers before authentication, and the version does not change under a running
  // console — an image is replaced by restarting the container, which ends this session anyway.
  const line = el('div', { className: 'muted version', textContent: serverLine(serverVersion) });
  who.append(line);
  if (serverVersion === undefined) {
    void health()
      .then((h) => {
        serverVersion = h.version ?? null;
        line.textContent = serverLine(serverVersion);
      })
      .catch(() => (line.textContent = serverLine(undefined)));
  }
  side.append(who);

  app.replaceChildren(...content);
};

/** A screen with nothing else on it: the first run, signing in, a halt nobody can leave yet. */
export const alone = (...content: Node[]): void => {
  side?.remove();
  app.replaceChildren(el('div', { className: 'centred' }, ...content));
};
