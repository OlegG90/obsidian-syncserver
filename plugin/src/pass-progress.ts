/**
 * Whether a running pass is worth saying anything about, and what (#319).
 *
 * A pass reports how far it has got; this decides whether a person should be told. Those are
 * different questions, and only the second one has a wrong answer that annoys people.
 *
 * **Most passes must stay silent.** Automatic sync fires after the vault settles, so a pass runs
 * after every edit somebody makes, and a vault with nothing to do finishes in a fraction of a
 * second. A surface that lit up for those would flicker on every keystroke-and-save — which is not
 * information, it is the plugin talking about itself. So the signal is not "a pass is running" but
 * "a pass has been running longer than somebody expects", and `SLOW_MS` is where that line is.
 *
 * **The total can grow, and pretending otherwise is the obvious bug.** The queue starts as the local
 * file list, and `resolveConflict` pushes the local original back onto it mid-walk — so a pass can
 * finish having handled more files than it began with. A bar that reaches the end and keeps going is
 * worse than no bar, so what comes out here can never read `1181 / 1180`: the total rises to meet the
 * count, and `grew` says it happened.
 *
 * Pure, and taking `now` rather than reading a clock, because a threshold tested with a stopwatch is
 * a threshold nobody tests.
 */

/** How long a pass runs before it is worth a word. */
export const SLOW_MS = 5_000;

/** What the engine reports, and the moment the pass began. */
export interface PassProgress {
  /** Queue items completed. Rises past `total` when the pass created work for itself. */
  done: number;
  /** What the pass expected to handle when it started: the local file list. */
  total: number;
  /** Epoch milliseconds. */
  startedAt: number;
}

export type ProgressDisplay =
  /** Say nothing: either the pass is young, or there is nothing to count. */
  | { kind: 'quiet' }
  | {
      kind: 'counting';
      done: number;
      /** Never below `done`. */
      total: number;
      /** The pass has handled more than it set out to, so the total is a moving target. */
      grew: boolean;
      elapsedMs: number;
    };

export const displayFor = (p: PassProgress, now: number): ProgressDisplay => {
  const elapsedMs = now - p.startedAt;
  if (elapsedMs < SLOW_MS) return { kind: 'quiet' };

  // A pass with nothing to walk can still be slow — a big pull, a tree read over a bad connection —
  // but `0 of 0` is a worse answer than the plain "working" every surface already shows.
  if (p.total === 0 && p.done === 0) return { kind: 'quiet' };

  return {
    kind: 'counting',
    done: p.done,
    total: Math.max(p.total, p.done),
    grew: p.done > p.total,
    elapsedMs,
  };
};

/**
 * The counter as a person reads it — `128 / ~1180`.
 *
 * The tilde is not decoration. It appears exactly when the total has been raised to meet the count,
 * which is the moment the number stopped being a prediction and started being a report.
 */
export const counterText = (d: ProgressDisplay): string =>
  d.kind === 'counting' ? `${d.done} / ${d.grew ? '~' : ''}${d.total}` : '';
