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
 * any operation refuses to start while any other is in flight. The word is "operation" —
 * the notice says so — because the thing running may be a sync, a share or a trash act.
 */
export interface Gate {
  /** Try to take the gate; false when another operation holds it. */
  tryBegin(): boolean;
  /** Give the gate back. Always in a `finally`. */
  end(): void;
}

export const openGate = (): Gate => {
  let busy = false;
  return {
    tryBegin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
  };
};
