/**
 * The sharing operations on one bound vault, asked without Obsidian.
 *
 * `sharing.ts` has its own tests for each protocol step. What these hold is what ties a step to the
 * vault, and above all its ORDER: a question the person can still refuse is asked before the server
 * is changed, a refusal on this side comes before the first write, and a badge follows only the
 * change it marks. The vault is a recording fake: every server call it receives is written down.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundVault } from '../src/bound-vault.js';
import { randomBytes } from '../src/crypto/bytes.js';
import { acceptInto, leaveFrom, type VaultShareDeps } from '../src/vault-shares.js';

/** A vault whose tree holds `paths`, whose client records every call, and whose names `readable` decides. */
const fakeVault = (paths: string[], readable: (keyId: string | null | undefined) => boolean = () => true) => {
  const calls: string[] = [];
  const record =
    (name: string, answer: unknown = undefined) =>
    async () => {
      calls.push(name);
      return answer;
    };
  const vaultKey = randomBytes(32);
  const v = {
    id: 'vault-1',
    client: {
      joinShare: async (shareId: string, body: unknown) => {
        calls.push(`joinShare ${shareId}`);
        return { root_node_id: 'joined-root', body };
      },
      shareReplica: record('shareReplica', [{ node_id: 'n1', name_enc: 'enc', name_key_id: 'ks-1' }]),
      leaveShare: record('leaveShare'),
      finalizeLeave: record('finalizeLeave'),
      blobKeys: record('blobKeys', []),
    },
    scopes: {
      vaultKey,
      vaultScopeId: 'kv',
      opened: { root_node_id: 'vault-root' },
      shareKey: () => ({ key: randomBytes(32), keyId: 'ks-1' }),
      keyIfOpenable: (keyId: string | null | undefined) => (readable(keyId) ? vaultKey : undefined),
      keyFor: () => vaultKey,
    },
    engine: { readTree: async () => new Map(paths.map((p) => [p, { nodeId: `id:${p}`, address: null }])) },
    paths: async () => new Map<string, string>(),
  } as unknown as BoundVault;
  return { v, calls };
};

/** The plugin's side, recording what was asked and what the badges were told. */
const plugin = (answer: string | undefined) => {
  const asked: string[] = [];
  const marks: string[] = [];
  const d: VaultShareDeps = {
    read: async () => new Uint8Array(),
    marks: {
      remember: async (shareId, path) => void marks.push(`remember ${shareId} ${path}`),
      forget: async (shareId) => void marks.push(`forget ${shareId}`),
    },
    askFolderName: async (suggestion) => (asked.push(suggestion), answer),
    newScopeId: () => 'scope-new',
  };
  return { d, asked, marks };
};

describe('accepting an invitation into this vault', () => {
  it('offers a free name after the person who invited, lands the folder under the vault root, and badges it', async () => {
    const { v, calls } = fakeVault(['Shared by alice', 'Notes/a.md']);
    const { d, asked, marks } = plugin('Team');
    await acceptInto(v, d, { shareId: 's1', initiatorLogin: 'alice' });
    assert.deepEqual(asked, ['Shared by alice 2'], 'the suggestion is already free');
    assert.deepEqual(calls, ['joinShare s1']);
    assert.deepEqual(marks, ['remember s1 Team']);
  });

  it('changes nothing on the server when the question is dismissed', async () => {
    const { v, calls } = fakeVault([]);
    const { d, marks } = plugin(undefined);
    await assert.rejects(acceptInto(v, d, { shareId: 's1', initiatorLogin: 'alice' }), /a name is needed/);
    assert.deepEqual(calls, []);
    assert.deepEqual(marks, []);
  });
});

describe('leaving a share from this vault', () => {
  it('refuses before the first write when a name in the share cannot be read here', async () => {
    const { v, calls } = fakeVault([], () => false);
    const { d, marks } = plugin(undefined);
    await assert.rejects(leaveFrom(v, d, 's1'), /Nothing has been changed/);
    assert.deepEqual(calls, ['shareReplica'], 'only the read that found the problem');
    assert.deepEqual(marks, [], 'the folder is still shared, so its badge stays');
  });
});
