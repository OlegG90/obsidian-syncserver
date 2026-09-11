/**
 * What crosses between copies: a write reaching every participant, the history that arrives
 * with a folder, and the material a departure owes on the way out.
 *
 * The theme is the one the schema calls `share_item_id` — the identity of an item inside the
 * share, which is the same in every vault and is what makes "the same file" answerable when
 * no two of them agree on a node id.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { catchUpShare } from '../src/shares/catchup.js';
import {
  activeShare,
  auth,
  b64,
  closeWorld,
  createFile,
  createNode,
  finalize,
  invitedShare,
  inviteTo,
  join,
  leaveBegin,
  makeAccount,
  materialFor,
  openShare,
  openWorld,
  prepare,
  putBlob,
  putFile,
  sha,
  shareKeyOf,
  sharedWith,
  strangerRoot,
  strangerVaultKey,
  theirCopyOf,
  theirReplicaNodes,
  w,
  type ReplicaRow,
} from './support/shares.js';

before(() => openWorld('shares-replication'));
after(closeWorld);

describe('a write inside a shared folder reaches every copy', () => {
  it('creates the new node in the other participant’s vault too', async () => {
    const { inside, ks } = await sharedWith('fanout-create');
    const made = await createNode('folder', `new-${randomUUID()}`, inside, ks);

    const theirs = await theirCopyOf(made);
    assert.ok(theirs, 'the item exists in their replica');

    const row = await w.db.one<{ shareId: string | null; vaultId: string }>(
      `SELECT share_id AS "shareId", vault_id AS "vaultId" FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, theirs],
    );
    assert.ok(row!.shareId, 'and carries the share mark, which the schema demands of it');
  });

  it('gives the recipient a journal entry, so it arrives as an ordinary change', async () => {
    // Not a special channel: their client learns about it through the same delta as
    // anything else they did themselves.
    const { inside, ks } = await sharedWith('fanout-journal');
    const made = await createNode('folder', `new-${randomUUID()}`, inside, ks);
    const theirs = await theirCopyOf(made);

    const entry = await w.db.one<{ op: string }>(
      `SELECT op::text AS op FROM journal WHERE vault_id = $1 AND node_id = $2`,
      [w.strangerVaultId, theirs],
    );
    assert.equal(entry!.op, 'put');
  });

  it('propagates a deletion', async () => {
    const { inside, ks } = await sharedWith('fanout-delete');
    const made = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const theirs = await theirCopyOf(made);

    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      made,
    ]);
    const r = await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${made}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    assert.equal(r.statusCode, 200, r.body);

    const gone = await w.db.one<{ deleted: string | null }>(
      `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, theirs],
    );
    assert.ok(gone!.deleted, 'their copy is in the trash too');
  });

  it('propagates a move within the share, and the subtree follows', async () => {
    const { inside, ks } = await sharedWith('fanout-move');
    const a = await createNode('folder', `a-${randomUUID()}`, inside, ks);
    const b = await createNode('folder', `b-${randomUUID()}`, inside, ks);
    const child = await createNode('folder', `child-${randomUUID()}`, a, ks);

    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      a,
    ]);
    const moved = await w.app.inject({
      method: 'POST',
      url: `/vaults/${w.vaultId}/nodes/${a}/move`,
      headers: { ...auth(), 'if-match': rev!.rev },
      payload: {
        parent_id: b,
        name_enc: b64('moved'),
        name_hmac: sha(Buffer.from(`moved-${randomUUID()}`)),
        name_key_id: (await w.db.one<{ id: string }>(`SELECT name_key_id AS id FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, a]))!.id,
      },
    });
    assert.equal(moved.statusCode, 200, moved.body);

    const theirA = await theirCopyOf(a);
    const theirB = await theirCopyOf(b);
    const theirChild = await theirCopyOf(child);

    const placed = await w.db.one<{ parentId: string; ancestry: string[] }>(
      `SELECT parent_id AS "parentId", ancestry FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, theirA],
    );
    assert.equal(placed!.parentId, theirB, 'their copy moved to the same place');

    const descendant = await w.db.one<{ ancestry: string[] }>(
      `SELECT ancestry FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, theirChild],
    );
    assert.ok(
      descendant!.ancestry.includes(theirB!),
      'and the subtree came with it, rather than claiming its old parent',
    );
  });

  it('does not send a participant their own write back', async () => {
    // The fan-out set excludes the vault the write happened in. Without that the originator
    // would get a second revision of their own change and see it as a remote edit.
    const { inside, ks } = await sharedWith('fanout-self');
    const made = await createNode('folder', `mine-${randomUUID()}`, inside, ks);

    const copies = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1 AND share_item_id = (
      SELECT share_item_id FROM nodes WHERE vault_id = $1 AND id = $2)`, [w.vaultId, made]);
    assert.equal(copies.length, 1, 'one copy in the writer’s own vault, not two');
  });
});

describe('who a write reaches, and who it does not', () => {
  it('skips a participant whose account is frozen, in both directions', async () => {
    // A freeze is the account having no room; delivering more is the one thing it cannot
    // absorb (SH-20). Their copy catches up on thaw.
    const { inside, ks } = await sharedWith('frozen');
    await w.db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [w.strangerId]);

    const made = await createNode('folder', `while-frozen-${randomUUID()}`, inside, ks);
    assert.equal(await theirCopyOf(made), undefined, 'nothing was delivered');

    await w.db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [w.strangerId]);
  });

  it('skips a participant who is finalizing, because revocation stops propagation now', async () => {
    // A third member, and not for decoration: revoking the LAST participant ends the share
    // (SH-07), and an ended share is no place to observe propagation. Somebody has to be
    // left for the write to still have a destination.
    const { shareId, inside, ks } = await sharedWith('revoked');
    const third = await makeAccount('shares-revoked-third');
    const theirVault = randomUUID();
    await w.app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${third.access}` },
      payload: { id: theirVault, name_enc: b64('third vault') },
    });
    await w.db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ($1, $2, $3, now(), '\x01')`,
      [shareId, third.id, theirVault],
    );

    const r = await w.app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${w.strangerId}`,
      headers: auth(),
    });
    assert.equal(r.json().outcome, 'revoked');
    assert.equal(r.json().ended, false, 'the share carries on for the third member');

    const made = await createNode('folder', `after-revoke-${randomUUID()}`, inside, ks);
    assert.equal(await theirCopyOf(made), undefined, 'a revoked device receives no further changes');
  });
});

describe('all of them or none of them', () => {
  it('advances no replica when one of them cannot be written', async () => {
    // The atomicity contract docs/04 states, and the test it explicitly asks for. The
    // replica is made unwritable by removing the parent the propagated create needs, so
    // the fan-out raises inside the transaction that already wrote the original.
    const { inside, ks } = await sharedWith('atomic-fanout');

    const beforeSrc = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.vaultId]);
    const beforeDst = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.strangerVaultId]);

    // A name that is already taken in the RECIPIENT's replica but free in the source: the
    // propagated insert violates their unique sibling name, and nothing may survive it.
    const clashName = `clash-${randomUUID()}`;
    const theirInside = await theirCopyOf(inside);
    await w.db.query(
      `INSERT INTO nodes (vault_id, parent_id, name_enc, name_hmac, name_key_id, type, mtime, rev, ancestry,
                          share_id, share_item_id)
       SELECT $1, $2, decode($3,'base64'), decode($4,'hex'), n.name_key_id, 'folder', now(), 0,
              n.ancestry || n.id, n.share_id, gen_random_uuid()
         FROM nodes n WHERE n.vault_id = $1 AND n.id = $2`,
      [w.strangerVaultId, theirInside, b64(clashName), sha(Buffer.from(clashName))],
    );

    const r = await w.app.inject({
      method: 'POST',
      url: `/vaults/${w.vaultId}/nodes`,
      headers: auth(),
      payload: {
        parent_id: inside,
        type: 'folder',
        mtime: new Date().toISOString(),
        name_enc: b64(clashName),
        name_hmac: sha(Buffer.from(clashName)),
        name_key_id: (await w.db.one<{ id: string }>(`SELECT name_key_id AS id FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, inside]))!.id,
      },
    });
    assert.notEqual(r.statusCode, 201, 'the write did not succeed');

    const afterSrc = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.vaultId]);
    const afterDst = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.strangerVaultId]);
    assert.equal(afterSrc.length, beforeSrc.length, 'the ORIGINAL rolled back too, not only the replica');
    assert.equal(afterDst.length, beforeDst.length + 1, 'and the replica gained nothing beyond the row we planted');
  });

  it('advances no replica when a propagated PUT cannot be written', async () => {
    // Same contract, a different shape. The recipient is made unwritable by DISABLING their
    // account: `fanoutTargets` excludes only FROZEN accounts, and a disabled one is still a
    // target whose vault refuses the write (`owned_rows_require_active_user`). The
    // propagation then raises inside the transaction that already updated the original, and
    // the original must come undone with it.
    const { inside, ks } = await sharedWith('atomic-put');
    const file = await createFile(inside, `put-${randomUUID()}.md`, 'first', ks);
    await w.db.query(`UPDATE users SET state = 'disabled' WHERE id = $1`, [w.strangerId]);
    try {
      const next = randomUUID();
      const nextHex = await putBlob(Buffer.from(next), ks);
      const r = await w.app.inject({
        method: 'PUT', url: `/vaults/${w.vaultId}/nodes/${file.nodeId}`, headers: auth(),
        payload: {
          sha256: nextHex, size: Buffer.byteLength(next), mtime: new Date().toISOString(),
          base_sha256: file.sha256, ...materialFor(nextHex, ks),
        },
      });
      assert.notEqual(r.statusCode, 200, 'the write did not succeed');

      const src = await w.db.one<{ sha: string }>(
        `SELECT encode(sha256,'hex') AS sha FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, file.nodeId]);
      assert.equal(src!.sha, file.sha256, 'the ORIGINAL still holds its old content');

      const theirs = await theirCopyOf(file.nodeId);
      const dst = await w.db.one<{ sha: string }>(
        `SELECT encode(sha256,'hex') AS sha FROM nodes WHERE vault_id = $1 AND id = $2`, [w.strangerVaultId, theirs]);
      assert.equal(dst!.sha, file.sha256, 'and the replica did not advance either');
    } finally {
      await w.db.query(`UPDATE users SET state = 'active' WHERE id = $1`, [w.strangerId]);
    }
  });

  it('advances no replica when a propagated delete cannot be written', async () => {
    const { inside, ks } = await sharedWith('atomic-delete');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const theirs = await theirCopyOf(doomed);
    await w.db.query(`UPDATE users SET state = 'disabled' WHERE id = $1`, [w.strangerId]);
    try {
      const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
        w.vaultId, doomed,
      ]);
      const r = await w.app.inject({
        method: 'DELETE', url: `/vaults/${w.vaultId}/nodes/${doomed}`,
        headers: { ...auth(), 'if-match': rev!.rev },
      });
      assert.notEqual(r.statusCode, 200, 'the delete did not succeed');

      const src = await w.db.one<{ deleted: string | null }>(
        `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, doomed]);
      assert.equal(src!.deleted, null, 'the ORIGINAL is not in the trash');

      const dst = await w.db.one<{ deleted: string | null }>(
        `SELECT deleted_at AS deleted FROM nodes WHERE vault_id = $1 AND id = $2`, [w.strangerVaultId, theirs]);
      assert.equal(dst!.deleted, null, 'and the replica is not either');
    } finally {
      await w.db.query(`UPDATE users SET state = 'active' WHERE id = $1`, [w.strangerId]);
    }
  });

  it('advances no replica when a propagated move cannot be written', async () => {
    const { inside, ks } = await sharedWith('atomic-move');
    const a = await createNode('folder', `a-${randomUUID()}`, inside, ks);
    const b = await createNode('folder', `b-${randomUUID()}`, inside, ks);
    await w.db.query(`UPDATE users SET state = 'disabled' WHERE id = $1`, [w.strangerId]);
    try {
      const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
        w.vaultId, a,
      ]);
      const moved = await w.app.inject({
        method: 'POST', url: `/vaults/${w.vaultId}/nodes/${a}/move`,
        headers: { ...auth(), 'if-match': rev!.rev },
        payload: {
          parent_id: b,
          name_enc: b64('moved'),
          name_hmac: sha(Buffer.from(`moved-${randomUUID()}`)),
          name_key_id: (await w.db.one<{ id: string }>(`SELECT name_key_id AS id FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, a]))!.id,
        },
      });
      assert.notEqual(moved.statusCode, 200, 'the move did not succeed');

      const src = await w.db.one<{ parentId: string }>(
        `SELECT parent_id AS "parentId" FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, a]);
      assert.equal(src!.parentId, inside, 'the ORIGINAL did not move');

      const theirA = await theirCopyOf(a);
      const theirInside = await theirCopyOf(inside);
      const dst = await w.db.one<{ parentId: string }>(
        `SELECT parent_id AS "parentId" FROM nodes WHERE vault_id = $1 AND id = $2`, [w.strangerVaultId, theirA]);
      assert.equal(dst!.parentId, theirInside, 'and the replica stayed put too');
    } finally {
      await w.db.query(`UPDATE users SET state = 'active' WHERE id = $1`, [w.strangerId]);
    }
  });
});

describe('history arrives with the folder', () => {
  it('delivers a file’s retained versions, not only its head', async () => {
    // A folder that arrives with no past is one whose "restore an earlier version" does
    // nothing, and that only shows up on the day somebody needs it.
    const { shareId, inside, ks } = await invitedShare('history');

    // Two revisions of one file, made before anybody joined.
    const file = await createFile(inside, `hist-${randomUUID()}`, 'first', ks);
    await putFile(file, 'second');

    const rootNodeId = (await join(shareId)).json().root_node_id;
    assert.ok(rootNodeId);

    const theirs = await theirCopyOf(file.nodeId);
    const versions = await w.db.query<{ rev: string; author: string }>(
      `SELECT rev::text AS rev, author_id AS author FROM versions
        WHERE vault_id = $1 AND node_id = $2 ORDER BY versions.rev`,
      [w.strangerVaultId, theirs],
    );
    assert.equal(versions.length, 2, 'both revisions came across');
    assert.ok(
      versions.every((v) => v.author === w.userId),
      'and every one credits the original writer, not the joiner (SH-19)',
    );
    assert.ok(Number(versions[1]!.rev) > Number(versions[0]!.rev), 'in order, renumbered into their sequence');
  });
});

describe('a departure has to account for the trash too', () => {
  it('refuses a pass that leaves a deleted node still marked', async () => {
    // The 500 a live vault hit: the schema refuses to let a member leave while any node of
    // theirs carries the mark, and the completeness check only looked at LIVE ones. It is
    // not a technicality — a trashed node keeps its name, that name is under KS, and after
    // the pass the key is gone, so it would come back from the trash unopenable.
    const { shareId, inside, ks } = await sharedWith('trash-marked');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      doomed,
    ]);
    await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });

    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    // Only the live nodes, which is what the client used to send.
    const liveOnly = await w.db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [w.vaultId, shareId],
    );
    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: liveOnly.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: w.vaultKeyId,
        })),
      },
    });

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'finalization_incomplete');
    assert.ok(r.json().missing.length > 0, 'and the trashed one is named among the missing');
  });

  it('accepts the pass once the trash is included, and clears its marks', async () => {
    const { shareId, inside, ks } = await sharedWith('trash-included');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      doomed,
    ]);
    await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const all = await w.db.query<{ id: string }>(`SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2`, [
      w.vaultId,
      shareId,
    ]);
    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: all.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: w.vaultKeyId,
        })),
      },
    });
    assert.equal(r.statusCode, 204, r.body);

    const left = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1 AND share_id = $2`, [w.vaultId, shareId]);
    assert.equal(left.length, 0, 'nothing carries the share any more, trashed or not');
  });

  it('lists a trashed FOLDER as part of the replica, which no other listing shows', async () => {
    // The deeper half of the same defect. The trash offers what can be restored, so it
    // shows only nodes with versions and never folders — and a trashed folder still carries
    // the mark that blocks a departure. A client asking the trash could not even discover
    // what was stopping it.
    const { shareId, inside, ks } = await sharedWith('trash-scope');
    const doomed = await createNode('folder', `doomed-${randomUUID()}`, inside, ks);
    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      doomed,
    ]);
    await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });

    const r = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/replica`, headers: auth() });
    const entry = (r.json() as { node_id: string; name_key_id: string; deleted: boolean }[]).find(
      (t) => t.node_id === doomed,
    );
    assert.ok(entry, 'the replica listing shows it');
    assert.equal(entry!.deleted, true);
    assert.equal(entry!.name_key_id, ks, 'still under the share key, which is why it must be converted');

    const trash = await w.app.inject({ method: 'GET', url: `/vaults/${w.vaultId}/trash`, headers: auth() });
    assert.ok(
      !(trash.json().entries as { node_id: string }[]).some((t) => t.node_id === doomed),
      'and the trash does not, which is the whole point of asking somewhere else',
    );
  });
});

describe('a departure owes the history, not only the head', () => {
  it('names every superseded blob, and takes an envelope without a tag for it', async () => {
    // The live vault refused here, on a blob its owner could not see: one edit ago. Every
    // write made while the folder was shared minted its content key under KS alone, so the
    // whole retained history owes a KV envelope — and a listing that reports the head alone
    // sends a client back with a pass the schema then rejects, naming a blob it never heard
    // of. What the client CANNOT produce is a tag: the plaintext of a superseded version is
    // not on disk, and re-downloading every one of them to HMAC a value nothing looks up is
    // not a price a departure should pay.
    const { shareId, inside, ks } = await sharedWith('history-leave');
    // Unique content, because a blob is its bytes: 'first' written by another test is the
    // same blob, and its material would answer this test's question for it.
    const body = randomUUID();
    const file = await createFile(inside, `hist-${randomUUID()}`, `${body}-1`, ks);
    const superseded = file.sha256;
    await putFile(file, `${body}-2`);

    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const listing = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/replica`, headers: auth() });
    const rows = listing.json() as ReplicaRow[];
    const entry = rows.find((n) => n.node_id === file.nodeId);
    assert.ok(entry, 'the file is in the replica');
    assert.equal(entry!.sha256, file.sha256, 'the head is named');
    assert.deepEqual(entry!.history_needing_material, [superseded], 'and so is the version behind it');

    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: rows.map((n) => ({
          node_id: n.node_id,
          name_enc: b64(`kv-${n.node_id}`),
          name_hmac: sha(Buffer.from(`kv-${n.node_id}`)),
          name_key_id: w.vaultKeyId,
          vault_envelopes: [...(n.needs_vault_material ? [n.sha256!] : []), ...n.history_needing_material].map(
            (hex) => ({ sha256: hex, scope_id: w.vaultKeyId, wrapped_key: Buffer.alloc(48, 9).toString('base64') }),
          ),
          // Only for the head, and only while it is readable — exactly what `rekey` sends.
          vault_dedup_tags:
            n.needs_vault_material && !n.deleted
              ? [{ sha256: n.sha256!, scope_id: w.vaultKeyId, content_tag: sha(Buffer.from(`tag:${n.sha256}`)) }]
              : [],
        })),
      },
    });
    assert.equal(r.statusCode, 204, r.body);

    const openable = await w.db.query(
      `SELECT 1 FROM blob_keys WHERE scope_id = $1 AND sha256 IN (decode($2,'hex'), decode($3,'hex'))`,
      [w.vaultKeyId, superseded, file.sha256],
    );
    assert.equal(openable.length, 2, 'both revisions open under the vault key once the share key is gone');
  });
});

describe('reading the CONTENT of a folder somebody shared', () => {
  it('hands a participant the envelope under the share scope', async () => {
    // The gap that let a participant read a shared folder's NAMES and not one byte of it.
    // The envelope was there, in the right scope, and the query declined to hand it over.
    const { shareId, inside, ks } = await sharedWith('content-read');
    const file = await createFile(inside, `readable-${randomUUID()}`, 'the contents', ks);

    // Their replica references the same blob; the propagation put it there.
    const theirs = await theirCopyOf(file.nodeId);
    assert.ok(theirs, 'the file reached their copy');

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}/blob-keys?sha256=${file.sha256}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 200, r.body);

    const keys = r.json().keys as { sha256: string; scope_id: string }[];
    assert.ok(
      keys.some((k) => k.sha256 === file.sha256 && k.scope_id === ks),
      'the share scope envelope is offered, which is the only one they can open',
    );
  });

  it('does not hand it to somebody who is not in the share', async () => {
    // The rule is membership, not the existence of an envelope.
    const folder = await createNode('folder', `private-content-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);
    const file = await createFile(folder, `not-yours-${randomUUID()}`, 'secret', w.vaultKeyId);
    void shareId;

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}/blob-keys?sha256=${file.sha256}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const keys = (r.json().keys ?? []) as { scope_id: string }[];
    assert.ok(!keys.some((k) => k.scope_id === ks));
  });

  it('stops offering it once they have left', async () => {
    // Same condition as the keys a vault is told about: a scope worth reporting is a scope
    // worth opening, and both stop at `left_at`.
    const { shareId, inside, ks } = await sharedWith('content-after-leave');
    const file = await createFile(inside, `gone-${randomUUID()}`, 'bytes', ks);

    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const nodes = await w.db.query<{ id: string }>(`SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2`, [
      w.strangerVaultId,
      shareId,
    ]);
    // The material travels with it, because the schema insists: a node may not be unmarked
    // until its blob has an envelope and a tag under the vault key. That is the rule which
    // makes "you keep your copy" true rather than a slogan — a file leaving a share has to
    // stay openable by the person keeping it.
    const keyId = await strangerVaultKey();
    const withContent = await w.db.query<{ id: string; sha: string | null }>(
      `SELECT id, encode(sha256,'hex') AS sha FROM nodes WHERE vault_id = $1 AND share_id = $2`,
      [w.strangerVaultId, shareId],
    );
    const done = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
      payload: {
        nodes: withContent.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: keyId,
          ...(n.sha
            ? {
                vault_envelopes: [
                  { sha256: n.sha, scope_id: keyId, wrapped_key: Buffer.alloc(48, 7).toString('base64') },
                ],
                vault_dedup_tags: [{ sha256: n.sha, scope_id: keyId, content_tag: sha(Buffer.from(`kv:${n.sha}`)) }],
              }
            : {}),
        })),
      },
    });
    assert.equal(done.statusCode, 204, done.body);

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}/blob-keys?sha256=${file.sha256}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const keys = (r.json().keys ?? []) as { scope_id: string }[];
    assert.ok(!keys.some((k) => k.scope_id === ks), 'the share key is no longer theirs to use');
  });
});

/** The initiator's current revision of a node, which every write to it must match. */
const revOf = async (nodeId: string): Promise<string> =>
  (await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [w.vaultId, nodeId]))!.rev;

