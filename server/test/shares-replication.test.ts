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
        WHERE vault_id = $1 AND node_id = $2 ORDER BY rev`,
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
      !(trash.json() as { node_id: string }[]).some((t) => t.node_id === doomed),
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
