import assert from 'node:assert/strict';
import type { OpenedVault } from '@syncserver/shared';
import { describe, it } from 'node:test';

import type { VaultWire } from '../src/engine/wire.js';
import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, toHex, utf8 } from '../src/crypto/bytes.js';
import { encryptName, nameHmac, wrapContentKey } from '../src/crypto/scope.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { SyncEngine } from '../src/engine/engine.js';
import { scopesOf } from './vault-scopes.js';
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

/**
 * The vault as the engine is now given it, rather than as it used to ask for it.
 *
 * The seam lost `openVault` when the caller took over opening: one value per
 * operation, passed to everything that operation needs (docs/06).
 */
const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 2,
  scopes: [{ scope: 'vault', key_id: scopeId }],
};

class FakeSyncClient implements VaultWire {
  putContentCalls = 0;

  private readonly remoteBytes: Uint8Array;
  private readonly remoteAddress: string;
  private readonly wrappedRemoteKey: string;

  constructor(
    private readonly kv: Uint8Array,
    remoteText: string,
    /** Where the SERVER says the node lives. Different from `path` means the server renamed it. */
    private readonly serverPath: string = path,
  ) {
    const sealed = sealBlob(utf8(remoteText));
    this.remoteBytes = sealed.bytes;
    this.remoteAddress = sealed.sha256;
    this.wrappedRemoteKey = wrapContentKey(kv, sealed.contentKey);
  }

