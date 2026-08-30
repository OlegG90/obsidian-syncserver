/**
 * Syncing after the vault changes, without anybody pressing anything (issue #238).
 *
 * Incoming changes already arrive on their own — the `/events` socket wakes the plugin when the vault
 * gains a revision (`push.ts`). This is the other half: the person's own edits, which until now waited
 * for a button.
 *
 * **A quiet period, not an interval.** A timer syncs a vault nobody touched and misses the edit made a
 * second after it fired. This starts counting when something changes and runs one pass once the vault
 * has been still for `QUIET_MS` — so a burst of edits, a paste of forty files, or a folder rename costs
 * one pass rather than forty.
 *
 * **It must outlast the editor's own save.** Obsidian writes a note about two seconds after typing
 * stops, and *that write* is what raises the event this counts from — so the quiet period is measured
 * from the save rather than from the last keystroke, and only has to cover a burst of saves landing
 * together. Anything shorter risks uploading a file the editor is still writing, and a half-written
 * note is what would then propagate to every other device.
 *
 * **A pass may therefore create a conflict file nobody asked for**, which is a decision rather than an
 * oversight (D-124): syncing sooner shrinks the window in which two devices can diverge, the losing
 * version is kept beside the winning one, and the notice for it is never suppressed. The quiet period
 * is also what keeps a pass from writing into a file somebody is typing into at that moment.
 *
 * **Nothing starts while an operation is running**, and that is what makes the engine's own writes
 * harmless. A pull writes files, those writes raise the same events, and if a pass could start on them
 * the plugin would wake itself in a loop. Instead the quiet period restarts for as long as the gate is
 * held, so what follows a pass is at most one more pass — which reads the files that pass pulled, the
 * read #237 defers to exactly here, and finds nothing to send.
 *
 * The timer is injected for the same reason the transport and the socket are: a test that waited five
 * real seconds per case is a test nobody runs.
 */

/** How long the vault must be still before a pass starts. */
export const QUIET_MS = 5_000;

/**
 * Whether automatic syncing is on when nobody has said (issue #238).
 *
 * **On at a desk, off on a phone.** A pass reads the files it cannot rule out and talks to a server,
 * which is a different proposition on a battery and a metered connection. Stored per install, so the
 * two ends of one account can disagree and both be right.
 *
 * One function rather than the expression written where it is read: `main.ts` decides whether to run
 * and `settings.ts` draws the toggle, and the same rule in two places is one of them eventually being
 * a different rule.
 */
export const autoSyncByDefault = (isMobile: boolean): boolean => !isMobile;

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LocalChangeDeps {
  /** True while any operation holds the shared gate — a sync, a share, the trash. */
  busy(): boolean;
  /** Start one pass. Never called while `busy()` answers true. */
  run(): void;
  /** Whether automatic syncing is on at all; asked per settling, so a setting change takes effect at once. */
  enabled(): boolean;
}

/** The clock and the delay, replaced only by `forTests` below. */
interface Pacing {
  quietMs: number;
  timer: Timer;
}

export interface LocalChangeWatcher {
  /** Something in the vault changed. Cheap and synchronous — it is called from an editor event. */
  touched(): void;
  /** Unregister: the plugin is unloading. */
  stop(): void;
}

const REAL_TIMER: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const open = (deps: LocalChangeDeps, pacing: Pacing): LocalChangeWatcher => {
  const { quietMs, timer } = pacing;
  let handle: unknown;

  const clear = (): void => {
    if (handle !== undefined) timer.clear(handle);
    handle = undefined;
  };

  const arm = (): void => {
    clear();
    handle = timer.set(() => {
      handle = undefined;
      // **Deferred, not dropped.** An operation holding the gate is either this plugin writing (a pull,
      // a share being accepted) or a person having pressed something. Either way the vault is still
      // moving, and the honest answer is to keep waiting rather than to start a second pass that the
      // gate would refuse anyway — a refusal the person never asked for and would have to read.
      if (deps.busy()) return arm();
      deps.run();
    }, quietMs);
  };

  return {
    touched: () => {
      // Asked here rather than at registration: turning the setting off stops the next pass, not only
      // the ones after a reload — and cancels one already counting down.
      if (!deps.enabled()) return clear();
      arm();
    },
    stop: clear,
  };
};

/** The production entry point. It takes no clock, so no caller can hand it one by accident. */
export const watchLocalChanges = (deps: LocalChangeDeps): LocalChangeWatcher =>
  open(deps, { quietMs: QUIET_MS, timer: REAL_TIMER });

/**
 * The same watcher on a clock a test advances by hand.
 *
 * **A separate function, visible in review**, the way `Session.forTests` is: the value under test here
 * is *when*, and a suite that waited five real seconds per case is one nobody runs — but a production
 * path that silently accepted a fake clock is a worse trade than the typing this costs.
 */
export const forTests = (deps: LocalChangeDeps, pacing: Pacing): LocalChangeWatcher => open(deps, pacing);
