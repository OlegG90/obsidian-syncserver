/**
 * Moving things across a share's edge, against a server that keeps state (#401, #402).
 *
 * The server refuses a `move` whose old and new parents are on different sides of a shared
 * folder — the two sides are different keys (docs/04). What the client does instead is the
 * protocol's other half: re-create the item under the destination's key and delete the source.
 * That half was never written, and the refusal it met instead turned a rename into two folders.
 *
 * **Why a fake with state, when the other engine tests answer from fixed lists.** Everything
 * asserted here is about what is LEFT — on the server and on disk — after a pass that moved,
 * created and deleted in some order. A fake that answers a fixed walk cannot say what is left;
 * this one holds the tree, applies each write, and refuses exactly what the server refuses.
 */
import assert from 'node:assert/strict';
import type { Change, Delta, OpenedVault } from '@syncserver/shared';
import { beforeEach, describe, it } from 'node:test';

import { ApiError, type CursorRejected, type CursorUnverifiable, type Envelope, type PutConflict } from '../src/api/client.js';
import { vaultKey } from '../src/crypto/account.js';
import { sealBlob } from '../src/crypto/blob.js';
import { randomBytes, utf8 } from '../src/crypto/bytes.js';
import { decryptName, encryptName, nameHmac, wrapContentKey } from '../src/crypto/scope.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { SyncEngine } from '../src/engine/engine.js';
import { MemoryStateStore } from '../src/engine/state.js';
import type { VaultWire } from '../src/engine/wire.js';
import { VaultScopes } from '../src/share-keys.js';
import { FakeVault } from './fake-vault.js';

const vaultId = '11111111-1111-4111-8111-111111111111';
const ROOT = 'root';
const KV_SCOPE = 'scope-vault';
const kv = vaultKey(randomBytes(32), vaultId);

/** Two shares, so a share root can be carried into the other one. */
const SHARES = {
  team: { id: '33333333-3333-4333-8333-333333333333', scope: 'scope-team', key: randomBytes(32) },
  other: { id: '44444444-4444-4444-8444-444444444444', scope: 'scope-other', key: randomBytes(32) },
};

const opened: OpenedVault = { root_node_id: ROOT, head_rev: 1, scopes: [{ scope: 'vault', key_id: KV_SCOPE }] };

const scopes = (): VaultScopes =>
  VaultScopes.open(
    {
      ...opened,
      scopes: [
        ...opened.scopes,
        ...Object.values(SHARES).map((s) => ({
          scope: 'share' as const, key_id: s.scope, share_id: s.id,
          wrapped_key: wrapShareKey(kv, s.key), wrapping: 'vault' as const,
        })),
      ],
    },
    { vaultKey: kv, openIdentity: () => randomBytes(32), userId: 'user' },
  );

const keyOf = (scopeId: string): Uint8Array =>
  scopeId === KV_SCOPE ? kv : Object.values(SHARES).find((s) => s.scope === scopeId)!.key;

/** Long enough to count as a rename candidate: below 512 bytes a hash match means nothing (docs/04). */
const body = (label: string): string => `${label}\n${'x'.repeat(600)}`;

interface ServerRow {
  id: string;
  parentId: string | null;
  nameEnc: string | null;
  nameHmac: string | null;
  nameKeyId: string | null;
  shareId: string | null;
  sha256: string | null;
  size: number | null;
  rev: number;
  deleted: boolean;
}

/** A vault as the server holds it: writes apply, and a move across a share's edge is refused. */
class Server implements VaultWire {
  readonly rows = new Map<string, ServerRow>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly envelopes = new Map<string, Envelope[]>();
  readonly tags = new Map<string, string>();
  /** Every refusal, by code — a pass that crosses correctly never meets one. */
  readonly refused: string[] = [];
  /** A server that says no to every move, for a reason that is not the boundary. */
  refuseMoves = false;
  private rev = 1;
  private ids = 0;

  constructor() {
    this.rows.set(ROOT, { id: ROOT, parentId: null, nameEnc: null, nameHmac: null, nameKeyId: null, shareId: null, sha256: null, size: null, rev: 1, deleted: false });
  }

