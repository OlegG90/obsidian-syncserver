/**
 * The departure mapping: the replica listing becomes the plan a leave performs.
 *
 * This is the decision that used to live in a closure inside the Obsidian plugin class,
 * where the only reader was a live walk — every comment it carried cited a defect that walk
 * found. Extracted to `departure.ts`, it is pure: rows in, `PlannedItem[]` out, with a
 * scopes seam a test can fake without opening a vault.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { randomBytes } from '../src/crypto/bytes.js';
import { encryptName } from '../src/crypto/scope.js';
import { replicaForLeave, type ReplicaRow } from '../src/departure.js';

const VAULT_SCOPE = 'vault-scope';
const SHARE_SCOPE = 'share-scope';

const vaultKey = randomBytes(32);
const shareKey = randomBytes(32);

/** The scopes of a vault that holds this one share's key — enough for the mapping. */
const scopes = {
  keyFor: (id: string | null | undefined) => {
    if (id === SHARE_SCOPE) return shareKey;
    if (id === VAULT_SCOPE) return vaultKey;
    throw new Error(`a node is named under a scope this client cannot open: ${id}`);
  },
};

const row = (over: Partial<ReplicaRow> & Pick<ReplicaRow, 'node_id'>): ReplicaRow => ({
  name_enc: null,
  name_key_id: null,
  deleted: false,
  sha256: null,
  needs_vault_material: false,
  history_needing_material: [],
  ...over,
});

describe('the departure mapping', () => {
  it('decrypts each name under the scope the server says it is in', () => {
    const rows = [
      row({
        node_id: 'live',
        name_key_id: SHARE_SCOPE,
        name_enc: encryptName(shareKey, 'inside.md'),
      }),
      // The share root is named under KV (SH-01); a node that never joined the conversion
      // keeps it. Both scopes are in the map, so which key a name wants is a lookup.
      row({
        node_id: 'unconverted',
        name_key_id: VAULT_SCOPE,
        name_enc: encryptName(vaultKey, 'already-private.md'),
      }),
    ];

    const plan = replicaForLeave(rows, scopes, new Map());
    assert.equal(plan[0]!.name, 'inside.md', 'the share-scope name opens with the share key');
    assert.equal(plan[1]!.name, 'already-private.md', 'the vault-scope name opens with the vault key');
  });

  it('refuses a name under a scope it holds no key for, rather than renaming the file', () => {
    // `requireEveryNameReadable` runs first and is what this guards against drifting from:
    // if that check ever stopped covering a case, the strict keyFor must refuse instead of
    // letting a wrong key produce a wrong name that looks like a right one.
    const rows = [row({ node_id: 'ghost', name_key_id: 'never-arrived', name_enc: encryptName(randomBytes(32), 'x.md') })];
    assert.throws(() => replicaForLeave(rows, scopes, new Map()), /scope this client cannot open/);
  });

  it('resolves each node to its path, and a trashed node to its name', () => {
    const rows = [
      row({ node_id: 'a', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'a.md') }),
      row({ node_id: 'b', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'b.md'), deleted: true }),
    ];
    const pathOfNode = new Map([['a', 'Team/a.md']]);

    const plan = replicaForLeave(rows, scopes, pathOfNode);
    assert.equal(plan[0]!.path, 'Team/a.md', 'a live node reads from where it actually is');
    assert.equal(plan[1]!.path, 'b.md', 'a trashed node has no path — its name is the only handle');
  });

  it('takes the server’s word on what still owes material, in both directions', () => {
    const rows = [
      row({
        node_id: 'needs', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'needs.md'),
        sha256: 'hex-head', needs_vault_material: true,
      }),
      row({
        node_id: 'done', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'done.md'),
        sha256: 'hex-head', needs_vault_material: false,
      }),
    ];

    const plan = replicaForLeave(rows, scopes, new Map());
    assert.equal(plan[0]!.address, 'hex-head', 'the head that needs an envelope is named');
    assert.equal(plan[1]!.address, null, 'one that is already under KV is not re-converted');
  });

  it('carries the superseded blobs, because a node is not one blob', () => {
    const rows = [
      row({
        node_id: 'edited', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'edited.md'),
        needs_vault_material: true, sha256: 'head',
        history_needing_material: ['rev1', 'rev2'],
      }),
    ];

    const plan = replicaForLeave(rows, scopes, new Map());
    assert.deepEqual(plan[0]!.history, ['rev1', 'rev2'], 'every superseded version owes an envelope');
    assert.equal(plan[0]!.deleted, false);
  });

  it('marks a trashed node, which is the half that used to strand a departure', () => {
    const rows = [
      row({ node_id: 'trash', name_key_id: SHARE_SCOPE, name_enc: encryptName(shareKey, 'gone.md'), deleted: true }),
    ];

    const plan = replicaForLeave(rows, scopes, new Map());
    assert.equal(plan[0]!.deleted, true, 'the conversion knows it must skip the plaintext read');
  });
});
