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
import { dedupTag, encryptName, nameHmac, wrapContentKey } from '../src/crypto/scope.js';
import { sealBlob } from '../src/crypto/blob.js';
import { SyncEngine } from '../src/engine/engine.js';
import { scopesOf } from './vault-scopes.js';
import { openTreeCache } from '../src/engine/tree-cache.js';
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
  /**
   * Seal once per text, and hand the same address back ever after.
   *
   * **This is what a real server does, and getting it wrong hid a defect.** Sealing uses a random
   * content key, so the same plaintext sealed twice lands at two addresses — which is why the dedup
   * tag exists at all: a client that already holds the content binds to the **existing** address rather
   * than sealing again. So a node deleted and recreated by another device keeps its address and changes
   * only its id, and a fake that re-sealed made that case look like an address change. A mutation
   * dropping the node-id half of the pre-pass predicate then passed, because no test could reach the
   * one thing that half protects.
   */
  private seal(text: string) {
    const already = this.byText.get(text);
    if (already) return already;
    const s = sealBlob(utf8(text));
    // The content key travels too, so this wire can actually serve a pull: an envelope from `blobKeys`
    // and the ciphertext from `getBlob`. Without both, every test here can only ever adopt or match.
    this.byAddress.set(s.sha256, { bytes: s.bytes, wrappedKey: wrapContentKey(this.kv, s.contentKey) });
    const out = { sha256: s.sha256, bytes: s.bytes };
    this.byText.set(text, out);
    return out;
  }

  private byText = new Map<string, { sha256: string; bytes: Uint8Array }>();

  private byAddress = new Map<string, { bytes: Uint8Array; wrappedKey: string }>();
  /** How many times the whole tree was fetched — what #252 is about. */
  listNodeCalls = 0;

  async listNodes() {
    this.listNodeCalls++;
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
  /** What the epoch probe is answered with. `undefined` = an ordinary, continuous server. */
  rejectWith: 'restore' | 'reset' | undefined = undefined;

  /** Set to a change to answer the probe with "something happened since your cursor". */
  deltaChanges: unknown[] = [];

  async delta() {
    if (this.rejectWith) {
      return { rejected: true, reason: this.rejectWith } as unknown as Awaited<ReturnType<VaultWire['delta']>>;
    }
    return {
      changes: this.deltaChanges,
      events: [],
      next_cursor: 'cur',
      has_more: false,
    } as unknown as Awaited<ReturnType<VaultWire['delta']>>;
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
  async getBlob(address: string) { return this.byAddress.get(address)?.bytes; }

  async blobKeys(_vaultId: string, addresses: string[]) {
    const out = new Map<string, { scopeId: string; wrappedKey: string }[]>();
    for (const a of addresses) {
      const held = this.byAddress.get(a);
      if (held) out.set(a, [{ scopeId, wrappedKey: held.wrappedKey }]);
    }
    return out;
  }
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
  it('an unchanged vault reads nothing and asks about nothing', async () => {
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
    // **Nothing travels** (issue #250). A path whose stored entry names the same node and the same
    // address as the walked tree takes the known-node branch, finds nothing changed on either side and
    // returns — it never reads the dedup map, so its tag is a question with a predetermined answer.
    // On a vault nobody has touched that is every file, so the request disappears rather than shrinking.
    // The test below keeps the case this could have broken: a server-side delete-and-recreate changes
    // the node id, so that file IS asked about and still rebinds instead of conflicting.
    // Counted as TAGS, not as calls: `dedupLookup([])` reaches the real client and makes no request at
    // all (`inBatches` of nothing is nothing), so what matters is that nothing travelled.
    assert.equal(wire.dedupTags.flat().length, 0, 'nothing was read and nothing was asked about');
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
    // Only the file that changed. The other two are unchanged on both sides, and nothing in their
    // reconciliation can consult the map, so their tags are questions with predetermined answers (#250).
    assert.equal(wire.dedupTags.flat().length, 1, 'only the changed file is asked about');
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

    // Different content, same size, same mtime — what a restore from backup or `mv -p` leaves behind.
    // `seed` and not `write`: this is the world changing under the plugin, not the plugin writing.
    vault.seed('a.md', 'hello worle', 1000); // 11 bytes, as 'hello world' is

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

  it('a file this device pulled is hinted from the vault, not from what the engine intended', async () => {
    // **The defect this pins** (#237). The engine recorded `Date.now()` as the timestamp of a file it
    // had just written and skipped on it ever after. `ObsidianVaultAdapter.write` does not set `mtime`
    // — Obsidian stamps the file itself — so that number never matched what `list()` reports, and every
    // pulled file was re-read on every pass while the state claimed a hint. It passed here only because
    // the fake stored what it was handed; it no longer does, and the engine no longer guesses: it asks
    // the vault (`stat`) after writing.
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'from-server.md', text: 'came down', nodeId: 'node-s', rev: 2 }]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);

    const first = await engine.sync();
    assert.equal(first.pulled.length, 1, 'the file came down');

    const hint = store.state.nodes['from-server.md'];
    const onDisk = await vault.stat('from-server.md');
    assert.equal(hint?.mtime, onDisk?.mtime, 'the hint is the timestamp the vault actually holds');
    assert.equal(hint?.size, utf8('came down').length);

    // And because it is the real one, the next pass skips the file outright — no read at all.
    vault.reads = 0;
    await engine.sync();
    assert.equal(vault.reads, 0, 'a pulled file costs no read on the pass after it arrived');
  });

  it('an epoch that says the local copy may be the only one turns the shortcut off', async () => {
    // The shortcut is a guess about the local file, and `restore`/`unverifiable`/`reset` are exactly
    // the passes where that guess is least safe: restoring a server from a backup is the event that
    // changes content while leaving timestamps alone. The policy already names them — `preferLocal` —
    // so this asks the same question the rest of the pass asks rather than keeping a second list.
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'hello world', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'a.md', text: 'hello world', nodeId: 'node-a', rev: 2 }]);
    const store = makeStore();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store);
    await engine.sync();

    // Proof the hint is live: an ordinary pass reads nothing.
    vault.reads = 0;
    await engine.sync();
    assert.equal(vault.reads, 0, 'the hint works on an ordinary pass');

    // The server went backwards. Same file, same mtime, same size — and it is read anyway.
    wire.rejectWith = 'restore';
    vault.reads = 0;
    await engine.sync();
    assert.ok(vault.reads > 0, 'under a restore the pass does not trust a timestamp');
  });
});

