/**
 * A share from opened to finished with: create, cancel, prepare, activate, invite, join,
 * decline, remove, leave, finalize.
 *
 * Most of what is asserted here is enforced by `schema.sql` rather than by the service —
 * `shares_check_root()` decides "a folder", "alive", "not already shared", and the composite
 * foreign key pins the root to the initiator's own vault. These tests exist to prove the
 * server turns each of those into an answer a caller can act on, because a refusal that
 * reaches the client as `500` is the same as no rule at all.
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

before(() => openWorld('shares-lifecycle'));
after(closeWorld);

describe('opening a share over a folder', () => {
  it('starts in preparing, because nobody may be invited before preparation is verified', async () => {
    const folder = await createNode('folder', `shared-${randomUUID()}`);
    const r = await openShare(folder);

    assert.equal(r.statusCode, 201, r.body);
    const body = r.json();
    assert.equal(body.state, 'preparing', 'not active — invite and join are refused until activation');
    assert.ok(body.share_id);
  });

  it('refuses a second share over the same folder', async () => {
    // One share per folder, `UNIQUE (initiator_vault_id, subtree_node_id)`. Without the
    // mapping this arrives as a 500 and the client cannot tell it from a server fault.
    const folder = await createNode('folder', `twice-${randomUUID()}`);
    assert.equal((await openShare(folder)).statusCode, 201);

    const again = await openShare(folder);
    assert.equal(again.statusCode, 400, again.body);
    assert.equal(again.json().error, 'invalid_write');
    assert.match(again.json().detail, /already part of share/, "the trigger's own sentence");
  });

  // "a share must be rooted at a folder, not a file" is enforced by `shares_check_root()`
  // and proved by w.db/tests.sql; asserting it here would mean building a file node with its
  // blob, upload and material rows for a rule this layer does not decide.

  it('refuses a node in a vault the caller does not own, without saying which half was wrong', async () => {
    // The composite foreign key fails; answering `not_found` keeps the endpoint from
    // reporting on another account's tree (#20).
    const folder = await createNode('folder', `mine-${randomUUID()}`);
    const r = await openShare(folder, w.strangerAccess);

    assert.equal(r.statusCode, 404, r.body);
  });

  it('checks the identifiers it is given, since all three become keys', async () => {
    const r = await w.app.inject({
      method: 'POST',
      url: '/shares',
      headers: auth(),
      payload: {
        vault_id: w.vaultId,
        node_id: w.rootId,
        subtree_key_id: 'not-a-uuid',
        wrapped_key_initiator: b64('k'),
      },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error, 'bad_subtree_key_id');
  });
});

describe('cancelling a share nobody has joined', () => {
  it('takes it straight to cancelled, with no finalization pass', async () => {
    // Legitimate precisely because no participant copy exists yet; ending a live share is
    // a different operation with a different cost.
    const folder = await createNode('folder', `cancel-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });
    assert.equal(r.statusCode, 204, r.body);

    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'cancelled');
  });

  it('says what state it is actually in when cancelling is no longer right', async () => {
    const folder = await createNode('folder', `twice-cancel-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });

    const again = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });
    assert.equal(again.statusCode, 409, again.body);
    assert.equal(again.json().error, 'share_not_preparing');
    assert.equal(again.json().state, 'cancelled', 'the state decides which operation is the right one');
  });

  it('is not something another account can do', async () => {
    const folder = await createNode('folder', `not-yours-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/cancel`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 404, 'and not 403 — a share they cannot see stays invisible');
  });
});

describe('the lists a client opens', () => {
  it('shows the initiator their own share before any member row exists', async () => {
    // They are in it: it is their folder. Waiting for a `share_members` row would leave a
    // share the initiator created invisible to them.
    const folder = await createNode('folder', `listed-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'GET', url: '/shares', headers: auth() });
    assert.equal(r.statusCode, 200);
    const mine = r.json().joined.find((s: { share_id: string }) => s.share_id === shareId);
    assert.ok(mine, 'the share is in the list');
    assert.equal(mine.is_initiator, true);
    assert.equal(mine.vault_id, w.vaultId);
  });

  it('drops a cancelled share from the list rather than showing a dead one', async () => {
    const folder = await createNode('folder', `gone-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/cancel`, headers: auth() });

    const r = await w.app.inject({ method: 'GET', url: '/shares', headers: auth() });
    assert.ok(!r.json().joined.some((s: { share_id: string }) => s.share_id === shareId));
  });

  it('lists the initiator as a member although they hold no membership row', async () => {
    const folder = await createNode('folder', `members-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    const rows = r.json() as { user_id: string; is_initiator: boolean; finalizing: boolean }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, w.userId);
    assert.equal(rows[0]!.is_initiator, true);
    assert.equal(rows[0]!.finalizing, false);
  });

  it('does not show the membership list to somebody outside the share', async () => {
    const folder = await createNode('folder', `private-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({
      method: 'GET',
      url: `/shares/${shareId}/members`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 404, 'the same answer as a share that does not exist');
  });
});

describe('activation, the one completeness check the schema cannot make', () => {
  it('opens an empty share, where there is nothing left to prepare', async () => {
    const folder = await createNode('folder', `activate-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().state, 'active');
  });

  it('refuses while an interior name is still under the vault key, and names the node', async () => {
    // The hole activation exists to close: a participant holds `KS` and nothing else, so a
    // name left under `KV` is one they could never decrypt. The gap list is the point —
    // without it the client would have to re-scan the whole subtree to find the work.
    const folder = await createNode('folder', `unprepared-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_prepared');
    assert.deepEqual(r.json().gaps, [{ nodeId: inside, missing: 'name' }]);
  });

  it('asks for a name only from nodes somebody will read — never from the trash', async () => {
    // A node can carry the share mark without ever having been prepared: the deleted
    // contents of a folder shared afterwards. Joining copies live nodes only, so nobody
    // will ever read that name, and demanding it be re-keyed would ask the client for work
    // on a node its own listings do not show — the shape of failure that stopped a
    // departure once already.
    //
    // Its BYTES are a different question and still owed: history arrives with the folder,
    // and a superseded blob is reachable whether or not its node is in the trash.
    const folder = await createNode('folder', `trash-${randomUUID()}`);
    const doomed = await createFile(folder, `gone-${randomUUID()}`, `trashed-${randomUUID()}`, w.vaultKeyId);
    const at = await w.db.one<{ rev: string }>(
      `SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.vaultId, doomed.nodeId],
    );
    const removed = await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${doomed.nodeId}`,
      headers: { ...auth(), 'if-match': at!.rev },
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const shareId = (await openShare(folder)).json().share_id;
    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 409, r.body);

    const gaps = r.json().gaps as { nodeId: string; missing: string }[];
    assert.ok(
      gaps.some((g) => g.nodeId === doomed.nodeId && g.missing === 'content'),
      'the bytes behind a trashed node are still owed an envelope',
    );
    assert.ok(
      !gaps.some((g) => g.nodeId === doomed.nodeId && g.missing === 'name'),
      'but its name is not, because nobody it is being shared with will ever see it',
    );
  });

  it('counts an envelope without its dedup tag as unprepared', async () => {
    // Two pieces of material, and a client that produced one of them is not finished. The
    // tag is asked for exactly where the plaintext is — a live head — so a file that opens
    // but cannot be recognised as a duplicate is a hole, not a nuance.
    const folder = await createNode('folder', `tagless-${randomUUID()}`);
    const file = await createFile(folder, `note-${randomUUID()}`, `tagless-${randomUUID()}`, w.vaultKeyId);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const named = {
      node_id: file.nodeId,
      name_enc: b64('note'),
      name_hmac: sha(Buffer.from('note')),
      name_key_id: ks,
    };
    // The envelope alone, which is what a client that forgot half the material sends.
    assert.equal(
      (await prepare(shareId, [{ ...named, blob_envelopes: materialFor(file.sha256, ks).blob_envelopes }])).statusCode,
      204,
    );
    const short = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(short.statusCode, 409, 'the envelope on its own does not finish the job');
    assert.deepEqual(short.json().gaps, [{ nodeId: file.nodeId, missing: 'content' }]);

    // And the tag closes it.
    assert.equal((await prepare(shareId, [{ ...named, ...materialFor(file.sha256, ks) }])).statusCode, 204);
    const ok = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('accepts once the interior name is re-keyed to the share key', async () => {
    const folder = await createNode('folder', `prepared-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const created = await openShare(folder);
    const shareId = created.json().share_id;

    // Preparation is the client's `POST /shares/{id}/prepare`, which is not built yet; the
    // effect it will have is written directly so activation can be tested on its own.
    const keyId = await w.db.one<{ id: string }>(`SELECT subtree_key_id AS id FROM shares WHERE id = $1`, [
      shareId,
    ]);
    await w.db.query(`UPDATE nodes SET name_key_id = $1 WHERE vault_id = $2 AND id = $3`, [
      keyId!.id,
      w.vaultId,
      inside,
    ]);

    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
  });

  it('is not something a second activation can do', async () => {
    const folder = await createNode('folder', `twice-active-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });

    const again = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().state, 'active');
  });
});

describe('inviting somebody', () => {
  it('puts an unanswered membership row in their list, and in the share', async () => {
    const shareId = await activeShare('invite');
    const r = await inviteTo(shareId, w.strangerId);
    assert.equal(r.statusCode, 204, r.body);

    const theirs = await w.app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const waiting = theirs.json().invitations.find((i: { share_id: string }) => i.share_id === shareId);
    assert.ok(waiting, 'it is waiting for them');
    assert.ok(waiting.initiator_login, 'and says who is asking');

    // Not in `joined`: an invitation is a decision they have not made, not a folder they hold.
    assert.ok(!theirs.json().joined.some((s: { share_id: string }) => s.share_id === shareId));

    const members = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    const row = members.json().find((m: { user_id: string }) => m.user_id === w.strangerId);
    assert.equal(row.joined_at, null, 'outstanding is joined_at being null; there is no state column');
  });

  it('refuses while the share is still preparing', async () => {
    const folder = await createNode('folder', `early-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await inviteTo(shareId, w.strangerId);
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_active');
    assert.equal(r.json().state, 'preparing');
  });

  it('answers an unknown account exactly as it answers one already invited', async () => {
    // Deliberate: two different situations, one answer. Telling them apart would say
    // whether a login exists, which is the oracle #73 closed on /auth/kdf.
    const shareId = await activeShare('oracle');
    assert.equal((await inviteTo(shareId, w.strangerId)).statusCode, 204);

    const twice = await inviteTo(shareId, w.strangerId);
    const nobody = await inviteTo(shareId, randomUUID());

    assert.equal(twice.statusCode, 409);
    assert.equal(nobody.statusCode, 409);
    assert.deepEqual(twice.json(), nobody.json(), 'the same answer, byte for byte');
  });

  it('is the initiator’s to do and nobody else’s', async () => {
    const shareId = await activeShare('not-yours');
    const r = await inviteTo(shareId, w.strangerId, w.strangerAccess);
    assert.equal(r.statusCode, 404, 'a share they are not in stays invisible');
  });
});

describe('an invitation nobody accepted', () => {
  it('vanishes when declined, leaving nothing behind', async () => {
    const shareId = await activeShare('decline');
    await inviteTo(shareId, w.strangerId);

    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 204, r.body);

    // Absence IS the record. There is no declined state to read, by design.
    const members = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    assert.ok(!members.json().some((m: { user_id: string }) => m.user_id === w.strangerId));

    const rows = await w.db.query(`SELECT 1 FROM share_members WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      w.strangerId,
    ]);
    assert.equal(rows.length, 0, 'the row is deleted, not marked');
  });

  it('frees its slot at once, so the same person can be invited again', async () => {
    const shareId = await activeShare('reinvite');
    await inviteTo(shareId, w.strangerId);
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });

    assert.equal((await inviteTo(shareId, w.strangerId)).statusCode, 204, 'the slot came back');
  });

  it('is withdrawn by the initiator the same way, from the other side', async () => {
    const shareId = await activeShare('withdraw');
    await inviteTo(shareId, w.strangerId);

    const r = await w.app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${w.strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'withdrawn', 'not "revoked" — there is no replica to finalize');

    const rows = await w.db.query(`SELECT 1 FROM share_members WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      w.strangerId,
    ]);
    assert.equal(rows.length, 0);
  });

  it('cannot be declined by somebody who was never invited', async () => {
    const shareId = await activeShare('uninvited');
    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/decline`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 404);
  });
});

describe('removing a member', () => {
  it('revokes rather than withdraws once they have joined, and stops propagation now', async () => {
    // Joining is not built yet, so the row is put in the state joining will leave it in.
    // What is asserted is the branch: a joined member is revoked, and revocation is only
    // begun here — their client finalizes the copy it alone holds the keys for.
    const shareId = await activeShare('revoke');
    await inviteTo(shareId, w.strangerId);
    await w.db.query(`UPDATE share_members SET joined_at = now(), vault_id = $3 WHERE share_id = $1 AND user_id = $2`, [
      shareId,
      w.strangerId,
      w.strangerVaultId,
    ]);

    const r = await w.app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${w.strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'revoked');

    const row = await w.db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.strangerId],
    );
    assert.ok(row!.started, 'propagation stopped');
    assert.equal(row!.left, null, 'but they have not left: that needs their own metadata pass');

    const members = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/members`, headers: auth() });
    const them = members.json().find((m: { user_id: string }) => m.user_id === w.strangerId);
    assert.equal(them.finalizing, true, 'and the list says so');
  });

  it('refuses to remove the initiator, because that is ending the share', async () => {
    const shareId = await activeShare('self');
    const r = await w.app.inject({ method: 'DELETE', url: `/shares/${shareId}/members/${w.userId}`, headers: auth() });

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'initiator_cannot_be_removed');
  });
});

describe('preparing a subtree for its share key', () => {
  it('re-keys an interior name, and activation then has nothing to complain about', async () => {
    // The two halves of one job, in sequence: the client converts, the server verifies.
    // Neither is much use alone, which is why this asserts the pair rather than the write.
    const folder = await createNode('folder', `prep-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const blocked = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(blocked.statusCode, 409, 'unprepared to begin with');

    const r = await prepare(shareId, [
      { node_id: inside, name_enc: b64('under KS'), name_hmac: sha(Buffer.from('under KS')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 204, r.body);

    const ok = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('names the versions behind each head, which no listing the client keeps would show', async () => {
    // The mirror of what stopped a departure. A folder edited before it is shared carries
    // versions under KV alone, and activation wants a KS envelope for every one of them —
    // while the client's own tree holds only the head of each file. Left to guess, it
    // prepares the head, is refused, and has nothing to look at to find out why.
    const folder = await createNode('folder', `prep-history-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    // Unique content per test: a blob is addressed by its bytes, so two tests writing
    // 'first' share one blob — and one of them giving it KV material would quietly answer
    // the other's question.
    const body = randomUUID();
    const file = await createFile(inside, `note-${randomUUID()}`, `${body}-1`, w.vaultKeyId);
    const superseded = file.sha256;
    await putFile(file, `${body}-2`);

    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const owed = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/preparation`, headers: auth() });
    assert.equal(owed.statusCode, 200, owed.body);
    const rows = owed.json() as { node_id: string; history_needing_material: string[] }[];
    assert.ok(!rows.some((n) => n.node_id === folder), 'the root is not preparation’s business (SH-01)');
    const entry = rows.find((n) => n.node_id === file.nodeId);
    assert.deepEqual(entry!.history_needing_material, [superseded], 'the version behind the head is named');

    const named = (id: string) => ({
      node_id: id,
      name_enc: b64(`ks-${id}`),
      name_hmac: sha(Buffer.from(`ks-${id}`)),
      name_key_id: ks,
    });

    // The head alone, exactly as a client that trusted its own tree would send it.
    assert.equal((await prepare(shareId, [named(inside), { ...named(file.nodeId), ...materialFor(file.sha256, ks) }])).statusCode, 204);
    const short = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(short.statusCode, 409, 'and activation refuses, because the history stays unreadable');

    assert.equal(
      (
        await prepare(shareId, [
          {
            ...named(file.nodeId),
            blob_envelopes: [
              { sha256: superseded, scope_id: ks, wrapped_key: Buffer.alloc(48, 9).toString('base64') },
            ],
          },
        ])
      ).statusCode,
      204,
    );
    const ok = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });
    assert.equal(ok.statusCode, 200, ok.body);
  });

  it('applies the same batch twice without complaint, because a lost response is not a fault', async () => {
    // Batches are resumable (docs/04) and nothing records which ones landed: a client that
    // did not hear the answer resends, and `activate` recomputes what is still missing.
    const folder = await createNode('folder', `resume-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);
    const item = {
      node_id: inside,
      name_enc: b64('under KS'),
      name_hmac: sha(Buffer.from('under KS')),
      name_key_id: ks,
    };

    assert.equal((await prepare(shareId, [item])).statusCode, 204);
    assert.equal((await prepare(shareId, [item])).statusCode, 204, 'a repeat changes nothing and is not an error');
  });

  it('refuses a scope that is not this share’s', async () => {
    // It would produce names no participant could read, and activation would then refuse
    // the share for a reason the client had just created.
    const folder = await createNode('folder', `wrongkey-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await prepare(shareId, [
      { node_id: inside, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: w.vaultKeyId },
    ]);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /key scope/);
  });

  it('refuses a node outside the share rather than skipping it', async () => {
    // Skipping would be the worse failure: activate would later report the item as missing
    // and send the client back to prepare something it believes it already prepared.
    const folder = await createNode('folder', `outside-${randomUUID()}`);
    const elsewhere = await createNode('folder', `elsewhere-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(shareId, [
      { node_id: elsewhere, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 400, r.body);
    assert.match(r.json().detail, /not a live interior node/);
  });

  it('will not prepare the share root, whose label stays under the vault key', async () => {
    // SH-01/SH-25: the root sits beside private siblings, and a participant names their own
    // copy's root when they join. `ancestry` excludes the node itself, so this is refused
    // by the same condition that keeps outsiders out.
    const folder = await createNode('folder', `root-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(shareId, [
      { node_id: folder, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);
    assert.equal(r.statusCode, 400, r.body);
  });

  it('stops once the share is active, when a name change is an ordinary write', async () => {
    const shareId = await activeShare('late-prep');
    const ks = await shareKeyOf(shareId);
    const r = await prepare(shareId, [
      { node_id: randomUUID(), name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks },
    ]);

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_preparing');
  });

  it('is the initiator’s to do', async () => {
    const folder = await createNode('folder', `whose-${randomUUID()}`);
    const inside = await createNode('folder', `interior-${randomUUID()}`, folder);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await prepare(
      shareId,
      [{ node_id: inside, name_enc: b64('x'), name_hmac: sha(Buffer.from('x')), name_key_id: ks }],
      w.strangerAccess,
    );
    assert.equal(r.statusCode, 404);
  });

  it('wants something to do', async () => {
    const folder = await createNode('folder', `empty-batch-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    assert.equal((await prepare(shareId, [])).statusCode, 400);
  });
});

describe('accepting an invitation', () => {
  it('materialises a copy in the joiner’s own vault, under the folder they chose', async () => {
    const { shareId } = await invitedShare('join');
    const r = await join(shareId);

    assert.equal(r.statusCode, 201, r.body);
    const rootNodeId = r.json().root_node_id;

    const replica = await w.db.one<{ vaultId: string; parentId: string; shareId: string }>(
      `SELECT vault_id AS "vaultId", parent_id AS "parentId", share_id AS "shareId"
         FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, rootNodeId],
    );
    assert.equal(replica!.vaultId, w.strangerVaultId, 'their vault, not the initiator’s');
    assert.equal(replica!.parentId, await strangerRoot());
    assert.equal(replica!.shareId, shareId);
  });

  it('gives corresponding nodes the same share_item_id, which is how two copies are one item', async () => {
    // Neither participant can see the other's node ids, so this is the only handle that
    // says "your file and mine are the same file".
    const { shareId, folder, inside } = await invitedShare('items');
    const rootNodeId = (await join(shareId)).json().root_node_id;

    const pairs = await w.db.query<{ src: string; dst: string }>(
      `SELECT a.id AS src, b.id AS dst
         FROM nodes a JOIN nodes b ON b.share_item_id = a.share_item_id AND b.vault_id = $3
        WHERE a.vault_id = $1 AND a.id = ANY($2::uuid[])`,
      [w.vaultId, [folder, inside], w.strangerVaultId],
    );
    assert.equal(pairs.length, 2, 'both the root and the interior folder have a counterpart');
    assert.ok(pairs.some((p) => p.src === folder && p.dst === rootNodeId));
  });

  it('names the replica root itself, and copies interior names untouched', async () => {
    // The root sits among their private folders and is theirs to call anything; the
    // interior is already under KS, which their envelope opens.
    const { shareId, inside, ks } = await invitedShare('names');
    const rootNodeId = (await join(shareId, 'my copy')).json().root_node_id;

    const root = await w.db.one<{ nameEnc: string; keyId: string }>(
      `SELECT encode(name_enc,'base64') AS "nameEnc", name_key_id AS "keyId"
         FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.strangerVaultId, rootNodeId],
    );
    assert.equal(Buffer.from(root!.nameEnc, 'base64').toString(), 'my copy');
    assert.equal(root!.keyId, await strangerVaultKey(), 'the root label is under THEIR vault key');

    const copy = await w.db.one<{ nameEnc: string; keyId: string }>(
      `SELECT encode(n.name_enc,'base64') AS "nameEnc", n.name_key_id AS "keyId"
         FROM nodes n JOIN nodes src ON src.share_item_id = n.share_item_id
        WHERE n.vault_id = $1 AND src.vault_id = $2 AND src.id = $3`,
      [w.strangerVaultId, w.vaultId, inside],
    );
    assert.equal(copy!.keyId, ks, 'the interior stays under the share key');
    assert.equal(Buffer.from(copy!.nameEnc, 'base64').toString(), 'interior', 'byte for byte');
  });

  it('puts the replica in the joiner’s journal, so their other devices learn about it', async () => {
    const { shareId } = await invitedShare('journal');
    const rootNodeId = (await join(shareId)).json().root_node_id;

    const entry = await w.db.one<{ op: string }>(
      `SELECT op::text AS op FROM journal WHERE vault_id = $1 AND node_id = $2`,
      [w.strangerVaultId, rootNodeId],
    );
    assert.equal(entry!.op, 'put', 'a replica arrives as an ordinary change, not out of band');
  });

  it('marks them joined, in the vault they were running in', async () => {
    const { shareId } = await invitedShare('member');
    await join(shareId);

    const row = await w.db.one<{ joined: string | null; vaultId: string }>(
      `SELECT joined_at AS joined, vault_id AS "vaultId" FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.strangerId],
    );
    assert.ok(row!.joined);
    assert.equal(row!.vaultId, w.strangerVaultId, 'observed from the request, never asked of the user');

    // And it moves from their invitations to the folders they hold.
    const lists = await w.app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.ok(lists.json().joined.some((s: { share_id: string }) => s.share_id === shareId));
    assert.ok(!lists.json().invitations.some((s: { share_id: string }) => s.share_id === shareId));
  });

  it('does not charge the joiner for bytes they already hold', async () => {
    // Content is stored once and `user_blobs` is a claim on it, not a copy — so a folder of
    // files this account already has costs nothing to join (#46).
    //
    // Asserted with **no room to spare**, and that is the whole point of the test. The
    // accounting asks one question of every distinct blob in the subtree at once, and a
    // version of it that matched nothing would still let an ordinary join through: it would
    // merely over-count, and a roomy quota hides over-counting completely. A quota set to
    // exactly what they use is the only condition that tells the two apart.
    const { shareId, inside, ks } = await invitedShare('held');
    const body = `both-copies-${randomUUID()}`;
    const bytes = Buffer.from(body);
    await createFile(inside, `note-${randomUUID()}`, body, ks);

    // The same bytes in the joiner's own vault. A blob is its content, so both sides address
    // it identically — which is what "already held" means here.
    const theirKey = await strangerVaultKey();
    const hex = sha(bytes);
    const theirAuth = { authorization: `Bearer ${w.strangerAccess}` };
    const uploaded = await w.app.inject({
      method: 'POST',
      url: '/blobs',
      query: { sha256: hex, size: String(bytes.length), key_id: theirKey },
      headers: { ...theirAuth, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);

    const theirName = `mine-${randomUUID()}`;
    const created = await w.app.inject({
      method: 'POST',
      url: `/vaults/${w.strangerVaultId}/nodes`,
      headers: theirAuth,
      payload: {
        parent_id: await strangerRoot(), type: 'file', sha256: hex, size: bytes.length,
        mtime: new Date().toISOString(),
        name_enc: b64(theirName), name_hmac: sha(Buffer.from(theirName)), name_key_id: theirKey,
        ...materialFor(hex, theirKey),
      },
    });
    assert.equal(created.statusCode, 201, created.body);

    const before = await w.db.one<{ used: string; quota: string }>(
      `SELECT COALESCE(SUM(b.size), 0)::text AS used, u.quota_bytes::text AS quota
         FROM users u
         LEFT JOIN user_blobs ub ON ub.user_id = u.id
         LEFT JOIN blobs b ON b.sha256 = ub.sha256
        WHERE u.id = $1 GROUP BY u.id`,
      [w.strangerId],
    );
    await w.db.query(`UPDATE users SET quota_bytes = $2 WHERE id = $1`, [w.strangerId, before!.used]);
    try {
      const joined = await join(shareId);
      assert.equal(joined.statusCode, 201, joined.body);
    } finally {
      // Restored, because the world is shared with every test after this one and a quota
      // left at the brim would refuse them for a reason that has nothing to do with them.
      await w.db.query(`UPDATE users SET quota_bytes = $2 WHERE id = $1`, [w.strangerId, before!.quota]);
    }
  });

  it('is redeemed once: a second acceptance finds nothing outstanding', async () => {
    const { shareId } = await invitedShare('once');
    assert.equal((await join(shareId)).statusCode, 201);

    const again = await join(shareId);
    assert.equal(again.statusCode, 404, 'the invitation is spent, not repeatable from another vault either');
  });

  it('refuses somebody who was never invited', async () => {
    const folder = await createNode('folder', `uninvited-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/activate`, headers: auth() });

    assert.equal((await join(shareId)).statusCode, 404);
  });

  it('refuses a destination folder that is not the joiner’s', async () => {
    const { shareId } = await invitedShare('elsewhere');
    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/join`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
      payload: {
        vault_id: w.vaultId, // the INITIATOR's vault
        parent_id: w.rootId,
        name_enc: b64('x'),
        name_hmac: sha(Buffer.from('x')),
        name_key_id: await strangerVaultKey(),
      },
    });
    assert.equal(r.statusCode, 404, r.body);
  });

  it('leaves nothing behind when it refuses', async () => {
    // One transaction: a join that fails must not leave a half-materialised folder, which
    // would be worse than no folder at all — the user would see files that sync nowhere.
    const { shareId } = await invitedShare('atomic');
    const before = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.strangerVaultId]);

    const r = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/join`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
      payload: {
        vault_id: w.strangerVaultId,
        parent_id: randomUUID(), // no such folder
        name_enc: b64('x'),
        name_hmac: sha(Buffer.from('x')),
        name_key_id: await strangerVaultKey(),
      },
    });
    assert.equal(r.statusCode, 404);

    const after = await w.db.query(`SELECT 1 FROM nodes WHERE vault_id = $1`, [w.strangerVaultId]);
    assert.equal(after.length, before.length, 'no partial replica');

    const row = await w.db.one<{ joined: string | null }>(
      `SELECT joined_at AS joined FROM share_members WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.strangerId],
    );
    assert.equal(row!.joined, null, 'and the invitation is still outstanding');
  });

  it('refuses while the share is not active', async () => {
    const folder = await createNode('folder', `inactive-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const r = await join(shareId);

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'share_not_active');
  });
});

describe('leaving', () => {
  it('stops propagation at once, before anything is converted', async () => {
    // finalization_started_at IS the stop: the fan-out set excludes it the moment it is
    // written, long before the client has converted anything. That exclusion is proved
    // against a live write by the revocation test above; what matters here is that leaving
    // writes the mark immediately rather than at the end of the pass.
    const { shareId } = await sharedWith('leave-stops');
    assert.equal((await leaveBegin(shareId)).statusCode, 200);

    const row = await w.db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.strangerId],
    );
    assert.ok(row!.started, 'propagation stopped');
    assert.equal(row!.left, null, 'and nothing is converted yet — that is the client’s pass');
  });

  it('ends the share when the last other participant goes', async () => {
    // SH-07: a departure, never a head count. With only the initiator left there is nobody
    // to share with.
    const { shareId } = await sharedWith('leave-ends');
    const r = await leaveBegin(shareId);

    assert.equal(r.json().ended, true);
    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'ended');
  });

  it('ends it for everybody when the initiator goes', async () => {
    // SH-17: "the initiator leaves" and "the share is dissolved" are one operation, and
    // every remaining member is put into finalization by it.
    const { shareId } = await sharedWith('initiator-leaves');
    const r = await leaveBegin(shareId, w.access);
    assert.equal(r.json().ended, true);

    const rows = await w.db.query<{ started: string | null }>(
      `SELECT finalization_started_at AS started FROM share_members WHERE share_id = $1`,
      [shareId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((m) => m.started), 'both sides are finalizing, each on their own client');
  });

  it('does not end a share that still has somebody in it', async () => {
    const { shareId } = await sharedWith('two-left');
    const third = await makeAccount('shares-third');
    await w.db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
       SELECT $1, $2, v.id, now(), '\\x01' FROM vaults v WHERE v.user_id = $2 LIMIT 1`,
      [shareId, third.id],
    ).catch(() => undefined);

    // The third account has no vault, so seed one and try again through the API path.
    const theirVault = randomUUID();
    await w.app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${third.access}` },
      payload: { id: theirVault, name_enc: b64('third vault') },
    });
    await w.db.query(
      `INSERT INTO share_members (share_id, user_id, vault_id, joined_at, wrapped_key)
            VALUES ($1, $2, $3, now(), '\\x01')
       ON CONFLICT (share_id, user_id) DO UPDATE SET joined_at = now(), vault_id = $3`,
      [shareId, third.id, theirVault],
    );

    const r = await leaveBegin(shareId);
    assert.equal(r.json().ended, false, 'somebody else is still in it');
  });

  it('can be begun twice, because the second call is a client coming back', async () => {
    // This asserted a refusal until a live vault got stuck between the two steps. The pass
    // that converts the replica is the client's, so a device interrupted after `begin` has
    // to be able to return — refusing it left the vault unreadable for good.
    const { shareId } = await sharedWith('twice-leave');
    assert.equal((await leaveBegin(shareId)).statusCode, 200);

    const again = await leaveBegin(shareId);
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().ended, true, 'and it reports the state as it now is');
  });
});

describe('finalizing a departure', () => {
  it('refuses a pass that leaves part of the replica converted', async () => {
    // The failure it prevents is silent and permanent: a folder whose files the owner can
    // no longer open, discovered long after the share is gone.
    const { shareId } = await sharedWith('partial');
    await leaveBegin(shareId);

    const all = await theirReplicaNodes(shareId);
    const r = await finalize(shareId, all.slice(1));

    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'finalization_incomplete');
    assert.ok(r.json().missing.length > 0, 'and it says which nodes are missing');
  });

  it('converts the replica to private files and records the departure', async () => {
    const { shareId } = await sharedWith('finalize');
    await leaveBegin(shareId);
    const r = await finalize(shareId, await theirReplicaNodes(shareId));
    assert.equal(r.statusCode, 204, r.body);

    const left = await w.db.query(
      `SELECT 1 FROM nodes WHERE vault_id = $1 AND share_id = $2`,
      [w.strangerVaultId, shareId],
    );
    assert.equal(left.length, 0, 'nothing still carries the share mark');

    const member = await w.db.one<{ left: string | null }>(
      `SELECT left_at AS left FROM share_members WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.strangerId],
    );
    assert.ok(member!.left, 'and the departure is recorded only now');
  });

  it('keeps the files: leaving a share leaves you with your copy (SH-05)', async () => {
    const { shareId, replicaRoot } = await sharedWith('keeps');
    await leaveBegin(shareId);
    await finalize(shareId, await theirReplicaNodes(shareId));

    const still = await w.db.one<{ id: string; keyId: string }>(
      `SELECT id, name_key_id AS "keyId" FROM nodes WHERE vault_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [w.strangerVaultId, replicaRoot],
    );
    assert.ok(still, 'the folder is still theirs');
    assert.equal(still!.keyId, await strangerVaultKey(), 'and everything is back under their own key');
  });

  it('is refused before finalization has been begun', async () => {
    const { shareId } = await sharedWith('too-early');
    const r = await finalize(shareId, await theirReplicaNodes(shareId));
    assert.equal(r.statusCode, 404, 'nothing to finalize yet');
  });
});

describe('a departure ends a share whichever door it came through', () => {
  it('ends the share when the initiator revokes the last participant', async () => {
    // SH-22: leaving and being revoked are the same state, so SH-07's "the last one out
    // ends it" has to hold for both. It held only for leaving — revoking the last
    // participant left the share active with nobody in it but the initiator.
    const { shareId } = await sharedWith('revoke-last');

    const r = await w.app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${w.strangerId}`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().outcome, 'revoked');
    assert.equal(r.json().ended, true, 'and the caller is told, because it changes what they say');

    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'ended');
  });

  it('puts the initiator into finalization too when a revoke ends it', async () => {
    // Ending is not something one member does to another: everybody's copy has to come
    // back to KV, the initiator's included.
    const { shareId } = await sharedWith('revoke-ends-all');
    await w.app.inject({ method: 'DELETE', url: `/shares/${shareId}/members/${w.strangerId}`, headers: auth() });

    const rows = await w.db.query<{ started: string | null }>(
      `SELECT finalization_started_at AS started FROM share_members WHERE share_id = $1`,
      [shareId],
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((m) => m.started), 'both sides finalize, each on their own client');
  });

  it('does not end it while somebody else is still in', async () => {
    const { shareId } = await sharedWith('revoke-not-last');
    const third = await makeAccount('shares-revoke-third');
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
    assert.equal(r.json().ended, false);

    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'active', 'the share carries on for the one who is left');
  });

  it('withdrawing an invitation is not a departure and ends nothing', async () => {
    // Nobody joined, so nobody left. The slot simply comes back.
    const { shareId } = await invitedShare('withdraw-not-departure');
    const r = await w.app.inject({
      method: 'DELETE',
      url: `/shares/${shareId}/members/${w.strangerId}`,
      headers: auth(),
    });

    assert.equal(r.json().outcome, 'withdrawn');
    assert.equal(r.json().ended, undefined, 'there is no departure to report');

    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'active');
  });
});

describe('finishing a departure that was interrupted', () => {
  it('keeps offering the share key while the pass is still owed', async () => {
    // The deadlock this closes: an ended share still has a replica named under KS until its
    // owner converts it back, and that conversion needs this key. Withholding it because
    // the share is over locks the vault out of both — it cannot read the names, so it
    // cannot sync, and it cannot convert them, so it never will.
    const { shareId } = await sharedWith('key-after-end');
    const ks = await shareKeyOf(shareId);
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'the key the finalization pass needs is still there',
    );
  });

  it('lets a client come back and begin again, rather than refusing', async () => {
    // A device interrupted between begin and finalize has to be able to return. Refusing
    // the second begin left it with no way to finish at all.
    const { shareId } = await sharedWith('begin-twice');
    const first = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(first.statusCode, 200);

    const again = await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().ended, true, 'and it says the share is over, which it is');
  });

  it('stops offering the key once the pass has run', async () => {
    const { shareId } = await sharedWith('key-after-finalize');
    const ks = await shareKeyOf(shareId);
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const nodes = await w.db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [w.strangerVaultId, shareId],
    );
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
      url: `/vaults/${w.strangerVaultId}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.ok(!r.json().scopes.some((s: { key_id: string }) => s.key_id === ks), 'nothing is named under it now');
  });
});

describe('leaving a share that never got off the ground', () => {
  it('cancels it rather than ending it, which the schema does not allow', async () => {
    // A 500 in a live vault: departMember wrote `ended` unconditionally, and `preparing`
    // may go only to `cancelled`. The share could not be left, and had no other way out
    // either — cancelling has no button.
    const folder = await createNode('folder', `leave-preparing-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;

    const r = await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().ended, true, 'it is over, whichever word the state uses');

    const state = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(state!.state, 'cancelled');
  });

  it('still hands the replica back, so its names can return to the vault key', async () => {
    // The point of going through leave rather than a bare state change: the initiator's
    // client owes the same conversion pass, and it needs the key to run it.
    const folder = await createNode('folder', `leave-preparing-keys-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const member = await w.db.one<{ started: string | null; left: string | null }>(
      `SELECT finalization_started_at AS started, left_at AS left FROM share_members
        WHERE share_id = $1 AND user_id = $2`,
      [shareId, w.userId],
    );
    assert.ok(member!.started, 'the pass is owed');
    assert.equal(member!.left, null, 'and not yet run');

    const r = await w.app.inject({ method: 'GET', url: `/vaults/${w.vaultId}`, headers: auth() });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'so the key it needs is still offered',
    );
  });
});

describe('what a share is over, and how long it stays visible', () => {
  it('marks the trash as well, because the schema refuses a subtree marked in part', async () => {
    // I tried the opposite first and the schema said no: a node inside a shared folder whose
    // child carries a different mark or none is "incompletely shared", with no exception for
    // a deleted child. So a trashed node joins the share UNPREPARED — preparation only
    // re-keys what is live, so its name stays under KV — and leaving has to cope with that
    // rather than the share pretending it is not there.
    const folder = await createNode('folder', `trash-marked-too-${randomUUID()}`);
    const doomed = await createNode('folder', `gone-${randomUUID()}`, folder);
    const rev = await w.db.one<{ rev: string }>(`SELECT rev::text AS rev FROM nodes WHERE vault_id = $1 AND id = $2`, [
      w.vaultId,
      doomed,
    ]);
    const removed = await w.app.inject({
      method: 'DELETE',
      url: `/vaults/${w.vaultId}/nodes/${doomed}`,
      headers: { ...auth(), 'if-match': rev!.rev },
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const opened = await openShare(folder);
    assert.equal(opened.statusCode, 201, opened.body);
    const shareId = opened.json().share_id;
    const ks = await shareKeyOf(shareId);

    const marked = await w.db.one<{ share: string | null; keyId: string | null }>(
      `SELECT share_id AS share, name_key_id AS "keyId" FROM nodes WHERE vault_id = $1 AND id = $2`,
      [w.vaultId, doomed],
    );
    assert.equal(marked!.share, shareId, 'the trashed node carries the share');
    assert.notEqual(marked!.keyId, ks, 'and is NOT under the share key: nothing prepared it');

    // Which the replica listing has to report, so a departure can tell the two apart:
    // convert what was converted, and only clear the mark on what was not.
    const r = await w.app.inject({ method: 'GET', url: `/shares/${shareId}/replica`, headers: auth() });
    const entry = (r.json() as { node_id: string; name_key_id: string }[]).find((n) => n.node_id === doomed);
    assert.ok(entry, 'it is in the set the pass must cover');
    assert.notEqual(entry!.name_key_id, ks);
  });

  it('keeps an ended share in the list while its pass is still owed', async () => {
    // Hiding it left the marks in place and no button to clear them: the screen went quiet
    // and the replica stayed half-converted for good. `left_at` is what removes a share from
    // somebody's life, and the pass writes it — not the ending.
    const { shareId } = await sharedWith('listed-after-end');
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });

    const r = await w.app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const row = r.json().joined.find((s: { share_id: string }) => s.share_id === shareId);
    assert.ok(row, 'still listed, so the pass can still be run');
    assert.equal(row.state, 'ended', 'and it says what state it is in');
  });

  it('drops it once the pass has run', async () => {
    const { shareId } = await sharedWith('unlisted-after-pass');
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const nodes = await w.db.query<{ id: string }>(`SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2`, [
      w.strangerVaultId,
      shareId,
    ]);
    const keyId = await strangerVaultKey();
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
      payload: {
        nodes: nodes.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: keyId,
        })),
      },
    });

    const r = await w.app.inject({
      method: 'GET',
      url: '/shares',
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.ok(!r.json().joined.some((s: { share_id: string }) => s.share_id === shareId));
  });
});

describe('sharing a folder again after the first one is over', () => {
  it('is allowed, because a share holds its folder only while it lives (SH-08)', async () => {
    // A plain UNIQUE kept the slot for ever, so a folder shared once could never be shared
    // again — while the design says re-sharing starts from scratch. Found by doing exactly
    // this on a live vault and getting `duplicate key value violates unique constraint`.
    const folder = await createNode('folder', `reshare-${randomUUID()}`);
    const first = (await openShare(folder)).json().share_id;

    await w.app.inject({ method: 'POST', url: `/shares/${first}/leave/begin`, headers: auth() });
    const nodes = await w.db.query<{ id: string }>(`SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2`, [
      w.vaultId,
      first,
    ]);
    await w.app.inject({
      method: 'POST',
      url: `/shares/${first}/finalize-leave`,
      headers: auth(),
      payload: {
        nodes: nodes.map((n) => ({
          node_id: n.id,
          name_enc: b64(`kv-${n.id}`),
          name_hmac: sha(Buffer.from(`kv-${n.id}`)),
          name_key_id: w.vaultKeyId,
        })),
      },
    });

    const again = await openShare(folder);
    assert.equal(again.statusCode, 201, again.body);
    assert.notEqual(again.json().share_id, first, 'a new share, with no reference to the old one');
  });

  it('still refuses a second LIVE share over the same folder', async () => {
    const folder = await createNode('folder', `two-live-${randomUUID()}`);
    assert.equal((await openShare(folder)).statusCode, 201);

    const again = await openShare(folder);
    assert.equal(again.statusCode, 400, again.body);
    assert.match(again.json().detail, /already part of share/);
  });

  it('keeps the finished share on record, because participants keep their copies', async () => {
    // Terminal rows are not swept: an offline device still has to learn the share ended, and
    // the history of who wrote what does not stop being true.
    const folder = await createNode('folder', `record-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    await w.app.inject({ method: 'POST', url: `/shares/${shareId}/leave/begin`, headers: auth() });

    const still = await w.db.one<{ state: string }>(`SELECT state::text AS state FROM shares WHERE id = $1`, [
      shareId,
    ]);
    assert.equal(still!.state, 'cancelled', 'the row is still there');
  });
});