  get address(): string {
    return this.remoteAddress;
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
          name_enc: encryptName(this.kv, this.serverPath),
          name_hmac: nameHmac(this.kv, this.serverPath),
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

  /** Paths created during a pass — a conflict file is uploaded in the same one that wrote it. */
  created: string[] = [];

  async createNode(_vaultId: string, body: { name_enc: string }): Promise<{ node_id: string; rev: number }> {
    this.created.push(body.name_enc);
    return { node_id: `node-${this.created.length}`, rev: 10 + this.created.length };
  }

  /**
   * The content precondition, modelled rather than waved through (D-52).
   *
   * An earlier version of this fake accepted every PUT. That made it unable to catch the one
   * failure it most needed to — an engine sending the server its own current address as the
   * base, which can never mismatch and so silently overwrites whatever arrived in between.
   */
  async putContent(
    _vaultId: string,
    _nodeId: string,
    body: { sha256: string; base_sha256: string | null },
  ): Promise<{ rev: number } | { conflict: 'base_mismatch'; sha256: string; rev: number }> {
    this.putContentCalls++;
    if (body.base_sha256 !== this.remoteAddress) {
      return { conflict: 'base_mismatch', sha256: this.remoteAddress, rev: 2 };
    }
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

  /** Recorded rather than thrown on: these scenarios do not rename, but a fake that refuses
   *  an operation the seam declares is how the last one hid a real path from its own tests. */
  moved: { nodeId: string; ifMatchRev: number }[] = [];

  async moveNode(_vaultId: string, nodeId: string, ifMatchRev: number): Promise<{ rev: number }> {
    this.moved.push({ nodeId, ifMatchRev });
    return { rev: ifMatchRev + 1 };
  }

  /** These scenarios never delete: no cursor, so no epoch, so nothing to delete against. */
  async deleteNode(): Promise<{ rev: number }> {
    throw new Error('deleteNode should not be called here');
  }

  /** No cursor in these scenarios means the engine never probes. */
  async delta(): Promise<never> {
    throw new Error('delta should not be called here');
  }
}

const makeKnownNodeScenario = ({
  localText,
  serverText,
  knownText,
  serverPath = path,
  vault = new FakeVault(),
}: {
  localText: string;
  serverText: string;
  knownText: string;
  /** Where the server says the node is now — a different path means it was renamed there. */
  serverPath?: string;
  /** A vault that behaves differently from the plain one: see the ordering suite below. */
  vault?: FakeVault;
}) => {
  const seed = randomBytes(32);
  const kv = vaultKey(seed, vaultId);
  const client = new FakeSyncClient(kv, serverText, serverPath);
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
  // No cast: the fake implements the seam the engine declares, so the type checker is
  // proving the double matches rather than being told to stop looking.
  const engine = new SyncEngine(client, vaultId, scopesOf(opened, kv), vault, store);
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

  it('known node changed on both sides becomes a conflict file, with neither version lost', async () => {
    const setup = makeKnownNodeScenario({ localText: 'local edit', serverText: 'remote edit', knownText: 'base' });

    const report = await setup.engine.sync();

    // The PUT is sent, and the SERVER decides. That is the point of the precondition: the
    // base is the version this device edited from, so a write that raced somebody else's is
    // refused rather than accepted — which a client comparing two hashes it fetched a moment
    // ago cannot arrange for itself.
    assert.equal(setup.client.putContentCalls, 1, 'the precondition is what refuses it, not a local guess');
    assert.ok(!report.pushed.some((p) => p.path === setup.path), 'the path itself was not written over');
    assert.equal(report.errors.length, 0, `a conflict is an outcome, not a failure: ${JSON.stringify(report.errors)}`);

    assert.equal(report.conflicts.length, 1, 'docs/04: the server version becomes the file, ours is kept beside it');
    const conflict = report.conflicts[0]!;
    assert.equal(conflict.path, setup.path);
    assert.equal(setup.vault.contents(setup.path), 'remote edit', 'the server version now holds the path');
    assert.equal(setup.vault.contents(conflict.conflictPath), 'local edit', 'and this device’s work survives');

    // Not left for the next click: the moment it exists it is an ordinary new file, and the
    // pass that created it uploads it.
    assert.equal(setup.client.created.length, 1, 'the conflict file was uploaded in this same pass');
    assert.ok(report.pushed.some((p) => p.path === conflict.conflictPath));
  });

  it('does not manufacture a conflict when both sides reached the same text', async () => {
    // Two devices editing frontmatter back and forth land here constantly. The base still
    // mismatches, so the server still refuses — but what it holds is exactly what was being
    // sent, and calling that a conflict would bury the user in files for nothing (docs/04).
    const setup = makeKnownNodeScenario({ localText: 'same', serverText: 'same', knownText: 'base' });

    const report = await setup.engine.sync();

    assert.equal(report.conflicts.length, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(setup.vault.contents(setup.path), 'same', 'nothing written, nothing renamed');
    assert.deepEqual(report.matched.map((m) => m.path), [setup.path], 'recorded as already in step');
  });
});

/**
 * Moving bytes about on disk, when the second step fails (issues #239, #242).
 *
 * Three places in the engine move content between paths, and each is two steps with no transaction
 * around them. Ordered the wrong way round they destroy the only copy: the rule is stated once at the
 * top of `engine.ts` — write the destination first, delete or overwrite the source after.
 *
 * **These are not tests about `write` throwing.** They are tests about what survives when it does, which
 * is the only observable difference between the two orderings — both are two writes and a delete, and
 * both look correct until one of them fails.
 */
class BrittleVault extends FakeVault {
  writes: string[] = [];

  constructor(private readonly failOn: string) {
    super();
  }

  override async write(path: string, bytes: Uint8Array, mtime = Date.now()): Promise<void> {
    this.writes.push(path);
    // Thrown BEFORE the write lands, which is the honest model: a disk that refuses has not written.
    if (path === this.failOn) throw new Error(`the disk refused ${path}`);
    return super.write(path, bytes, mtime);
  }
}

describe('a failed write never leaves content nowhere', () => {
  it('keeps the local file when a remote rename cannot write its destination (issue #239)', async () => {
    // The server moved the node to `moved.md`. Under the old order the local copy was deleted first, so
    // a failing write left the bytes nowhere — and the NEXT pass would read the vanished path as a
    // deletion and push it, taking the file off every other device too.
    const vault = new BrittleVault('moved.md');
    const { engine } = makeKnownNodeScenario({
      localText: 'the only copy',
      serverText: 'the only copy',
      knownText: 'the only copy',
      serverPath: 'moved.md',
      vault,
    });

    const report = await engine.sync();

    assert.equal(vault.writes[0], 'moved.md', 'the destination was tried first, before anything was lost');
    assert.equal(vault.contents(path), 'the only copy', 'and the source is still there');
    assert.equal(report.renamed.length, 0, 'nothing is reported as renamed');
    assert.ok(report.errors.length >= 1, 'the pass says the file failed');
    // The destination is attempted a second time, and that is the pass being sensible rather than a
    // defect: the rename never claimed the node, so the walk finishes by pulling it as a server-only
    // file. On a working disk that second attempt is the file arriving. Not asserted as an exact count,
    // because how many times the engine retries is not what this test is about.

  });

  it('keeps this device’s version when a conflict cannot write the server copy (issue #242)', async () => {
    // Local and server both moved away from what this device last knew: a conflict. `localPlain` exists
    // only in memory by then, so under the old order — overwrite the path, then write the conflict copy —
    // a failing second write lost the person's edits while the report still claimed a conflict file.
    const vault = new BrittleVault(path);
    const { engine } = makeKnownNodeScenario({
      localText: 'what I wrote here',
      serverText: 'what somebody else wrote',
      knownText: 'what we both started from',
      vault,
    });

    const report = await engine.sync();

    const conflictPath = vault.paths().find((p) => p !== path);
    assert.ok(conflictPath, `this device’s version was kept somewhere: ${vault.paths().join(', ')}`);
    assert.equal(vault.contents(conflictPath), 'what I wrote here', 'and it is the local text, not the server’s');
    assert.equal(report.conflicts.length, 0, 'a conflict that did not complete is not reported as handled');
    assert.equal(report.errors.length, 1, 'the pass ends in an error report');
  });
});
