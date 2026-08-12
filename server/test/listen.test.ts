/**
 * The `LISTEN` reconnect cycle, driven with a scripted connection.
 *
 * `Db.listen`'s interface promises that a dropped connection is re-established with a
 * short backoff. Against a healthy PostgreSQL that promise is reachable only by killing
 * the backend — events.test.ts does that end to end. Here the same state machine, behind
 * its injected connection factory, is driven with a fake so the two races the design had
 * are pinned down deterministically:
 *
 * - a socket drop fires `error` **and** `end`, and the teardown must run once — a second
 *   restart would start a second connect and leak the losing connection;
 * - `stop()` may land between two awaits of a connect in flight, and the connection must
 *   be returned unsubscribed, or `close()` waits on it forever.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { subscribe, type ListenConnection, type NotificationMsg } from '../src/listen.js';

class FakeConnection implements ListenConnection {
  readonly queries: string[] = [];
  released = false;
  private readonly listeners = new Map<string, ((msg?: NotificationMsg) => void)[]>();

  constructor(private readonly failListen = false) {}

  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    if (this.failListen && sql.startsWith('LISTEN ')) throw new Error('protocol error');
  }

  on(event: string, listener: (msg?: NotificationMsg) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  release(): void {
    this.released = true;
  }

  fire(event: 'error' | 'end'): void {
    for (const l of this.listeners.get(event) ?? []) l();
  }

  deliver(payload: string): void {
    for (const l of this.listeners.get('notification') ?? []) l({ payload });
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('Db.listen reconnect cycle', () => {
  it('delivers a notification payload on the subscribed channel', async () => {
    const conn = new FakeConnection();
    const seen: string[] = [];
    const sub = subscribe('sync_test', (p) => seen.push(p), async () => conn, { backoffMs: 1 });
    await flush();
    assert.deepEqual(conn.queries, ['LISTEN sync_test']);
    conn.deliver('vault-1');
    await flush();
    assert.deepEqual(seen, ['vault-1']);
    await sub.stop();
  });

  it('reconnects exactly once when a socket drop fires both error and end', async () => {
    const conns: FakeConnection[] = [];
    const seen: string[] = [];
    const factory = async (): Promise<ListenConnection> => {
      const c = new FakeConnection();
      conns.push(c);
      return c;
    };
    const sub = subscribe('sync_test', (p) => seen.push(p), factory, { backoffMs: 1 });
    await flush();
    assert.equal(conns.length, 1, 'one connection to start');

    conns[0]!.deliver('before');
    conns[0]!.fire('error');
    conns[0]!.fire('end');

    await sleep(15);
    await flush();
    assert.equal(conns.length, 2, 'exactly one reconnect, not two');
    assert.equal(conns[0]!.released, true, 'the dead connection was released');
    assert.ok(conns[1]!.queries.includes('LISTEN sync_test'), 'the replacement subscribed');

    conns[0]!.deliver('stale'); // queued on the dead connection: must not double-fire
    conns[1]!.deliver('after');
    await flush();
    assert.deepEqual(seen, ['before', 'after']);
    await sub.stop();
  });

  it('retries when the LISTEN itself fails', async () => {
    const conns: FakeConnection[] = [];
    const factory = async (): Promise<ListenConnection> => {
      const c = new FakeConnection(conns.length === 0);
      conns.push(c);
      return c;
    };
    const sub = subscribe('sync_test', () => {}, factory, { backoffMs: 1 });
    await sleep(15);
    await flush();
    assert.equal(conns.length, 2, 'retried after the failed LISTEN');
    assert.equal(conns[0]!.released, true);
    assert.equal(conns[1]!.released, false);
    await sub.stop();
  });

  it('delivers nothing after stop()', async () => {
    const conn = new FakeConnection();
    const seen: string[] = [];
    const sub = subscribe('sync_test', (p) => seen.push(p), async () => conn, { backoffMs: 1 });
    await flush();
    await sub.stop();
    conn.deliver('late');
    await flush();
    assert.deepEqual(seen, []);
  });

  it('does not reconnect after stop()', async () => {
    let calls = 0;
    let conn: FakeConnection | undefined;
    const factory = async (): Promise<ListenConnection> => {
      calls++;
      conn = new FakeConnection();
      return conn;
    };
    const sub = subscribe('sync_test', () => {}, factory, { backoffMs: 1 });
    await flush();
    assert.equal(calls, 1);
    await sub.stop();
    conn!.fire('error');
    conn!.fire('end');
    await sleep(15);
    assert.equal(calls, 1, 'a drop after stop schedules nothing');
  });

  it('stop() releases a connection that was still connecting', async () => {
    let resolveConnect!: (c: ListenConnection) => void;
    const pending = new FakeConnection();
    const factory = () =>
      new Promise<ListenConnection>((resolve) => {
        resolveConnect = resolve;
      });

    const sub = subscribe('sync_test', () => {}, factory, { backoffMs: 1 });
    await flush();
    assert.ok(resolveConnect, 'the factory was asked for a connection');

    let stopped = false;
    const stopP = sub.stop().then(() => {
      stopped = true;
    });
    await flush();
    assert.equal(stopped, false, 'stop waits for the connect that is in flight');

    resolveConnect(pending);
    await stopP;
    assert.equal(pending.queries.length, 0, 'a connection after stop never subscribes');
    assert.equal(pending.released, true, 'it is returned to the pool instead');
  });
});