  /** A node placed directly, as another device or an earlier session left it. */
  seed(parentId: string, name: string, opts: { scopeId: string; shareId?: string; text?: string }): string {
    const id = `n${++this.ids}`;
    let sha256: string | null = null;
    let size: number | null = null;
    if (opts.text !== undefined) {
      const sealed = sealBlob(utf8(opts.text));
      this.blobs.set(sealed.sha256, sealed.bytes);
      this.envelopes.set(sealed.sha256, [{ scopeId: opts.scopeId, wrappedKey: wrapContentKey(keyOf(opts.scopeId), sealed.contentKey) }]);
      sha256 = sealed.sha256;
      size = sealed.bytes.length;
    }
    const key = keyOf(opts.scopeId);
    this.rows.set(id, {
      id, parentId, nameEnc: encryptName(key, name), nameHmac: nameHmac(key, name), nameKeyId: opts.scopeId,
      shareId: opts.shareId ?? null, sha256, size, rev: ++this.rev, deleted: false,
    });
    return id;
  }

  /** The live nodes by path, with the facts a test asserts on. */
  tree(): Map<string, ServerRow> {
    const out = new Map<string, ServerRow>();
    const pathOf = (r: ServerRow): string => {
      if (r.parentId === null) return '';
      const parent = pathOf(this.rows.get(r.parentId)!);
      const name = decryptLabel(r);
      return parent ? `${parent}/${name}` : name;
    };
    for (const r of this.rows.values()) if (!r.deleted && r.parentId !== null) out.set(pathOf(r), r);
    return out;
  }

  async listNodes(): Promise<{ nodes: Change[]; snapshot: string }> {
    const nodes = [...this.rows.values()].filter((r) => !r.deleted).map((r): Change => ({
      node_id: r.id, parent_id: r.parentId, name_enc: r.nameEnc, name_hmac: r.nameHmac, name_key_id: r.nameKeyId,
      op: 'put', rev: r.rev, sha256: r.sha256, size: r.size, mtime: new Date(0).toISOString(), share_id: r.shareId, author_id: null,
    }));
    return { nodes, snapshot: `c${this.rev}` };
  }

  async delta(): Promise<Delta | CursorRejected | CursorUnverifiable> {
    return { changes: [], events: [], next_cursor: `c${this.rev}`, has_more: false };
  }

  async dedupLookup(_v: string, tags: string[]): Promise<Map<string, string>> {
    return new Map(tags.filter((t) => this.tags.has(t)).map((t) => [t, this.tags.get(t)!]));
  }

  async putBlob(sealed: { sha256: string; bytes: Uint8Array }): Promise<{ sha256: string; size: number }> {
    this.blobs.set(sealed.sha256, sealed.bytes);
    return { sha256: sealed.sha256, size: sealed.bytes.length };
  }

