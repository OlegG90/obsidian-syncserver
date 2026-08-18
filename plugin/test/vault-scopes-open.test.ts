/**
 * `VaultScopes`: which key opens a name, and what happens when none does.
 *
 * The rule is one rule — a name is opened with the key for its `name_key_id`, defaulting to
 * the vault's own — and it was written out at three call sites that disagreed about the
 * failure. It has two forms here, and the difference is the return type rather than an
 * argument: a caller that must be able to read a name cannot silently become one that
 * shrugs, because `Uint8Array` and `Uint8Array | undefined` are not the same promise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OpenedVault } from '@syncserver/shared';
import { randomBytes, toHex } from '../src/crypto/bytes.js';
import { encryptName } from '../src/crypto/scope.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { UNREADABLE_NAME, VaultScopes } from '../src/share-keys.js';

const vaultScopeId = 'scope-vault';
const openableId = 'scope-openable';
const undeliveredId = 'scope-undelivered';

const vaultKey = randomBytes(32);
const shareKey = randomBytes(32);

const deps = { vaultKey, openIdentity: () => randomBytes(32), userId: 'user' };

/**
 * One vault, two shares: one whose key is wrapped under `KV` and opens, and one reported
 * with no wrapped key at all — what an envelope that never arrived looks like from here.
 */
const opened: OpenedVault = {
  root_node_id: 'root',
  head_rev: 1,
  scopes: [
    { scope: 'vault', key_id: vaultScopeId },
    {
      scope: 'share', key_id: openableId, share_id: '11111111-1111-4111-8111-111111111111',
      wrapped_key: wrapShareKey(vaultKey, shareKey), wrapping: 'vault',
    },
    { scope: 'share', key_id: undeliveredId, share_id: '22222222-2222-4222-8222-222222222222' },
  ],
};

const scopes = (): VaultScopes => VaultScopes.open(opened, deps);

describe('the scopes of an opened vault', () => {
  it('answers the vault key for a name that claims no scope, and for its own', () => {
    // A node inherits the root's scope until a share overrides it, so "no scope named" and
    // "the vault's scope" are the same answer — asserted together because a caller that got
    // one right and the other wrong would look correct on ordinary vaults for ever.
    const s = scopes();
    assert.equal(toHex(s.keyFor(null)), toHex(vaultKey));
    assert.equal(toHex(s.keyFor(undefined)), toHex(vaultKey));
    assert.equal(toHex(s.keyFor(vaultScopeId)), toHex(vaultKey));
  });

  it('unwraps a share key that arrived, and reports the one that did not', () => {
    const s = scopes();
    assert.equal(toHex(s.keyFor(openableId)), toHex(shareKey));
    assert.deepEqual(s.unopenable, [], 'a scope with no wrapped key is not a FAILED unwrap');
    assert.equal(s.keyIfOpenable(undeliveredId), undefined);
  });

  it('throws for the caller who must read, and answers for the caller who can cope', () => {
    // The whole point of the pair. Same question, two callers: one is about to write a name
    // and has nothing sensible to do without the key; the other is listing rows or skipping
    // a subtree and must carry on.
    const s = scopes();
    assert.throws(() => s.keyFor(undeliveredId), /scope this client cannot open/);
    assert.equal(s.keyIfOpenable(undeliveredId), undefined);
  });

  it('carries the instant it describes, so nothing has to be opened twice', () => {
    const s = scopes();
    assert.equal(s.opened, opened);
    assert.equal(s.vaultScopeId, vaultScopeId);
    assert.equal(toHex(s.vaultKey), toHex(vaultKey));
  });

  it('pairs each share with the scope its interior is named under', () => {
    // A share root's own label is under KV (SH-01), so the scope its children live in cannot
    // be read off the root — the server reports the pairing, and this is where it is read.
    const pairs = scopes().shareScopes();
    assert.equal(pairs.get('11111111-1111-4111-8111-111111111111'), openableId);
    assert.equal(pairs.get('22222222-2222-4222-8222-222222222222'), undeliveredId);
    assert.equal(pairs.size, 2, 'the vault scope is not a share');
  });

  it('reads a name it has the key for, and stands in for one it does not', () => {
    const s = scopes();
    assert.equal(s.readName(vaultScopeId, encryptName(vaultKey, 'ordinary.md')), 'ordinary.md');
    assert.equal(s.readName(openableId, encryptName(shareKey, 'shared.md')), 'shared.md');
    assert.equal(s.readName(undeliveredId, encryptName(randomBytes(32), 'secret.md')), UNREADABLE_NAME);
  });

  it('stands in rather than throwing when the name itself is unusable', () => {
    // A row is worth showing either way — it is the only handle a person has on a file they
    // want gone. `decryptName` is an AEAD open, so the wrong key throws rather than returning
    // nonsense, and a listing that dies on one bad row shows none of the good ones.
    const s = scopes();
    assert.equal(s.readName(vaultScopeId, null), UNREADABLE_NAME, 'no name at all');
    assert.equal(s.readName(vaultScopeId, encryptName(randomBytes(32), 'x.md')), UNREADABLE_NAME, 'wrong key');
    assert.equal(s.readName(vaultScopeId, 'not base64 at all'), UNREADABLE_NAME, 'not a sealed value');
  });

  it('reports a share key it could not unwrap, without failing the rest', () => {
    // A wrapped key that is present and wrong: the difference from the undelivered case is
    // that this one was TRIED. One bad envelope must not cost the other shares their keys.
    const broken: OpenedVault = {
      ...opened,
      scopes: [
        ...opened.scopes,
        {
          scope: 'share', key_id: 'scope-broken', share_id: '33333333-3333-4333-8333-333333333333',
          wrapped_key: wrapShareKey(randomBytes(32), shareKey), wrapping: 'vault',
        },
      ],
    };

    const s = VaultScopes.open(broken, deps);
    assert.deepEqual(s.unopenable, ['scope-broken']);
    assert.equal(s.keyIfOpenable('scope-broken'), undefined);
    assert.equal(toHex(s.keyFor(openableId)), toHex(shareKey), 'the good one still opened');
  });
});
