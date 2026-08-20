/**
 * Which of the console's screens to show, decided against the server rather than the
 * browser — and tested here, because it is the one judgement this workspace makes that is
 * not already the API's.
 *
 * The decision is an **async tree**, not a single predicate: whether the restore status or
 * the health endpoint is even asked depends on whether a token is held, and which way the
 * answer falls picks the screen. So the dependencies are functions — `restoreStatus` and
 * `health` are called only when the branch needs them — and a test supplies fakes to pin
 * every path.
 *
 * The screens are what `main.ts` draws: the first run, signing in, the accounts, and the
 * restore-confirm surface. A pending restore outranks the accounts screen because the
 * server answers everything else with `restore_pending` anyway — the first thing shown is
 * the way out.
 */

/** Which server question a signed-in console asks first. */
export interface ScreenDeps {
  /** Whether a console token is held — synchronous, from memory. */
  signedIn(): boolean;
  /** `GET /admin/restore` — only asked of a signed-in console. */
  restoreStatus(): Promise<{ pending: boolean }>;
  /** `GET /health` — only asked before a console has signed in. */
  health(): Promise<{ bootstrap_pending: boolean }>;
}

/** The screen to draw. */
export type Screen = 'restore' | 'accounts' | 'firstRun' | 'signIn';

/**
 * Choose the screen, asking only the question the branch needs.
 *
 * Two independent trees, split by whether a token is held. A signed-in console asks
 * whether a restore is pending; one that has not signed in asks whether the server is on
 * its first run. Neither asks the other's question, because doing so would be a request
 * the answer could not use.
 */
export const chooseScreen = async (deps: ScreenDeps): Promise<Screen> => {
  if (deps.signedIn()) {
    const status = await deps.restoreStatus();
    return status.pending ? 'restore' : 'accounts';
  }
  const state = await deps.health();
  return state.bootstrap_pending ? 'firstRun' : 'signIn';
};

/**
 * Whether a refusal means the session is over rather than the act was refused.
 *
 * The console holds its access token in memory and asks for no refresh, so the token simply
 * expires — fifteen minutes by default — while a tab sits open. Every call after that is
 * refused, and until this existed the screen showed the refusal as a sentence and left its
 * "Loading…" in place: a page that had ended, saying nothing about how to carry on. That is
 * the live walk it comes from — Audit log, then Accounts, then `unauthenticated` above a
 * list that would have waited forever.
 *
 * Matched on the **code**, not the status. The server is careful about which word it uses:
 * a token that no longer verifies is `unauthenticated`, and a login that does not is
 * `invalid_credentials`. Both are 401s and only one of them means "sign in again" — reading
 * the status alone would send somebody who mistyped a password back to a screen they are
 * already on, saying their session had ended.
 *
 * Structural rather than an `ApiError` check, so the screen module keeps depending on
 * nothing.
 */
export const sessionEnded = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'unauthenticated';
