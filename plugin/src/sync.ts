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
import type { PassOptions, SyncReport } from './engine/engine.js';
import { eventSentence, priority, summary } from './engine/report.js';
import type { SyncPhase } from './obsidian/status.js';
import { busyLine, type Gate } from './gate.js';

export interface SyncCoordinatorDeps {
  /** The one gate every operation family shares — one operation at a time, across all of them. */
  gate: Gate;
  /** `'none'` before a connection exists, otherwise the session's own state. */
  sessionState(): 'none' | 'locked' | 'open';
  /** Unlock with the passphrase. False means refused; a thrown error is a failed pass. */
  unlock(passphrase: string): Promise<boolean>;
  /** Ask for the passphrase; undefined means dismissed. Never called without permission to prompt. */
  askPassphrase(): Promise<string | undefined>;
  /**
   * Run one engine pass. Called only with an open session.
   *
   * `rescan` reads every file rather than trusting the recorded `mtime`/`size` (issue #237) — the way
   * back when a timestamp lied, which a restore from backup or another sync tool can make it do.
   */
  runPass(opts: PassOptions): Promise<SyncReport>;
  /** The phase changed — the status bar and anything else that renders it. */
  setPhase(phase: SyncPhase): void;
  /** A line for the user, with an optional duration in milliseconds. */
  notify(message: string, durationMs?: number): void;
}

export interface SyncCoordinator {
  /** The manual path: unlock (prompting when locked), one pass, render. */
  run(opts?: PassOptions): Promise<void>;
  /**
   * A pass nobody asked for: runs only with an open session and nothing else in flight, prompts for
   * nothing, and says nothing unless something moved or needs a person.
   *
   * Two callers, and they are the same kind of caller: the change-notification socket (`push.ts`) and
   * the vault settling after a local edit (`local-changes.ts`).
   */
  runIfIdle(): Promise<void>;
}

export const openSyncCoordinator = (deps: SyncCoordinatorDeps): SyncCoordinator => {
  /**
   * One pass.
   *
   * **`attended` is the whole of "did a person ask for this"**, and everything that differs between a
   * press and a pass the plugin started for itself hangs off it: whether the passphrase may be asked
   * for, and whether an outcome nobody is waiting on is worth a notice. Named for the question rather
   * than for the prompt, because since #238 the unattended path is the common one — the vault settling
   * starts far more passes than a button ever did.
   */
  const pass = async (attended: boolean, rescan = false): Promise<void> => {
    // The shared gate, taken synchronously before any await: a second call — manual or a
    // push hint — cannot slip past while the first waits on the passphrase or the pass. It
    // is the SAME gate the share and trash flows take, so a hint arriving mid-departure
    // finds it held and yields instead of meeting interior names with no key.
    if (!deps.gate.tryBegin('a sync')) {
      if (attended) deps.notify(`SyncServer: ${busyLine(deps.gate.holding() ?? 'another operation')}`, 8000);
      return;
    }
    try {
      const state = deps.sessionState();
      if (state === 'none') {
        // **Only when somebody asked.** Unattended, this is the answer to a question nobody put: an
        // installed-but-unconnected vault would otherwise raise this notice a few seconds after every
        // edit, for ever, which is what automatic syncing turned a one-off sentence into (#238). The
        // ribbon and the status bar already say `not connected`, permanently and without interrupting.
        if (attended) deps.notify('SyncServer: not connected. Open the plugin settings first.');
        return;
      }
      if (state === 'locked') {
        // A background pass never asks for the passphrase, and says nothing either — the phase is
        // already `locked` on every surface that renders one, and repeating it as a notice on each
        // edit would be the same spam by another name. What a person needs to know is that the sync
        // is locked, which is on the ribbon; what they do about it is unlock, which starts a pass.
        if (!attended) return;
        const passphrase = await deps.askPassphrase();
        if (!passphrase) return; // dismissed
        if (!(await deps.unlock(passphrase))) return; // refused
      }
      deps.setPhase({ kind: 'syncing' });
      const report = await deps.runPass({ rescan });
      deps.setPhase({ kind: 'idle', at: Date.now(), report });
      render(report, attended);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      deps.setPhase({ kind: 'failed', message, at: Date.now() });
      deps.notify(`SyncServer: ${message}`, 10000);
    } finally {
      deps.gate.end();
    }
  };

  /**
   * The post-pass render: one line that says what happened, then each thing that needs a person named
   * individually — "3 failed" (or "3 conflicts") is not actionable by count.
   *
   * **A pass nobody asked for says nothing when nothing happened** (issue #238). Automatic syncing turns
   * one notice per press into one every time the vault settles, and "nothing changed" arriving all day
   * is how a person learns to dismiss the notices that matter. So the summary is skipped for an
   * unattended pass with an empty summary — and only the summary. Errors, conflicts, quarantines and
   * account states are told either way: those are the ones nothing else on screen would say, and a
   * conflict arriving unasked is allowed precisely because it is still announced (D-124).
   */
  const render = (report: SyncReport, announce: boolean): void => {
    const parts = summary(report);
    // The "saw nothing" reading is the report module's `empty` mood, not a re-derived check.
    const head = parts.length ? parts.join(', ') : priority(report) === 'empty' ? 'vault looks empty' : 'nothing changed';
    if (announce || parts.length) deps.notify(`SyncServer: ${head} — ${report.scanned} local files seen.`);
    for (const e of report.errors.slice(0, 5)) deps.notify(`SyncServer: ${e.path} — ${e.message}`, 10000);
    for (const c of report.conflicts.slice(0, 5)) {
      deps.notify(`SyncServer: conflict — ${c.path}\nyour copy: ${c.conflictPath}`, 15000);
    }
    for (const q of report.quarantined.slice(0, 5)) {
      deps.notify(`SyncServer: vault was reset elsewhere — ${q.from} was kept as ${q.to}`, 15000);
    }
    // Last, and held longest: these are the two things nothing else on any screen would tell
    // somebody who never opens the settings — that a share they are in is over, and that
    // their account has stopped accepting anything.
    for (const e of report.events) deps.notify(`SyncServer: ${eventSentence(e)}`, 20000);
  };

  return {
    run: (opts) => pass(true, opts?.rescan ?? false),
    // Never a rescan: an unattended pass is the cheap path, and reading every file because something
    // arrived — or because somebody saved a note — is the opposite of what makes it cheap.
    runIfIdle: () => pass(false),
  };
};
