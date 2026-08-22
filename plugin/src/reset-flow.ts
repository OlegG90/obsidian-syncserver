/**
 * "My copy is the truth" — the coordinator for starting a reset (#158).
 *
 * The same shape as `share-flow.ts` and `history-flow.ts`, for the reason this project keeps
 * re-learning: anything decided inside `main.ts` or a `PluginSettingTab` is decided where no test can
 * watch, and four of the five defects a real phone found lived exactly there.
 *
 * There are two decisions here and both are easy to get quietly wrong:
 *
 * - **it takes the shared gate**, and it is the first act outside the three coordinators that must.
 *   Everything else the settings screen offers touches one row; this removes the vault's whole tree, and
 *   a sync running through it would be uploading against node ids that stop existing mid-pass;
 * - **the local state is cleared only after the server has accepted.** `state.nodes` maps every path to
 *   a node id the reset deletes, so it has to go — but clearing it first would leave a device that had
 *   forgotten what it synced against a server that still holds everything, and the next pass would
 *   re-upload the lot as new files beside the old ones.
 */
import { busyLine, type Gate } from './gate.js';

export interface ResetFlowDeps {
  /** The one gate every operation family shares — one operation at a time, across all of them. */
  gate: Gate;
  /** Empty this vault on the server; answers what it removed and the epoch every other device will meet. */
  reset(): Promise<{ removed: number; epoch: number }>;
  /** Forget what this device thinks it has synced. Only ever called once the reset has happened. */
  forgetState(): Promise<void>;
  /** Upload this copy, which is the second half of the act and not an optimisation. */
  sync(): Promise<void>;
  notify(message: string, durationMs?: number): void;
  /** The screen showing this is now out of date. */
  done(): void;
}

export interface ResetFlow {
  /** Start it. Answers whether it happened, so a caller can leave its own screen alone if it did not. */
  start(): Promise<boolean>;
}

export const openResetFlow = (deps: ResetFlowDeps): ResetFlow => ({
  async start() {
    // Taken synchronously before any await, as everywhere else: two presses arrive as two calls before
    // either has reached the network.
    if (!deps.gate.tryBegin('a reset')) {
      deps.notify(`SyncServer: ${busyLine(deps.gate.holding() ?? 'another operation')}`, 8000);
      return false;
    }

    let removed: number;
    try {
      ({ removed } = await deps.reset());
      await deps.forgetState();
    } catch (e) {
      // The gate is released by the `finally` below, so a failed reset leaves the device exactly as it
      // was: the server refused, and nothing here has forgotten anything.
      deps.notify(`SyncServer: the reset failed — ${e instanceof Error ? e.message : String(e)}`, 12000);
      return false;
    } finally {
      deps.gate.end();
    }

    // Said before the upload starts rather than after it finishes: the sync may take minutes, and the
    // number is the answer to "did that do what I meant".
    deps.notify(
      `SyncServer: ${removed} item(s) removed from the server. This device is uploading its copy now.`,
      12000,
    );

    // **Outside the gate.** The sync takes it for itself, and holding it across both would make the
    // upload refuse the very pass it is asking for.
    await deps.sync();
    deps.done();
    return true;
  },
});
