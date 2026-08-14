/**
 * Sharing a folder, from the side that holds the keys.
 *
 * The plan is asserted apart from the performing, for the reason `rename.ts` established:
 * the decisions are the expensive part to get wrong and the cheap part to check. What is
 * checked here that no server test could see is the **cryptographic** half — that a
 * participant ends up able to read the names and open the bytes, and that the initiator's
 * own root label is left alone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { newKeypair, openFrom } from '../src/crypto/hpke.js';
import { fromBase64, toBase64, utf8 } from '../src/crypto/bytes.js';
import { decryptName, nameHmac, unwrapContentKey, wrapContentKey } from '../src/crypto/scope.js';
import { newShareKey, unwrapShareKey, wrapShareKey } from '../src/crypto/share.js';
import {
  inviteTo,
  preparePlan,
  shareFolder,
  SHARE_KEY_INFO,
  type SharedNode,
  type SharingDeps,
} from '../src/sharing.js';

const VAULT_SCOPE = 'vault-scope-id';
const SHARE_SCOPE = 'share-scope-id';

const node = (path: string, address: string | null = null): SharedNode => ({
  path,
  nodeId: `node:${path}`,
  address,
  nameKeyId: VAULT_SCOPE,
});

describe('what preparation must convert', () => {
  const tree = [node('Team'), node('Team/notes'), node('Team/notes/a.md', 'addr-a'), node('Team/b.md', 'addr-b')];

  it('leaves the share root alone, which is the rule and not an omission', () => {
    // SH-01/SH-25: the root sits among the initiator's private folders, where a participant
    // could not read it and never needs to — they name their own copy's root when they join.
    const plan = preparePlan('Team', tree);
    assert.ok(!plan.some((i) => i.nodeId === 'node:Team'), 'the root is not in the plan');
    assert.equal(plan.length, 3, 'everything below it is');
  });

  it('carries the name and the path separately, because both are needed', () => {
    // The name is what gets encrypted; the path is what gets read, since the dedup tag is
    // over the plaintext.
    const item = preparePlan('Team', tree).find((i) => i.nodeId === 'node:Team/notes/a.md');
    assert.equal(item!.name, 'a.md');
    assert.equal(item!.path, 'Team/notes/a.md');
  });

  it('ignores anything outside the folder, however similar the path looks', () => {
    // `Team2/x.md` starts with "Team" and is not in it. A prefix match without the
    // separator would quietly share a sibling folder.
    const plan = preparePlan('Team', [...tree, node('Team2/x.md', 'addr-x'), node('Teamwork.md', 'addr-y')]);
    assert.ok(!plan.some((i) => i.path.startsWith('Team2')));
    assert.ok(!plan.some((i) => i.path === 'Teamwork.md'));
  });

  it('marks folders as having no content to re-key', () => {
    const folder = preparePlan('Team', tree).find((i) => i.nodeId === 'node:Team/notes');
    assert.equal(folder!.address, null);
  });
});

/** A client that records what it was asked and answers with what the test dictates. */
const harness = (vaultKey: Uint8Array, contentKey: Uint8Array) => {
  const prepared: { shareId: string; items: unknown[] }[] = [];
  const created: Record<string, string>[] = [];
  let activated = 0;

  const deps: SharingDeps = {
    client: {
      createShare: async (body: Record<string, string>) => {
        created.push(body);
        return { share_id: 'share-1', state: 'preparing' };
      },
      prepareShare: async (shareId: string, items: unknown[]) => {
        prepared.push({ shareId, items });
      },
      activateShare: async () => {
        activated++;
        return { state: 'active' };
      },
      // One envelope, under the vault's own scope — what the file has before it is shared.
      blobKeys: async () =>
        new Map([['addr-a', [{ scopeId: VAULT_SCOPE, wrappedKey: wrapContentKey(vaultKey, contentKey) }]]]),
      recipientPubkey: async () => ({ user_id: 'u1', pubkey: '' }),
      invite: async () => undefined,
    } as unknown as SharingDeps['client'],
    read: async () => utf8('the plaintext'),
    vaultId: 'vault-1',
    vaultKey,
    vaultScopeId: VAULT_SCOPE,
    newScopeId: () => SHARE_SCOPE,
  };

  return { deps, prepared, created, activated: () => activated };
};