/** Move and rename in one, as the client does — the initiator's own write. */
const moveTo = async (nodeId: string, parentId: string, name: string, ks: string): Promise<void> => {
  const r = await w.app.inject({
    method: 'POST',
    url: `/vaults/${w.vaultId}/nodes/${nodeId}/move`,
    headers: { ...auth(), 'if-match': await revOf(nodeId) },
    payload: { parent_id: parentId, name_enc: b64(name), name_hmac: sha(Buffer.from(name)), name_key_id: ks },
  });
  assert.equal(r.statusCode, 200, r.body);
};

const trash = async (nodeId: string): Promise<void> => {
  const r = await w.app.inject({
    method: 'DELETE',
    url: `/vaults/${w.vaultId}/nodes/${nodeId}`,
    headers: { ...auth(), 'if-match': await revOf(nodeId) },
  });
  assert.equal(r.statusCode, 200, r.body);
};

/** Restore one version of a node: the node's oldest unless told otherwise. */
const restore = async (nodeId: string, which: 'oldest' | 'newest' = 'oldest'): Promise<void> => {
  const v = await w.db.one<{ rev: string }>(
    `SELECT rev::text AS rev FROM versions WHERE vault_id = $1 AND node_id = $2
      ORDER BY versions.rev ${which === 'oldest' ? 'ASC' : 'DESC'} LIMIT 1`,
    [w.vaultId, nodeId],
  );
  const r = await w.app.inject({
    method: 'POST',
    url: `/vaults/${w.vaultId}/restore`,
    headers: auth(),
    payload: { node_id: nodeId, rev: Number(v!.rev) },
  });
  assert.equal(r.statusCode, 200, r.body);
};

