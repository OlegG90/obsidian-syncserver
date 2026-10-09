/**
 * Whether the server answers, read off the requests this device already makes (#441).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HttpResponse, Transport } from '../src/api/transport.js';
import { watchContact, type Contact } from '../src/contact.js';
import { contactLine, phaseIcon, shortStatus, statusLines } from '../src/obsidian/status.js';

const answered: HttpResponse = { status: 409, headers: {}, text: () => '{"error":"rev_mismatch"}', bytes: new Uint8Array() };

describe('watching the transport (#441)', () => {
  it('counts any status as an answer, and a throw as no answer, keeping when it started', async () => {
    let clock = 1000;
    let online = true;
    const inner: Transport = async () => {
      if (!online) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      return answered;
    };
    const kinds: string[] = [];
    const watch = watchContact(inner, (c) => kinds.push(c.kind), () => clock);
    assert.deepEqual(watch.current(), { kind: 'unknown' });

    await watch.transport({ method: 'GET', url: 'x', headers: {} });
    assert.deepEqual(watch.current(), { kind: 'answered', at: 1000 }, 'a refusal is still the server answering');

    online = false;
    clock = 2000;
    await assert.rejects(watch.transport({ method: 'GET', url: 'x', headers: {} }));
    clock = 3000;
    watch.unreachable('timed out after 5000ms');
    assert.deepEqual(watch.current(), { kind: 'unreachable', since: 2000, reason: 'timed out after 5000ms' }, 'since the first failure');

    online = true;
    await watch.transport({ method: 'GET', url: 'x', headers: {} });
    assert.deepEqual(kinds, ['answered', 'unreachable', 'answered'], 'surfaces repaint on a change of kind, not per request');
  });
});

describe('what the status says about it (#441)', () => {
  const away: Contact = { kind: 'unreachable', since: 0, reason: 'net::ERR_NAME_NOT_RESOLVED' };
  const conn = { serverUrl: 'http://sync.example:8287', login: 'oleh', vaultId: 'v' };

  it('says offline rather than locked when the server cannot be reached', () => {
    assert.equal(shortStatus({ kind: 'locked' }, away), 'Sync: offline');
    assert.equal(phaseIcon({ kind: 'locked' }, away), 'wifi-off');
    assert.equal(shortStatus({ kind: 'locked' }), 'Sync: locked', 'and locked when nothing says otherwise');
    assert.equal(shortStatus({ kind: 'locked' }, { kind: 'answered', at: 0 }), 'Sync: locked');
  });

  it('leaves a pass under way and a failed one their own words', () => {
    assert.equal(shortStatus({ kind: 'syncing' }, away), 'Sync: working…');
    assert.equal(shortStatus({ kind: 'failed', message: 'x', at: 0 }, away), 'Sync: failed');
  });

  it('puts a connection line under the server, and an offline state in place of locked', () => {
    const lines = statusLines({ kind: 'locked' }, conn, undefined, away);
    assert.equal(lines[0], 'Server: http://sync.example:8287');
    assert.match(lines[1]!, /^Connection: cannot reach the server since .* — no network, or the server is not running \(net::ERR_NAME_NOT_RESOLVED\)\.$/);
    assert.ok(lines.some((l) => l.startsWith('State: offline — the session opens once the server answers')));
    assert.ok(!lines.some((l) => l.startsWith('State: locked')));
  });

  it('says when it last answered, and that it has not been asked', () => {
    assert.match(contactLine({ kind: 'answered', at: 0 }), /^Connection: the server answered at /);
    assert.equal(contactLine({ kind: 'unknown' }), 'Connection: not asked yet this session.');
  });
});
