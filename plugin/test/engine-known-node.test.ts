import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SyncClient } from '../src/api/client.js';
import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, toHex, utf8 } from '../src/crypto/bytes.js';
import { encryptName, nameHmac, wrapContentKey } from '../src/crypto/scope.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SyncEngine } from '../src/engine/engine.js';
import type { StateStore, VaultState } from '../src/engine/state.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const scopeId = 'scope-vault';
const nodeId = 'node-note';
const path = 'note.md';

class InitialStateStore implements StateStore {
  constructor(private state: VaultState) {}

  async load(): Promise<VaultState> {
    return structuredClone(this.state);
  }

  async save(state: VaultState): Promise<void> {
    this.state = structuredClone(state);
  }
}

class FakeSyncClient {
  putContentCalls = 0;

  private readonly remoteBytes: Uint8Array;
  private readonly remoteAddress: string;
  private readonly wrappedRemoteKey: string;

  constructor(
    private readonly kv: Uint8Array,
    remoteText: string,
  ) {
    const sealed = sealBlob(utf8(remoteText));
    this.remoteBytes = sealed.bytes;
    this.remoteAddress = sealed.sha256;
    this.wrappedRemoteKey = wrapContentKey(kv, sealed.contentKey);
  }

  get address(): string {
    return this.remoteAddress;
  }

  async openVault(_vaultId: string): Promise<{ root_node_id: string; head_rev: number; scopes: { scope: string; key_id: string }[] }> {
    return { root_node_id: rootNodeId, head_rev: 2, scopes: [{ scope: 'vault', key_id: scopeId }] };
  }

  async listNodes(_vaultId: string): Promise<{
    nodes: {
      node_id: string;
      parent_id: string | null;
      name_enc: string | null;
      name_hmac: string | null;
      name_key_id: string | null;
      op: 'put';
      rev: number;
      sha256: string | null;
      size: number | null;
      mtime: string;
      share_id: string | null;
      author_id: string | null;
    }[];
    snapshot: string;
  }> {
    return {
      snapshot: 'cursor-2',
      nodes: [
        {
          node_id: rootNodeId,
          parent_id: null,
          name_enc: null,
          name_hmac: null,
          name_key_id: null,
          op: 'put',
          rev: 1,
          sha256: null,
          size: null,
          mtime: new Date(0).toISOString(),
          share_id: null,
          author_id: null,
        },
        {
          node_id: nodeId,
          parent_id: rootNodeId,
          name_enc: encryptName(this.kv, path),
          name_hmac: nameHmac(this.kv, path),
          name_key_id: scopeId,
          op: 'put',
          rev: 2,
          sha256: this.remoteAddress,
          size: this.remoteBytes.length,
          mtime: new Date(1).toISOString(),
          share_id: null,
          author_id: null,
        },
      ],
    };
  }

  async dedupLookup(_vaultId: string, _tags: string[]): Promise<Map<string, string>> {
    return new Map();
  }

  async putBlob(_sealed: { sha256: string; bytes: Uint8Array; keyId: string }): Promise<{ sha256: string; size: number }> {
    return { sha256: _sealed.sha256, size: _sealed.bytes.length };
  }

  async createNode(): Promise<{ node_id: string; rev: number }> {
    throw new Error('createNode should not be called by these scenarios');
  }

  async putContent(): Promise<{ rev: number }> {
    this.putContentCalls++;
    return { rev: 3 };
  }

  async blobKeys(_vaultId: string, addresses: string[]): Promise<Map<string, { scopeId: string; wrappedKey: string }[]>> {
    const out = new Map<string, { scopeId: string; wrappedKey: string }[]>();
    if (addresses.includes(this.remoteAddress)) out.set(this.remoteAddress, [{ scopeId, wrappedKey: this.wrappedRemoteKey }]);
    return out;
  }

  async getBlob(address: string): Promise<Uint8Array | undefined> {
    return address === this.remoteAddress ? this.remoteBytes : undefined;
  }
}

const makeKnownNodeScenario = ({ localText, serverText, knownText }: { localText: string; serverText: string; knownText: string }) => {
  const seed = randomBytes(32);
  const kv = vaultKey(seed, vaultId);
  const client = new FakeSyncClient(kv, serverText);
  const vault = new FakeVault();
  vault.seed(path, localText);
  const store = new InitialStateStore({
    nodes: {
      [path]: {
        nodeId,
        rev: 1,
        plainHash: toHex(sha256(utf8(knownText))),
        address: '0'.repeat(64),
      },
    },
  });
  const engine = new SyncEngine(client as unknown as SyncClient, vaultId, kv, vault, store);
  return { client, engine, path, vault };
};

describe('SyncEngine known-node reconciliation', () => {
  it('known node with unchanged local content pulls a newer server version instead of pushing the old one', async () => {
    const setup = makeKnownNodeScenario({ localText: 'old', serverText: 'new', knownText: 'old' });

    const report = await setup.engine.sync();

    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    assert.equal(setup.vault.contents(setup.path), 'new');
    assert.equal(report.pulled.length, 1);
    assert.equal(report.pulled[0]!.path, setup.path);
    assert.equal(report.pushed.length, 0, 'must not overwrite the server with stale local bytes');
    assert.equal(setup.client.putContentCalls, 0, 'remote-only change must not call PUT');
  });

  it('known node with local and remote changes reports an error instead of overwriting the server', async () => {
    const setup = makeKnownNodeScenario({ localText: 'local edit', serverText: 'remote edit', knownText: 'base' });

    const report = await setup.engine.sync();

    assert.equal(setup.vault.contents(setup.path), 'local edit', 'local edit stays in place for the user to resolve');
    assert.equal(report.pushed.length, 0);
    assert.equal(report.pulled.length, 0);
    assert.equal(setup.client.putContentCalls, 0, 'must not blindly PUT over the remote edit');
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]!.path, setup.path);
    assert.match(report.errors[0]!.message, /changed on this device and on the server/);
  });
});