const freezeStranger = () => w.db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [w.strangerId]);

/** Lift the freeze and catch the stranger's copy up, as a thaw does. */
const thawStranger = async (shareId: string) => {
  await w.db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [w.strangerId]);
  return w.db.tx((c) => catchUpShare(c, { userId: w.strangerId, vaultId: w.strangerVaultId }, shareId));
};

/** The stranger's copy of an item, as their vault holds it. */
const theirNode = async (srcNodeId: string) => {
  const id = await theirCopyOf(srcNodeId);
  assert.ok(id, 'their replica holds the item');
  const row = await w.db.one<{
    id: string; parentId: string; nameEnc: string; ancestry: string[]; sha256: string | null; rev: string; deleted: boolean;
  }>(
    `SELECT id, parent_id AS "parentId", encode(name_enc,'base64') AS "nameEnc", ancestry,
            encode(sha256,'hex') AS sha256, rev::text AS rev, deleted_at IS NOT NULL AS deleted
       FROM nodes WHERE vault_id = $1 AND id = $2`,
    [w.strangerVaultId, id],
  );
  return row!;
};

/** A node's versions in one vault, oldest first. */
const versionsOf = (vaultId: string, nodeId: string) =>
  w.db.query<{ rev: string; sha256: string; authorId: string }>(
    `SELECT rev::text AS rev, encode(sha256,'hex') AS sha256, author_id AS "authorId"
       FROM versions WHERE vault_id = $1 AND node_id = $2 ORDER BY versions.rev`,
    [vaultId, nodeId],
  );