  async getBlob(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256);
  }

  async blobKeys(_v: string, addresses: string[]): Promise<Map<string, Envelope[]>> {
    return new Map(addresses.filter((a) => this.envelopes.has(a)).map((a) => [a, this.envelopes.get(a)!]));
  }

  /** The share a node's CHILDREN belong to: a root's own mark, or its parent's. */
  private shareInside(id: string): string | null {
    return this.rows.get(id)!.shareId;
  }

  private material(body: { blob_envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[]; dedup_tags?: { sha256: string; content_tag: string }[] }): void {
    for (const e of body.blob_envelopes ?? []) {
      this.envelopes.set(e.sha256, [...(this.envelopes.get(e.sha256) ?? []), { scopeId: e.scope_id, wrappedKey: e.wrapped_key }]);
    }
    for (const t of body.dedup_tags ?? []) this.tags.set(t.content_tag, t.sha256);
  }

  /** Something that lands on the server just before the next create — somebody else's, in a race. */
  beforeCreate: (() => void) | undefined;

  async createNode(_v: string, body: Parameters<VaultWire['createNode']>[1]): Promise<{ node_id: string; rev: number }> {
    const race = this.beforeCreate;
    this.beforeCreate = undefined;
    race?.();
    // The sibling-name index, as the schema has it: among live nodes of one parent (#420).
    if ([...this.rows.values()].some((r) => !r.deleted && r.parentId === body.parent_id && r.nameHmac === body.name_hmac)) {
      return this.refuse(409, 'name_taken');
    }
    const shareId = this.shareInside(body.parent_id);
    // What the schema insists on (SH-26, SH-28): inside a share, the name and the content are
    // under the share's key. A client that forgot would be refused, not quietly accepted.
    const want = shareId ? Object.values(SHARES).find((s) => s.id === shareId)!.scope : KV_SCOPE;
    assert.equal(body.name_key_id, want, 'a new node is named under its destination’s scope');
    if (body.sha256) {
      assert.ok(body.blob_envelopes?.some((e) => e.sha256 === body.sha256 && e.scope_id === want), 'and its content enveloped under it');
    }
    this.material(body);
    const id = `n${++this.ids}`;
    this.rows.set(id, {
      id, parentId: body.parent_id, nameEnc: body.name_enc, nameHmac: body.name_hmac, nameKeyId: body.name_key_id,
      shareId, sha256: body.sha256 ?? null, size: body.size ?? null, rev: ++this.rev, deleted: false,
    });
    return { node_id: id, rev: this.rev };
  }

  /** Every node whose content was replaced, in order — an edit that followed its node. */
  readonly edited: string[] = [];

  async putContent(_v: string, nodeId: string, body: Parameters<VaultWire['putContent']>[2]): Promise<{ rev: number } | PutConflict> {
    const r = this.rows.get(nodeId)!;
    const want = r.shareId ? Object.values(SHARES).find((s) => s.id === r.shareId)!.scope : KV_SCOPE;
    assert.ok(body.blob_envelopes?.some((e) => e.sha256 === body.sha256 && e.scope_id === want), 'an edit is sealed under its node’s scope');
    this.material(body);
    Object.assign(r, { sha256: body.sha256, size: body.size, rev: ++this.rev });
    this.edited.push(nodeId);
    return { rev: this.rev };
  }

  async moveNode(_v: string, nodeId: string, ifMatchRev: number, body: { parent_id: string; name_enc: string; name_hmac: string; name_key_id: string }): Promise<{ rev: number }> {
    const r = this.rows.get(nodeId)!;
    if (this.refuseMoves) return this.refuse(409, 'rev_mismatch');
    if (r.rev !== ifMatchRev) return this.refuse(409, 'rev_mismatch');
    // The server's rule since #401: the boundary lies between the old parent and the new one.
    if (this.shareInside(r.parentId!) !== this.shareInside(body.parent_id)) return this.refuse(409, 'share_boundary');
    Object.assign(r, { parentId: body.parent_id, nameEnc: body.name_enc, nameHmac: body.name_hmac, nameKeyId: body.name_key_id, rev: ++this.rev });
    return { rev: this.rev };
  }

  async deleteNode(_v: string, nodeId: string, ifMatchRev: number): Promise<{ rev: number }> {
    const r = this.rows.get(nodeId)!;
    if (r.rev !== ifMatchRev) return this.refuse(409, 'rev_mismatch');
    const gone = (id: string): void => {
      this.rows.get(id)!.deleted = true;
      for (const c of this.rows.values()) if (c.parentId === id && !c.deleted) gone(c.id);
    };
    gone(nodeId);
    return { rev: ++this.rev };
  }

  private refuse(status: number, code: string): never {
    this.refused.push(code);
    throw new ApiError(status, code, JSON.stringify({ error: code }));
  }
}

/** Test-side only: names are sealed, and a test asserting on paths needs them back. */
const decryptLabel = (r: ServerRow): string => decryptName(keyOf(r.nameKeyId!), r.nameEnc!);

/** Move a file on disk the way Obsidian does: the bytes appear at the new path, the old one is gone. */
const moveLocal = (vault: FakeVault, from: string, to: string): void => {
  vault.seed(to, vault.contents(from)!);
  void vault.delete(from);
};

let server: Server;
let vault: FakeVault;
let engine: SyncEngine;
let team: string;
let mine: string;

beforeEach(async () => {
  server = new Server();
  // A folder shared with somebody: its root named under KV (SH-01), its interior under KS.
  team = server.seed(ROOT, 'Team', { scopeId: KV_SCOPE, shareId: SHARES.team.id });
  server.seed(team, 'plan.md', { scopeId: SHARES.team.scope, shareId: SHARES.team.id, text: body('plan') });
  mine = server.seed(ROOT, 'Mine', { scopeId: KV_SCOPE });
  server.seed(mine, 'own.md', { scopeId: KV_SCOPE, text: body('own') });

  vault = new FakeVault();
  engine = new SyncEngine(server, vaultId, scopes(), vault, new MemoryStateStore());
  const first = await engine.sync();
  assert.deepEqual(first.errors, []);
  assert.deepEqual(vault.paths(), ['Mine/own.md', 'Team/plan.md'], 'the fixture arrives before anything moves');
});

