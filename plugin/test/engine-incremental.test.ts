/**
 * #237 — a sync pass re-reads and re-hashes the whole vault.
 *
 * The fix stores `mtime`+`size` beside `plainHash` and skips the read when both match.
 * `mtime` is a hint, not authority — a rescan forces full reads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenedVault } from '@syncserver/shared';
import type { VaultWire } from '../src/engine/wire.js';
import type { StateStore } from '../src/engine/state.js';
import { vaultKey } from '../src/crypto/account.js';
import { randomBytes, toHex, utf8 } from '../src/crypto/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { dedupTag, encryptName, nameHmac } from '../src/crypto/scope.js';
import { sealBlob } from '../src/crypto/blob.js';
import { SyncEngine } from '../src/engine/engine.js';
import { scopesOf } from './vault-scopes.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const rootNodeId = 'root';
const scopeId = 'scope-vault';
const opened: OpenedVault = {
  root_node_id: rootNodeId,
  head_rev: 1,
  scopes: [{ scope: 'vault', key_id: scopeId }],
};

class CountingVault extends FakeVault {
  reads = 0;
  // expose raw map for same-mtime tamper (same size, same mtime, different bytes)
  rawFiles(): Map<string, { bytes: Uint8Array; mtime: number }> {
    return (this as unknown as { files: Map<string, { bytes: Uint8Array; mtime: number }> }).files;
  }
  override async read(path: string): Promise<Uint8Array> {
    this.reads++;
    return super.read(path);
  }
}

class TrackingWire implements VaultWire {
  dedupTags: string[][] = [];
  putContentCalls = 0;
  created = 0;
  // optional static server files — when set, listNodes returns them
  serverFiles: { path: string; text: string; nodeId: string; rev: number }[] = [];
  private sealed = new Map<string, { sha256: string; bytes: Uint8Array }>();
  private tagToAddr = new Map<string, string>();
  constructor(private readonly kv: Uint8Array) {}
  setServerFiles(files: { path: string; text: string; nodeId: string; rev: number }[]) {
    this.serverFiles = files;
    this.sealed.clear();
    this.tagToAddr.clear();
    for (const f of files) {
      const s = this.seal(f.text);
      this.sealed.set(f.path, s);
      const tag = dedupTag(this.kv, utf8(f.text));
      this.tagToAddr.set(tag, s.sha256);
    }
  }
  private seal(text: string) {
    const s = sealBlob(utf8(text));
    return { sha256: s.sha256, bytes: s.bytes };
  }
  async listNodes() {
    const nodes: import('@syncserver/shared').Change[] = [
      { node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null, op: 'put' as const, rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null },
    ];
    for (const f of this.serverFiles) {
      const s = this.sealed.get(f.path) ?? this.seal(f.text);
      nodes.push({
        node_id: f.nodeId, parent_id: rootNodeId,
        name_enc: encryptName(this.kv, f.path), name_hmac: nameHmac(this.kv, f.path), name_key_id: scopeId,
        op: 'put' as const, rev: f.rev, sha256: s.sha256, size: s.bytes.length,
        mtime: new Date(0).toISOString(), share_id: null, author_id: null,
      } as import('@syncserver/shared').Change);
    }
    return { nodes, snapshot: 'cur' };
  }
  async delta() {
    return { changes: [], events: [], next_cursor: 'cur', has_more: false } as unknown as Awaited<ReturnType<VaultWire['delta']>>;
  }
  async dedupLookup(_vaultId: string, tags: string[]) {
    this.dedupTags.push([...tags]);
    const out = new Map<string, string>();
    for (const t of tags) {
      const addr = this.tagToAddr.get(t);
      if (addr) out.set(t, addr);
    }
    return out;
  }
  async putBlob(sealed: { sha256: string; bytes: Uint8Array; keyId: string }) {
    return { sha256: sealed.sha256, size: sealed.bytes.length };
  }
  async getBlob() { return undefined; }
  async blobKeys() { return new Map(); }
  async createNode() { this.created++; return { node_id: `new-${this.created}`, rev: 10 }; }
  async putContent(_v: string, _n: string, _b: unknown) { this.putContentCalls++; return { rev: 2 }; }
  async moveNode() { return { rev: 2 }; }
  async deleteNode() { return { rev: 2 }; }
}

function makeStore(initial: import('../src/engine/state.js').VaultState = { nodes: {} }): StateStore & { state: import('../src/engine/state.js').VaultState } {
  let state = structuredClone(initial);
  return {
    get state() { return state; },
    async load() { return structuredClone(state); },
    async save(s) { state = structuredClone(s); },
  };
}

describe('engine #237 — incremental pre-pass', () => {
  it('an unchanged vault does no pre-pass reads and no dedup lookup', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'hello world', 1000);
    vault.seed('b.md', 'second', 1000);
    vault.seed('c.md', 'third', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([
      { path: 'a.md', text: 'hello world', nodeId: 'node-a', rev: 2 },
      { path: 'b.md', text: 'second', nodeId: 'node-b', rev: 3 },
      { path: 'c.md', text: 'third', nodeId: 'node-c', rev: 4 },
    ]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);

    // first sync populates the hint (adoption matched)
    vault.reads = 0;
    wire.dedupTags = [];
    await engine.sync();
    assert.ok(vault.reads > 0, 'first sync must read to populate hint');

    // second sync — nothing changed
    vault.reads = 0;
    wire.dedupTags = [];
    const report = await engine.sync();
    assert.equal(vault.reads, 0, 'unchanged vault must skip every read (meta phase)');
    // skipped files still contribute a dedup tag derived from plainHash so adoption/reset can match
    assert.equal(wire.dedupTags[0]?.length ?? 0, 3, 'unchanged vault still queries dedup (cheap HMAC, no read)');
    assert.equal(report.pushed.length, 0);
    assert.equal(report.matched.length, 0); // early return does not report matched, just returns
  });

  it('a vault with one changed file (mtime bump) reads only that file', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'hello', 1000);
    vault.seed('b.md', 'world', 1000);
    vault.seed('c.md', 'third', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([
      { path: 'a.md', text: 'hello', nodeId: 'node-a', rev: 2 },
      { path: 'b.md', text: 'world', nodeId: 'node-b', rev: 3 },
      { path: 'c.md', text: 'third', nodeId: 'node-c', rev: 4 },
    ]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);
    await engine.sync(); // populate

    // edit one file — mtime moves, size changes
    vault.seed('b.md', 'world!!', 2000);
    vault.reads = 0;
    wire.dedupTags = [];
    const report = await engine.sync();
    // meta reads 1 (b.md) + upload re-read 1 = 2 total reads; skipped files add 0
    assert.equal(vault.reads, 2, 'one changed file — one meta read + one upload read, others skipped');
    assert.equal(wire.dedupTags[0]?.length, 3, 'all files query dedup (skipped via HMAC, changed via read)');
    assert.equal(report.pushed.length, 1);
    assert.equal(report.pushed[0]!.path, 'b.md');
  });

  it('a file whose mtime moved but content did not refreshes the hint and next pass still skips', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'same content', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'a.md', text: 'same content', nodeId: 'node-a', rev: 2 }]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);
    await engine.sync();

    // mtime moves, content identical
    vault.seed('a.md', 'same content', 2000);
    vault.reads = 0;
    await engine.sync();
    // first pass after mtime move must read (hint mismatch), but content identical so no push
    assert.equal(vault.reads, 1, 'mtime bump with same content still reads once to verify');
    assert.equal(store.state.nodes['a.md']?.mtime, 2000, 'hint refreshed to new mtime');

    vault.reads = 0;
    wire.dedupTags = [];
    await engine.sync();
    assert.equal(vault.reads, 0, 'next pass after refresh skips again');
  });

  it('entries predating mtime/size are read once then cached', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('old.md', 'legacy', 1000);
    const wire = new TrackingWire(kv);
    // state from before #237 — no mtime/size stored
    const legacyHash = toHex(sha256(utf8('legacy')));
    const store = makeStore({
      nodes: {
        'old.md': { nodeId: 'node-old', rev: 1, plainHash: legacyHash, address: '0'.repeat(64) },
      },
    });
    // also need server to hold that node so reconcile sees known node at same path
    const origList = wire.listNodes.bind(wire);
    wire.listNodes = async () => ({
      nodes: [
        { node_id: rootNodeId, parent_id: null, name_enc: null, name_hmac: null, name_key_id: null, op: 'put' as const, rev: 1, sha256: null, size: null, mtime: new Date(0).toISOString(), share_id: null, author_id: null },
        { node_id: 'node-old', parent_id: rootNodeId, name_enc: encryptName(kv, 'old.md'), name_hmac: nameHmac(kv, 'old.md'), name_key_id: scopeId, op: 'put' as const, rev: 2, sha256: '0'.repeat(64), size: 6, mtime: new Date(0).toISOString(), share_id: null, author_id: null },
      ],
      snapshot: 'cur',
    });
    vault.reads = 0;
    await new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store).sync();
    assert.equal(vault.reads, 1, 'legacy entry without hint must be read once');
    assert.equal(store.state.nodes['old.md']?.mtime, 1000);
    assert.equal(store.state.nodes['old.md']?.size, 6);

    vault.reads = 0;
    await new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store).sync();
    assert.equal(vault.reads, 0, 'next pass uses newly cached hint');
  });

  it('a changed file under unchanged mtime is missed without rescan and found with rescan', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'hello world', 1000); // 11 bytes
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'a.md', text: 'hello world', nodeId: 'node-a', rev: 2 }]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);
    await engine.sync();

    // tamper content to same size, same mtime (restore / mv -p scenario)
    // 'hello world' -> 'hello worle' (11 bytes, different hash)
    vault.rawFiles().set('a.md', { bytes: utf8('hello worle'), mtime: 1000 });

    vault.reads = 0;
    wire.putContentCalls = 0;
    const withoutRescan = await engine.sync();
    assert.equal(vault.reads, 0, 'without rescan the hint makes the pass skip the read');
    assert.equal(withoutRescan.pushed.length, 0, 'and the change is missed — mtime is a hint, not authority');

    vault.reads = 0;
    wire.putContentCalls = 0;
    const withRescan = await engine.sync({ rescan: true });
    // meta read 1 + upload read 1 = 2
    assert.equal(vault.reads, 2, 'rescan forces the read');
    assert.equal(withRescan.pushed.length, 1, 'rescan finds the change');
    assert.equal(withRescan.pushed[0]!.path, 'a.md');
  });

  it('skipped file still dedup-matches on delete+recreate (no spurious conflict)', async () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'same body', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'a.md', text: 'same body', nodeId: 'node-old', rev: 2 }]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);
    await engine.sync(); // populates hint with node-old

    // server recreates the node with new id but same content (delete+create)
    wire.setServerFiles([{ path: 'a.md', text: 'same body', nodeId: 'node-new', rev: 3 }]);
    vault.reads = 0;
    const report = await engine.sync();
    // file is skipped (mtime+size match) but dedup tag is still derived, so adoption matched
    assert.equal(vault.reads, 0, 'skipped file should not be re-read even for adoption check');
    assert.equal(report.matched.length, 1, 'same content at same path should bind, not conflict');
    assert.equal(report.conflicts.length, 0);
    assert.equal(report.matched[0]!.path, 'a.md');
    assert.equal(store.state.nodes['a.md']?.nodeId, 'node-new', 'hint tracks new nodeId');
  });
});
