/**
 * The four acts, and the order they happen in.
 *
 * Both halves were untestable before: the rule lived as six re-typed lines inside a 1228-line class
 * that imports `obsidian` at run time, so nothing could ask it a question. What is asked here is the
 * invariant — the connection and the sync ledger move together, and only where they should — and the
 * ordering that makes the invariant hold at every instant, not only at the end.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openSessionHold, type HoldDeps, type HoldRecord } from '../src/session-hold.js';
import type { Connection, Session } from '../src/session/index.js';
import type { SyncPhase } from '../src/obsidian/status.js';

const connection = (over: Partial<Connection> = {}): Connection =>
  ({
    serverUrl: 'https://example.test',
    login: 'oleh',
    deviceId: 'device-1',
    vaultId: 'vault-1',
    wrappedSeed: 'sealed',
    accountSalt: 'salt',
    kdfParams: { m: 65536, t: 3, p: 1 },
    ...over,
  }) as Connection;

const sessionWith = (conn: Connection): Session => ({ connection: conn }) as unknown as Session;

/**
 * Deps that record what they were asked to do, in the order they were asked.
 *
 * The same double the real adapter's tests use (`made`, `written`, `modified` in `adapter.test.ts`):
 * a list of strings is what makes an ordering assertion readable, and readable is what makes it
 * survive somebody rearranging the module for a reason that sounded good at the time.
 */
const recorder = () => {
  const calls: string[] = [];
  const records: HoldRecord[] = [];
  let held: Session | undefined | 'never set' = 'never set';

  const deps: HoldDeps = {
    hold: (s) => {
      held = s;
      calls.push(s ? 'hold' : 'hold:none');
    },
    record: async (what) => {
      records.push(what);
      calls.push(what.state ? `record:${what.state}` : 'record');
    },
    phase: (p: SyncPhase) => void calls.push(`phase:${p.kind}`),
    push: (what) => void calls.push(`push:${what}`),
  };

  return { deps, calls, records, held: () => held };
};

describe('taking a session', () => {
  it('empties the sync ledger, because adoption has to run', async () => {
    const r = recorder();
    const conn = connection();
    await openSessionHold(r.deps).take(sessionWith(conn));
    assert.deepEqual(r.records, [{ connection: conn, state: 'empty' }]);
  });

  /**
   * The whole order, as one assertion. Each step is here because moving it breaks something:
   * the socket must stop before the session changes under it, the session must be held before the
   * socket asks for its access token, and the file must be saved before any surface says `idle`.
   */
  it('happens in an order nothing can be moved in', async () => {
    const r = recorder();
    await openSessionHold(r.deps).take(sessionWith(connection()));
    assert.deepEqual(r.calls, ['push:stop', 'hold', 'record:empty', 'phase:idle', 'push:start']);
  });
});

describe('resuming a connection already written down', () => {
  it('leaves the ledger alone — this device is still looking at the same vault', async () => {
    const r = recorder();
    await openSessionHold(r.deps).resume(sessionWith(connection()));
    assert.deepEqual(r.records, [{ connection: r.records[0]!.connection }], 'no state key at all');
    assert.equal('state' in r.records[0]!, false);
  });

  it('comes back locked, not idle — the seed was never written down', async () => {
    const r = recorder();
    await openSessionHold(r.deps).resume(sessionWith(connection()));
    assert.deepEqual(r.calls, ['push:stop', 'hold', 'record', 'phase:locked', 'push:start']);
  });

  /**
   * Moving to another server is this act with one field changed, which is the point of taking a
   * session rather than a URL: the difference between the two callers stops being two blocks.
   */
  it('is also how a device moves to another server', async () => {
    const r = recorder();
    const moved = connection({ serverUrl: 'https://elsewhere.test' });
    await openSessionHold(r.deps).resume(sessionWith(moved));
    assert.equal(r.records[0]!.connection?.serverUrl, 'https://elsewhere.test');
    assert.equal(r.calls[0], 'push:stop', 'the old socket is closed before the new address is written');
  });
});

describe('keeping a re-wrapped envelope', () => {
  /**
   * A passphrase change hands back a new `wrappedSeed`. The session keeps running and the phase keeps
   * saying what it said — so this must NOT go through the transition, or a healthy socket would be
   * closed and reopened to write one field.
   */
  it('writes the connection and touches nothing else', async () => {
    const r = recorder();
    await openSessionHold(r.deps).keep(sessionWith(connection({ wrappedSeed: 're-sealed' })));
    assert.deepEqual(r.calls, ['record']);
    assert.equal(r.records[0]!.connection?.wrappedSeed, 're-sealed');
  });
});

describe('releasing', () => {
  it('erases both halves, never one', async () => {
    const r = recorder();
    await openSessionHold(r.deps).release();
    assert.deepEqual(r.records, [{ connection: undefined, state: 'erase' }]);
  });

  it('stops the socket before the session goes, and never starts it again', async () => {
    const r = recorder();
    await openSessionHold(r.deps).release();
    assert.deepEqual(r.calls, ['push:stop', 'hold:none', 'record:erase', 'phase:disconnected']);
    assert.equal(r.held(), undefined);
  });
});

describe('the invariant, across all four', () => {
  /**
   * The one #303 broke, stated once. A device's identity and its private account of what it has
   * synced are written by the same call or not at all — never one without the other.
   */
  it('never moves the ledger without the connection', async () => {
    const r = recorder();
    const hold = openSessionHold(r.deps);
    const s = sessionWith(connection());

    await hold.take(s);
    await hold.resume(s);
    await hold.keep(s);
    await hold.release();

    for (const rec of r.records) {
      if (rec.state === undefined) continue;
      const moved = rec.state === 'erase' ? rec.connection === undefined : rec.connection !== undefined;
      assert.ok(moved, `state ${rec.state} without the matching connection`);
    }
    assert.equal(r.records.length, 4, 'every act writes exactly once');
  });
});
