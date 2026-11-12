/**
 * Binding a vault: one opening, by one id, and a vault that is gone said as such.
 *
 * The plugin's root used to assemble this by hand in three methods that each read the vault id from
 * the settings, so "the engine is built for the vault whose scopes it was handed" held only while the
 * three reads agreed. These tests hold it without Obsidian: a client that records what it was asked.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenedVault } from '@syncserver/shared';

import { ApiError, type SyncClient } from '../src/api/client.js';
import { bindVault, type VaultBinding } from '../src/bound-vault.js';
import { randomBytes } from '../src/crypto/bytes.js';
import type { TreeCache } from '../src/engine/tree-cache.js';
import type { StateStore } from '../src/engine/state.js';
import type { VaultAdapter } from '../src/engine/vault.js';
import { VAULT_GONE } from '../src/vault-removal.js';

const opened: OpenedVault = { root_node_id: 'root', head_rev: 1, scopes: [{ scope: 'vault', key_id: 'scope-vault' }] };

/** A client whose only answer is `openVault`, recording every id it was asked for. */
const clientAnswering = (answer: () => Promise<OpenedVault>) => {
  const asked: string[] = [];
  const client = { openVault: (id: string) => (asked.push(id), answer()) } as unknown as SyncClient;
  return { client, asked };
};

const handle = (client: SyncClient) => ({
  client,
  kv: randomBytes(32),
  userId: 'user',
  openIdentity: () => randomBytes(32),
  treeCache: {} as TreeCache,
});

const binding: VaultBinding = {
  vaultId: 'vault-1',
  vault: {} as VaultAdapter,
  store: {} as StateStore,
  deviceLabel: 'laptop',
  syncObsidian: false,
};

describe('binding a vault', () => {
  it('opens it once, by the binding’s id, and names that id', async () => {
    const { client, asked } = clientAnswering(async () => opened);
    const v = await bindVault(handle(client), binding);
    assert.deepEqual(asked, ['vault-1']);
    assert.equal(v.id, 'vault-1');
    assert.equal(v.client, client);
    assert.equal(v.scopes.opened, opened, 'the scopes come from this opening, not another');
  });

  it('says a vault is gone when the server has no such vault (#175)', async () => {
    const { client } = clientAnswering(async () => {
      throw new ApiError(404, 'not_found', '{}');
    });
    await assert.rejects(bindVault(handle(client), binding), (e: Error) => e.message === VAULT_GONE);
  });

  it('lets any other refusal through as itself', async () => {
    const refusal = new ApiError(503, 'unavailable', '{}');
    const { client } = clientAnswering(async () => {
      throw refusal;
    });
    await assert.rejects(bindVault(handle(client), binding), (e) => e === refusal);
  });
});