describe('opening a share', () => {
  const vaultKey = newShareKey();
  const contentKey = newShareKey();
  const tree = [node('Team'), node('Team/a.md', 'addr-a')];

  it('wraps the share key so the initiator can find it again', async () => {
    // Their copy is a wrap rather than an envelope because it needs no delivery — it is
    // already on the device that made it. What it needs is to survive a restart without
    // asking the server for anything it could withhold.
    const h = harness(vaultKey, contentKey);
    const { shareKey } = await shareFolder(h.deps, 'Team', tree);

    const wrapped = h.created[0]!.wrapped_key_initiator!;
    assert.deepEqual(unwrapShareKey(vaultKey, wrapped), shareKey);
  });

  it('produces names a participant can actually read', async () => {
    // The point of the whole conversion, asserted the way a participant would experience
    // it: with `KS` and nothing else, the name comes back.
    const h = harness(vaultKey, contentKey);
    const { shareKey } = await shareFolder(h.deps, 'Team', tree);

    const items = h.prepared[0]!.items as { name_enc: string; name_hmac: string; name_key_id: string }[];
    assert.equal(items.length, 1, 'the root was not converted');
    assert.equal(decryptName(shareKey, items[0]!.name_enc), 'a.md');
    assert.equal(items[0]!.name_hmac, nameHmac(shareKey, 'a.md'), 'and the lookup hmac matches it');
    assert.equal(items[0]!.name_key_id, SHARE_SCOPE);
  });

  it('re-wraps the SAME content key rather than re-encrypting the file', async () => {
    // Preparation adds a second envelope for one blob; re-encrypting would double the
    // storage and change every address the tree already points at.
    const h = harness(vaultKey, contentKey);
    const { shareKey } = await shareFolder(h.deps, 'Team', tree);

    const items = h.prepared[0]!.items as { blob_envelopes: { wrapped_key: string; sha256: string }[] }[];
    const envelope = items[0]!.blob_envelopes[0]!;
    assert.equal(envelope.sha256, 'addr-a', 'the address is unchanged');
    assert.deepEqual(unwrapContentKey(shareKey, envelope.wrapped_key), contentKey, 'the same KC, a new wrap');
  });

  it('tags the content under the share scope, so dedup works between participants', async () => {
    const h = harness(vaultKey, contentKey);
    await shareFolder(h.deps, 'Team', tree);

    const items = h.prepared[0]!.items as { dedup_tags: { scope_id: string }[] }[];
    assert.equal(items[0]!.dedup_tags[0]!.scope_id, SHARE_SCOPE);
  });

  it('activates only after everything is prepared', async () => {
    // Order matters: a share that cannot be activated is still `preparing`, and the
    // initiator can cancel it having lost nothing. Nobody has been asked to join yet.
    const h = harness(vaultKey, contentKey);
    await shareFolder(h.deps, 'Team', tree);

    assert.equal(h.prepared.length, 1);
    assert.equal(h.activated(), 1);
  });

  it('refuses a folder the server has never seen', async () => {
    const h = harness(vaultKey, contentKey);
    await assert.rejects(() => shareFolder(h.deps, 'Nowhere', tree), /not on the server/);
  });
});

describe('handing the key to somebody else', () => {
  it('seals it so only their private key opens it', async () => {
    const recipient = newKeypair();
    const shareKey = newShareKey();
    let sent = '';

    await inviteTo(
      {
        client: {
          recipientPubkey: async () => ({ user_id: 'u1', pubkey: toBase64(recipient.publicKey) }),
          invite: async (_id: string, body: { wrapped_key: string }) => {
            sent = body.wrapped_key;
          },
        } as unknown as SharingDeps['client'],
      },
      'share-1',
      'someone',
      shareKey,
    );

    const envelope = fromBase64(sent);
    const opened = openFrom(
      recipient.secretKey,
      { enc: envelope.subarray(0, 32), ciphertext: envelope.subarray(32) },
      utf8(SHARE_KEY_INFO),
      new Uint8Array(0),
    );
    assert.deepEqual(opened, shareKey, 'the recipient recovers exactly the share key');
  });

  it('binds the envelope to being a share key, so it cannot be replayed as another', async () => {
    // `info` is the binding. Opening with a different label must fail — otherwise an
    // envelope sealed for one purpose could be presented as one sealed for another.
    const recipient = newKeypair();
    const shareKey = newShareKey();
    let sent = '';

    await inviteTo(
      {
        client: {
          recipientPubkey: async () => ({ user_id: 'u1', pubkey: toBase64(recipient.publicKey) }),
          invite: async (_id: string, body: { wrapped_key: string }) => {
            sent = body.wrapped_key;
          },
        } as unknown as SharingDeps['client'],
      },
      'share-1',
      'someone',
      shareKey,
    );

    const envelope = fromBase64(sent);
    assert.throws(() =>
      openFrom(
        recipient.secretKey,
        { enc: envelope.subarray(0, 32), ciphertext: envelope.subarray(32) },
        utf8('syncserver/pairing/v1'),
        new Uint8Array(0),
      ),
    );
  });
});

describe('the share key itself', () => {
  it('survives a wrap and an unwrap under the vault key', () => {
    const kv = newShareKey();
    const ks = newShareKey();
    assert.deepEqual(unwrapShareKey(kv, wrapShareKey(kv, ks)), ks);
  });

  it('is not derived from anything, so two are never the same', () => {
    // It has to be readable by people who will never hold this account's seed, which is
    // exactly why it cannot be a branch of it.
    assert.notDeepEqual(newShareKey(), newShareKey());
  });

  it('refuses to open under the wrong key rather than returning rubbish', () => {
    const ks = newShareKey();
    assert.throws(() => unwrapShareKey(newShareKey(), wrapShareKey(newShareKey(), ks)));
  });
});
