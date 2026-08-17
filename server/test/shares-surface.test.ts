/**
 * What the share domain shows to the rest of the server: the key scopes a vault reports, the
 * account states a delta carries, and the public key an invitation is sealed to.
 *
 * Read by other route families, which is why they have their own module on the server side —
 * and why they have their own suite here.
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

before(() => openWorld('shares-surface'));
after(closeWorld);

describe('the keys a client needs to read a vault', () => {
  it('gives the initiator their own share key, wrapped under the vault key', async () => {
    // Without this a restart leaves a client able to see shared nodes and unable to name
    // them: the interior is under KS, and KS reaches a device only wrapped.
    const folder = await createNode('folder', `scopes-${randomUUID()}`);
    const created = await openShare(folder);
    const shareId = created.json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await w.app.inject({ method: 'GET', url: `/vaults/${w.vaultId}`, headers: auth() });
    assert.equal(r.statusCode, 200, r.body);
    const scope = r.json().scopes.find((s: { key_id: string }) => s.key_id === ks);

    assert.ok(scope, 'the share scope is reported');
    assert.equal(scope.scope, 'share');
    assert.equal(scope.share_id, shareId);
    assert.equal(scope.wrapping, 'vault', 'theirs is a wrap, not an envelope — it needed no delivery');
    assert.ok(scope.wrapped_key);
  });

  it('gives a participant theirs as an account envelope instead', async () => {
    // Different row, different wrapping, and the client cannot guess which: the two are
    // opened with different keys entirely.
    const { shareId } = await sharedWith('scopes-member');
    const ks = await shareKeyOf(shareId);

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const scope = r.json().scopes.find((s: { key_id: string }) => s.key_id === ks);

    assert.ok(scope, 'the participant is told about the scope their replica is named under');
    assert.equal(scope.wrapping, 'account');
  });

  it('says nothing about a share the caller is not in', async () => {
    const folder = await createNode('folder', `private-scope-${randomUUID()}`);
    const shareId = (await openShare(folder)).json().share_id;
    const ks = await shareKeyOf(shareId);

    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${w.strangerVaultId}`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.ok(!r.json().scopes.some((s: { key_id: string }) => s.key_id === ks));
  });

  it('keeps reporting it after the share is over, until the pass has run', async () => {
    // This asserted the opposite until a live vault stopped syncing. An ended share still
    // has a replica named under KS, and converting it back needs this key — so the share
    // being over is exactly the wrong moment to withhold it. `left_at` is what ends it, and
    // `left_at` is what the finalization pass writes.
    const { shareId } = await sharedWith('scopes-ended');
    const ks = await shareKeyOf(shareId);
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });

    const r = await w.app.inject({ method: 'GET', url: `/vaults/${w.vaultId}`, headers: auth() });
    assert.ok(
      r.json().scopes.some((s: { key_id: string }) => s.key_id === ks),
      'the initiator still owes the same pass, and still needs the key',
    );
  });

  it('still reports the vault’s own scope first, which everything else defaults to', async () => {
    const r = await w.app.inject({ method: 'GET', url: `/vaults/${w.vaultId}`, headers: auth() });
    assert.equal(r.json().scopes[0].scope, 'vault');
    assert.equal(r.json().scopes[0].key_id, w.vaultKeyId);
  });
});

describe('the states the delta carries', () => {
  /** The events of this account's own vault, as a sync would meet them. */
  const eventsOf = async (token = w.access, vault = w.vaultId) => {
    const r = await w.app.inject({
      method: 'GET',
      url: `/vaults/${vault}/delta`,
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().events as { type: string; share_id?: string; at: string }[];
  };

  it('says nothing to an account with nothing true of it', async () => {
    // A fresh account, because this suite's own vault accumulates ended shares — which is
    // itself the point: the events are about what is true NOW, per account.
    const fresh = await makeAccount('events-quiet');
    const theirVault = randomUUID();
    await w.app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { authorization: `Bearer ${fresh.access}` },
      payload: { id: theirVault, name_enc: b64('quiet vault') },
    });

    assert.deepEqual(await eventsOf(fresh.access, theirVault), []);
  });

  it('tells a member their share ended, and keeps telling them until they finalize', async () => {
    // The prompt IS the reminder that a metadata pass is owed. Delivered once and lost, a
    // device that was offline would never learn its replica has to come back to KV.
    const { shareId } = await sharedWith('event-ended');
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });

    const mine = (list: { type: string; share_id?: string }[]) =>
      list.some((e) => e.type === 'share_ended' && e.share_id === shareId);

    assert.ok(mine(await eventsOf(w.strangerAccess, w.strangerVaultId)), 'the participant is told');
    assert.ok(mine(await eventsOf(w.strangerAccess, w.strangerVaultId)), 'and again, because the pass is still owed');
  });

  it('stops once the replica has been converted back', async () => {
    const { shareId } = await sharedWith('event-finalized');
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/leave/begin`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    const nodes = await w.db.query<{ id: string }>(
      `SELECT id FROM nodes WHERE vault_id = $1 AND share_id = $2 AND deleted_at IS NULL`,
      [w.strangerVaultId, shareId],
    );
    const keyId = await strangerVaultKey();
    await w.app.inject({
      method: 'POST',
      url: `/shares/${shareId}/finalize-leave`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
      payload: {
        nodes: nodes.map((n) => ({
          node_id: n.id,
          name_enc: b64(`back-${n.id}`),
          name_hmac: sha(Buffer.from(`back-${n.id}`)),
          name_key_id: keyId,
        })),
      },
    });

    const after = await eventsOf(w.strangerAccess, w.strangerVaultId);
    assert.ok(
      !after.some((e) => e.type === 'share_ended' && e.share_id === shareId),
      'left_at is what stops it',
    );
  });

  it('tells a frozen account it is frozen, which nothing else does', async () => {
    // Before this the only way to learn was to be refused a write — a state discovered by
    // bumping into it.
    await w.db.query(`UPDATE users SET frozen_at = now() WHERE id = $1`, [w.userId]);
    const events = await eventsOf();

    const frozen = events.find((e) => e.type === 'account_frozen');
    assert.ok(frozen, 'the state is reported');
    assert.equal(frozen!.share_id, undefined, 'and names no share: the quota is per account (SH-20)');

    await w.db.query(`UPDATE users SET frozen_at = NULL WHERE id = $1`, [w.userId]);
    assert.ok(!(await eventsOf()).some((e) => e.type === 'account_frozen'), 'and stops when it stops being true');
  });
});

describe('who to seal a share key to', () => {
  it('gives the initiator a real recipient’s public key', async () => {
    const shareId = await activeShare('pubkey');
    const login = (await w.db.one<{ login: string }>(`SELECT login FROM users WHERE id = $1`, [w.strangerId]))!.login;

    const r = await w.app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/${encodeURIComponent(login)}/pubkey`,
      headers: auth(),
    });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().user_id, w.strangerId);
    assert.ok(r.json().pubkey, 'and the key to seal to');
  });

  it('answers an unknown login with a fake pair rather than a 404 (#73)', async () => {
    // A distinct answer for "no such account" is an enumeration oracle, and this endpoint
    // takes a login. The fake must also be indistinguishable in shape from a real answer.
    const shareId = await activeShare('pubkey-unknown');
    const r = await w.app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/nobody-at-all/pubkey`,
      headers: auth(),
    });

    assert.equal(r.statusCode, 200, 'not a 404');
    assert.match(r.json().user_id, /^[0-9a-f-]{36}$/, 'shaped like an id');
    assert.ok(r.json().pubkey.length > 0);
  });

  it('gives the SAME fake twice, because a changing one gives it away', async () => {
    // A random fake would differ between two calls and answer the question more plainly
    // than a 404 would.
    const shareId = await activeShare('pubkey-stable');
    const ask = () =>
      w.app.inject({
        method: 'GET',
        url: `/shares/${shareId}/recipients/still-nobody/pubkey`,
        headers: auth(),
      });

    assert.deepEqual((await ask()).json(), (await ask()).json());
  });

  it('says plainly that a console account cannot be a recipient', async () => {
    // #115: it holds no `pubkey`, so there is nothing to seal a share key to. Named rather
    // than folded into the deliberately-silent answers around it, because a console
    // account's existence is not a secret — `admin` is seeded on every installation — while
    // an invitation that vanished with no reason is a bug report waiting to happen.
    const shareId = await activeShare('pubkey-console');
    const login = `console-${Date.now()}`;
    await w.db.query(
      `INSERT INTO users (id, login, role, state, password_hash, quota_bytes)
       VALUES (gen_random_uuid(), $1, 'admin', 'active', '$argon2id$fake', 1)`,
      [login],
    );

    const r = await w.app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/${encodeURIComponent(login)}/pubkey`,
      headers: auth(),
    });

    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'console_account');
  });

  it('is the initiator’s question and nobody else’s', async () => {
    const shareId = await activeShare('pubkey-whose');
    const r = await w.app.inject({
      method: 'GET',
      url: `/shares/${shareId}/recipients/admin/pubkey`,
      headers: { authorization: `Bearer ${w.strangerAccess}` },
    });
    assert.equal(r.statusCode, 404);
  });
});
