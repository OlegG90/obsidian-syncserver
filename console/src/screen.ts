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
