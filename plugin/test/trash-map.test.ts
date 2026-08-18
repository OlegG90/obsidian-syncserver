/**
 * The trash listing mapping: server rows become display rows, name decrypted per scope.
 *
 * The decision that used to live in a closure inside the Obsidian plugin class — which key
 * opens a trashed node's name, and what to show when no key exists — is now a pure map over
 * `VaultScopes.readName`. The rule worth pinning is the lenient one: a node this device
 * holds no key for still gets a row, named as unreadable and still discardable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { randomBytes } from '../src/crypto/bytes.js';
import { encryptName } from '../src/crypto/scope.js';
import { wrapShareKey } from '../src/crypto/share.js';
import { UNREADABLE_NAME, VaultScopes } from '../src/share-keys.js';
import { trashRows, type TrashEntryRow } from '../src/trash-map.js';

const vaultScopeId = 'scope-vault';
const openableId = 'scope-openable';
const undeliveredId = 'scope-undelivered';

const vaultKey = randomBytes(32);
const shareKey = randomBytes(32);

/** A vault with one share: its key arrives, and one that never did. */
const scopes = VaultScopes.open(
  {
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
  },
  { vaultKey, openIdentity: () => randomBytes(32), userId: 'user' },
);

const entry = (over: Partial<TrashEntryRow> & Pick<TrashEntryRow, 'node_id'>): TrashEntryRow => ({
  parent_id: null,
  name_enc: null,
  type: 'file',
  deleted_at: '2026-01-01T00:00:00Z',
  versions: 1,
  name_key_id: null,
  share_id: null,
  ...over,
});

describe('the trash listing', () => {
  it('decrypts each name under the scope the server says it is in', () => {
    const rows = trashRows(
      [
        entry({ node_id: 'private', name_enc: encryptName(vaultKey, 'old.md') }),
        entry({ node_id: 'shared', name_key_id: openableId, name_enc: encryptName(shareKey, 'shared-old.md'), share_id: 's' }),
      ],
      scopes,
    );

    assert.equal(rows[0]!.name, 'old.md', 'the vault-scope name opens with the vault key');
    assert.equal(rows[1]!.name, 'shared-old.md', 'a trashed node of a share is still under KS');
    assert.equal(rows[1]!.shared, true, 'and that fact survives, worth seeing but not acting on');
  });

  it('names an unreadable node plainly, and still offers the row', () => {
    const rows = trashRows(
      [entry({ node_id: 'ghost', name_key_id: undeliveredId, name_enc: encryptName(randomBytes(32), 'x.md') })],
      scopes,
    );

    assert.equal(rows[0]!.name, UNREADABLE_NAME, 'a missing key is a sentence, not a fake filename');
    assert.equal(rows[0]!.nodeId, 'ghost', 'the row survives — it is the only handle on a file the person wants gone');
  });

  it('keeps the counts a restore or an empty has to know', () => {
    const rows = trashRows(
      [entry({ node_id: 'v', versions: 4, deleted_at: '2026-02-02T00:00:00Z' })],
      scopes,
    );

    assert.equal(rows[0]!.versions, 4, 'how many revisions are behind the node');
    assert.equal(rows[0]!.deletedAt, '2026-02-02T00:00:00Z', 'when it was deleted');
  });
});