describe('a frozen member catches up with everything, not only content (#337)', () => {
  it('takes the renames and moves made while they were frozen, with the subtree following', async () => {
    const { shareId, inside, ks } = await sharedWith('catchup-move');
    const a = await createNode('folder', `a-${randomUUID()}`, inside, ks);
    const b = await createNode('folder', `b-${randomUUID()}`, inside, ks);
    const child = await createNode('folder', `child-${randomUUID()}`, a, ks);
    const fileName = `note-${randomUUID()}.md`;
    const file = await createFile(inside, fileName, `body ${randomUUID()}`, ks);
    const other = await createFile(inside, `other-${randomUUID()}.md`, `body ${randomUUID()}`, ks);

    // Three shapes, kept apart so each is its own evidence: a new parent under the same name,
    // a new name in the same place, and both at once.
    await freezeStranger();
    await moveTo(file.nodeId, b, fileName, ks);
    const otherName = `other-renamed-${randomUUID()}.md`;
    await moveTo(other.nodeId, inside, otherName, ks);
    const aName = `a-renamed-${randomUUID()}`;
    await moveTo(a, b, aName, ks);
    assert.notEqual((await theirNode(file.nodeId)).parentId, await theirCopyOf(b), 'the freeze held the moves back');

    const done = await thawStranger(shareId);
    assert.equal(done.moved, 3, 'every move is delivered');

    const theirB = await theirCopyOf(b);
    const theirFile = await theirNode(file.nodeId);
    assert.equal(theirFile.parentId, theirB, 'the file is where the source has it');
    assert.equal(theirFile.nameEnc, b64(fileName), 'under the name it kept');

    const theirOther = await theirNode(other.nodeId);
    assert.equal(theirOther.parentId, await theirCopyOf(inside), 'the renamed file stayed where it was');
    assert.equal(theirOther.nameEnc, b64(otherName), 'under its new name');

    const theirA = await theirNode(a);
    assert.equal(theirA.parentId, theirB);
    assert.equal(theirA.nameEnc, b64(aName));
    assert.ok(
      (await theirNode(child)).ancestry.includes(theirB!),
      'and the moved folder took its subtree along, rather than leaving it claiming the old chain',
    );

    const again = await w.db.tx((c) => catchUpShare(c, { userId: w.strangerId, vaultId: w.strangerVaultId }, shareId));
    assert.deepEqual({ moved: again.moved, restored: again.restored }, { moved: 0, restored: 0 }, 'and a second pass moves nothing');
  });

  it('survives a gap that hands names from one file to another', async () => {
    // Sibling names are unique among live nodes, and the gap reorders them: a swap, and a
    // file deleted and another created under its name. The end state is sound; a walk that
    // applied it node by node would collide halfway and fail the thaw.
    const { shareId, inside, ks } = await sharedWith('catchup-names');
    const xName = `x-${randomUUID()}.md`;
    const yName = `y-${randomUUID()}.md`;
    const zName = `z-${randomUUID()}.md`;
    const x = await createFile(inside, xName, `x ${randomUUID()}`, ks);
    const y = await createFile(inside, yName, `y ${randomUUID()}`, ks);
    const z = await createFile(inside, zName, `z ${randomUUID()}`, ks);

    await freezeStranger();
    await moveTo(x.nodeId, inside, `swap-${randomUUID()}`, ks);
    await moveTo(y.nodeId, inside, xName, ks);
    await moveTo(x.nodeId, inside, yName, ks);
    await trash(z.nodeId);
    const z2 = await createFile(inside, zName, `z again ${randomUUID()}`, ks);

    const done = await thawStranger(shareId);
    assert.equal(done.moved, 2);
    assert.equal(done.deleted, 1);
    assert.equal(done.created, 1);

    assert.equal((await theirNode(x.nodeId)).nameEnc, b64(yName), 'the two names swapped');
    assert.equal((await theirNode(y.nodeId)).nameEnc, b64(xName));
    assert.equal((await theirNode(z.nodeId)).deleted, true, 'the old file is in the trash');
    const theirZ2 = await theirNode(z2.nodeId);
    assert.equal(theirZ2.nameEnc, b64(zName), 'and the new one holds its name');
    assert.equal(theirZ2.deleted, false);
  });

  it('brings back what was restored from the trash while they were frozen', async () => {
    const { shareId, inside, ks } = await sharedWith('catchup-undelete');
    const file = await createFile(inside, `back-${randomUUID()}.md`, `body ${randomUUID()}`, ks);
    await trash(file.nodeId);
    assert.equal((await theirNode(file.nodeId)).deleted, true, 'the deletion reached them while they were live');

    await freezeStranger();
    await restore(file.nodeId, 'newest');

    const done = await thawStranger(shareId);
    assert.equal(done.restored, 1);
    const theirs = await theirNode(file.nodeId);
    assert.equal(theirs.deleted, false, 'their copy is out of the trash too');
    assert.equal(theirs.sha256, file.sha256);
  });
});

