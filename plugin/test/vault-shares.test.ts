/**
 * The sharing operations on one bound vault, asked without Obsidian.
 *
 * `sharing.ts` has its own tests for each protocol step. What these hold is what ties a step to the
 * vault, and above all its ORDER: a question the person can still refuse is asked before the server
 * is changed, a refusal on this side comes before the first write, and a badge follows only the
 * change it marks. The vault and the plugin share one log: every server call and every badge change
 * is written down in the order it happened.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundVault } from '../src/bound-vault.js';
import { randomBytes } from '../src/crypto/bytes.js';
import { acceptInto, leaveFrom, type VaultShareDeps } from '../src/vault-shares.js';

/** A vault whose tree holds `paths`, whose client logs every call, and whose names `readable` decides. */
const fakeVault = (
  log: string[],
  paths: string[],
  opts: { readable?: (keyId: string | null | undefined) => boolean; replica?: unknown[] } = {},
) => {
  const readable = opts.readable ?? (() => true);
  const record =
    (name: string, answer: unknown = undefined) =>
    async () => {
      log.push(name);
      return answer;
    };
  const vaultKey = randomBytes(32);
  return {
    id: 'vault-1',
    client: {
      joinShare: async (shareId: string, body: unknown) => {
        log.push(`joinShare ${shareId}`);
        return { root_node_id: 'joined-root', body };
      },
      shareReplica: record('shareReplica', opts.replica ?? [{ node_id: 'n1', name_enc: 'enc', name_key_id: 'ks-1' }]),
      leaveShare: record('leaveShare', { ended: false }),
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
    read: async () => new Uint8Array(),
    paths: async () => new Map<string, string>(),
  } as unknown as BoundVault;
};

/** The plugin's side, logging what the badges were told and recording what was asked. */
const plugin = (log: string[], answer: string | undefined) => {
  const asked: string[] = [];
  const d: VaultShareDeps = {
    marks: {
      remember: async (shareId, path) => void log.push(`remember ${shareId} ${path}`),
      forget: async (shareId) => void log.push(`forget ${shareId}`),
    },
    askFolderName: async (suggestion) => (asked.push(suggestion), answer),
    newScopeId: () => 'scope-new',
  };
  return { d, asked };
};

describe('accepting an invitation into this vault', () => {
  it('offers a free name after the person who invited, lands the folder under the vault root, and badges it', async () => {
    const log: string[] = [];
    const { d, asked } = plugin(log, 'Team');
    await acceptInto(fakeVault(log, ['Shared by alice', 'Notes/a.md']), d, { shareId: 's1', initiatorLogin: 'alice' });
    assert.deepEqual(asked, ['Shared by alice 2'], 'the suggestion is already free');
    assert.deepEqual(log, ['joinShare s1', 'remember s1 Team'], 'badged after the join, not before');
  });

  it('changes nothing on the server when the question is dismissed', async () => {
    const log: string[] = [];
    const { d } = plugin(log, undefined);
    await assert.rejects(acceptInto(fakeVault(log, []), d, { shareId: 's1', initiatorLogin: 'alice' }), /a name is needed/);
    assert.deepEqual(log, []);
  });
});

describe('leaving a share from this vault', () => {
  it('refuses before the first write when a name in the share cannot be read here', async () => {
    const log: string[] = [];
    const { d } = plugin(log, undefined);
    await assert.rejects(leaveFrom(fakeVault(log, [], { readable: () => false }), d, 's1'), /Nothing has been changed/);
    assert.deepEqual(log, ['shareReplica'], 'only the read that found the problem — and the badge stays');
  });

  it('takes the badge away only once the server has let the folder go', async () => {
    const log: string[] = [];
    const { d } = plugin(log, undefined);
    await leaveFrom(fakeVault(log, [], { replica: [] }), d, 's1');
    assert.deepEqual(log, ['shareReplica', 'leaveShare', 'finalizeLeave', 'forget s1']);
  });
});
