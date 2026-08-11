/**
 * M1, first slice: **adoption**. A vault that already has files is no longer overwritten
 * blindly, and it is no longer the one direction the engine refuses to take (docs/10) — this
 * is the boundary M0.5 drew, moved.
 *
 * One pass now reconciles, rather than choosing push XOR pull for the whole vault:
 *
 * | Local | Server | Result |
 * |---|---|---|
 * | only local | — | upload — unless the content is already known in this scope, in which case bind to the existing address and send nothing (docs/07, "nearly free") |
 * | — | only server | download |
 * | both, this device already knows the node | ordinary edit: the content precondition decides (#52) |
 * | both, this device does NOT know the node | **adoption**: matching content binds silently; differing content is a conflict with no common ancestor — the server version becomes the file, the local one survives as a conflict file (docs/07) |
 *
 * The third row is the one M0.5 already had. The fourth is new, and it is what turns on the
 * moment two independent copies of a vault meet — the ordinary case for a migration or a
 * second device.
 *
 * **What this slice does NOT cover, on purpose**, because each is its own acceptance scenario
 * (docs/10) and none is safe to fold in silently: rename detection by hash (a moved file is
 * still seen as delete+create here), deleted-node/trash reconciliation, resync after the
 * journal TTL (`410`), and the pre-flight checks a real migration needs (quota, case
 * collisions, placeholder files). Left for the slices after this one.
 */
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
  /**
   * Paths this device had synced that are no longer on disk, and were not explained by a
   * rename. **Reported, not acted on**: telling the server to delete them is its own
   * scenario, and a rescan that guesses wrong about a disappearance deletes somebody's work.
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

  async sync(): Promise<SyncReport> {
    const report: SyncReport = {
      scanned: 0, pushed: [], pulled: [], matched: [], conflicts: [], renamed: [], vanished: [], errors: [],
    };
    const state = await this.store.load();

    const opened = await this.client.openVault(this.vaultId);
    const scopeId = opened.scopes.find((s) => s.scope === 'vault')?.key_id;
    if (!scopeId) throw new Error('the vault reports no key scope of its own');

    const { tree, cursor } = await this.readServerTree(opened.root_node_id);
    const local = (await this.vault.list()).filter((f) => isSyncable(f.path));
    report.scanned = local.length;

    // Filled as the walk goes, not snapshotted before it. The queue grows — a conflict
    // resolution adds a file — and a path that this pass has just created and uploaded is
    // not a "server only" node to fetch back down at the end. Taken from the list up front,
    // that is exactly what happened: the conflict file was pushed and then immediately
    // pulled over itself, which a real server answers silently because the envelope it
    // needs was uploaded a moment earlier.
    const handled = new Set<string>();

    // Read once, hash, tag — and let the bytes go. Holding every file in memory at once is
    // the thing docs/02 rules out; re-reading a handful of them a second time, just before
    // an actual upload, costs I/O this trades for that.
    const meta = new Map<string, LocalMeta>();
    for (const f of local) {
      const bytes = await this.vault.read(f.path);
      meta.set(f.path, {
        plainHash: toHex(sha256(bytes)),
        tag: dedupTag(this.vaultKey, bytes),
        mtime: f.mtime,
        size: bytes.length,
      });
    }
    const dedup = await this.client.dedupLookup(this.vaultId, [...new Set([...meta.values()].map((m) => m.tag))]);

    // Paths this device had synced and can no longer find. A rename shows up as exactly this
    // plus a new path holding the same bytes, and the pairing has to be decided BEFORE the
    // walk creates a second node for the new one.
    const here = new Set(local.map((f) => f.path));
    const vanished = new Map<string, Vanished[]>();
    for (const [path, known] of Object.entries(state.nodes)) {
      if (here.has(path)) continue;
      const list = vanished.get(known.plainHash) ?? [];
      list.push({ path, nodeId: known.nodeId, rev: known.rev, address: known.address });
      vanished.set(known.plainHash, list);
    }

    // Shallowest first, so a folder exists before the file that lives in it. A FIFO queue
    // rather than one static pass: a conflict file created mid-walk is pushed onto the end
    // and uploaded in this same pass, not left for the next click. Its folder is always
    // already there — it lands beside the file it came from, which this loop has by then
    // already ensured a parent for.
    const queue: VaultFile[] = [...local].sort((a, b) => depth(a.path) - depth(b.path));

    while (queue.length) {
      const file = queue.shift()!;
      handled.add(file.path);
      try {
        await this.reconcileLocal(file, meta, dedup, vanished, tree, opened.root_node_id, scopeId, state, report, queue);
      } catch (e) {
        report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // Whatever the walk did not claim as a rename source really is gone from this device.
    // Said out loud and left alone: acting on it means deleting on the server, and a rescan
    // that guesses wrong about a disappearance — a folder not yet mounted, a sync client
    // mid-write — deletes work nobody asked it to.
    for (const list of vanished.values()) {
      for (const v of list) {
        report.vanished.push({ path: v.path });
        handled.add(v.path);
      }
    }

    // What is left: server files no local copy ever stood in for. Ordinary pull.
    const serverOnly = [...tree.values()].filter((n) => n.isFile && n.address && !handled.has(n.path));
    await this.pull(serverOnly, scopeId, state, report);

    state.cursor = cursor;
    await this.store.save(state);
    return report;
  }

  /**
   * The server's tree, with paths reconstructed on this side.
   *
   * The server holds `parent_id` and an encrypted name and nothing else — it has no paths at
   * all (docs/03) — so a path exists only once a client has decrypted every name on the way
   * down. `list` returns nodes shallowest-first, which is what makes one pass enough.
   */
  private async readServerTree(rootNodeId: string): Promise<{ tree: Map<string, ServerNode>; cursor: string }> {
    const res = await this.client.listNodes(this.vaultId);
    const pathOf = new Map<string, string>([[rootNodeId, '']]);
    const tree = new Map<string, ServerNode>();

    for (const n of res.nodes) {
      if (n.node_id === rootNodeId) continue;
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

  // ---- one local file --------------------------------------------------------------

  /**
   * Everything that can happen to ONE local file, in the shape of the table at the top of
   * this file. `queue` is the same FIFO `sync()` is draining — a conflict resolution pushes
   * the local original onto it as a brand new file to upload.
   */
  private async reconcileLocal(
    file: VaultFile,
    meta: Map<string, LocalMeta>,
    dedup: Map<string, string>,
    vanished: Map<string, Vanished[]>,
    tree: Map<string, ServerNode>,
    rootNodeId: string,
    scopeId: string,
    state: VaultState,
    report: SyncReport,
    queue: VaultFile[],
  ): Promise<void> {
    // A conflict file born during this same pass has no pre-pass entry; compute it now.
    const m = meta.get(file.path) ?? (await this.hashAndTag(file.path));

    const known = state.nodes[file.path];
    const onServer = tree.get(file.path);

    if (onServer && known && known.nodeId === onServer.nodeId) {
      // Ordinary edit: this device has synced this exact node before. Local and remote
      // movement are separate facts; treating any difference as a local edit would let an
      // unchanged stale local file overwrite a newer server version.
      const localChanged = known.plainHash !== m.plainHash;
      const remoteChanged = known.address !== onServer.address;

      if (!localChanged && !remoteChanged) return;

      if (!localChanged && remoteChanged) {
        await this.pull([onServer], scopeId, state, report);
        return;
      }

      // Local moved — alone, or with the server. Both go through the same PUT: the
      // precondition is what decides which it was, and the server is a better arbiter of
      // that than a client comparing two hashes it fetched a moment ago. If they diverged,
      // the 409 comes back and `pushEdit` writes the conflict file (docs/04).
      await this.pushEdit(file, m, known, onServer, scopeId, dedup, state, report, queue);
      return;
    }

    if (onServer && !known) {
      // ADOPTION: a node sits at this path that this device has never recorded — the
      // ordinary shape of a migration, or of a second device meeting an already-synced
      // vault. Content, not history, decides what happens next (docs/07).
      const matched = dedup.get(m.tag);
      if (matched === onServer.address) {
        // Same plaintext, already at this exact address: record and move on.
        state.nodes[file.path] = { nodeId: onServer.nodeId, rev: onServer.rev, plainHash: m.plainHash, address: onServer.address! };
        report.matched.push({ path: file.path });
        return;
      }
      await this.resolveConflict(file, onServer, scopeId, state, report, queue);
      return;
    }

    // Nothing at this path on the server. Before treating it as new, ask whether it is
    // something this device already had somewhere else.
    const source = this.renameSourceFor(m, vanished, tree);
    if (source) {
      await this.pushMove(file, m, source, tree, rootNodeId, scopeId, state, report);
      return;
    }

    // Neither: a genuinely new file, nowhere on the server yet.
    await this.pushNew(file, m, tree, rootNodeId, scopeId, dedup, state, report);
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
  private renameSourceFor(
    m: LocalMeta,
    vanished: Map<string, Vanished[]>,
    tree: Map<string, ServerNode>,
  ): Vanished | undefined {
    if (m.size < RENAME_MIN_BYTES) return undefined;

    const candidates = vanished.get(m.plainHash);
    if (!candidates || candidates.length !== 1) return undefined;

    const source = candidates[0]!;
    const node = tree.get(source.path);
    if (!node || node.nodeId !== source.nodeId) return undefined;

    // Consumed: a second file with these bytes must not claim the same source.
    vanished.delete(m.plainHash);
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
   * A move, not a delete and a create.
   *
   * The node keeps its id, so its **history follows it** — `versions` is keyed by `node_id`
   * and knows nothing about names (docs/04). Recreating it would strand every earlier
   * revision under a node the vault no longer shows.
   *
   * `If-Match` on the revision, because here placement really is the subject of the write:
   * unlike content, where `rev` moving on a rename would make an unrelated edit a conflict.
   */
  private async pushMove(
    file: VaultFile,
    m: LocalMeta,
    source: Vanished,
    tree: Map<string, ServerNode>,
    rootNodeId: string,
    scopeId: string,
    state: VaultState,
    report: SyncReport,
  ): Promise<void> {
    const parentId = await this.ensureFolders(file.path, tree, rootNodeId, scopeId);
    const name = basename(file.path);

    const out = await this.client.moveNode(this.vaultId, source.nodeId, source.rev, {
      parent_id: parentId,
      name_enc: encryptName(this.vaultKey, name),
      name_hmac: nameHmac(this.vaultKey, name),
      name_key_id: scopeId,
    });

    delete state.nodes[source.path];
    state.nodes[file.path] = { nodeId: source.nodeId, rev: out.rev, plainHash: m.plainHash, address: source.address };

    // The tree follows, so the pull at the end of the pass does not see the old path as a
    // server-only node and fetch a file that has just moved.
    tree.delete(source.path);
    tree.set(file.path, {
      nodeId: source.nodeId,
      parentId,
      path: file.path,
      rev: out.rev,
      address: source.address,
      isFile: true,
    });

    report.renamed.push({ from: source.path, to: file.path });
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
  private async pushEdit(
    file: VaultFile,
    m: LocalMeta,
    known: { address: string } | undefined,
    onServer: ServerNode,
    scopeId: string,
    dedup: Map<string, string>,
    state: VaultState,
    report: SyncReport,
    queue: VaultFile[],
  ): Promise<void> {
    const plain = await this.vault.read(file.path);
    const { sha256: address, material } = await this.resolveContent(plain, m.tag, dedup.get(m.tag), scopeId);

    const out = await this.client.putContent(this.vaultId, onServer.nodeId, {
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      base_sha256: known?.address ?? onServer.address,
      ...material,
    });

    if ('conflict' in out) {
      if (out.conflict !== 'base_mismatch') {
        // rev_mismatch or share_boundary: not about content, and not something a conflict
        // file would resolve.
        report.errors.push({ path: file.path, message: `refused: ${out.conflict}` });
        return;
      }

      const current: ServerNode = { ...onServer, address: out.sha256 ?? onServer.address, rev: out.rev ?? onServer.rev };
      const serverPlain = await this.fetchPlain(current, scopeId);

      // Compared as PLAINTEXT, and it cannot be done any other way. `KC` is random, so the
      // same text sealed twice lands at two different addresses (docs/06) — comparing the
      // server's address against the one just uploaded would call every such case a
      // conflict, which is precisely the case docs/04 says must not become one. Two devices
      // reach identical content constantly, editing frontmatter back and forth.
      if (toHex(sha256(serverPlain)) === m.plainHash) {
        state.nodes[file.path] = {
          nodeId: onServer.nodeId,
          rev: current.rev,
          plainHash: m.plainHash,
          address: current.address!,
        };
        report.matched.push({ path: file.path });
        return;
      }

      // A real conflict: both sides moved from a common base. Same resolution as adoption's
      // no-common-ancestor case, because the outcome the user needs is identical — the
      // server version takes the path, this device's work survives beside it.
      await this.resolveConflict(file, current, scopeId, state, report, queue, serverPlain);
      return;
    }

    state.nodes[file.path] = { nodeId: onServer.nodeId, rev: out.rev, plainHash: m.plainHash, address };
    report.pushed.push({ path: file.path });
  }

  /** A path with no node on the server at all: create one, folders and all. */
  private async pushNew(
    file: VaultFile,
    m: LocalMeta,
    tree: Map<string, ServerNode>,
    rootNodeId: string,
    scopeId: string,
    dedup: Map<string, string>,
    state: VaultState,
    report: SyncReport,
  ): Promise<void> {
    const plain = await this.vault.read(file.path);
    const { sha256: address, material } = await this.resolveContent(plain, m.tag, dedup.get(m.tag), scopeId);
    const parentId = await this.ensureFolders(file.path, tree, rootNodeId, scopeId);
    const name = basename(file.path);

    const created = await this.client.createNode(this.vaultId, {
      parent_id: parentId,
      type: 'file',
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      name_enc: encryptName(this.vaultKey, name),
      name_hmac: nameHmac(this.vaultKey, name),
      name_key_id: scopeId,
      ...material,
    });
    state.nodes[file.path] = { nodeId: created.node_id, rev: created.rev, plainHash: m.plainHash, address };
    tree.set(file.path, { nodeId: created.node_id, parentId, path: file.path, rev: created.rev, address, isFile: true });
    report.pushed.push({ path: file.path });
  }

  /**
   * Content already known to this vault's scope needs no envelope, no tag and no upload —
   * `nodes_check_private_material` only checks that the rows EXIST (docs/04). Content that
   * is not sealed, uploaded and tagged fresh, same as before this slice.
   */
  private async resolveContent(
    plain: Uint8Array,
    tag: string,
    dedupMatch: string | undefined,
    scopeId: string,
  ): Promise<{ sha256: string; material: { blob_envelopes: { sha256: string; scope_id: string; wrapped_key: string }[]; dedup_tags: { sha256: string; scope_id: string; content_tag: string }[] } }> {
    if (dedupMatch) {
      return { sha256: dedupMatch, material: { blob_envelopes: [], dedup_tags: [] } };
    }
    const sealed = sealBlob(plain);
    await this.client.putBlob(sealed);
    return {
      sha256: sealed.sha256,
      material: {
        blob_envelopes: [{ sha256: sealed.sha256, scope_id: scopeId, wrapped_key: wrapContentKey(this.vaultKey, sealed.contentKey) }],
        dedup_tags: [{ sha256: sealed.sha256, scope_id: scopeId, content_tag: tag }],
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
    scopeId: string,
    state: VaultState,
    report: SyncReport,
    queue: VaultFile[],
    /** Already fetched by the caller that had to read it to decide this was a conflict at all. */
    fetched?: Uint8Array,
  ): Promise<void> {
    const serverPlain = fetched ?? (await this.fetchPlain(onServer, scopeId));
    const localPlain = await this.vault.read(file.path);
    const conflictPath = withConflictSuffix(file.path, this.deviceLabel);

    await this.vault.write(file.path, serverPlain);
    await this.vault.write(conflictPath, localPlain);

    state.nodes[file.path] = {
      nodeId: onServer.nodeId,
      rev: onServer.rev,
      plainHash: toHex(sha256(serverPlain)),
      address: onServer.address!,
    };
    report.conflicts.push({ path: file.path, conflictPath });
    queue.push({ path: conflictPath, mtime: Date.now() });
  }

  /** The server's own bytes for a node, opened with the content key its envelope carries. */
  private async fetchPlain(node: ServerNode, scopeId: string): Promise<Uint8Array> {
    if (!node.address) throw new Error('a folder has no content — this is a bug if it happens');

    const envelope = (await this.client.blobKeys(this.vaultId, [node.address]))
      .get(node.address)
      ?.find((e) => e.scopeId === scopeId);
    if (!envelope) throw new Error('no content-key envelope under this vault’s own key');

    const ciphertext = await this.client.getBlob(node.address);
    if (!ciphertext) throw new Error('the server holds no bytes at that address');
    return openBlob(unwrapContentKey(this.vaultKey, envelope.wrappedKey), ciphertext);
  }

  // ---- pull --------------------------------------------------------------------

  private async pull(nodes: ServerNode[], scopeId: string, state: VaultState, report: SyncReport): Promise<void> {
    // One request for every envelope, not one per file: applying a delta means opening
    // everything that changed, and a round trip per note is what makes a first sync feel
    // broken on a home connection.
    const envelopes = await this.client.blobKeys(this.vaultId, nodes.map((n) => n.address!));

    for (const node of nodes) {
      try {
        const envelope = envelopes.get(node.address!)?.find((e) => e.scopeId === scopeId);
        if (!envelope) throw new Error('no content-key envelope under this vault’s own key');

        const ciphertext = await this.client.getBlob(node.address!);
        if (!ciphertext) throw new Error('the server holds no bytes at that address');

        const plain = openBlob(unwrapContentKey(this.vaultKey, envelope.wrappedKey), ciphertext);
        await this.vault.write(node.path, plain);

        state.nodes[node.path] = { nodeId: node.nodeId, rev: node.rev, plainHash: toHex(sha256(plain)), address: node.address! };
        report.pulled.push({ path: node.path });
      } catch (e) {
        report.errors.push({ path: node.path, message: message(e) });
      }
    }
  }

  /** Every folder on the way to a file, created once and remembered in the tree we are holding. */
  private async ensureFolders(
    filePath: string,
    tree: Map<string, ServerNode>,
    rootNodeId: string,
    scopeId: string,
  ): Promise<string> {
    const parts = filePath.split('/').slice(0, -1);
    let parentId = rootNodeId;
    let sofar = '';

    for (const part of parts) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const existing = tree.get(sofar);
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
        name_key_id: scopeId,
      });
      tree.set(sofar, { nodeId: created.node_id, parentId, path: sofar, rev: created.rev, address: null, isFile: false });
      parentId = created.node_id;
    }

    return parentId;
  }
}

const depth = (path: string): number => path.split('/').length;
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
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