describe('a catch-up delivers history once, numbered as the member numbers it (#340)', () => {
  it('does not repeat what propagation already brought, and the newest version is the head', async () => {
    const { shareId, inside, ks } = await sharedWith('catchup-history');
    const file = await createFile(inside, `hist-${randomUUID()}.md`, `v1 ${randomUUID()}`, ks);
    await putFile(file, `v2 ${randomUUID()}`);

    await freezeStranger();
    await putFile(file, `v3 ${randomUUID()}`);
    await putFile(file, `v4 ${randomUUID()}`);
    // The source's revision counter pulled far ahead of the member's, so a copy numbered by
    // the source's revisions would land above anything the member wrote itself.
    for (let i = 0; i < 5; i++) await createNode('folder', `elsewhere-${randomUUID()}`);

    const done = await thawStranger(shareId);
    assert.equal(done.versions, 2, 'the two versions of the gap, not the two before it again');

    const theirs = await theirNode(file.nodeId);
    const source = await versionsOf(w.vaultId, file.nodeId);
    const mine = await versionsOf(w.strangerVaultId, theirs.id);
    assert.deepEqual(
      mine.map((v) => v.sha256),
      source.map((v) => v.sha256),
      'one history, in order, with nothing twice',
    );
    assert.equal(mine.at(-1)!.sha256, theirs.sha256, 'the highest revision is the content the file holds');
    assert.equal(mine.at(-1)!.rev, theirs.rev, 'and it is the revision the node itself carries');
    assert.ok(mine.every((v) => v.authorId === w.userId), 'written by the person who wrote them (SH-19)');

    const again = await w.db.tx((c) => catchUpShare(c, { userId: w.strangerId, vaultId: w.strangerVaultId }, shareId));
    assert.equal(again.versions, 0, 'a second pass delivers nothing');
  });

  it('does not refill a version the member already thinned, above the head', async () => {
    // Retention thins each vault on its own schedule. A catch-up that delivered every version
    // "missing" would put an old one back — numbered above the current head.
    const { shareId, inside, ks } = await sharedWith('catchup-thinned');
    const file = await createFile(inside, `thin-${randomUUID()}.md`, `v1 ${randomUUID()}`, ks);
    await putFile(file, `v2 ${randomUUID()}`);
    const theirId = (await theirNode(file.nodeId)).id;
    const oldest = (await versionsOf(w.strangerVaultId, theirId))[0]!;
    await w.db.query(`DELETE FROM versions WHERE vault_id = $1 AND node_id = $2 AND rev = $3`, [
      w.strangerVaultId,
      theirId,
      oldest.rev,
    ]);

    await freezeStranger();
    await putFile(file, `v3 ${randomUUID()}`);

    const done = await thawStranger(shareId);
    assert.equal(done.versions, 1, 'only the version of the gap');
    const mine = await versionsOf(w.strangerVaultId, theirId);
    assert.equal(mine.length, 2, 'the thinned one stays thinned');
    assert.equal(mine.at(-1)!.sha256, file.sha256, 'and the head is the current content');
  });
});