describe('a file carried across a share’s edge (#402)', () => {
  it('leaves the share: re-created under the vault key, deleted from the share, one copy on disk', async () => {
    moveLocal(vault, 'Team/plan.md', 'Mine/plan.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.deepEqual(server.refused, [], 'no move was attempted that the server had to refuse');
    const tree = server.tree();
    assert.equal(tree.get('Team/plan.md'), undefined, 'gone from the share');
    assert.equal(tree.get('Mine/plan.md')?.shareId, null, 'and private where it landed');
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'Mine/plan.md'], 'and nothing came back');
  });

  it('joins the share: re-created under the share key, the private one deleted', async () => {
    moveLocal(vault, 'Mine/own.md', 'Team/own.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.deepEqual(server.refused, []);
    const tree = server.tree();
    assert.equal(tree.get('Mine/own.md'), undefined);
    assert.equal(tree.get('Team/own.md')?.shareId, SHARES.team.id);
    assert.deepEqual(vault.paths(), ['Team/own.md', 'Team/plan.md']);
  });

  it('is still an ordinary move on one side of the edge — the node, and its history, travel', async () => {
    const before = server.tree().get('Team/plan.md')!.id;
    moveLocal(vault, 'Team/plan.md', 'Team/renamed.md');
    await engine.sync();
    assert.equal(server.tree().get('Team/renamed.md')?.id, before, 'the same node, not a copy');
  });
});

describe('a folder carried across a share’s edge (#402)', () => {
  it('crosses file by file and leaves no empty folder behind', async () => {
    const proj = server.seed(ROOT, 'Proj', { scopeId: KV_SCOPE });
    server.seed(proj, 'a.md', { scopeId: KV_SCOPE, text: body('a') });
    server.seed(proj, 'b.md', { scopeId: KV_SCOPE, text: body('b') });
    await engine.sync();

    moveLocal(vault, 'Proj/a.md', 'Team/Proj/a.md');
    moveLocal(vault, 'Proj/b.md', 'Team/Proj/b.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.deepEqual(server.refused, []);
    const tree = server.tree();
    assert.equal(tree.get('Proj'), undefined, 'the emptied source folder is gone');
    assert.equal(tree.get('Team/Proj/a.md')?.shareId, SHARES.team.id);
    assert.equal(tree.get('Team/Proj/b.md')?.shareId, SHARES.team.id);
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'Team/Proj/a.md', 'Team/Proj/b.md', 'Team/plan.md']);
  });

  it('renames a share root in place, because its name is its holder’s alone (#401)', async () => {
    moveLocal(vault, 'Team/plan.md', 'Ours/plan.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    const tree = server.tree();
    assert.equal(tree.get('Ours')?.id, team, 'the root itself was renamed, not copied');
    assert.equal(tree.get('Ours/plan.md')?.shareId, SHARES.team.id, 'and its content never left the share');
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'Ours/plan.md']);
  });

  it('will not carry a share root into another share, and touches nothing', async () => {
    const other = server.seed(ROOT, 'Other', { scopeId: KV_SCOPE, shareId: SHARES.other.id });
    server.seed(other, 'x.md', { scopeId: SHARES.other.scope, shareId: SHARES.other.id, text: body('x') });
    await engine.sync();
    const before = [...server.tree().keys()].sort();

    moveLocal(vault, 'Team/plan.md', 'Other/Team/plan.md');
    const report = await engine.sync();

    assert.match(report.errors[0]?.message ?? '', /cannot be moved into another shared folder/);
    assert.deepEqual([...server.tree().keys()].sort(), before, 'the server is exactly as it was');
    assert.equal(vault.contents('Team/plan.md'), undefined, 'and the source was not pulled back beside it');
  });
});

