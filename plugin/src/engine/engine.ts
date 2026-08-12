/**
 * M1, two-way sync of one vault: push, pull, adopt, delete, and resync after a moved epoch.
 *
 * One pass reconciles, rather than choosing push XOR pull for the whole vault:
 *
 * | Local | Server | Result |
 * |---|---|---|
 * | only local | — | upload — unless the content is already known in this scope, in which case bind to the existing address and send nothing (docs/07, "nearly free") |
 * | — | only server | download |
 * | both, this device already knows the node | ordinary edit: the content precondition decides (#52) |
 * | both, this device does NOT know the node | **adoption**: matching content binds silently; differing content is a conflict with no common ancestor (docs/07) |
 * | known here, gone from the server | a **delete** — but which side deleted is read from the epoch, below |
 *
 * The last row is the one that cannot be read from the trees alone. The same absence is a
 * deletion on one epoch and a rescue target on another, so before anything is removed the
 * stored cursor is presented to the delta endpoint and its answer decides (#70, docs/04):
 *
 * - `200` / `journal_ttl` — the server is continuous with what we saw, or ahead of it. A
 *   known node missing from the walk **was** deleted there; the local copy is removed.
 * - `restore` / `cursor_unverifiable` — the server moved backwards, or the cursor cannot be
 *   checked at all. Absence proves nothing: nothing is deleted locally, and what the server
 *   lost is uploaded as new.
 * - `reset` — another device won the vault. Its tree is the truth; local work it does not
 *   hold is quarantined to `_Reset <date>/`, never erased (#80, docs/07).
 *
 * Local deletes (a synced file gone from disk) push `deleteNode` — safe under every epoch,
 * because the row soft-deletes into the trash and the content survives (docs/03).
 *
 * The engine instance is one sync, so the per-pass context lives on the instance rather than
 * being threaded through a dozen parameters. Out of scope, deliberately: folder moves are
 * still per-file, and the delta's *pages* are not applied incrementally — the full walk is
 * the data source, the probe is only the provenance check (incremental application is M2).
 */