describe('a restore inside a shared folder reaches every copy (#336)', () => {
  it('puts the old content into the other member’s copy, as a new version', async () => {
    const { inside, ks } = await sharedWith('restore-content');
    const file = await createFile(inside, `r-${randomUUID()}.md`, `first ${randomUUID()}`, ks);
    const first = file.sha256;
    await putFile(file, `second ${randomUUID()}`);
    const theirId = (await theirNode(file.nodeId)).id;
    const before = (await versionsOf(w.strangerVaultId, theirId)).length;

    await restore(file.nodeId, 'oldest');

    const theirs = await theirNode(file.nodeId);
    assert.equal(theirs.sha256, first, 'their copy holds the restored content');
    const mine = await versionsOf(w.strangerVaultId, theirId);
    assert.equal(mine.length, before + 1, 'as a new version — going back is something that happened');
    assert.equal(mine.at(-1)!.sha256, first);
  });

  it('brings a deleted file back out of their trash, and the folder it was lifted with', async () => {
    const { inside, ks } = await sharedWith('restore-undelete');
    const folder = await createNode('folder', `d-${randomUUID()}`, inside, ks);
    const file = await createFile(folder, `f-${randomUUID()}.md`, `body ${randomUUID()}`, ks);
    await trash(file.nodeId);
    await trash(folder);
    assert.equal((await theirNode(folder)).deleted, true);
    assert.equal((await theirNode(file.nodeId)).deleted, true);

    await restore(file.nodeId, 'newest');

    assert.equal((await theirNode(folder)).deleted, false, 'the lifted folder is out of their trash');
    const theirs = await theirNode(file.nodeId);
    assert.equal(theirs.deleted, false, 'and so is the file');
    assert.equal(theirs.sha256, file.sha256);
  });
});
