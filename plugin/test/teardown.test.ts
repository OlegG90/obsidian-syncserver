/**
 * The one rule unloading has: every step runs.
 *
 * Testable only because it lives outside `main.ts`, which imports `obsidian`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { teardownStep } from '../src/teardown.js';

describe('a teardown step', () => {
  it('lets the next one happen after a throw', async () => {
    const done: string[] = [];
    const said: string[] = [];
    const complain = (m: string): void => void said.push(m);

    await teardownStep('stop the watcher', () => { done.push('watcher'); }, complain);
    await teardownStep('close the socket', () => { throw new Error('socket was already gone'); }, complain);
    await teardownStep('remove the styles', () => { done.push('styles'); }, complain);

    // The third is the point: without the guard the second would have ended the unload, and
    // Obsidian's own cleanup — the ribbon item among it — would never have run either.
    assert.deepEqual(done, ['watcher', 'styles']);
    assert.equal(said.length, 1);
  });

  it('survives a rejected promise, not only a thrown error', async () => {
    const said: unknown[] = [];
    await teardownStep('close the socket', () => Promise.reject(new Error('no')), (m, e) => void said.push([m, e]));
    assert.equal(said.length, 1);
  });

  it('names what failed, so a log line is worth reading', async () => {
    let message = '';
    await teardownStep('close the push connection', () => { throw new Error('x'); }, (m) => { message = m; });
    assert.match(message, /close the push connection/);
    assert.match(message, /unloading/);
  });

  it('says nothing when a step succeeds', async () => {
    let called = false;
    await teardownStep('do the thing', () => undefined, () => { called = true; });
    assert.equal(called, false);
  });
});