/**
 * Walking the server's tree, and not walking it (issue #252).
 *
 * Measured on a real vault: the listing is 313 KB and turning it into paths costs 12–17 ms of
 * decryption at 624 nodes, 92 ms at 5 000 — paid on every pass, and since #238 a pass happens whenever
 * the vault settles rather than when somebody presses a button.
 *
 * **The cursor is the whole of what makes reuse safe.** These cases are about when the engine is allowed
 * to believe the tree it already has, and — more importantly — when it is not. A cache that guessed
 * would put this device permanently out of step with the server, silently, which is the worst failure
 * this product has.
 */
describe('the tree is walked once while nothing happens (issue #252)', () => {
  const scenario = () => {
    const seed = randomBytes(32);
    const kv = vaultKey(seed, vaultId);
    const vault = new CountingVault();
    vault.seed('a.md', 'hello world', 1000);
    const wire = new TrackingWire(kv);
    wire.setServerFiles([{ path: 'a.md', text: 'hello world', nodeId: 'node-a', rev: 2 }]);
    const store = makeStore();
    const cache = openTreeCache();
    const engine = new SyncEngine(wire, vaultId, scopesOf(opened, kv), vault, store, 'device', false, cache);
    return { wire, engine, store };
  };

  it('walks once, then reuses it while the probe says nothing happened', async () => {
    const { wire, engine } = scenario();

    await engine.sync();
    assert.equal(wire.listNodeCalls, 1, 'the first pass has nothing to reuse');

    await engine.sync();
    await engine.sync();
    assert.equal(wire.listNodeCalls, 1, 'and the quiet ones reuse it');
  });

  it('walks again the moment the probe reports a change', async () => {
    const { wire, engine } = scenario();
    await engine.sync();
    await engine.sync();
    assert.equal(wire.listNodeCalls, 1);

    // One change since our cursor is enough: what it was does not matter, only that the tree this
    // device holds can no longer be assumed to be the server's.
    wire.deltaChanges = [{ node_id: 'whatever' }];
    await engine.sync();

    assert.equal(wire.listNodeCalls, 2, 'anything at all having happened means walking again');
  });

  it('walks again under an epoch that moved, however quiet the page was', async () => {
    // A rejected cursor is not a quiet one: `restore`, `reset` and `unverifiable` all mean the server
    // is not where this device left it, and a tree remembered from before is a tree from another world.
    const { wire, engine } = scenario();
    await engine.sync();
    assert.equal(wire.listNodeCalls, 1);

    wire.rejectWith = 'restore';
    await engine.sync();

    assert.equal(wire.listNodeCalls, 2, 'an epoch that moved rebuilds');
  });

  it('gives out a copy, so a pass that changes the tree cannot poison the next one', async () => {
    // A pass mutates the tree it is handed — a pushed file joins it, a reset remaps it. Handing out the
    // cache's own map would corrupt it on the first pass that used it, and the corruption would look
    // like the server having changed.
    const cache = openTreeCache();
    const walked = {
      cursor: 'cur',
      scopes: 'kv|',
      tree: new Map([['a.md', { nodeId: 'n1', parentId: 'root', path: 'a.md', rev: 1, isFile: true } as never]]),
      unreadable: [],
    };
    cache.put(walked);

    walked.tree.set('b.md', { nodeId: 'n2' } as never);
    const first = cache.get({ cursor: 'cur', scopes: 'kv|' })!;
    first.tree.set('c.md', { nodeId: 'n3' } as never);

    const second = cache.get({ cursor: 'cur', scopes: 'kv|' })!;
    assert.deepEqual([...second.tree.keys()], ['a.md'], 'neither the caller before nor after can reach it');
  });

  it('answers nothing for a cursor it did not walk at', async () => {
    const cache = openTreeCache();
    cache.put({ cursor: 'one', scopes: 'kv|', tree: new Map(), unreadable: [] });
    assert.equal(cache.get({ cursor: 'two', scopes: 'kv|' }), undefined);
  });

  it('answers nothing when the keys the names were read with have changed', async () => {
    // **The defect the first version of this shipped.** The tree is a function of the nodes AND of the
    // scopes this device can open: a subtree whose key will not open is absent from it and listed as
    // unreadable instead. Share membership travels as delta *events*, outside the journal — so a key
    // arriving moves what a walk would produce while the node listing has not changed at all, and the
    // probe answers `quiet`. Keyed on the cursor alone, the cache went on hiding a share whose key had
    // just arrived until some unrelated node happened to change.
    const cache = openTreeCache();
    cache.put({ cursor: 'one', scopes: 'kv|', tree: new Map(), unreadable: [] });

    assert.equal(cache.get({ cursor: 'one', scopes: 'kv|share-a' }), undefined, 'a key arrived');
    assert.ok(cache.get({ cursor: 'one', scopes: 'kv|' }), 'and the unchanged case still answers');
  });
});
