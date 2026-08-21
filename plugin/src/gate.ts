/**
 * One operation at a time, across every coordinator.
 *
 * `sync.ts`, `share-flow.ts` and `history-flow.ts` each guarded only themselves with a
 * local boolean — so a push-triggered sync could start while a departure was midway
 * between `leave/begin` and `finalize-leave`, because the sync's guard did not know the
 * share flow's was held. The share and history flows were also built per call, so their
 * guards reset on every settings rebuild: two presses across one `display()` each found a
 * fresh `false`.
 *
 * One gate, created in `main.ts` and handed to all three, makes them aware of each other:
 * any operation refuses to start while any other is in flight.
 *
 * **It can also be watched, which is what makes the rule sayable before it is enforced**
 * (#125). A gate that could only answer `false` to a press meant a person pressed *Invite*
 * and then learned a sync was running; the screen had no way to know beforehand and no way
 * to hear when it changed. Both are here now — and it holds the **name** of whatever took
 * it, because "an operation is running" is a sentence that leaves somebody guessing which.
 */
export interface Gate {
  /**
   * Try to take the gate; false when another operation holds it.
   *
   * `what` is a phrase naming this operation, read straight out to a person as
   * "waiting for: sharing the folder". Every caller already had one for its failure
   * message.
   */
  tryBegin(what: string): boolean;
  /** Give the gate back. Always in a `finally`. */
  end(): void;
  /** What holds it, or nothing when it is free. */
  holding(): string | undefined;
  /** Hear about every change to that. Returns the way to stop hearing. */
  watch(listener: (holding: string | undefined) => void): () => void;
}

/**
 * What is running, as one sentence — used by the screen that disables the actions and by the
 * notice that refuses a press, so the rule is worded once.
 *
 * The name comes from the operation itself rather than being assumed to be a sync: a trash
 * discard holding the gate while somebody presses Invite is common, and "a sync is running"
 * would be a plain untruth about it.
 *
 * It names syncing, sharing and the trash — **not pairing**, although the mockup did.
 * Approving a pairing code does not take this gate; `pairing-flow.ts` guards itself with a
 * local flag, so it neither waits for a sync nor makes one wait. Saying otherwise here would
 * describe a rule that is not enforced anywhere.
 */
export const busyLine = (holding: string): string =>
  `Waiting for ${holding} to finish. Syncing, sharing and trash actions come back when it does.`;

export const openGate = (): Gate => {
  let busy: string | undefined;
  const listeners = new Set<(holding: string | undefined) => void>();

  /**
   * Told, one by one, with a failure kept to the listener it came from.
   *
   * A screen that throws while redrawing must not take an operation's `finally` down with
   * it: `end()` would stop halfway and the gate would stay held for the rest of the
   * session, which is a worse fault than the redraw that caused it.
   */
  const announce = (): void => {
    for (const l of listeners) {
      try {
        l(busy);
      } catch (e) {
        console.error('SyncServer: a gate listener failed', e);
      }
    }
  };

  return {
    tryBegin(what) {
      if (busy !== undefined) return false;
      busy = what;
      announce();
      return true;
    },
    end() {
      if (busy === undefined) return;
      busy = undefined;
      announce();
    },
    holding: () => busy,
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
