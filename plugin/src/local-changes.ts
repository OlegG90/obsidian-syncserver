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
  quietMs?: number;
  timer?: Timer;
}

export interface LocalChangeWatcher {
  /** Something in the vault changed. Cheap and synchronous — it is called from an editor event. */
  touched(): void;
  /** Whether a pass is currently waiting on the quiet period. */
  waiting(): boolean;
  /** Unregister: the plugin is unloading, or automatic syncing was turned off. */
  stop(): void;
}

const REAL_TIMER: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const watchLocalChanges = (deps: LocalChangeDeps): LocalChangeWatcher => {
  const quietMs = deps.quietMs ?? QUIET_MS;
  const timer = deps.timer ?? REAL_TIMER;
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
      // the ones after a reload.
      if (!deps.enabled()) return clear();
      arm();
    },
    waiting: () => handle !== undefined,
    stop: clear,
  };
};
