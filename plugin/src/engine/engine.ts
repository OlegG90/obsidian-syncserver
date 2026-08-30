/**
 * M1, two-way sync of one vault: push, pull, adopt, delete, and resync after a moved epoch.
 *
 * One pass reconciles, rather than choosing push XOR pull for the whole vault:
 *
 * | Local | Server | Result |
 * |---|---|---|
 * | only local | — | upload — unless the content is already known in this scope, in which case bind to the existing address and send nothing (docs/07, "nearly free") |
 * | — | only server | download |
 * | both, this device already knows the node | ordinary edit: the content precondition decides (D-52) |
 * | both, this device does NOT know the node | **adoption**: matching content binds silently; differing content is a conflict with no common ancestor (docs/07) |
 * | known here, gone from the server | a **delete** — but which side deleted is read from the epoch, below |
 *
 * The last row is the one that cannot be read from the trees alone. The same absence is a
 * deletion on one epoch and a rescue target on another, so before anything is removed the
 * stored cursor is presented to the delta endpoint and its answer decides (D-70, docs/04):
 *
 * - `200` / `journal_ttl` — the server is continuous with what we saw, or ahead of it. A
 *   known node missing from the walk **was** deleted there; the local copy is removed.
 * - `restore` / `cursor_unverifiable` — the server moved backwards, or the cursor cannot be
 *   checked at all. Absence proves nothing: nothing is deleted locally, and what the server
 *   lost is uploaded as new.
 * - `reset` — another device won the vault. Its tree is the truth; local work it does not
 *   hold is quarantined to `_Reset <date>/`, never erased (D-80, docs/07).
 *
 * Local deletes (a synced file gone from disk) push `deleteNode` — safe under every epoch,
 * because the row soft-deletes into the trash and the content survives (docs/03).
 *
 * **Never destroy the last local copy of content before its replacement exists** (issues #239, #242).
 * Three places move bytes about on disk — a remote rename, a conflict, and the quarantine a reset
 * writes — and each is two steps with no transaction around them. Ordered the wrong way round, a failed
 * or interrupted second step leaves the content nowhere: the vault has lost it, and for a rename the
 * NEXT pass reads the vanished path as a deletion and pushes it, taking the file off every other device
 * too. Write the destination first, delete the source after. It is the same rule each time and it is
 * stated here rather than three times, because three copies of a reason drift.
 *
 * One pass's mutable state is a single `PassContext` built in `sync()` and handed to every
 * helper, so a reused instance starts a fresh pass instead of carrying the last one's
 * fields. Out of scope, deliberately: folder moves are still per-file, and the delta's
 * *pages* are not applied incrementally — the full walk is the data source, the probe is
 * only the provenance check (incremental application is M2).
 */
import type { DeltaEvent } from '@syncserver/shared';
import { resolveContent } from './content.js';
import { treeFrom, type UnreadableFolder } from './tree.js';
import type { TreeCache } from './tree-cache.js';
import { remapState, remapTree } from './remap.js';
import type { ServerNode } from './wire.js';
import type { VaultWire } from './wire.js';
import { openBlob, sealBlob } from '../crypto/blob.js';
import { toHex } from '../crypto/bytes.js';
import { decryptName, dedupTag, dedupTagFromHash, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../crypto/scope.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { StateStore, VaultState } from './state.js';
import { isSyncable, type VaultAdapter, type VaultFile } from './vault.js';
import { folderMoves, renameSourceFor, type Vanished } from './rename.js';
import { contentScopeFor } from './scopes.js';
import { VaultScopes } from '../share-keys.js';

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
   * not hold is moved to `_Reset <date>/`, never erased (D-80, docs/07).
   */
  quarantined: { from: string; to: string }[];
  /**
   * What the server says is true of this account right now (docs/04).
   *
   * **States, not a log**: they are recomputed on every delta and repeat until they stop
   * being true, so a device that was offline is told again and one that has caught up is not
   * told at all. The engine does not act on them — an ended share is finalized by a person
   * pressing Leave, and a freeze is lifted by freeing space — it carries them, because the
   * pass is the only moment the client and the server speak without being asked to.
   *
   * They arrived on every delta for months with nobody reading them, which cost the server a
   * query per sync and the person the two facts they most needed: that a share they are in
   * is over, and that their account has stopped accepting anything.
   */
  events: DeltaEvent[];
  /**
   * Paths this device had synced that are no longer on disk, and were neither explained by a
   * rename nor pushed as a delete. Reported, not acted on — a rescan that guesses wrong
   * about a disappearance (a folder not yet mounted) must not delete somebody's work.
   */
  vanished: { path: string }[];
  /**
   * Shared folders this device holds no key for, one entry each (D-115's cousin: a key that
   * has not arrived, not a permission that was refused).
   *
   * **Not an error, and deliberately not part of the pass's mood.** Everything that could
   * sync did; a folder whose key has not reached this device is a state that persists until
   * it does, so letting it dominate would make "up to date" an unreachable answer for as
   * long as the state lasts. It is counted and named, which is what a person can act on —
   * deliver the key, or pair this device — and nothing more.
   */
  unreadable: UnreadableFolder[];
  errors: { path: string; message: string }[];
}



/** What the pre-pass learns about one local file without holding onto its bytes. */
/**
 * What a caller may ask of one pass.
 *
 * One type rather than the same anonymous shape at five call sites — the command, `syncNow`, the
 * coordinator, `runPass` and here — because they are one option travelling, and five copies drift.
 */
export interface PassOptions {
  /**
   * Read every file, rather than trusting the recorded `mtime`/`size` (issue #237).
   *
   * The way back when a timestamp lied: a restore from backup, `mv -p`, or another tool writing into
   * the vault can leave content changed under an unmoved timestamp, and nothing detects that by
   * construction.
   */
  rescan?: boolean;
}

interface LocalMeta {
  plainHash: string;
  /** `HMAC(vault key, sha256(plaintext))` — what the dedup lookup is keyed by (docs/06). */
  tag: string;
  mtime: number;
  size: number;
}


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

