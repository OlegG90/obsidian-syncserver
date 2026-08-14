/**
 * The pairing coordinator: the one owner of "join an account" and "approve a device".
 *
 * Both halves lived inside the settings tab — the loop, the cancel flag, the second between
 * attempts, and every sentence shown to the person. That is the same shape `sync.ts` was
 * extracted from, for the same reason: a `PluginSettingTab` cannot be constructed outside
 * Obsidian, so anything decided inside one is decided where no test can watch. Two of the
 * defects a real phone found on 14 August lived in that class.
 *
 * The decisions this module owns, and the settings tab no longer does:
 *
 * - a join needs a passphrase before anything is registered with the server;
 * - the code shown is the code sent — one value, generated once per attempt;
 * - waiting is a person walking between two devices, so attempts are a second apart and
 *   a cancel stops the next one rather than the current request;
 * - one attempt at a time, because a second would register a second pairing and show a
 *   second code while the first was still live.
 *
 * What it deliberately does NOT own: **normalising the code**. `Session` does that at both
 * of its entry points (a code is hashed there, and hashing the displayed form on one device
 * and the typed form on the other is exactly the bug that made pairing fail on real
 * hardware). Doing it here as well would state one rule in two places.
 */
import type { PairArgs } from './session/index.js';

export interface PairingFlowDeps {
  /** A fresh 128-bit code, grouped for reading. */
  newCode(): string;
  /** Join an account with this code, polling `waiting` between claim attempts. */
  join(args: PairArgs, waiting: () => Promise<boolean>): Promise<void>;
  /** Approve another device's pairing from this one. Needs the seed, so it may prompt. */
  approve(code: string): Promise<void>;
  /** Put the code in front of the person; called once, before any waiting. */
  showCode(code: string): void;
  /** The line under the code: waiting, cancelled, or what went wrong. */
  setStatus(text: string): void;
  /** A line for the user, with an optional duration in milliseconds. */
  notify(message: string, durationMs?: number): void;
  /** Sleep between claim attempts. Injected so a test does not wait in real seconds. */
  wait(ms: number): Promise<void>;
  /** The pairing finished; the screen showing it is now wrong and should be rebuilt. */
  done(): void;
}

export interface PairingFlow {
  /** The new device: show a code and wait for the other one to approve it. */
  join(args: Omit<PairArgs, 'pairingCode'>): Promise<void>;
  /** The connected device: take a code that was read off the other screen. */
  approve(code: string): Promise<void>;
  /** Stop waiting. Takes effect before the next attempt, not during the current one. */
  cancel(): void;
}

/** A second: long enough that a person is still walking, short enough not to feel stuck. */
const BETWEEN_ATTEMPTS_MS = 1000;

export const openPairingFlow = (deps: PairingFlowDeps): PairingFlow => {
  // Set synchronously before any await, for the reason `sync.ts` gives: a second press
  // while the first attempt waits would register a second pairing and show a second code,
  // and only one of them could ever be approved.
  let running = false;
  let cancelled = false;

  return {
    async join(args) {
      if (running) {
        deps.notify('SyncServer: already waiting for approval.');
        return;
      }
      if (!args.passphrase) {
        // Checked before a code exists: registering a pairing the person cannot finish
        // would leave it waiting on the server for its full ten minutes.
        deps.notify('SyncServer: the account’s passphrase is required.');
        return;
      }

      running = true;
      cancelled = false;
      const pairingCode = deps.newCode();
      deps.showCode(pairingCode);
      deps.setStatus('Waiting for approval…');

      try {
        await deps.join({ ...args, pairingCode }, async () => {
          if (cancelled) return false;
          await deps.wait(BETWEEN_ATTEMPTS_MS);
          return true;
        });
        deps.notify('SyncServer: paired.');
        deps.done();
      } catch (e) {
        // Twice, and on purpose: the notice is seen, and the line under the code is where
        // somebody who has been staring at that code will look.
        const message = e instanceof Error ? e.message : String(e);
        deps.setStatus(message);
        deps.notify(`SyncServer: ${message}`, 10000);
      } finally {
        running = false;
      }
    },

    async approve(code) {
      // Emptiness is a UI question and is asked here; what the code *is* — dashes, case,
      // a misread `O` for `0` — is the session's, at the point it hashes.
      if (!code.trim()) {
        deps.notify('SyncServer: enter the code shown on the other device.');
        return;
      }
      try {
        await deps.approve(code);
        deps.notify('SyncServer: approved. The other device should finish on its own.');
      } catch (e) {
        deps.notify(`SyncServer: ${e instanceof Error ? e.message : String(e)}`, 10000);
      }
    },

    cancel() {
      cancelled = true;
      deps.setStatus('Cancelled.');
    },
  };
};