describe('a move the server refuses (#402)', () => {
  it('brings nothing back and uploads nothing new, and the next pass tries the same move', async () => {
    const before = server.tree().get('Mine/own.md')!.id;
    server.refuseMoves = true;
    moveLocal(vault, 'Mine/own.md', 'Mine/renamed.md');

    const refused = await engine.sync();
    assert.equal(refused.errors.length, 1, 'the refusal is reported');
    assert.deepEqual(vault.paths(), ['Mine/renamed.md', 'Team/plan.md'], 'the source was not pulled back');
    assert.equal(server.tree().get('Mine/renamed.md'), undefined, 'and the destination was not uploaded as a copy');

    // The pass after it: the state still says where the file was, so it is the same move again.
    const again = await engine.sync();
    assert.equal(again.errors.length, 1);
    assert.deepEqual(vault.paths(), ['Mine/renamed.md', 'Team/plan.md']);

    server.refuseMoves = false;
    const moved = await engine.sync();
    assert.deepEqual(moved.errors, []);
    assert.equal(server.tree().get('Mine/renamed.md')?.id, before, 'moved at last, as the same node');
    assert.deepEqual(vault.paths(), ['Mine/renamed.md', 'Team/plan.md']);
  });

  it('holds a whole folder back the same way', async () => {
    server.refuseMoves = true;
    moveLocal(vault, 'Mine/own.md', 'Elsewhere/own.md');

    const refused = await engine.sync();
    assert.ok(refused.errors.length >= 1);
    assert.deepEqual(vault.paths(), ['Elsewhere/own.md', 'Team/plan.md'], 'no second copy of the folder');
    assert.equal(server.tree().get('Elsewhere'), undefined, 'and no new folder on the server');
  });
});

describe('a shared folder renamed with something else going on inside it (#409)', () => {
  /** What the server holds outside the vault's own scope — a share's content that left it shows up here. */
  const privateFiles = (): string[] =>
    [...server.tree()].filter(([p, r]) => r.shareId === null && r.sha256 !== null && !p.startsWith('Mine/')).map(([p]) => p);

  it('moves the root once when a file inside was edited in the same moment — the case that emptied a share', async () => {
    server.seed(team, 'notes.md', { scopeId: SHARES.team.scope, shareId: SHARES.team.id, text: body('notes') });
    await engine.sync();
    const notes = server.tree().get('Team/notes.md')!.id;

    moveLocal(vault, 'Team/plan.md', 'Ours/plan.md');
    vault.seed('Ours/notes.md', body('notes, edited while the folder was renamed'));
    await vault.delete('Team/notes.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.deepEqual(server.refused, []);
    const tree = server.tree();
    assert.equal(tree.get('Ours')?.id, team, 'the root itself was renamed');
    assert.equal(tree.get('Ours/notes.md')?.id, notes, 'the edited file is the same node');
    assert.equal(tree.get('Ours/notes.md')?.shareId, SHARES.team.id, 'and still in the share');
    assert.deepEqual(server.edited, [notes], 'the edit went up against it');
    assert.deepEqual(privateFiles(), [], 'nothing was re-created outside the share');
    assert.ok([...server.rows.values()].every((r) => !r.deleted), 'and nothing was deleted from it');
  });

  it('moves the root once when it has a subfolder — which was never recognised as a folder move', async () => {
    const sub = server.seed(team, 'sub', { scopeId: SHARES.team.scope, shareId: SHARES.team.id });
    server.seed(sub, 'deep.md', { scopeId: SHARES.team.scope, shareId: SHARES.team.id, text: body('deep') });
    await engine.sync();
    const deep = server.tree().get('Team/sub/deep.md')!.id;

    moveLocal(vault, 'Team/plan.md', 'Ours/plan.md');
    moveLocal(vault, 'Team/sub/deep.md', 'Ours/sub/deep.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    const tree = server.tree();
    assert.equal(tree.get('Ours')?.id, team);
    assert.equal(tree.get('Ours/sub/deep.md')?.id, deep, 'the subfolder rode along');
    assert.deepEqual(privateFiles(), []);
  });

  it('touches nothing when a shared folder’s files scatter into folders the server has never seen', async () => {
    server.seed(team, 'notes.md', { scopeId: SHARES.team.scope, shareId: SHARES.team.id, text: body('notes') });
    await engine.sync();
    const before = [...server.tree().keys()].sort();

    moveLocal(vault, 'Team/plan.md', 'One/plan.md');
    moveLocal(vault, 'Team/notes.md', 'Two/notes.md');
    const report = await engine.sync();

    assert.match(report.errors.map((e) => e.message).join(' '), /this shared folder is gone from here/);
    assert.deepEqual([...server.tree().keys()].sort(), before, 'the server is exactly as it was');
    assert.ok([...server.rows.values()].every((r) => !r.deleted), 'nothing left the share');
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'One/plan.md', 'Two/notes.md'], 'and nothing was pulled back beside them');
  });
});