const POLICY: Record<RemoteEpoch, SyncPolicy> = {
  // The walk is current, so a known node missing from it was genuinely deleted.
  continuous: { pushDeletes: true, applyRemoteDeletes: true, preferLocal: false },
  // The journal pruned past our cursor, but the server moved forwards — same reading.
  journal_ttl: { pushDeletes: true, applyRemoteDeletes: true, preferLocal: false },
  // The server went backwards: absence proves nothing, and our copy may be the only one.
  restore: { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true },
  // The cursor cannot be checked at all: resync from empty, deleting nothing (D-100).
  unverifiable: { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true },
  // Not a flag change but a different algorithm (`resyncAfterReset`), so the flags it never
  // reads record its stance — never trust absence, never delete — and the table is total:
  // the per-pass context can always name a policy, whichever epoch decided the pass.
  reset: { pushDeletes: false, applyRemoteDeletes: false, preferLocal: true },
};

/**
 * Everything one pass mutates, built fresh in `sync()` and handed to every helper.
 *
 * The instance used to carry this state as a dozen `!`-typed fields written in `sync()`,
 * which made stale state type-legal — a `policy` left over from a previous pass after the
 * reset short-circuit — and left "one sync per instance" enforced by discipline alone. With
 * a context, reuse is structurally safe: a second `sync()` builds a second context, and no
 * helper can see state that belongs to another pass. `policy` is always named by the epoch
 * that decided the pass; the reset path simply never reads it.
 */
interface PassContext {
  policy: SyncPolicy;
  tree: Map<string, ServerNode>;
  byNodeId: Map<string, ServerNode>;
  meta: Map<string, LocalMeta>;
  dedup: Map<string, string>;
  vanished: Map<string, Vanished[]>;
  handled: Set<string>;
  queue: VaultFile[];
  rootNodeId: string;
  /** The vault's own key scope — the root default every node inherits until a share overrides it. */
  vaultScopeId: string;
  /**
   * Share id → the scope its interior is named under.
   *
   * Needed because a share root's OWN label is under `KV` (SH-01), so the scope its children
   * belong to cannot be read off it. The server reports the pairing when the vault is
   * opened, which is the only place it exists as one fact.
   */
  shareScopes: Map<string, string>;
  state: VaultState;
  report: SyncReport;
}

export class SyncEngine {
  constructor(
    private readonly client: VaultWire,
    private readonly vaultId: string,
    /**
     * The vault as it stood when this operation began, and the keys that read it (docs/06).
     *
     * Handed in rather than fetched, and that is the point: `sync` needed it and `readTree`
     * needed it, so a pass asked twice and a single share operation asked five times — every
     * answer describing the same instant. A value the caller opens once is also what lets
     * this class stop knowing how a vault is opened at all.
     *
     * It carries `KV` and the share keys too, because they describe that same instant. They
     * were three constructor arguments assembled by every caller, which is one instant
     * described three times and three chances for the descriptions to disagree.
     */
    private readonly scopes: VaultScopes,
    private readonly vault: VaultAdapter,
    private readonly store: StateStore,
    /** Named in a conflict file's filename (docs/04): `Note (conflict 2026-08-01 laptop).md`. */
    private readonly deviceLabel = 'device',
    /** Synchronise `.obsidian/` configuration — off by default (D-7, docs/01). */
    private readonly syncObsidian = false,
    /**
     * Where the last walked tree is kept, when the caller has somewhere for it to live (issue #252).
     *
     * Optional because the lifetime is the point: it holds decrypted paths, so it belongs to something
     * that ends when the session locks. A caller with nowhere safe to put it passes nothing and walks
     * every time, which is what every pass did before.
     */
    private readonly cache?: TreeCache,
  ) {}

  /** The scope filter, applied to every direction: scan, pull, and the delete bookkeeping. */
  private readonly scope = (path: string): boolean => isSyncable(path, this.syncObsidian);

  /**
   * The key for a key scope, resolved by the scope's `key_id`.
   *
   * The strict form, deliberately: every caller of this is about to write something — a name,
   * an hmac, a wrapped content key — and a wrong key there is a wrong value written, not a
   * failure. The one caller that must survive a missing key is the tree read, and it asks
   * `keyIfOpenable` instead.
   */
  private scopeKeyFor(nameKeyId: string | null | undefined): Uint8Array {
    return this.scopes.keyFor(nameKeyId);
  }

  /** The scope a node at `path` must be named under — the rule itself is `scopes.ts`. */
  /** `content.ts`, with this engine's key for the scope and its client's upload. */
  private content(plain: Uint8Array, scopeId: string, ctx: PassContext) {
    return resolveContent(plain, { id: scopeId, key: this.scopeKeyFor(scopeId) }, ctx.dedup, (sealed) =>
      this.client.putBlob(sealed),
    );
  }

  private contentScopeId(ctx: PassContext, path: string): string {
    const parent = parentOf(path);
    return contentScopeFor(parent ? ctx.tree.get(parent) : undefined, ctx.shareScopes, ctx.vaultScopeId);
  }

