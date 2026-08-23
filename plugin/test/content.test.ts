/**
 * What a file's bytes become on the way to the server (`content.ts`).
 *
 * Three branches that used to need a whole pass to reach, and one of them — the envelope being wrapped
 * to the scope the node is named under — is the difference between a shared file the other side can open
 * and one it cannot.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { resolveContent } from '../src/engine/content.js';
import { dedupTag, unwrapContentKey } from '../src/crypto/scope.js';
import { openBlob } from '../src/crypto/blob.js';

const key = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const bytes = new TextEncoder().encode('the note');

describe('bytes this scope already holds', () => {
  it('reuses the address and produces no material at all', async () => {
    // Nothing to wrap: the envelope and the tag the first upload wrote are already there, and writing
    // them again would be the same rows a second time.
    const scope = { id: 'scope-1', key: key(1) };
    const dedup = new Map([[dedupTag(scope.key, bytes), 'the-existing-address']]);
    let uploads = 0;

    const out = await resolveContent(bytes, scope, dedup, async () => void uploads++);

    assert.equal(out.sha256, 'the-existing-address');
    assert.deepEqual(out.material, { blob_envelopes: [], dedup_tags: [] });
    assert.equal(uploads, 0, 'and nothing is sent');
  });

  it('does not match a tag from another scope, because the tag is per scope', async () => {
    // The privacy property, asserted: two vaults holding the same file produce different tags, so the
    // server cannot tell they match (docs/07). A tag that matched across scopes would leak exactly that.
    const mine = { id: 'mine', key: key(1) };
    const theirs = dedupTag(key(2), bytes);
    let uploads = 0;

    const out = await resolveContent(bytes, mine, new Map([[theirs, 'theirs']]), async () => void uploads++);

    assert.notEqual(out.sha256, 'theirs');
    assert.equal(uploads, 1, 'it seals and uploads its own');
  });
});

describe('bytes this scope has never seen', () => {
  it('uploads once and hands back the material that opens them', async () => {
    const scope = { id: 'scope-1', key: key(1) };
    const sent: { sha256: string; bytes: Uint8Array; keyId: string }[] = [];

    const out = await resolveContent(bytes, scope, new Map(), async (s) => void sent.push(s));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.sha256, out.sha256, 'the address is what was uploaded');
    assert.equal(out.material.blob_envelopes.length, 1);
    assert.equal(out.material.dedup_tags.length, 1);
  });

  it('wraps the content key to the scope it was given, and the bytes come back out', async () => {
    // The assertion this extraction exists for. Hand it the wrong scope — the vault's, for a file inside
    // a share — and this still "works": an envelope is written, and the share's readers cannot open it.
    const scope = { id: 'share-scope', key: key(7) };
    let uploaded: { bytes: Uint8Array } | undefined;

    const out = await resolveContent(bytes, scope, new Map(), async (s) => void (uploaded = s));

    const envelope = out.material.blob_envelopes[0]!;
    assert.equal(envelope.scope_id, 'share-scope');
    const contentKey = unwrapContentKey(scope.key, envelope.wrapped_key);
    assert.deepEqual(openBlob(contentKey, uploaded!.bytes), bytes, 'and that key opens what was sent');
  });

  it('tags the upload so the next file with these bytes takes the other branch', async () => {
    const scope = { id: 'scope-1', key: key(1) };
    const out = await resolveContent(bytes, scope, new Map(), async () => undefined);

    const tag = out.material.dedup_tags[0]!;
    assert.equal(tag.content_tag, dedupTag(scope.key, bytes));
    assert.equal(tag.scope_id, 'scope-1');

    const again = await resolveContent(bytes, scope, new Map([[tag.content_tag, tag.sha256]]), async () => {
      throw new Error('it uploaded again');
    });
    assert.equal(again.sha256, out.sha256);
  });
});
