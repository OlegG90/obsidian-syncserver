/**
 * The sync coordinator: the one owner of "run a pass".
 *
 * The flow used to live inside main.ts: syncNow() opened the session, built the engine,
 * ran it, rendered, and guarded against re-entry only in the push callback — a manual
 * "Sync now" while a push-triggered sync ran would start a second engine over the same
 * `data.state`, and the session's `use()` explicitly serves concurrent callers
 * (session.test.ts). The sequence has an owner now: unlock, one pass, render, with the
 * re-entry guard inside the module so every entry point shares it.
 *
 * Two entry points differ only in whether they may ask for the passphrase. A push
 * notification is a hint (docs/04): it must never prompt, and it yields to whatever is
 * already running, because that sync will see the change anyway. The manual command
 * prompts when locked and says so when a sync is already running.
 *
 * Everything Obsidian is injected, so the module is testable where the plugin class is
 * not (sync.test.ts).
 */
import type { SyncReport } from './engine/engine.js';
import { summary } from './engine/report.js';
import type { SyncPhase } from './obsidian/status.js';

export interface SyncCoordinatorDeps {
  /** `'none'` before a connection exists, otherwise the session's own state. */
  sessionState(): 'none' | 'locked' | 'open';
  /** Unlock with the passphrase. False means refused; a thrown error is a failed pass. */
  unlock(passphrase: string): Promise<boolean>;
  /** Ask for the passphrase; undefined means dismissed. Never called without permission to prompt. */
  askPassphrase(): Promise<string | undefined>;
  /** Run one engine pass. Called only with an open session. */
  runPass(): Promise<SyncReport>;
  /** The phase changed — the status bar and anything else that renders it. */
  setPhase(phase: SyncPhase): void;
  /** A line for the user, with an optional duration in milliseconds. */
  notify(message: string, durationMs?: number): void;
}

export interface SyncCoordinator {
  /** The manual path: unlock (prompting when locked), one pass, render. */
  run(): Promise<void>;
  /** The push path: a hint — runs only when the session is open and nothing is running. */
  runIfIdle(): Promise<void>;
}

export const openSyncCoordinator = (deps: SyncCoordinatorDeps): SyncCoordinator => {
  // Set synchronously before any await, so a second call cannot slip past the guard while
  // the first waits on the passphrase prompt or the pass itself — that is the whole point.
  let running = false;

  const pass = async (prompt: boolean): Promise<void> => {
    if (running) {
      if (prompt) deps.notify('SyncServer: a sync is already running.');
      return;
    }
    running = true;
    try {
      const state = deps.sessionState();
      if (state === 'none') {
        deps.notify('SyncServer: not connected. Open the plugin settings first.');
        return;
      }
      if (state === 'locked') {
        if (!prompt) return; // a background hint never asks for the passphrase
        const passphrase = await deps.askPassphrase();
        if (!passphrase) return; // dismissed
        if (!(await deps.unlock(passphrase))) return; // refused
      }
      deps.setPhase({ kind: 'syncing' });
      const report = await deps.runPass();
      deps.setPhase({ kind: 'idle', at: Date.now(), report });
      render(report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.setPhase({ kind: 'failed', message, at: Date.now() });
      deps.notify(`SyncServer: ${message}`, 10000);
    } finally {
      running = false;
    }
  };

  // The post-pass render: one line that says what happened, then each thing that needs a
  // person named individually — "3 failed" (or "3 conflicts") is not actionable by count.
  const render = (report: SyncReport): void => {
    const parts = summary(report);
    const head = parts.length ? parts.join(', ') : report.scanned === 0 ? 'vault looks empty' : 'nothing changed';
    deps.notify(`SyncServer: ${head} — ${report.scanned} local files seen.`);
    for (const e of report.errors.slice(0, 5)) deps.notify(`SyncServer: ${e.path} — ${e.message}`, 10000);
    for (const c of report.conflicts.slice(0, 5)) {
      deps.notify(`SyncServer: conflict — ${c.path}\nyour copy: ${c.conflictPath}`, 15000);
    }
    for (const q of report.quarantined.slice(0, 5)) {
      deps.notify(`SyncServer: vault was reset elsewhere — ${q.from} was kept as ${q.to}`, 15000);
    }
  };

  return {
    run: () => pass(true),
    runIfIdle: () => pass(false),
  };
};