  async sync(opts: PassOptions = {}): Promise<SyncReport> {
    const report: SyncReport = {
      scanned: 0, pushed: [], pulled: [], matched: [], conflicts: [], renamed: [],
      deleted: [], removed: [], quarantined: [], vanished: [], unreadable: [], errors: [], events: [],
    };
    const state = await this.store.load();

    const vaultScopeId = this.scopes.vaultScopeId;
    const rootNodeId = this.scopes.opened.root_node_id;
    const shareScopes = this.scopes.shareScopes();

    // Provenance before a byte moves: present the stored cursor, and let its answer decide
    // what a missing node means (D-70). The pages themselves are re-read through the walk —
    // the probe is the check, not the data.
    const probe = state.cursor
      ? await this.probeEpoch(state.cursor)
      : { epoch: 'continuous' as const, events: [], quiet: false };
    const epoch: RemoteEpoch = probe.epoch;
    report.events = probe.events;

    /**
     * The tree, walked or remembered (issue #252).
     *
     * Reused only when the server has said, in the probe already made, that **nothing has happened**
     * since the cursor this tree was walked at. Anything else — a change, another page, an epoch that
     * moved — walks again. The cache holds plaintext paths and belongs to the unlocked session, so a
     * pass with no cache (a test, a share operation) simply walks, which is what every pass did before.
     */
    const remembered = probe.quiet && state.cursor ? this.cache?.get(state.cursor) : undefined;
    const walked = remembered ?? (await this.readServerTree(rootNodeId));
    if (!remembered) this.cache?.put(walked);
    const { tree, cursor, unreadable } = walked;
    const byNodeId = new Map<string, ServerNode>();
    for (const n of tree.values()) byNodeId.set(n.nodeId, n);

    /**
     * In scope for this pass: syncable, and not inside a shared folder we cannot read.
     *
     * The second half is not a preference. A folder whose interior was skipped is absent from
     * the tree, and absent from the tree means "the server has never heard of this" — which
     * the walk answers by uploading. Under `KV`, into the vault's own scope. That is a share's
     * contents silently converted into ordinary notes, so the exclusion is the same rule as
     * `.obsidian/`: out of scope, in both directions, for as long as it stays unreadable.
     */
    const inScope = (path: string): boolean =>
      this.scope(path) && !unreadable.some((u) => path === u.path || path.startsWith(`${u.path}/`));

    report.unreadable = unreadable;

    const local = (await this.vault.list()).filter((f) => inScope(f.path));
    report.scanned = local.length;

    // Read once, hash, tag — and let the bytes go. Holding every file in memory at once is
    // the thing docs/02 rules out; re-reading a handful of them a second time, just before
    // an actual upload, costs I/O this trades for that.
    //
    // **The skip hint** — docs/04 "What the client reads before it decides anything" states the rule and
    // why a timestamp is only ever a hint (issue #237). What is here is the one thing the rule does not
    // say: the epochs it is turned off for are read out of `POLICY` rather than listed again, so "is
    // the server's word trustworthy here" has one answer in this file instead of two that can drift.
    const trustHints = !opts.rescan && !POLICY[epoch].preferLocal;
    const meta = new Map<string, LocalMeta>();
    for (const f of local) {
      const known = state.nodes[f.path];
      if (trustHints && known?.mtime === f.mtime && known?.size === f.size) {
        meta.set(f.path, {
          plainHash: known.plainHash,
          tag: dedupTagFromHash(this.scopes.vaultKey, known.plainHash),
          mtime: f.mtime,
          size: f.size,
        });
        continue;
      }
      const bytes = await this.vault.read(f.path);
      meta.set(f.path, {
        plainHash: toHex(sha256(bytes)),
        tag: dedupTag(this.scopes.vaultKey, bytes),
        mtime: f.mtime,
        size: bytes.length,
      });
    }
    /**
     * **Only for the files whose reconciliation could consult it** (issue #250).
     *
     * The map is read in exactly three places, and two of them cannot be reached by a file that is
     * unchanged on both sides:
     *
     * - `reconcileLocal`'s adoption branch, which needs `!known || known.nodeId !== onServer.nodeId` —
     *   a node this device has not synced, or one deleted and recreated under a new id;
     * - `resolveContent`, on the way to an upload, which a file with nothing to push never reaches;
     * - `resyncAfterReset`, under an epoch where hints are not trusted anyway, so every file was read
     *   and every tag computed.
     *
     * So a path whose stored entry names **the same node and the same address** as the walked tree goes
     * down the known-node branch, finds nothing changed on either side and returns — without ever
     * asking the map. Its tag is a question with a predetermined answer, and on a vault nobody has
     * touched that is every file: the ask disappears entirely rather than shrinking, which is what
     * #237 wanted and #250 could not safely do until the lookups were measured.
     *
     * The tag is still **computed** for everything — it costs an HMAC over a hash already in hand, and
     * `meta` is what the rest of the pass reads. What changes is what travels.
     */
    const mightNeedATag = (path: string, m: LocalMeta): boolean => {
      const known = state.nodes[path];
      const onServer = tree.get(path);
      return !(known && onServer && known.nodeId === onServer.nodeId && known.address === onServer.address
        && known.plainHash === m.plainHash);
    };
    const asking = [...new Set([...meta].filter(([p, m]) => mightNeedATag(p, m)).map(([, m]) => m.tag))];
    const dedup = await this.client.dedupLookup(this.vaultId, asking);

    const here = new Set(local.map((f) => f.path));

    const ctx: PassContext = {
      policy: POLICY[epoch],
      tree, byNodeId, meta, dedup,
      state, report, rootNodeId, vaultScopeId,
      shareScopes,
      vanished: new Map(), handled: new Set(), queue: [],
    };

    if (epoch === 'reset') {
      await this.resyncAfterReset(local, ctx);
      ctx.state.cursor = cursor;
      await this.store.save(ctx.state);
      return ctx.report;
    }

    // Paths this device had synced and can no longer find. A rename shows up as exactly this
    // plus a new path holding the same bytes, and the pairing has to be decided BEFORE the
    // walk creates a second node for the new one.
    for (const [path, known] of Object.entries(ctx.state.nodes)) {
      // Out of scope paths are frozen, not vanished: turning the `.obsidian/` switch off
      // must not read "still on the server, not on disk" as a deletion to push. They stay
      // in state so flipping the switch back on resumes them as ordinary files. An
      // unreadable share is frozen for exactly the same reason and by the same rule — when
      // its key arrives, the files resume as themselves rather than as a pile of deletes.
      if (!inScope(path)) continue;
      if (here.has(path)) continue;
      const list = ctx.vanished.get(known.plainHash) ?? [];
      list.push({ path, nodeId: known.nodeId, rev: known.rev, address: known.address });
      ctx.vanished.set(known.plainHash, list);
    }

    // Shallowest first, so a folder exists before the file that lives in it. A FIFO queue
    // rather than one static pass: a conflict file created mid-walk is pushed onto the end
    // and uploaded in this same pass, not left for the next click. Its folder is always
    // already there — it lands beside the file it came from, which this loop has by then
    // already ensured a parent for.
    ctx.queue = [...local].sort((a, b) => depth(a.path) - depth(b.path));

    // A folder renamed is ONE move of the folder node, not a move per child. Detect the
    // whole-folder case before the per-file walk, so the children are not moved individually
    // and the empty source folder does not linger on the server.
    await this.moveRenamedFolders(local, here, ctx);

    while (ctx.queue.length) {
      const file = ctx.queue.shift()!;
      ctx.handled.add(file.path);
      try {
        await this.reconcileLocal(file, ctx);
      } catch (e) {
        ctx.report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // Whatever the walk did not claim as a rename source is a file this device deleted.
    // Pushing the delete is safe: the row soft-deletes into the trash and the content
    // survives (docs/03). The only thing that stops us is an epoch that makes the absence
    // unreadable — under a restore we cannot tell "deleted" from "never arrived".
    for (const list of ctx.vanished.values()) {
      for (const v of list) {
        ctx.handled.add(v.path);
        if (!ctx.policy.pushDeletes) {
          delete ctx.state.nodes[v.path];
          continue;
        }
        await this.pushDelete(v, ctx);
      }
    }

    // What is left: server files no local copy ever stood in for. Ordinary pull.
    const serverOnly = [...ctx.tree.values()].filter((n) => n.isFile && n.address && this.scope(n.path) && !ctx.handled.has(n.path));
    await this.pull(serverOnly, ctx);

    ctx.state.cursor = cursor;
    await this.store.save(ctx.state);
    return ctx.report;
  }

  /**
   * The one question the delta endpoint is asked: can this cursor still be answered, and if
   * not, why. `limit: 1` because we are after the verdict, not the page.
   *
   * A cursor this server cannot verify is one of the three answers `delta` declares, not an
   * exception to be caught by status (D-100). For the client that `400` is a refusal; for the
   * engine it is a policy — resync from an empty cursor, deleting nothing — and a policy
   * belongs on the type, where the next consumer of `VaultWire` can see it.
   */
  private async probeEpoch(cursor: string): Promise<{ epoch: RemoteEpoch; events: DeltaEvent[]; quiet: boolean }> {
    const res = await this.client.delta(this.vaultId, cursor, 1);
    if ('rejected' in res) return { epoch: res.reason, events: [], quiet: false };
    if ('unverifiable' in res) return { epoch: 'unverifiable', events: [], quiet: false };
    // The probe asks for one page and reads none of it — except these two. The account states
    // ride on every delta answer by design, so the call that is already being made is where
    // they are collected; asking again would be a second request for a field this one had.
    //
    // `quiet` is the other thing the answer already contains: an empty page with nothing after it
    // means no node has been written, moved or removed since this cursor — so the tree cannot have
    // changed either, which is what lets the last walk be reused (issue #252, `tree-cache.ts`).
    return { epoch: 'continuous', events: res.events, quiet: res.changes.length === 0 && !res.has_more };
  }

  /**
   * The server's tree as paths, for a caller that is not a sync.
   *
   * Sharing a folder needs exactly this and nothing else about the engine: a share is
   * rooted at a node id, and node ids are what this class spends its pass resolving paths
   * to. Exposed rather than copied — a second implementation of "decrypt every name and
   * rebuild the paths" would be a second thing to get wrong about scopes.
   */
  async readTree(): Promise<Map<string, ServerNode>> {
    const { tree } = await this.readServerTree(this.scopes.opened.root_node_id);
    return tree;
  }

  /**
   * Every node the server holds, as paths — skipping any subtree this device cannot read.
   *
   * The server holds `parent_id` and an encrypted name and nothing else — it has no paths at
   * all (docs/03) — so a path exists only once a client has decrypted every name on the way
   * down. `list` returns nodes shallowest-first, which is what makes one pass enough.
   *
   * **The one read that must survive a missing key.** Every other use of a scope key is about
   * to write something, so a missing key there is a defect worth refusing. This one is a
   * listing, and refusing it stopped the entire pass — before a report existed, from the only
   * one of nine such call sites with no `try` around it. A share whose key has not reached
   * this device is a state, not a fault: the client drops such scopes deliberately, and this
   * is where that decision is either kept or quietly broken.
   *
   * **The skip is transitive, and it has to be.** A path is built from its parent's path, so
   * a skipped folder whose children were kept would put those children at the vault root.
   * The listing arrives parents-first, so remembering which ids were skipped is enough.
   *
   * `unreadable` travels back with the tree because the local side needs it: a subtree that
   * is simply absent from the tree reads as "files the server has never heard of", which the
   * walk would upload — the contents of an unreadable share, re-uploaded as ordinary notes
   * under `KV`. The prefix is the skipped node's PARENT, which is the share's root: a root's
   * own label is under `KV` (SH-01), so its path is readable even when its interior is not,
   * and one key covers a whole share, so every child of that root is unreadable together.
   */
  private async readServerTree(
    rootNodeId: string,
  ): Promise<{ tree: Map<string, ServerNode>; cursor: string; unreadable: UnreadableFolder[] }> {
    const res = await this.client.listNodes(this.vaultId);
    return { ...treeFrom(res.nodes, rootNodeId, this.scopes), cursor: res.snapshot };
  }

  // ---- one local file -----------------------------------------------------------

  /**
   * Everything that can happen to ONE local file, in the shape of the table at the top of
   * this file. The queue is the same FIFO `sync()` is draining — a conflict resolution
   * pushes the local original onto it as a brand new file to upload.
   */
  private async reconcileLocal(file: VaultFile, ctx: PassContext): Promise<void> {
    // A conflict file born during this same pass has no pre-pass entry; compute it now.
    const m = ctx.meta.get(file.path) ?? (await this.hashAndTag(file));

    const known = ctx.state.nodes[file.path];
    const onServer = ctx.tree.get(file.path);

    // The node we know is still at this path on the server.
    if (onServer && known && known.nodeId === onServer.nodeId) {
      // Ordinary edit: this device has synced this exact node before. Local and remote
      // movement are separate facts; treating any difference as a local edit would let an
      // unchanged stale local file overwrite a newer server version.
      const localChanged = known.plainHash !== m.plainHash;
      const remoteChanged = known.address !== onServer.address;

      if (!localChanged && !remoteChanged) {
        // Content identical but mtime moved — refresh the hint so the next pass can skip.
        if (known.mtime !== m.mtime || known.size !== m.size) {
          ctx.state.nodes[file.path] = { ...known, ...SyncEngine.hintFrom(m) };
        }
        return;
      }

      // Under a restore the server's "change" is the backup going backwards, and our copy is
      // the newer one — so the usual remote-wins pull is inverted into a push.
      if (!localChanged && remoteChanged && !ctx.policy.preferLocal) {
        await this.pull([onServer], ctx);
        return;
      }

      // Local moved — alone, or with the server. Both go through the same PUT: the
      // precondition is what decides which it was, and the server is a better arbiter of
      // that than a client comparing two hashes it fetched a moment ago. If they diverged,
      // the 409 comes back and `pushEdit` writes the conflict file (docs/04).
      await this.pushEdit(file, m, known, onServer, ctx);
      return;
    }

    // A node at this path, but not the one we know — deleted and recreated, or a fresh
    // adoption. Content, not history, decides what happens next (docs/07).
    if (onServer && (!known || known.nodeId !== onServer.nodeId)) {
      const matched = ctx.dedup.get(m.tag);
      if (matched === onServer.address) {
        // Same plaintext, already at this exact address: record and move on.
        ctx.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: onServer.rev, plainHash: m.plainHash, address: onServer.address!, ...SyncEngine.hintFrom(m) };
        ctx.report.matched.push({ path: file.path });
        return;
      }
      await this.resolveConflict(file, onServer, ctx);
      return;
    }

    // Nothing at this path on the server. If we know the file, its node either moved or is
    // gone — and which of those it is decides whether this is a rename, a delete, or a
    // rescue. If we never knew it, it is a rename source or genuinely new.
    if (known) {
      const movedTo = ctx.byNodeId.get(known.nodeId);
      if (movedTo) {
        await this.applyRemoteRename(file, m, known, movedTo, ctx);
        return;
      }

      // Gone entirely. Deleted on the server — or lost to a restore. The policy knows which.
      const localChanged = known.plainHash !== m.plainHash;
      if (ctx.policy.applyRemoteDeletes && !localChanged) {
        await this.vault.delete(file.path);
        delete ctx.state.nodes[file.path];
        ctx.report.removed.push({ path: file.path });
        return;
      }
      // A restore (absence proves nothing) or local edits worth keeping: upload as new.
      await this.pushNew(file, m, ctx);
      return;
    }

    // Never known here, not on the server: a rename source, or genuinely new.
    const source = this.renameSourceFor(m, ctx);
    if (source) {
      await this.pushMove(file, m, source, ctx);
      return;
    }
    await this.pushNew(file, m, ctx);
  }

  /**
   * The decision is `rename.ts`'s; consuming the candidate is this pass's.
   *
   * Kept apart on purpose: a module that quietly mutated its own input could not be asked
   * the same question twice, which is exactly what a fixture test does.
   */
  private renameSourceFor(m: LocalMeta, ctx: PassContext): Vanished | undefined {
    const source = renameSourceFor(m, ctx.vanished, ctx.tree);
    if (!source) return undefined;

    // Consumed: a second file with these bytes must not claim the same source.
    ctx.vanished.delete(m.plainHash);
    return source;
  }

  /**
   * The skip hint for a file the pre-pass measured — `list()` gave the timestamp, the read gave the size.
   *
   * Written as a call at each of the five sites that record a node, rather than two more fields spelled
   * into five object literals, because the **source** of a hint is the thing this has twice got wrong:
   * once by inventing it, once by copying it from the wrong path. Two sources, two names — this one and
   * `hintFor` below — so a reader sees which is which without checking where `m` came from.
   */
  private static hintFrom(m: LocalMeta): { mtime: number; size: number } {
    return { mtime: m.mtime, size: m.size };
  }

  /**
   * The skip hint for a file **this device just wrote**, taken from the vault rather than guessed.
   *
   * The engine does not choose a written file's timestamp — the editor stamps it — so the only honest
   * hint is the one the vault reports afterwards (issue #237, `VaultAdapter.stat`). A missing answer is
   * not an error: the entry simply carries no hint and the next pass reads the file once, which is what
   * every entry written before hints existed does.
   */
  private async hintFor(path: string): Promise<{ mtime?: number; size?: number }> {
    return (await this.vault.stat(path)) ?? {};
  }

  /**
   * Read one file and describe it, for a path the pre-pass did not cover.
   *
   * **Takes the `VaultFile`, not the path**, because the `mtime` it records has to be the vault's own —
   * the number `list()` will report on the next pass — and not `Date.now()`, which nothing will ever
   * report again (#237). A hint that cannot match is worse than no hint: it says a file was checked.
   */
  private async hashAndTag(file: VaultFile): Promise<LocalMeta> {
    const bytes = await this.vault.read(file.path);
    return {
      plainHash: toHex(sha256(bytes)),
      tag: dedupTag(this.scopes.vaultKey, bytes),
      mtime: file.mtime,
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
  private async moveRenamedFolders(local: VaultFile[], here: Set<string>, ctx: PassContext): Promise<void> {
    // Every condition that decides whether this IS a folder move lives in `rename.ts`.
    // What is left here is what only this class can do: name the folder under the right
    // scope, call the server, and repair the walk's own view of the tree afterwards.
    for (const move of folderMoves(ctx.vanished, ctx.tree, ctx.meta, here)) {
      const name = basename(move.to);
      const destParent = move.to ? parentOf(move.to) : '';
      const destParentId = destParent ? ctx.tree.get(destParent)!.nodeId : ctx.rootNodeId;
      try {
        // The moved folder's new name is named under the destination parent's scope.
        const nameScopeId = this.contentScopeId(ctx, move.to);
        const out = await this.client.moveNode(this.vaultId, move.nodeId, move.rev, {
          parent_id: destParentId,
          name_enc: encryptName(this.scopeKeyFor(nameScopeId), name),
          name_hmac: nameHmac(this.scopeKeyFor(nameScopeId), name),
          name_key_id: nameScopeId,
        });
        ctx.tree = remapTree(ctx.tree, move.from, move.to, out.rev);
        ctx.state.nodes = remapState(ctx.state.nodes, move.from, move.to);
        for (const child of move.children) {
          ctx.vanished.delete(child.hash);
          ctx.handled.add(child.to);
        }
        ctx.handled.add(move.to);
        // The moved files' local copies were handled in this pass — do not upload them.
        for (const f of local) {
          if (f.path.startsWith(`${move.to}/`)) ctx.handled.add(f.path);
        }
        ctx.report.renamed.push({ from: move.from, to: move.to });
      } catch (e) {
        // A refused move is not a failure we can resolve here — the per-file fallback ran
        // nothing for these, so report and let the next pass retry.
        ctx.report.errors.push({ path: move.from, message: message(e) });
      }
    }
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
  private async pushMove(file: VaultFile, m: LocalMeta, source: Vanished, ctx: PassContext): Promise<void> {
    const parentId = await this.ensureFolders(file.path, ctx);
    const name = basename(file.path);
    // The moved node's new name is named under the scope of its destination folder.
    const nameScopeId = this.contentScopeId(ctx, file.path);
    const nameKey = this.scopeKeyFor(nameScopeId);

    const out = await this.client.moveNode(this.vaultId, source.nodeId, source.rev, {
      parent_id: parentId,
      name_enc: encryptName(nameKey, name),
      name_hmac: nameHmac(nameKey, name),
      name_key_id: nameScopeId,
    });

    delete ctx.state.nodes[source.path];
    ctx.state.nodes[file.path] = { nodeId: source.nodeId, rev: out.rev, plainHash: m.plainHash, address: source.address, ...SyncEngine.hintFrom(m) };

    // The tree follows, so the pull at the end of the pass does not see the old path as a
    // server-only node and fetch a file that has just moved.
    ctx.tree.delete(source.path);
    ctx.byNodeId.set(source.nodeId, { ...ctx.byNodeId.get(source.nodeId)!, path: file.path, parentId });
    ctx.tree.set(file.path, {
      nodeId: source.nodeId,
      parentId,
      path: file.path,
      rev: out.rev,
      address: source.address,
      isFile: true,
      nameKeyId: nameScopeId,
    });

    ctx.report.renamed.push({ from: source.path, to: file.path });
  }

  /**
   * Seal-or-bind, then PUT with the content precondition (D-52).
   *
   * The base is **the version this device last synchronised** — `known.address` — and not
   * whatever the server holds at this instant. Sending the server its own current address
   * would make the precondition a tautology: it could never fail, and D-52's entire job is to
   * fail when somebody else has written in the meantime.
   *
   * So a `409 base_mismatch` here is not an error to report; it is the answer arriving.
   * docs/04 gives the two branches, and the first one matters more than it looks: if the
   * server's content is what this device was about to write, two devices simply reached the
   * same text independently — very common, editing frontmatter back and forth — and calling
   * that a conflict would bury the user in files for nothing.
   */
  private async pushEdit(file: VaultFile, m: LocalMeta, known: { address: string } | undefined, onServer: ServerNode, ctx: PassContext): Promise<void> {
    const plain = await this.vault.read(file.path);
    // The edited content lives under the node's scope — the vault's, or a share's for a
    // node inside a shared folder — so its envelope and tag go to that scope, not a fixed one.
    const scopeId = this.contentScopeId(ctx, file.path);
    const { sha256: address, material } = await this.content(plain, scopeId, ctx);

    const out = await this.client.putContent(this.vaultId, onServer.nodeId, {
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      // Under a restore we pin the base to what the (rolled-back) server holds, so our newer
      // copy lands on top of it instead of bouncing off a base it never had.
      base_sha256: ctx.policy.preferLocal ? onServer.address : (known?.address ?? onServer.address),
      ...material,
    });

    if ('conflict' in out) {
      if (out.conflict !== 'base_mismatch') {
        // rev_mismatch or share_boundary: not about content, and not something a conflict
        // file would resolve.
        ctx.report.errors.push({ path: file.path, message: `refused: ${out.conflict}` });
        return;
      }

      const current: ServerNode = { ...onServer, address: out.sha256 ?? onServer.address, rev: out.rev ?? onServer.rev };
      const serverPlain = await this.fetchPlain(current, ctx);

      // Compared as PLAINTEXT, and it cannot be done any other way. `KC` is random, so the
      // same text sealed twice lands at two different addresses (docs/06) — comparing the
      // server's address against the one just uploaded would call every such case a
      // conflict, which is precisely the case docs/04 says must not become one. Two devices
      // reach identical content constantly, editing frontmatter back and forth.
      if (toHex(sha256(serverPlain)) === m.plainHash) {
        ctx.state.nodes[file.path] = {
          nodeId: onServer.nodeId,
          rev: current.rev,
          plainHash: m.plainHash,
          address: current.address!,
          mtime: m.mtime,
          size: m.size,
        };
        ctx.report.matched.push({ path: file.path });
        return;
      }

      // A real conflict: both sides moved from a common base. Same resolution as adoption's
      // no-common-ancestor case, because the outcome the user needs is identical — the
      // server version takes the path, this device's work survives beside it.
      await this.resolveConflict(file, current, ctx, serverPlain);
      return;
    }

    ctx.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: out.rev, plainHash: m.plainHash, address, ...SyncEngine.hintFrom(m) };
    ctx.report.pushed.push({ path: file.path });
  }

  /** A path with no node on the server at all: create one, folders and all. */
  private async pushNew(file: VaultFile, m: LocalMeta, ctx: PassContext): Promise<void> {
    const plain = await this.vault.read(file.path);
    const scopeId = this.contentScopeId(ctx, file.path);
    const { sha256: address, material } = await this.content(plain, scopeId, ctx);
    const parentId = await this.ensureFolders(file.path, ctx);
    const name = basename(file.path);
    const nameKey = this.scopeKeyFor(scopeId);

    const created = await this.client.createNode(this.vaultId, {
      parent_id: parentId,
      type: 'file',
      sha256: address,
      size: plain.length,
      mtime: new Date(file.mtime).toISOString(),
      name_enc: encryptName(nameKey, name),
      name_hmac: nameHmac(nameKey, name),
      name_key_id: scopeId,
      ...material,
    });
    ctx.state.nodes[file.path] = { nodeId: created.node_id, rev: created.rev, plainHash: m.plainHash, address, ...SyncEngine.hintFrom(m) };
    ctx.tree.set(file.path, { nodeId: created.node_id, parentId, path: file.path, rev: created.rev, address, isFile: true, nameKeyId: scopeId });
    ctx.byNodeId.set(created.node_id, ctx.tree.get(file.path)!);
    ctx.report.pushed.push({ path: file.path });
  }

  /**
   * Content already known to this scope needs no envelope, no tag and no upload —
   * `nodes_check_private_material` only checks that the rows EXIST (docs/04). Content that
   * is not sealed, uploaded and tagged fresh, same as before this slice.
   *
   * Both the envelope and the dedup tag are scoped to `scopeId` — the vault's own scope or a
   * share's — because the trigger checks them together under the node's scope.
   */

  /**
   * No common ancestor (docs/07): the server version becomes the file at this path, and the
   * local original is kept, never silently discarded. The conflict file is queued so it
   * uploads in the same pass — it is an ordinary new file the moment it exists.
   */
  private async resolveConflict(
    file: VaultFile,
    onServer: ServerNode,
    ctx: PassContext,
    /** Already fetched by the caller that had to read it to decide this was a conflict at all. */
    fetched?: Uint8Array,
  ): Promise<void> {
    const serverPlain = fetched ?? (await this.fetchPlain(onServer, ctx));
    const localPlain = await this.vault.read(file.path);
    const conflictPath = withConflictSuffix(file.path, this.deviceLabel);

    // The same ordering rule (#242), and it reads inverted here because the *destination* is the
    // conflict copy: `localPlain` exists nowhere but memory, so overwriting the path first and failing
    // second would lose this device's edits while the report below still claimed a copy had been made.
    await this.vault.write(conflictPath, localPlain);
    await this.vault.write(file.path, serverPlain);

    ctx.state.nodes[file.path] = {
      nodeId: onServer.nodeId,
      rev: onServer.rev,
      plainHash: toHex(sha256(serverPlain)),
      address: onServer.address!,
      ...(await this.hintFor(file.path)),
    };
    ctx.report.conflicts.push({ path: file.path, conflictPath });
    // The conflict copy is uploaded later in this same pass, and it is a file the vault now holds — so
    // it joins the queue described the way `list()` would have described it, not the way this device
    // imagined it.
    const copy = await this.vault.stat(conflictPath);
    ctx.queue.push({ path: conflictPath, mtime: copy?.mtime ?? Date.now(), size: copy?.size ?? localPlain.length });
  }

  /** The server's own bytes for a node, opened with the content key its envelope carries. */
  private async fetchPlain(node: ServerNode, ctx: PassContext): Promise<Uint8Array> {
    if (!node.address) throw new Error('a folder has no content — this is a bug if it happens');

    // The node's content is sealed under the scope it is named in; its envelope carries the
    // content key wrapped to that scope.
    const scopeId = node.nameKeyId ?? ctx.vaultScopeId;
    const envelope = (await this.client.blobKeys(this.vaultId, [node.address]))
      .get(node.address)
      ?.find((e) => e.scopeId === scopeId);
    if (!envelope) throw new Error(`no content-key envelope under the node's scope (${scopeId})`);

    const ciphertext = await this.client.getBlob(node.address);
    if (!ciphertext) throw new Error('the server holds no bytes at that address');
    return openBlob(unwrapContentKey(this.scopeKeyFor(scopeId), envelope.wrappedKey), ciphertext);
  }

  // ---- delete ---------------------------------------------------------------------

  /**
   * A synced file gone from disk is pushed as a delete — by node id, and with the revision
   * the walk just saw. The row soft-deletes into the trash, so a wrong call is recoverable;
   * the precondition is what stops a delete racing a write from winning.
   */
  private async pushDelete(v: Vanished, ctx: PassContext): Promise<void> {
    const onServer = ctx.byNodeId.get(v.nodeId);
    // Gone from the server too — another device deleted it first. Nothing to push.
    if (!onServer) {
      delete ctx.state.nodes[v.path];
      return;
    }
    try {
      await this.client.deleteNode(this.vaultId, v.nodeId, onServer.rev);
      ctx.tree.delete(onServer.path);
      ctx.byNodeId.delete(v.nodeId);
      delete ctx.state.nodes[v.path];
      ctx.report.deleted.push({ path: v.path });
    } catch (e) {
      ctx.report.errors.push({ path: v.path, message: message(e) });
    }
  }

  // ---- remote rename (the node's id moved; only its path changed) ------------------

  /**
   * The server renamed a node we know: the id we track now lives at a different path. The
   * local file follows it, and if we had edits in hand they go up against the moved node —
   * by node id, not by path, so a rename and an edit never collide into a conflict (D-52).
   */
  private async applyRemoteRename(file: VaultFile, m: LocalMeta, known: { nodeId: string; plainHash: string; address: string }, movedTo: ServerNode, ctx: PassContext): Promise<void> {
    const localChanged = known.plainHash !== m.plainHash;

    // Destination first, source after — the ordering rule at the top of this file (#239).
    const plain = await this.vault.read(file.path);
    await this.vault.write(movedTo.path, plain, file.mtime);
    await this.vault.delete(file.path);

    delete ctx.state.nodes[file.path];
    // `m` describes the file at its OLD path. The new one is a file this device wrote a moment ago, so
    // its hint is whatever the vault now says about it — not the timestamp the source happened to have.
    ctx.state.nodes[movedTo.path] = {
      nodeId: known.nodeId, rev: movedTo.rev, plainHash: m.plainHash, address: movedTo.address!,
      ...(await this.hintFor(movedTo.path)),
    };
    ctx.handled.add(movedTo.path);
    ctx.report.renamed.push({ from: file.path, to: movedTo.path });

    // Our edits, if any, still go up — against the node at its new path.
    if (localChanged) {
      await this.pushEdit({ path: movedTo.path, mtime: file.mtime, size: m.size }, m, known, movedTo, ctx);
    }
  }

  // ---- resync after a reset ---------------------------------------------------------

  /**
   * A `410 reset` means another device declared itself the source of truth and re-uploaded
   * the vault with new node ids. Its tree is the truth now. Local content the new tree holds
   * rebinds nearly free (the blobs are already on the server), and everything it does NOT
   * hold is moved to `_Reset <date>/` — quarantined, never erased (D-80, docs/07).
   */
  private async resyncAfterReset(local: VaultFile[], ctx: PassContext): Promise<void> {
    const quarantineRoot = `_Reset ${new Date().toISOString().slice(0, 10)}`;
    ctx.state.nodes = {};
    ctx.handled = new Set();

    for (const file of local) {
      ctx.handled.add(file.path);
      const m = ctx.meta.get(file.path)!;
      const onServer = ctx.tree.get(file.path);
      try {
        if (onServer && ctx.dedup.get(m.tag) === onServer.address) {
          // Same plaintext at the same path in the winning tree: rebind, nothing moves.
          ctx.state.nodes[file.path] = { nodeId: onServer.nodeId, rev: onServer.rev, plainHash: m.plainHash, address: onServer.address!, ...SyncEngine.hintFrom(m) };
          ctx.report.matched.push({ path: file.path });
          continue;
        }
        // Displaced. The local copy is kept, out of sync's reach.
        const dest = `${quarantineRoot}/${file.path}`;
        const bytes = await this.vault.read(file.path);
        await this.vault.write(dest, bytes, file.mtime);
        await this.vault.delete(file.path);
        ctx.report.quarantined.push({ from: file.path, to: dest });
        // If the winning tree has its own file at this path, it now comes down.
        if (onServer && onServer.isFile) await this.pull([onServer], ctx);
      } catch (e) {
        ctx.report.errors.push({ path: file.path, message: message(e) });
      }
    }

    // What the winning tree holds that we never had.
    const serverOnly = [...ctx.tree.values()].filter((n) => n.isFile && n.address && this.scope(n.path) && !ctx.handled.has(n.path));
    await this.pull(serverOnly, ctx);
  }

  // ---- pull -------------------------------------------------------------------------

  private async pull(nodes: ServerNode[], ctx: PassContext): Promise<void> {
    // One request for every envelope, not one per file: applying a delta means opening
    // everything that changed, and a round trip per note is what makes a first sync feel
    // broken on a home connection.
    const envelopes = await this.client.blobKeys(this.vaultId, nodes.map((n) => n.address!));

    for (const node of nodes) {
      try {
        const scopeId = node.nameKeyId ?? ctx.vaultScopeId;
        const envelope = envelopes.get(node.address!)?.find((e) => e.scopeId === scopeId);
        if (!envelope) throw new Error(`no content-key envelope under the node's scope (${scopeId})`);

        const ciphertext = await this.client.getBlob(node.address!);
        if (!ciphertext) throw new Error('the server holds no bytes at that address');

        const plain = openBlob(unwrapContentKey(this.scopeKeyFor(scopeId), envelope.wrappedKey), ciphertext);
        await this.vault.write(node.path, plain);

        ctx.state.nodes[node.path] = {
          nodeId: node.nodeId, rev: node.rev, plainHash: toHex(sha256(plain)), address: node.address!,
          ...(await this.hintFor(node.path)),
        };
        ctx.report.pulled.push({ path: node.path });
      } catch (e) {
        ctx.report.errors.push({ path: node.path, message: message(e) });
      }
    }
  }

  /** Every folder on the way to a file, created once and remembered in the tree we are holding. */
  private async ensureFolders(filePath: string, ctx: PassContext): Promise<string> {
    const parts = filePath.split('/').slice(0, -1);
    let parentId = ctx.rootNodeId;
    let sofar = '';

    for (const part of parts) {
      sofar = sofar ? `${sofar}/${part}` : part;
      const existing = ctx.tree.get(sofar);
      if (existing) {
        parentId = existing.nodeId;
        continue;
      }
      // A folder is named under its own parent's scope, so a folder inside a shared folder
      // is itself named under the share's `KS` (SH-28).
      const scopeId = this.contentScopeId(ctx, sofar);
      const scopeKey = this.scopeKeyFor(scopeId);
      const created = await this.client.createNode(this.vaultId, {
        parent_id: parentId,
        type: 'folder',
        mtime: new Date().toISOString(),
        name_enc: encryptName(scopeKey, part),
        name_hmac: nameHmac(scopeKey, part),
        name_key_id: scopeId,
      });
      ctx.tree.set(sofar, { nodeId: created.node_id, parentId, path: sofar, rev: created.rev, address: null, isFile: false, nameKeyId: scopeId });
      ctx.byNodeId.set(created.node_id, ctx.tree.get(sofar)!);
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

