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
import type { SyncClient } from '../api/client.js';
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
}

export class SyncEngine {
  constructor(
    private readonly client: SyncClient,
    private readonly vaultId: string,
    private readonly vaultKey: Uint8Array,
    private readonly vault: VaultAdapter,
    private readonly store: StateStore,
    /** Named in a conflict file's filename (docs/04): `Note (conflict 2026-08-01 laptop).md`. */
    private readonly deviceLabel = 'device',
  ) {}

  async sync(): Promise<SyncReport> {
    const report: SyncReport = { scanned: 0, pushed: [], pulled: [], matched: [], conflicts: [], errors: [] };
    const state = await this.store.load();

    const opened = await this.client.openVault(this.vaultId);
    const scopeId = opened.scopes.find((s) => s.scope === 'vault')?.key_id;
    if (!scopeId) throw new Error('the vault reports no key scope of its own');

    const { tree, cursor } = await this.readServerTree(opened.root_node_id);
    const local = (await this.vault.list()).filter((f) => isSyncable(f.path));
    report.scanned = local.length;
    const localPaths = new Set(local.map((f) => f.path));

    // Read once, hash, tag — and let the bytes go. Holding every file in memory at once is
    // the thing docs/02 rules out; re-reading a handful of them a second time, just before
    // an actual upload, costs I/O this trades for that.
    const meta = new Map<string, LocalMeta>();
    for (const f of local) {
      const bytes = await this.vault.read(f.path);
      meta.set(f.path, { plainHash: toHex(sha256(bytes)), tag: dedupTag(this.vaultKey, bytes), mtime: f.mtime });
    }
    const dedup = await this.client.dedupLookup(this.vaultId, [...new Set([...meta.values()].map((m) => m.tag))]);

    // Shallowest first, so a folder exists before the file that lives in it. A FIFO queue
    // rather than one static pass: a conflict file created mid-walk is pushed onto the end
    // and uploaded in this same pass, not left for the next click. Its folder is always
    // already there — it lands beside the file it came from, which this loop has by then
    // already ensured a parent for.
    const queue: VaultFile[] = [...local].sort((a, b) => depth(a.path) - depth(b.path));

    while (queue.length) {
      const file = queue.shift()!;
      try {
        await this.reconcileLocal(file, meta, dedup, tree, opened.root_node_id, scopeId, state, report, queue);
      } catch (e) {
        report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // What is left: server files no local copy ever stood in for. Ordinary pull.
    const serverOnly = [...tree.values()].filter((n) => n.isFile && n.address && !localPaths.has(n.path));
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

      if (localChanged && !remoteChanged) {
        await this.pushEdit(file, m, onServer, scopeId, dedup, state, report);
        return;
      }

      if (!localChanged && remoteChanged) {
        await this.pull([onServer], scopeId, state, report);
        return;
      }

      report.errors.push({
        path: file.path,
        message: 'changed on this device and on the server; resolve manually before syncing again',
      });
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

    // Neither: a genuinely new file, nowhere on the server yet.
    await this.pushNew(file, m, tree, rootNodeId, scopeId, dedup, state, report);
  }

  private async hashAndTag(path: string): Promise<LocalMeta> {
    const bytes = await this.vault.read(path);
    return { plainHash: toHex(sha256(bytes)), tag: dedupTag(this.vaultKey, bytes), mtime: Date.now() };
  }

  /** Seal-or-bind, then PUT against the content the server currently holds (#52). */
  private async pushEdit(
    file: VaultFile,
    m: LocalMeta,
    onServer: ServerNode,
    scopeId: string,
    dedup: Map<string, string>,
    state: VaultState,
    report: SyncReport,
  ): Promise<void> {
    const plain = await this.vault.read(file.path);
    const { sha256: address, material } = await this.resolveContent(plain, m.tag, dedup.get(m.tag), scopeId);

    const out = await this.client.putContent(this.vaultId, onServer.nodeId, {
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      base_sha256: onServer.address,
      ...material,
    });
    if ('conflict' in out) {
      // A genuine race — somebody else wrote this node between the tree read and now.
      // M1's adoption handles "no common ancestor"; this is the other kind, still open.
      report.errors.push({ path: file.path, message: `refused: ${out.conflict}` });
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
  ): Promise<void> {
    if (!onServer.address) throw new Error('a folder cannot collide on content — this is a bug if it happens');

    const envelope = (await this.client.blobKeys(this.vaultId, [onServer.address]))
      .get(onServer.address)
      ?.find((e) => e.scopeId === scopeId);
    if (!envelope) throw new Error('no content-key envelope under this vault’s own key');
    const ciphertext = await this.client.getBlob(onServer.address);
    if (!ciphertext) throw new Error('the server holds no bytes at that address');
    const serverPlain = openBlob(unwrapContentKey(this.vaultKey, envelope.wrappedKey), ciphertext);

    const localPlain = await this.vault.read(file.path);
    const conflictPath = withConflictSuffix(file.path, this.deviceLabel);

    await this.vault.write(file.path, serverPlain);
    await this.vault.write(conflictPath, localPlain);

    state.nodes[file.path] = {
      nodeId: onServer.nodeId,
      rev: onServer.rev,
      plainHash: toHex(sha256(serverPlain)),
      address: onServer.address,
    };
    report.conflicts.push({ path: file.path, conflictPath });
    queue.push({ path: conflictPath, mtime: Date.now() });
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