import { ApiError } from '../api/client.js';
import type { VaultWire } from './wire.js';
import { openBlob, sealBlob } from '../crypto/blob.js';
import { toHex } from '../crypto/bytes.js';
import { decryptName, dedupTag, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../crypto/scope.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { StateStore, VaultState } from './state.js';
import { isSyncable, type VaultAdapter, type VaultFile } from './vault.js';

export interface SyncReport {
  /**
   * How many local files the engine SAW, after exclusions.
   *
   * Reported because "0 up, 0 down" has more than one cause — nothing changed, or the vault
   * looked empty — and they are indistinguishable without this number.
   */
  scanned: number;
  pushed: { path: string }[];
  pulled: { path: string }[];
  /** Local and server agreed already: recorded, nothing moved either way (docs/07). */
  matched: { path: string }[];
  /** Adoption found the same path holding different content on each side (docs/04's naming). */
  conflicts: { path: string; conflictPath: string }[];
  /** Recognised as a move rather than a delete and a create: same node, new place. */
  renamed: { from: string; to: string }[];
  /** Deleted on this device and the delete pushed to the server (which keeps it in trash). */
  deleted: { path: string }[];
  /** Deleted on the server; the local copy was removed. */
  removed: { path: string }[];
  /**
   * A `410 reset` means another device won the vault. Local work that the reset tree does
   * not hold is moved to `_Reset <date>/`, never erased (#80, docs/07).
   */
  quarantined: { from: string; to: string }[];
  /**
   * Paths this device had synced that are no longer on disk, and were neither explained by a
   * rename nor pushed as a delete. Reported, not acted on — a rescan that guesses wrong
   * about a disappearance (a folder not yet mounted) must not delete somebody's work.
   */
  vanished: { path: string }[];
  errors: { path: string; message: string }[];
}

/** A node as the server describes it, plus the path this client resolved it to. */
interface ServerNode {
  nodeId: string;
  parentId: string | null;
  path: string;
  rev: number;
  address: string | null;
  isFile: boolean;
}

/** What the pre-pass learns about one local file without holding onto its bytes. */
interface LocalMeta {
  plainHash: string;
  /** `HMAC(vault key, sha256(plaintext))` — what the dedup lookup is keyed by (docs/06). */
  tag: string;
  mtime: number;
  size: number;
}

/**
 * A path this device had synced and can no longer find, kept as a possible rename source.
 *
 * Not every disappearance is a rename, and the cost of being wrong is asymmetric: a missed
 * rename costs an upload the deduplication makes nearly free, while a wrong one moves a node
 * the user still has somewhere else. So the match is deliberately narrow — see `RENAME_MIN_BYTES`.
 */
interface Vanished {
  path: string;
  nodeId: string;
  rev: number;
  address: string;
}

/**
 * Below this, a hash match means nothing (docs/04).
 *
 * Empty notes, a repeated icon, a stub from a template — small files collide constantly, and
 * the heuristic would move whichever one it happened to see first. Falling back to
 * delete-and-create costs nothing extra, because the blob deduplicates anyway.
 */
const RENAME_MIN_BYTES = 512;

/**
 * What the cursor probe says about the server relative to us, and so what an absence means.
 *
 * `reset` is excluded from the flag table because it is not a flag change but a different
 * algorithm (`resyncAfterReset`). The rest differ only in how a missing node is read.
 */
type RemoteEpoch = 'continuous' | 'journal_ttl' | 'restore' | 'reset' | 'unverifiable';

interface SyncPolicy {
  /** A synced file gone from disk is pushed as a server delete. */
  pushDeletes: boolean;
  /** A known node missing from the walked tree deletes the local copy. */
  applyRemoteDeletes: boolean;
  /** Content the server lost is re-uploaded, not pulled over our newer copy. */
  preferLocal: boolean;
}

const POLICY: Record<Exclude<RemoteEpoch, 'reset'>, SyncPolicy> = {
  // The walk is current, so a known node missing from it was genuinely deleted.
  continuous: { pushDeletes: true, applyRemoteDeletes: true, preferLocal: false },
  // The journal pruned past our cursor, but the server moved forwards — same reading.
  journal_ttl: { pushDeletes: true, applyRemoteDeletes: true, preferLocal: false },
  // The server went backwards: absence proves nothing, and our copy may be the only one.
  restore: { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true },
  // The cursor cannot be checked at all: resync from empty, deleting nothing (#100).
  unverifiable: { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true },
};

export class SyncEngine {
  constructor(
    private readonly client: VaultWire,
    private readonly vaultId: string,
    private readonly vaultKey: Uint8Array,
    private readonly vault: VaultAdapter,
    private readonly store: StateStore,
    /** Named in a conflict file's filename (docs/04): `Note (conflict 2026-08-01 laptop).md`. */
    private readonly deviceLabel = 'device',
  ) {}

  // ---- per-sync context ---------------------------------------------------------
  // The engine is built per sync, so these are written once in `sync()` and read by the
  // helpers, instead of a dozen parameters threaded through every call.

  private policy!: SyncPolicy;
  private tree!: Map<string, ServerNode>;
  private byNodeId!: Map<string, ServerNode>;
  private meta!: Map<string, LocalMeta>;
  private dedup!: Map<string, string>;
  private vanished!: Map<string, Vanished[]>;
  private handled!: Set<string>;
  private queue!: VaultFile[];
  private rootNodeId!: string;
  private scopeId!: string;
  private state!: VaultState;
  private report!: SyncReport;

  async sync(): Promise<SyncReport> {
    this.report = {
      scanned: 0, pushed: [], pulled: [], matched: [], conflicts: [], renamed: [],
      deleted: [], removed: [], quarantined: [], vanished: [], errors: [],
    };
    this.state = await this.store.load();

    const opened = await this.client.openVault(this.vaultId);
    const scopeId = opened.scopes.find((s) => s.scope === 'vault')?.key_id;
    if (!scopeId) throw new Error('the vault reports no key scope of its own');
    this.scopeId = scopeId;
    this.rootNodeId = opened.root_node_id;

    // Provenance before a byte moves: present the stored cursor, and let its answer decide
    // what a missing node means (#70). The pages themselves are re-read through the walk —
    // the probe is the check, not the data.
    const epoch: RemoteEpoch = this.state.cursor ? await this.probeEpoch(this.state.cursor) : 'continuous';

    const { tree, cursor } = await this.readServerTree();
    this.tree = tree;
    this.byNodeId = new Map();
    for (const n of tree.values()) this.byNodeId.set(n.nodeId, n);

    const local = (await this.vault.list()).filter((f) => isSyncable(f.path));
    this.report.scanned = local.length;

    // Read once, hash, tag — and let the bytes go. Holding every file in memory at once is
    // the thing docs/02 rules out; re-reading a handful of them a second time, just before
    // an actual upload, costs I/O this trades for that.
    this.meta = new Map();
    for (const f of local) {
      const bytes = await this.vault.read(f.path);
      this.meta.set(f.path, {
        plainHash: toHex(sha256(bytes)),
        tag: dedupTag(this.vaultKey, bytes),
        mtime: f.mtime,
        size: bytes.length,
      });
    }
    this.dedup = await this.client.dedupLookup(this.vaultId, [...new Set([...this.meta.values()].map((m) => m.tag))]);

    const here = new Set(local.map((f) => f.path));

    if (epoch === 'reset') {
      await this.resyncAfterReset(local);
      this.state.cursor = cursor;
      await this.store.save(this.state);
      return this.report;
    }

    this.policy = POLICY[epoch];

    // Paths this device had synced and can no longer find. A rename shows up as exactly this
    // plus a new path holding the same bytes, and the pairing has to be decided BEFORE the
    // walk creates a second node for the new one.
    this.vanished = new Map();
    for (const [path, known] of Object.entries(this.state.nodes)) {
      if (here.has(path)) continue;
      const list = this.vanished.get(known.plainHash) ?? [];
      list.push({ path, nodeId: known.nodeId, rev: known.rev, address: known.address });
      this.vanished.set(known.plainHash, list);
    }

    // Shallowest first, so a folder exists before the file that lives in it. A FIFO queue
    // rather than one static pass: a conflict file created mid-walk is pushed onto the end
    // and uploaded in this same pass, not left for the next click. Its folder is always
    // already there — it lands beside the file it came from, which this loop has by then
    // already ensured a parent for.
    this.handled = new Set();
    this.queue = [...local].sort((a, b) => depth(a.path) - depth(b.path));

    // A folder renamed is ONE move of the folder node, not a move per child. Detect the
    // whole-folder case before the per-file walk, so the children are not moved individually
    // and the empty source folder does not linger on the server.
    await this.moveRenamedFolders(local, here);

    while (this.queue.length) {
      const file = this.queue.shift()!;
      this.handled.add(file.path);
      try {
        await this.reconcileLocal(file);
      } catch (e) {
        this.report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // Whatever the walk did not claim as a rename source is a file this device deleted.
    // Pushing the delete is safe: the row soft-deletes into the trash and the content
    // survives (docs/03). The only thing that stops us is an epoch that makes the absence
    // unreadable — under a restore we cannot tell "deleted" from "never arrived".
    for (const list of this.vanished.values()) {
      for (const v of list) {
        this.handled.add(v.path);
        if (!this.policy.pushDeletes) {
          delete this.state.nodes[v.path];
          continue;
        }
        await this.pushDelete(v);
      }
    }

    // What is left: server files no local copy ever stood in for. Ordinary pull.
    const serverOnly = [...this.tree.values()].filter((n) => n.isFile && n.address && !this.handled.has(n.path));
    await this.pull(serverOnly);

    this.state.cursor = cursor;
    await this.store.save(this.state);
    return this.report;
  }

  /**
   * The one question the delta endpoint is asked: can this cursor still be answered, and if
   * not, why. `limit: 1` because we are after the verdict, not the page.
   *
   * A `400 cursor_unverifiable` is caught here rather than in the client because the client
   * rightly treats it as an error, while for the engine it is a policy: resync from an empty
   * cursor, deleting nothing (#100).
   */
  private async probeEpoch(cursor: string): Promise<RemoteEpoch> {
    try {
      const res = await this.client.delta(this.vaultId, cursor, 1);
      if ('rejected' in res) return res.reason;
      return 'continuous';
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) return 'unverifiable';
      throw e;
    }
  }

  /**
   * The server's tree, with paths reconstructed on this side.
   *
   * The server holds `parent_id` and an encrypted name and nothing else — it has no paths at
   * all (docs/03) — so a path exists only once a client has decrypted every name on the way
   * down. `list` returns nodes shallowest-first, which is what makes one pass enough.
   */
  private async readServerTree(): Promise<{ tree: Map<string, ServerNode>; cursor: string }> {
    const res = await this.client.listNodes(this.vaultId);
    const pathOf = new Map<string, string>([[this.rootNodeId, '']]);
    const tree = new Map<string, ServerNode>();

    for (const n of res.nodes) {
      if (n.node_id === this.rootNodeId) continue;
      const parentPath = pathOf.get(n.parent_id ?? '') ?? '';
      const name = n.name_enc ? decryptName(this.vaultKey, n.name_enc) : n.node_id;
      const path = parentPath ? `${parentPath}/${name}` : name;
      pathOf.set(n.node_id, path);

      tree.set(path, {
        nodeId: n.node_id,
        parentId: n.parent_id,
        path,
        rev: n.rev,
        address: n.sha256,
        // A folder is a node with no content. The server does not label them either.
        isFile: n.sha256 !== null,
      });
    }

    return { tree, cursor: res.snapshot };
  }

  // ---- one local file -----------------------------------------------------------

  /**
   * Everything that can happen to ONE local file, in the shape of the table at the top of
   * this file. The queue is the same FIFO `sync()` is draining — a conflict resolution
   * pushes the local original onto it as a brand new file to upload.
   */
  private async reconcileLocal(file: VaultFile): Promise<void> {
    // A conflict file born during this same pass has no pre-pass entry; compute it now.
    const m = this.meta.get(file.path) ?? (await this.hashAndTag(file.path));

    const known = this.state.nodes[file.path];
    const onServer = this.tree.get(file.path);

    // The node we know is still at this path on the server.
    if (onServer && known && known.nodeId === onServer.nodeId) {
      // Ordinary edit: this device has synced this exact node before. Local and remote
      // movement are separate facts; treating any difference as a local edit would let an
      // unchanged stale local file overwrite a newer server version.
      const localChanged = known.plainHash !== m.plainHash;
      const remoteChanged = known.address !== onServer.address;

      if (!localChanged && !remoteChanged) return;

      // Under a restore the server's "change" is the backup going backwards, and our copy is
      // the newer one — so the usual remote-wins pull is inverted into a push.
      if (!localChanged && remoteChanged && !this.policy.preferLocal) {
        await this.pull([onServer]);
        return;
      }

      // Local moved — alone, or with the server. Both go through the same PUT: the
      // precondition is what decides which it was, and the server is a better arbiter of
      // that than a client comparing two hashes it fetched a moment ago. If they diverged,
      // the 409 comes back and `pushEdit` writes the conflict file (docs/04).
      await this.pushEdit(file, m, known, onServer);
      return;
    }

    // A node at this path, but not the one we know — deleted and recreated, or a fresh
    // adoption. Content, not history, decides what happens next (docs/07).
    if (onServer && (!known || known.nodeId !== onServer.nodeId)) {
      const matched = this.dedup.get(m.tag);
      if (matched === onServer.address) {
        // Same plaintext, already at this exact address: record and move on.
        this.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: onServer.rev, plainHash: m.plainHash, address: onServer.address! };
        this.report.matched.push({ path: file.path });
        return;
      }
      await this.resolveConflict(file, onServer);
      return;
    }

    // Nothing at this path on the server. If we know the file, its node either moved or is
    // gone — and which of those it is decides whether this is a rename, a delete, or a
    // rescue. If we never knew it, it is a rename source or genuinely new.
    if (known) {
      const movedTo = this.byNodeId.get(known.nodeId);
      if (movedTo) {
        await this.applyRemoteRename(file, m, known, movedTo);
        return;
      }

      // Gone entirely. Deleted on the server — or lost to a restore. The policy knows which.
      const localChanged = known.plainHash !== m.plainHash;
      if (this.policy.applyRemoteDeletes && !localChanged) {
        await this.vault.delete(file.path);
        delete this.state.nodes[file.path];
        this.report.removed.push({ path: file.path });
        return;
      }
      // A restore (absence proves nothing) or local edits worth keeping: upload as new.
      await this.pushNew(file, m);
      return;
    }

    // Never known here, not on the server: a rename source, or genuinely new.
    const source = this.renameSourceFor(m);
    if (source) {
      await this.pushMove(file, m, source);
      return;
    }
    await this.pushNew(file, m);
  }

  /**
   * The one vanished path this file plausibly came from, or nothing.
   *
   * Deliberately narrow, in the terms docs/04 sets. **Unique**: two candidates with the same
   * content give no way to tell which moved where, and picking one is a coin toss with
   * somebody's file. **Large enough**: below a few hundred bytes a hash match carries almost
   * no information — empty notes and repeated stubs collide constantly. **Still where it
   * was**: if the server's tree no longer has a node at the old path, there is nothing to
   * move and this is an ordinary create.
   *
   * Failing any of these is not a failure. It falls through to delete-and-create, and the
   * blob deduplicates, so the cost of being conservative here is metadata.
   */
  private renameSourceFor(m: LocalMeta): Vanished | undefined {
    if (m.size < RENAME_MIN_BYTES) return undefined;

    const candidates = this.vanished.get(m.plainHash);
    if (!candidates || candidates.length !== 1) return undefined;

    const source = candidates[0]!;
    const node = this.tree.get(source.path);
    if (!node || node.nodeId !== source.nodeId) return undefined;

    // Consumed: a second file with these bytes must not claim the same source.
    this.vanished.delete(m.plainHash);
    return source;
  }

  private async hashAndTag(path: string): Promise<LocalMeta> {
    const bytes = await this.vault.read(path);
    return {
      plainHash: toHex(sha256(bytes)),
      tag: dedupTag(this.vaultKey, bytes),
      mtime: Date.now(),
      size: bytes.length,
    };
  }

  /**
   * A folder renamed is ONE move of the folder node, not a move per child.
   *
   * The per-file rename heuristic would move each child individually, which is correct but
   * leaves the empty source folder node behind on the server. Here the whole folder moves:
   * the children vanish under `V/…` and reappear, with identical content, under `N/…`, and
   * `V` is a folder node the server actually has.
   *
   * Deliberately strict — it fires only when **every** child of `V` reappears under the
   * **same** new parent `N` with the same relative path and the same hash, `N` does not
   * already exist on the server, and the parent chain of `N` is already there. Any of those
   * failing — a child edited during the move, a child scattered somewhere else, a folder
   * moved into a folder that is itself new — falls through to the per-file walk, which is
   * conservative by construction (docs/04).
   */
  private async moveRenamedFolders(local: VaultFile[], here: Set<string>): Promise<void> {
    // Group vanished files by their parent directory. A "folder" is a path prefix: every
    // child shares it.
    const byParent = new Map<string, { rel: string; v: Vanished; hash: string }[]>();
    for (const [hash, list] of this.vanished) {
      for (const v of list) {
        const slash = v.path.lastIndexOf('/');
        const parent = slash === -1 ? '' : v.path.slice(0, slash);
        const rel = slash === -1 ? v.path : v.path.slice(slash + 1);
        const arr = byParent.get(parent) ?? [];
        arr.push({ rel, v, hash });
        byParent.set(parent, arr);
      }
    }

    for (const [parent, children] of byParent) {
      // Only a path that IS a server folder node can be moved as one. And only when the
      // parent is a real folder with children — the vault root ('' ) is not movable.
      const source = this.tree.get(parent);
      if (!source || source.isFile || children.length === 0) continue;

      // Every child must reappear under the SAME new parent, at the same relative path,
      // with the same content.
      let newParent: string | undefined;
      const move = children.every(({ rel, v, hash }) => {
        const appeared = this.appearedUnder(rel, hash, here);
        if (!appeared || appeared.path === v.path) return false;
        const slash = appeared.path.lastIndexOf('/');
        const np = slash === -1 ? '' : appeared.path.slice(0, slash);
        if (newParent !== undefined && np !== newParent) return false;
        newParent = np;
        return true;
      });
      if (!move || newParent === undefined) continue;

      // The destination folder must not already exist (that would be a merge, not a move),
      // and its own parent chain must already be present so no folder is created in the
      // middle of a walk that has not processed it yet.
      if (this.tree.has(newParent)) continue;
      if (newParent && !this.parentChainExists(newParent)) continue;

      // One move of the folder node. The server recomputes ancestry for the whole subtree.
      const name = basename(newParent);
      const destParent = newParent ? parentOf(newParent) : '';
      const destParentId = destParent ? this.tree.get(destParent)!.nodeId : this.rootNodeId;
      try {
        const out = await this.client.moveNode(this.vaultId, source.nodeId, source.rev, {
          parent_id: destParentId,
          name_enc: encryptName(this.vaultKey, name),
          name_hmac: nameHmac(this.vaultKey, name),
          name_key_id: this.scopeId,
        });
        this.remapTreePaths(parent, newParent, out.rev);
        this.remapStatePaths(parent, newParent);
        for (const { rel, v, hash } of children) {
          this.vanished.delete(hash);
          this.handled.add(`${newParent}/${rel}`);
        }
        this.handled.add(newParent === '' ? '' : newParent);
        // The moved files' local copies were handled in this pass — do not upload them.
        for (const f of local) {
          if (f.path.startsWith(`${newParent}/`)) this.handled.add(f.path);
        }
        this.report.renamed.push({ from: parent, to: newParent });
      } catch (e) {
        // A refused move is not a failure we can resolve here — the per-file fallback
        // already ran nothing for these, so report and let the next pass retry.
        this.report.errors.push({ path: parent, message: message(e) });
      }
    }
  }

  /** A local file at `N/<rel>` whose hash matches the vanished one, or nothing. */
  private appearedUnder(rel: string, plainHash: string, here: Set<string>): VaultFile | undefined {
    // The candidate new path is the same relative path under any parent. We search the
    // appeared paths by scanning local files with this exact hash and the right suffix.
    for (const f of here) {
      if (!f.endsWith(`/${rel}`)) continue;
      const m = this.meta.get(f);
      if (m && m.plainHash === plainHash) {
        return { path: f, mtime: m.mtime };
      }
    }
    return undefined;
  }

  /** Every ancestor ABOVE the destination already exists as a server folder node. */
  private parentChainExists(path: string): boolean {
    // The destination itself is not part of its own parent chain; only the folders above it.
    const parent = parentOf(path);
    if (!parent) return true;
    let sofar = '';
    for (const part of parent.split('/')) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const node = this.tree.get(sofar);
      if (!node || node.isFile) return false;
    }
    return true;
  }

  /** Rewrite `from/…` paths in the walked tree to `to/…`, refreshing the moved folder's rev. */
  private remapTreePaths(from: string, to: string, rev: number): void {
    const prefix = from ? `${from}/` : '';
    const dest = to ? `${to}/` : '';
    const next = new Map<string, ServerNode>();
    for (const [path, node] of this.tree) {
      if (path === from) {
        next.set(to, { ...node, path: to, rev });
      } else if (path.startsWith(prefix)) {
        next.set(dest + path.slice(prefix.length), { ...node, path: dest + path.slice(prefix.length) });
      } else {
        next.set(path, node);
      }
    }
    this.tree = next;
  }

  /** The same rewrite for the local state, so the moved files are remembered at their new paths. */
  private remapStatePaths(from: string, to: string): void {
    const prefix = from ? `${from}/` : '';
    const dest = to ? `${to}/` : '';
    const next: VaultState['nodes'] = {};
    for (const [path, known] of Object.entries(this.state.nodes)) {
      if (path.startsWith(prefix)) {
        next[dest + path.slice(prefix.length)] = known;
      } else {
        next[path] = known;
      }
    }
    this.state.nodes = next;
  }

  /**
   * A move, not a delete and a create.
   *
   * The node keeps its id, so its **history follows it** — `versions` is keyed by `node_id`
   * and knows nothing about names (docs/04). Recreating it would strand every earlier
   * revision under a node the vault no longer shows.
   *
   * `If-Match` on the revision, because here placement really is the subject of the write:
   * unlike content, where `rev` moving on a rename would make an unrelated edit a conflict.
   */
  private async pushMove(file: VaultFile, m: LocalMeta, source: Vanished): Promise<void> {
    const parentId = await this.ensureFolders(file.path);
    const name = basename(file.path);

    const out = await this.client.moveNode(this.vaultId, source.nodeId, source.rev, {
      parent_id: parentId,
      name_enc: encryptName(this.vaultKey, name),
      name_hmac: nameHmac(this.vaultKey, name),
      name_key_id: this.scopeId,
    });

    delete this.state.nodes[source.path];
    this.state.nodes[file.path] = { nodeId: source.nodeId, rev: out.rev, plainHash: m.plainHash, address: source.address };

    // The tree follows, so the pull at the end of the pass does not see the old path as a
    // server-only node and fetch a file that has just moved.
    this.tree.delete(source.path);
    this.byNodeId.set(source.nodeId, { ...this.byNodeId.get(source.nodeId)!, path: file.path, parentId });
    this.tree.set(file.path, {
      nodeId: source.nodeId,
      parentId,
      path: file.path,
      rev: out.rev,
      address: source.address,
      isFile: true,
    });

    this.report.renamed.push({ from: source.path, to: file.path });
  }

  /**
   * Seal-or-bind, then PUT with the content precondition (#52).
   *
   * The base is **the version this device last synchronised** — `known.address` — and not
   * whatever the server holds at this instant. Sending the server its own current address
   * would make the precondition a tautology: it could never fail, and #52's entire job is to
   * fail when somebody else has written in the meantime.
   *
   * So a `409 base_mismatch` here is not an error to report; it is the answer arriving.
   * docs/04 gives the two branches, and the first one matters more than it looks: if the
   * server's content is what this device was about to write, two devices simply reached the
   * same text independently — very common, editing frontmatter back and forth — and calling
   * that a conflict would bury the user in files for nothing.
   */
  private async pushEdit(file: VaultFile, m: LocalMeta, known: { address: string } | undefined, onServer: ServerNode): Promise<void> {
    const plain = await this.vault.read(file.path);
    const { sha256: address, material } = await this.resolveContent(plain, m.tag);

    const out = await this.client.putContent(this.vaultId, onServer.nodeId, {
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      // Under a restore we pin the base to what the (rolled-back) server holds, so our newer
      // copy lands on top of it instead of bouncing off a base it never had.
      base_sha256: this.policy.preferLocal ? onServer.address : (known?.address ?? onServer.address),
      ...material,
    });

    if ('conflict' in out) {
      if (out.conflict !== 'base_mismatch') {
        // rev_mismatch or share_boundary: not about content, and not something a conflict
        // file would resolve.
        this.report.errors.push({ path: file.path, message: `refused: ${out.conflict}` });
        return;
      }

      const current: ServerNode = { ...onServer, address: out.sha256 ?? onServer.address, rev: out.rev ?? onServer.rev };
      const serverPlain = await this.fetchPlain(current);

      // Compared as PLAINTEXT, and it cannot be done any other way. `KC` is random, so the
      // same text sealed twice lands at two different addresses (docs/06) — comparing the
      // server's address against the one just uploaded would call every such case a
      // conflict, which is precisely the case docs/04 says must not become one. Two devices
      // reach identical content constantly, editing frontmatter back and forth.
      if (toHex(sha256(serverPlain)) === m.plainHash) {
        this.state.nodes[file.path] = {
          nodeId: onServer.nodeId,
          rev: current.rev,
          plainHash: m.plainHash,
          address: current.address!,
        };
        this.report.matched.push({ path: file.path });
        return;
      }

      // A real conflict: both sides moved from a common base. Same resolution as adoption's
      // no-common-ancestor case, because the outcome the user needs is identical — the
      // server version takes the path, this device's work survives beside it.
      await this.resolveConflict(file, current, serverPlain);
      return;
    }

    this.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: out.rev, plainHash: m.plainHash, address };
    this.report.pushed.push({ path: file.path });
  }

  /** A path with no node on the server at all: create one, folders and all. */
  private async pushNew(file: VaultFile, m: LocalMeta): Promise<void> {
    const plain = await this.vault.read(file.path);
    const { sha256: address, material } = await this.resolveContent(plain, m.tag);
    const parentId = await this.ensureFolders(file.path);
    const name = basename(file.path);

    const created = await this.client.createNode(this.vaultId, {
      parent_id: parentId,
      type: 'file',
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      name_enc: encryptName(this.vaultKey, name),
      name_hmac: nameHmac(this.vaultKey, name),
      name_key_id: this.scopeId,
      ...material,
    });
    this.state.nodes[file.path] = { nodeId: created.node_id, rev: created.rev, plainHash: m.plainHash, address };
    this.tree.set(file.path, { nodeId: created.node_id, parentId, path: file.path, rev: created.rev, address, isFile: true });
    this.byNodeId.set(created.node_id, this.tree.get(file.path)!);
    this.report.pushed.push({ path: file.path });
  }

  /**
   * Content already known to this vault's scope needs no envelope, no tag and no upload —
   * `nodes_check_private_material` only checks that the rows EXIST (docs/04). Content that
   * is not sealed, uploaded and tagged fresh, same as before this slice.
   */
  private async resolveContent(
    plain: Uint8Array,
    tag: string,
  ): Promise<{ sha256: string; material: { blob_envelopes: { sha256: string; scope_id: string; wrapped_key: string }[]; dedup_tags: { sha256: string; scope_id: string; content_tag: string }[] } }> {
    const dedupMatch = this.dedup.get(tag);
    if (dedupMatch) {
      return { sha256: dedupMatch, material: { blob_envelopes: [], dedup_tags: [] } };
    }
    const sealed = sealBlob(plain);
    await this.client.putBlob(sealed);
    return {
      sha256: sealed.sha256,
      material: {
        blob_envelopes: [{ sha256: sealed.sha256, scope_id: this.scopeId, wrapped_key: wrapContentKey(this.vaultKey, sealed.contentKey) }],
        dedup_tags: [{ sha256: sealed.sha256, scope_id: this.scopeId, content_tag: tag }],
      },
    };
  }

  /**
   * No common ancestor (docs/07): the server version becomes the file at this path, and the
   * local original is kept, never silently discarded. The conflict file is queued so it
   * uploads in the same pass — it is an ordinary new file the moment it exists.
   */
  private async resolveConflict(
    file: VaultFile,
    onServer: ServerNode,
    /** Already fetched by the caller that had to read it to decide this was a conflict at all. */
    fetched?: Uint8Array,
  ): Promise<void> {
    const serverPlain = fetched ?? (await this.fetchPlain(onServer));
    const localPlain = await this.vault.read(file.path);
    const conflictPath = withConflictSuffix(file.path, this.deviceLabel);

    await this.vault.write(file.path, serverPlain);
    await this.vault.write(conflictPath, localPlain);

    this.state.nodes[file.path] = {
      nodeId: onServer.nodeId,
      rev: onServer.rev,
      plainHash: toHex(sha256(serverPlain)),
      address: onServer.address!,
    };
    this.report.conflicts.push({ path: file.path, conflictPath });
    this.queue.push({ path: conflictPath, mtime: Date.now() });
  }

  /** The server's own bytes for a node, opened with the content key its envelope carries. */
  private async fetchPlain(node: ServerNode): Promise<Uint8Array> {
    if (!node.address) throw new Error('a folder has no content — this is a bug if it happens');

    const envelope = (await this.client.blobKeys(this.vaultId, [node.address]))
      .get(node.address)
      ?.find((e) => e.scopeId === this.scopeId);
    if (!envelope) throw new Error('no content-key envelope under this vault’s own key');

    const ciphertext = await this.client.getBlob(node.address);
    if (!ciphertext) throw new Error('the server holds no bytes at that address');
    return openBlob(unwrapContentKey(this.vaultKey, envelope.wrappedKey), ciphertext);
  }

  // ---- delete ---------------------------------------------------------------------

  /**
   * A synced file gone from disk is pushed as a delete — by node id, and with the revision
   * the walk just saw. The row soft-deletes into the trash, so a wrong call is recoverable;
   * the precondition is what stops a delete racing a write from winning.
   */
  private async pushDelete(v: Vanished): Promise<void> {
    const onServer = this.byNodeId.get(v.nodeId);
    // Gone from the server too — another device deleted it first. Nothing to push.
    if (!onServer) {
      delete this.state.nodes[v.path];
      return;
    }
    try {
      await this.client.deleteNode(this.vaultId, v.nodeId, onServer.rev);
      this.tree.delete(onServer.path);
      this.byNodeId.delete(v.nodeId);
      delete this.state.nodes[v.path];
      this.report.deleted.push({ path: v.path });
    } catch (e) {
      this.report.errors.push({ path: v.path, message: message(e) });
    }
  }

  // ---- remote rename (the node's id moved; only its path changed) ------------------

  /**
   * The server renamed a node we know: the id we track now lives at a different path. The
   * local file follows it, and if we had edits in hand they go up against the moved node —
   * by node id, not by path, so a rename and an edit never collide into a conflict (#52).
   */
  private async applyRemoteRename(file: VaultFile, m: LocalMeta, known: { nodeId: string; plainHash: string; address: string }, movedTo: ServerNode): Promise<void> {
    const localChanged = known.plainHash !== m.plainHash;

    // Move the local file to where the server put the node. The content goes with it.
    const plain = await this.vault.read(file.path);
    await this.vault.delete(file.path);
    await this.vault.write(movedTo.path, plain, file.mtime);

    delete this.state.nodes[file.path];
    this.state.nodes[movedTo.path] = { nodeId: known.nodeId, rev: movedTo.rev, plainHash: m.plainHash, address: movedTo.address! };
    this.handled.add(movedTo.path);
    this.report.renamed.push({ from: file.path, to: movedTo.path });

    // Our edits, if any, still go up — against the node at its new path.
    if (localChanged) {
      await this.pushEdit({ path: movedTo.path, mtime: file.mtime }, m, known, movedTo);
    }
  }

  // ---- resync after a reset ---------------------------------------------------------

  /**
   * A `410 reset` means another device declared itself the source of truth and re-uploaded
   * the vault with new node ids. Its tree is the truth now. Local content the new tree holds
   * rebinds nearly free (the blobs are already on the server), and everything it does NOT
   * hold is moved to `_Reset <date>/` — quarantined, never erased (#80, docs/07).
   */
  private async resyncAfterReset(local: VaultFile[]): Promise<void> {
    const quarantineRoot = `_Reset ${new Date().toISOString().slice(0, 10)}`;
    this.state.nodes = {};
    this.handled = new Set();

    for (const file of local) {
      this.handled.add(file.path);
      const m = this.meta.get(file.path)!;
      const onServer = this.tree.get(file.path);
      try {
        if (onServer && this.dedup.get(m.tag) === onServer.address) {
          // Same plaintext at the same path in the winning tree: rebind, nothing moves.
          this.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: onServer.rev, plainHash: m.plainHash, address: onServer.address! };
          this.report.matched.push({ path: file.path });
          continue;
        }
        // Displaced. The local copy is kept, out of sync's reach.
        const dest = `${quarantineRoot}/${file.path}`;
        const bytes = await this.vault.read(file.path);
        await this.vault.write(dest, bytes, file.mtime);
        await this.vault.delete(file.path);
        this.report.quarantined.push({ from: file.path, to: dest });
        // If the winning tree has its own file at this path, it now comes down.
        if (onServer && onServer.isFile) await this.pull([onServer]);
      } catch (e) {
        this.report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // What the winning tree holds that we never had.
    const serverOnly = [...this.tree.values()].filter((n) => n.isFile && n.address && !this.handled.has(n.path));
    await this.pull(serverOnly);
  }

  // ---- pull -------------------------------------------------------------------------

  private async pull(nodes: ServerNode[]): Promise<void> {
    // One request for every envelope, not one per file: applying a delta means opening
    // everything that changed, and a round trip per note is what makes a first sync feel
    // broken on a home connection.
    const envelopes = await this.client.blobKeys(this.vaultId, nodes.map((n) => n.address!));

    for (const node of nodes) {
      try {
        const envelope = envelopes.get(node.address!)?.find((e) => e.scopeId === this.scopeId);
        if (!envelope) throw new Error('no content-key envelope under this vault’s own key');

        const ciphertext = await this.client.getBlob(node.address!);
        if (!ciphertext) throw new Error('the server holds no bytes at that address');

        const plain = openBlob(unwrapContentKey(this.vaultKey, envelope.wrappedKey), ciphertext);
        await this.vault.write(node.path, plain);

        this.state.nodes[node.path] = { nodeId: node.nodeId, rev: node.rev, plainHash: toHex(sha256(plain)), address: node.address! };
        this.report.pulled.push({ path: node.path });
      } catch (e) {
        this.report.errors.push({ path: node.path, message: message(e) });
      }
    }
  }

  /** Every folder on the way to a file, created once and remembered in the tree we are holding. */
  private async ensureFolders(filePath: string): Promise<string> {
    const parts = filePath.split('/').slice(0, -1);
    let parentId = this.rootNodeId;
    let sofar = '';

    for (const part of parts) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const existing = this.tree.get(sofar);
      if (existing) {
        parentId = existing.nodeId;
        continue;
      }
      const created = await this.client.createNode(this.vaultId, {
        parent_id: parentId,
        type: 'folder',
        mtime: new Date().toISOString(),
        name_enc: encryptName(this.vaultKey, part),
        name_hmac: nameHmac(this.vaultKey, part),
        name_key_id: this.scopeId,
      });
      this.tree.set(sofar, { nodeId: created.node_id, parentId, path: sofar, rev: created.rev, address: null, isFile: false });
      this.byNodeId.set(created.node_id, this.tree.get(sofar)!);
      parentId = created.node_id;
    }

    return parentId;
  }
}

const depth = (path: string): number => path.split('/').length;
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `Note (conflict 2026-08-01 laptop).md` — the exact form docs/04 specifies for a content
 * conflict, reused here for adoption's "no common ancestor" case since it is the same
 * situation stated the other way: two versions with no shared history landed on one path.
 */
const withConflictSuffix = (path: string, device: string): string => {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  const date = new Date().toISOString().slice(0, 10);
  return `${dir}${stem} (conflict ${date} ${device})${ext}`;
};

