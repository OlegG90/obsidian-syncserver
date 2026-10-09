/**
 * Whether the server has been answering, as this device last saw it (#441).
 *
 * The status said `locked` while the computer was offline. That was true and pointed at the wrong
 * thing: the session was closed because nothing could open it, and a person reading `locked` goes
 * looking for a passphrase prompt that would only fail. What was missing is a fact the plugin already
 * had and threw away — every request either came back or did not.
 *
 * So the transport is watched rather than the server pinged on a clock: a request that comes back is
 * an answer, whatever its status, and one that throws is not. A ping on a timer would cost requests for
 * a line somebody reads twice a day, and would be out of date between ticks anyway.
 *
 * **What it records is the last outcome, not a guarantee.** Answered at 14:03 says nothing about
 * 14:05. The status says the time with it, for that reason.
 */
import type { Transport } from './api/transport.js';

export type Contact =
  | { kind: 'unknown' }
  | { kind: 'answered'; at: number }
  | { kind: 'unreachable'; since: number; reason: string };

export interface ContactWatch {
  /** The transport to hand every client, which reports back here. */
  transport: Transport;
  current(): Contact;
  /** For a failure found above the transport — a wait `SyncClient` gave up on. */
  unreachable(reason: string): void;
}

/**
 * Watch a transport's outcomes.
 *
 * `changed` fires only when the kind changes — answered to unreachable and back — because each
 * answer during a pass would otherwise repaint every surface once per request. A surface that wants
 * the time reads `current()` when it draws.
 */
export const watchContact = (inner: Transport, changed: (c: Contact) => void, now: () => number = Date.now): ContactWatch => {
  let contact: Contact = { kind: 'unknown' };
  const set = (next: Contact): void => {
    const kindChanged = next.kind !== contact.kind;
    contact = next;
    if (kindChanged) changed(next);
  };
  const unreachable = (reason: string): void =>
    set({ kind: 'unreachable', since: contact.kind === 'unreachable' ? contact.since : now(), reason });

  return {
    transport: async (req) => {
      try {
        const res = await inner(req);
        set({ kind: 'answered', at: now() });
        return res;
      } catch (e) {
        unreachable(e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    current: () => contact,
    unreachable,
  };
};