describe('a shared folder moved onto a folder the server already has (#412)', () => {
  it('replaces a leftover empty folder of that name, and moves the root in one piece', async () => {
    // What a deleted folder leaves on the server (#413): invisible here, and still holding its name.
    const stale = server.seed(mine, 'Team', { scopeId: KV_SCOPE });
    moveLocal(vault, 'Team/plan.md', 'Mine/Team/plan.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.deepEqual(server.refused, []);
    const tree = server.tree();
    assert.equal(tree.get('Mine/Team')?.id, team, 'the root itself is there now');
    assert.equal(tree.get('Mine/Team/plan.md')?.shareId, SHARES.team.id, 'and its file never left the share');
    assert.equal(server.rows.get(stale)!.deleted, true, 'the leftover is gone');
    assert.deepEqual(vault.paths(), ['Mine/Team/plan.md', 'Mine/own.md']);
  });

  it('will not merge a shared folder into a folder that holds something, and touches nothing', async () => {
    const there = server.seed(mine, 'Team', { scopeId: KV_SCOPE });
    server.seed(there, 'theirs.md', { scopeId: KV_SCOPE, text: body('theirs') });
    await engine.sync();
    const before = [...server.tree().keys()].sort();

    moveLocal(vault, 'Team/plan.md', 'Mine/Team/plan.md');
    const report = await engine.sync();

    assert.match(report.errors.map((e) => e.message).join(' '), /already a folder “Mine\/Team” on the server/);
    assert.deepEqual([...server.tree().keys()].sort(), before, 'the server is exactly as it was');
    assert.ok([...server.rows.values()].every((r) => !r.deleted), 'nothing left the share');
  });

  it('still lets a file dragged into an existing folder leave the share (#402)', async () => {
    moveLocal(vault, 'Team/plan.md', 'Mine/plan.md');
    const report = await engine.sync();
    assert.deepEqual(report.errors, []);
    assert.equal(server.tree().get('Mine/plan.md')?.shareId, null);
  });
});

describe('a folder deleted here (#413)', () => {
  it('is deleted on the server in the same pass as its files, nested folders and all', async () => {
    const outer = server.seed(mine, 'Old', { scopeId: KV_SCOPE });
    const inner = server.seed(outer, 'Deeper', { scopeId: KV_SCOPE });
    server.seed(inner, 'gone.md', { scopeId: KV_SCOPE, text: body('gone') });
    await engine.sync();

    vault.rmdir('Mine/Old');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.equal(server.rows.get(inner)!.deleted, true, 'the inner folder went');
    assert.equal(server.rows.get(outer)!.deleted, true, 'and the one around it, once it was empty');
    assert.equal(server.tree().get('Mine/Old'), undefined);
  });

  it('removes a leftover the server has held since before this fix', async () => {
    const leftover = server.seed(mine, 'Leftover', { scopeId: KV_SCOPE });
    await engine.sync();
    assert.equal(server.rows.get(leftover)!.deleted, true);
  });

  it('keeps an empty folder that is still here', async () => {
    const empty = server.seed(mine, 'Empty', { scopeId: KV_SCOPE });
    vault.mkdir('Mine/Empty');
    await engine.sync();
    assert.equal(server.rows.get(empty)!.deleted, false);
  });

  it('never deletes a share root this way, even with nothing left in it', async () => {
    const quiet = server.seed(ROOT, 'Quiet', { scopeId: KV_SCOPE, shareId: SHARES.other.id });
    await engine.sync();
    assert.equal(server.rows.get(quiet)!.deleted, false);
  });

  it('deletes an empty folder inside a share, as deleting it there means for everybody', async () => {
    const sub = server.seed(team, 'Sub', { scopeId: SHARES.team.scope, shareId: SHARES.team.id });
    await engine.sync();
    assert.equal(server.rows.get(sub)!.deleted, true);
  });
});

describe('a name somebody else took a moment earlier (#420)', () => {
  it('ends with both files kept, one of them a conflict copy, and no error after', async () => {
    vault.seed('Team/dup.md', body('mine'));
    server.beforeCreate = () => {
      server.seed(team, 'dup.md', { scopeId: SHARES.team.scope, shareId: SHARES.team.id, text: body('theirs') });
    };

    const first = await engine.sync();
    assert.deepEqual(server.refused, ['name_taken'], 'the race is answered as a name conflict');
    assert.equal(first.errors.length, 1);

    const second = await engine.sync();
    assert.deepEqual(second.errors, []);
    const local = vault.paths().filter((p) => p.startsWith('Team/dup'));
    assert.equal(local.length, 2, 'theirs at the name, mine beside it');
    assert.equal(vault.contents('Team/dup.md'), body('theirs'));
    assert.ok(local.some((p) => p !== 'Team/dup.md' && vault.contents(p) === body('mine')), 'nothing of mine is lost');

    const third = await engine.sync();
    assert.deepEqual(third.errors, [], 'and it settles');
  });
});

describe('a rename that changes only letter case, arriving where case does not count (#421)', () => {
  it('renames the file in place, and nothing is deleted anywhere', async () => {
    // Windows: `Own.md` and `own.md` are one file.
    const windows = new FakeVault({ foldCase: true });
    const here = new SyncEngine(server, vaultId, scopes(), windows, new MemoryStateStore());
    await here.sync();
    assert.deepEqual(windows.paths(), ['Mine/own.md', 'Team/plan.md']);

    // The phone, where case counts, renamed it.
    const row = server.tree().get('Mine/own.md')!;
    Object.assign(row, { nameEnc: encryptName(kv, 'Own.md'), nameHmac: nameHmac(kv, 'Own.md'), rev: row.rev + 100 });

    const first = await here.sync();
    assert.deepEqual(first.errors, []);
    assert.deepEqual(windows.paths(), ['Mine/Own.md', 'Team/plan.md'], 'the file is there, under the new case');
    assert.equal(windows.contents('Mine/Own.md'), body('own'));

    const second = await here.sync();
    assert.deepEqual(second.errors, []);
    assert.equal(row.deleted, false, 'and the pass after it deleted nothing on the server');
  });

  it('sends a case-only rename made here as one move of the same node', async () => {
    const windows = new FakeVault({ foldCase: true });
    const here = new SyncEngine(server, vaultId, scopes(), windows, new MemoryStateStore());
    await here.sync();
    const node = server.tree().get('Mine/own.md')!.id;

    await windows.rename('Mine/own.md', 'Mine/Own.md');
    const report = await here.sync();

    assert.deepEqual(report.errors, []);
    assert.equal(server.tree().get('Mine/Own.md')?.id, node, 'the same node, renamed');
    assert.ok([...server.rows.values()].every((r) => !r.deleted), 'nothing deleted');
  });
});

describe('a file renamed here while somebody renamed it there (#418)', () => {
  /** Another participant's rename, already on the server, not yet pulled here. */
  const renameThere = (path: string, name: string, key: Uint8Array) => {
    const row = server.tree().get(path)!;
    Object.assign(row, { nameEnc: encryptName(key, name), nameHmac: nameHmac(key, name), rev: row.rev + 100 });
    return row.id;
  };

  it('keeps the one node and its history, under the name given here', async () => {
    const node = renameThere('Team/plan.md', 'theirs.md', SHARES.team.key);
    moveLocal(vault, 'Team/plan.md', 'Team/mine.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.equal(server.rows.get(node)!.deleted, false, 'nobody lost the file');
    assert.equal(server.tree().get('Team/mine.md')?.id, node, 'the same node carries the later name');
    assert.equal(server.tree().get('Team/theirs.md'), undefined);
    assert.equal([...server.rows.values()].filter((r) => r.sha256 === server.rows.get(node)!.sha256).length, 1, 'and no copy of it');
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'Team/mine.md']);
  });

  it('brings the file back under the other name when it was deleted here, rather than deleting it for everybody', async () => {
    const node = renameThere('Team/plan.md', 'theirs.md', SHARES.team.key);
    await vault.delete('Team/plan.md');
    const report = await engine.sync();

    assert.deepEqual(report.errors, []);
    assert.equal(server.rows.get(node)!.deleted, false, 'the rename there outranks a delete of a path that no longer exists');
    assert.deepEqual(vault.paths(), ['Mine/own.md', 'Team/theirs.md']);
  });

  it('does the same for a file that is nobody else\'s — another device of this account', async () => {
    const node = renameThere('Mine/own.md', 'renamed-on-the-phone.md', kv);
    moveLocal(vault, 'Mine/own.md', 'Mine/renamed-here.md');
    await engine.sync();

    assert.equal(server.rows.get(node)!.deleted, false);
    assert.equal(server.tree().get('Mine/renamed-here.md')?.id, node);
  });
});
