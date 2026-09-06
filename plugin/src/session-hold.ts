/**
 * What this device is holding an account by, and the four ways that changes.
 *
 * `BoundVault` is one opening of one vault; this is its longer-lived twin — one device's grip on one
 * account, which outlives every opening and is what a restart finds waiting. Four acts change it and
 * nothing else may:
 *
 * - **take** — a session was just opened for the first time on this device: a fresh account, a
 *   recovery, or a pairing. The sync ledger is emptied, because a vault reached this way may hold
 *   nothing or an old copy of everything, and only adoption can tell which (docs/07);
 * - **resume** — a connection that was already written down becomes a session again. Nothing is
 *   emptied: this device's ledger describes the vault it is still looking at;
 * - **keep** — the connection changed under a live session. One thing does this: a passphrase change
 *   re-wraps the seed, and a file left holding the old envelope asks for a passphrase that no longer
 *   opens anything;
 * - **release** — the device lets go. Both halves are erased.
 *
 * **The rule this exists to hold is that the connection and the ledger move together.** It used to be
 * a sentence in a comment, and the six lines that enforce it were re-typed at three sites while a
 * private method containing exactly those lines sat between them, used by two others. That is the
 * shape #303 was: a device that holds one device's identity and another's account of what it has
 * synced looks perfectly healthy and writes conflict files for ever. `checks/check-connection-writes.mjs`
 * refuses an assignment to `data.connection` anywhere but here, because the recurrence to guard
 * against is not a wrong rule — it is somebody with one more field to write, doing it on the spot.
 *
 * **It does not own the session.** `this.sess` is read in seventeen places across the plugin, and a
 * module that owned the field would be a middle man for all of them. It owns the transition and hands
 * the session to `hold`; the field stays where it was.
 *
 * **Every act stops the change-notification socket first**, which is free when none is running
 * (`stopPush` awaits an optional) and necessary when one is: a socket opened against the previous
 * connection would keep delivering revisions for a vault this device no longer holds.
 */
import type { Connection, Session } from './session/index.js';
import type { SyncPhase } from './obsidian/status.js';

/**
 * What to write down, as one instruction.
 *
 * The save is inside it, deliberately: "written but not saved" is not a state anything wants, and it
 * is the worst thing this module could leave behind — a file that still names the old server, or the
 * old wrapped seed, after the session in memory has moved on.
 */
export interface HoldRecord {
  /** The connection to write down; `undefined` erases it. */
  connection: Connection | undefined;
  /**
   * Present only when the sync ledger moves too.
   *
   * `'empty'` starts adoption — the pass walks the vault and reconciles it against the server rather
   * than trusting an account of a history this device may not share. `'erase'` removes it with the
   * connection.
   */
  state?: 'empty' | 'erase';
}

export interface HoldDeps {
  /** Put the session where the rest of the plugin reads it, or take it away. */
  hold(s: Session | undefined): void;
  /** Write the connection — and the ledger, when it moves — and save. */
  record(what: HoldRecord): Promise<void>;
  /** What every surface renders. */
  phase(p: SyncPhase): void;
  /** The change-notification socket. Starting is a no-op without a connection, stopping without one. */
  push(what: 'start' | 'stop'): Promise<void> | void;
}

export interface SessionHold {
  /** A session opened here for the first time: connecting, recovering, or pairing. */
  take(s: Session): Promise<void>;
  /** A connection already written down, made into a session again. */
  resume(s: Session): Promise<void>;
  /** The connection changed under a live session; nothing else moves. */
  keep(s: Session): Promise<void>;
  /** Let go of the account locally. The caller does whatever must happen on the server first. */
  release(): Promise<void>;
}

export const openSessionHold = (deps: HoldDeps): SessionHold => {
  /**
   * The order is the invariant, not an implementation detail.
   *
   * The session goes in before the socket opens, because the socket asks for its access token; and
   * the record is saved before the phase says `idle`, because a surface reading "up to date" over a
   * file that still describes the previous account is a lie a person acts on.
   */
  const settle = async (s: Session | undefined, what: HoldRecord, phase: SyncPhase): Promise<void> => {
    await deps.push('stop');
    deps.hold(s);
    await deps.record(what);
    deps.phase(phase);
    if (s) await deps.push('start');
  };

  return {
    take: (s) => settle(s, { connection: s.connection, state: 'empty' }, { kind: 'idle' }),

    resume: (s) => settle(s, { connection: s.connection }, { kind: 'locked' }),

    // The one act that is not a transition: the session keeps running, the phase keeps saying what it
    // said, and only the file changes. Routing it through `settle` would stop and restart a healthy
    // socket to write one field.
    keep: (s) => deps.record({ connection: s.connection }),

    release: () => settle(undefined, { connection: undefined, state: 'erase' }, { kind: 'disconnected' }),
  };
};
