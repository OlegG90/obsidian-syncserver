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
 * **It does not take the shared gate, and that is a decision** (#131). `sync.ts`, `share-flow.ts`
 * and `history-flow.ts` share one gate so none of them can interleave with another; pairing
 * keeps a local flag instead. Approving writes one row — the pairing's envelope — and touches
 * nothing a sync touches, and the server serialises that row itself (`FOR UPDATE`) and refuses
 * a second approval outright. So the shared gate would buy nothing here and would cost
 * something real: approving is a person standing at two devices with a code that expires in
 * ten minutes, and making them wait for a sync to finish is the one moment where waiting is
 * expensive.
 *
 * What it deliberately does NOT own: **normalising the code**. `Session` does that at both
 * of its entry points (a code is hashed there, and hashing the displayed form on one device
 * and the typed form on the other is exactly the bug that made pairing fail on real
 * hardware). Doing it here as well would state one rule in two places.
 */
import { ApiError } from './api/client.js';
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
  /** Re-draw the live code and status into the current element — a rebuild must not lose them. */
  redraw(): void;
}

/**
 * What a pairing refusal means, in the words of the thing a person is doing.
 *
 * `409 already_settled` reached the screen exactly as that string. It is what the server says
 * when the pairing has already been approved or claimed — the ordinary cause being a second
 * press, or the other device having finished while this one was being read — and none of that
 * is legible in a status code.
 *
 * `not_found` covers three cases deliberately (docs/06): no such code, a mistyped one, and an
 * expired one. The server will not distinguish them, so neither can this sentence — it names
 * all three rather than guessing at one.
 */
const explain = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === 'already_settled') {
      return 'that code has already been approved — by this press or an earlier one. The other device should be finishing on its own.';
    }
    if (e.code === 'not_found') {
      return 'no pairing is waiting for that code. Check it against the other screen; codes last ten minutes, and one that has expired reads the same as one that never existed.';
    }
  }
  return e instanceof Error ? e.message : String(e);
};

/** A second: long enough that a person is still walking, short enough not to feel stuck. */
const BETWEEN_ATTEMPTS_MS = 1000;

export const openPairingFlow = (deps: PairingFlowDeps): PairingFlow => {
  // Set synchronously before any await, for the reason `sync.ts` gives: a second press
  // while the first attempt waits would register a second pairing and show a second code,
  // and only one of them could ever be approved.
  let running = false;
  let cancelled = false;
  /** The code currently being waited on — kept so a rebuild can draw it again. */
  let liveCode: string | undefined;
  /** The line under it — the status a rebuild has to put back. */
  let liveStatus: string | undefined;

  const show = (code: string): void => {
    liveCode = code;
    deps.showCode(code);
  };
  const status = (text: string): void => {
    liveStatus = text;
    deps.setStatus(text);
  };

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
      show(pairingCode);
      status('Waiting for approval…');

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
        status(message);
        deps.notify(`SyncServer: ${message}`, 10000);
      } finally {
        running = false;
        // The wait is over — the code is spent, and a later `redraw` must not resurrect it
        // as if the pairing were still live.
        liveCode = undefined;
      }
    },

    async approve(code) {
      // Emptiness is a UI question and is asked here; what the code *is* — dashes, case,
      // a misread `O` for `0` — is the session's, at the point it hashes.
      if (!code.trim()) {
        deps.notify('SyncServer: enter the code shown on the other device.');
        return;
      }
      // The SAME flag a join takes, and it was missing here entirely (#131): `running`
      // guarded the join and nothing guarded this, so two presses sent two approvals. The
      // server refuses the second — the row is taken `FOR UPDATE` and answers
      // `already_settled` — but a person who pressed twice would read that refusal as
      // something having gone wrong, when nothing did. One pairing act at a time on this
      // device, and the two halves are never both wanted at once anyway: a device joining an
      // account has no account to approve for.
      if (running) {
        deps.notify('SyncServer: a pairing is already under way on this device.');
        return;
      }
      running = true;
      try {
        await deps.approve(code);
        deps.notify('SyncServer: approved. The other device should finish on its own.');
      } catch (e) {
        deps.notify(`SyncServer: ${explain(e)}`, 10000);
      } finally {
        running = false;
      }
    },

    cancel() {
      cancelled = true;
      status('Cancelled.');
    },

    redraw() {
      // The settings tab is rebuilt on every display(); the element a held flow drew into
      // is gone, and the flow itself must draw the live state back into the fresh one.
      if (liveCode) show(liveCode);
      if (liveStatus) status(liveStatus);
    },
  };
};
