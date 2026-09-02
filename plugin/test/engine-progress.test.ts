/**
 * The walk says how far it has got (#319).
 *
 * `pass-progress.test.ts` decides what those numbers mean; this asks whether they arrive at all, and
 * whether a listener can hurt the pass. The second question is the one worth a test: a surface that
 * throws while redrawing must not cost somebody their upload, and that is a `try` nobody would notice
 * had been deleted.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Delta } from '@syncserver/shared';

import { vaultKey } from '../src/crypto/account.js';
import { randomBytes } from '../src/crypto/bytes.js';
import { SyncEngine } from '../src/engine/engine.js';
import { FakeVault } from './fake-vault.js';
import { openedWith, OneFileWire, Store, type VaultConstants } from './one-file-wire.js';
import { scopesOf } from './vault-scopes.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const V: VaultConstants = { vaultId, rootNodeId: 'root', scopeId: 'scope-vault', kv: vaultKey(randomBytes(32), vaultId) };
const continuous: Delta = { changes: [], events: [], next_cursor: 'cursor-new', has_more: false };

const engineOver = (vault: FakeVault) =>
  new SyncEngine(new OneFileWire(V, [], continuous), vaultId, scopesOf(openedWith(V), V.kv), vault, new Store({ nodes: {} }));

const vaultOf = (...paths: string[]): FakeVault => {
  const vault = new FakeVault();
  for (const p of paths) vault.seed(p, `contents of ${p}`);
  return vault;
};

describe('a pass reports its own progress', () => {
  it('counts every file once, and ends on the total', async () => {
    const vault = vaultOf('a.md', 'b.md', 'c.md');
    const seen: { done: number; total: number }[] = [];

    await engineOver(vault).sync({ onProgress: (p) => seen.push(p) });

    assert.deepEqual(seen, [
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });

  it('says nothing when there is nothing to walk', async () => {
    const seen: unknown[] = [];
    await engineOver(new FakeVault()).sync({ onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen, []);
  });

  it('runs a pass unchanged when nobody is listening', async () => {
    const vault = vaultOf('a.md');
    const report = await engineOver(vault).sync();
    assert.equal(report.pushed.length, 1);
  });

  /**
   * The listener is a surface, and surfaces throw. `Gate` learned this the same way (#233): a
   * redraw that fails must not take the operation down with it, because the operation's `finally`
   * is what releases the gate — and here it is somebody's first upload of a whole vault.
   */
  it('finishes the pass when the listener throws on every file', async () => {
    const vault = vaultOf('a.md', 'b.md');
    let calls = 0;

    const report = await engineOver(vault).sync({
      onProgress: () => {
        calls += 1;
        throw new Error('the surface fell over');
      },
    });

    assert.equal(calls, 2, 'it is still called for the second file');
    assert.equal(report.pushed.length, 2, 'and both files went up');
    assert.equal(report.errors.length, 0, 'a listener failing is not a file failing');
  });
});
