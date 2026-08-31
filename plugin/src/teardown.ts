/**
 * Unloading, where one failure must not cost the rest.
 *
 * Obsidian's base class cleans up what it was told about — the ribbon item, the status bar,
 * the commands — **after** `onunload` returns. So an exception thrown on the way out does not
 * merely skip a step of ours; it abandons the framework's teardown too, and what survives is a
 * plugin half gone and half registered. From the outside that looks like a duplicated ribbon
 * entry after an update (#290).
 *
 * Here rather than in `main.ts` because `main.ts` imports `obsidian` and cannot be loaded by a
 * test. The rule this file holds is one worth a test: *every step runs, whatever the others
 * do* is exactly the sort of thing that regresses quietly the next time someone adds a fourth.
 */

/** What a failed step is told to. Console in the plugin; a spy in a test. */
export type Complain = (message: string, cause: unknown) => void;

/**
 * Run one teardown step, and swallow nothing.
 *
 * Reported rather than silently absorbed: a teardown that fails quietly is how the next person
 * spends an evening on the half that survived.
 */
export const teardownStep = async (
  what: string,
  run: () => unknown,
  complain: Complain = (m, e) => console.error(m, e),
): Promise<void> => {
  try {
    await run();
  } catch (e: unknown) {
    complain(`SyncServer: could not ${what} while unloading`, e);
  }
};
