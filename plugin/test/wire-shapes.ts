/**
 * The two shapes that cross `VaultWire`, built in one place.
 *
 * Six test files each wrote out a `Change` by hand — twelve fields, most of them the same twelve
 * constants every time — and a seventh was always about to. It is not what any of them is testing:
 * they are about deletes, incremental passes, known nodes, scope, an unopenable share, and the
 * `.obsidian` switch. What they share is only what the server's answer LOOKS like.
 *
 * **The tree each one builds is not shared, deliberately.** `listNodes` differs by more than
 * accident between these files: `engine-scope` puts a blob under a different scope, and
 * `engine-unopenable-share` builds a share this device holds no key for. Lifting `listNodes` here
 * would mean options, and a fixture with options grows until it can answer things the real server
 * cannot — which is exactly how #304 hid. So this owns a row and an envelope; composing them into a
 * tree stays with the test that has an opinion about the tree.
 *
 * **A row the server could not emit cannot be built here.** An address without a length, or a length
 * without an address, is a shape no server produces — so `content` is one optional field holding
 * both, and the type refuses the half-built row that twelve loose fields allowed. The root is a
 * second function rather than a spec with everything omitted, for the same reason: its four null
 * name fields are what identifies it, and they travel together or the row is a lie.
 */
import type { Change } from '@syncserver/shared';
import type { Envelope } from '../src/api/client.js';
import { encryptName, nameHmac, wrapContentKey } from '../src/crypto/scope.js';

/** The instant a row carries unless a test has an opinion about time. */
const AT = new Date(0).toISOString();

export interface RowSpec {
  nodeId: string;
  parentId: string;
  /** The plaintext path. Encrypted and hmac'd under `key`, and labelled with `scopeId`. */
  name: string;
  /** `KV`, or a share's key when the row belongs to one. */
  key: Uint8Array;
  scopeId: string;
  rev: number;
  /** A file's address and length. Both, or neither — a folder has neither. */
  content?: { sha256: string; size: number };
  /** Set on a row inside a share (SH-02). */
  shareId?: string;
  /**
   * When the row's timestamp is the point — two nodes a test needs to tell apart, or a hint that
   * must not match. Data about the row, not a capability of the fake: a server emits whatever
   * instant the node carries, so this widens nothing.
   */
  mtime?: string;
}

/**
 * One node, as `listNodes` reports it.
 *
 * `op` is always `put`: these fixtures answer a walk, and a walk reports what is there. The files
 * that test deletion assert on what the engine SENT, not on a `del` coming back.
 */
export const row = (spec: RowSpec): Change => {
  if (spec.name === '') throw new Error('wire-shapes: a named node needs a name; use rootRow() for the root');

  return {
    node_id: spec.nodeId,
    parent_id: spec.parentId,
    name_enc: encryptName(spec.key, spec.name),
    name_hmac: nameHmac(spec.key, spec.name),
    name_key_id: spec.scopeId,
    op: 'put',
    rev: spec.rev,
    sha256: spec.content?.sha256 ?? null,
    size: spec.content?.size ?? null,
    mtime: spec.mtime ?? AT,
    share_id: spec.shareId ?? null,
    author_id: null,
  };
};

/**
 * The vault root, which is the one node with no name at all.
 *
 * Its four null name fields are what tells a client this is the root rather than a node whose name
 * it failed to read — so they travel together, and building this by hand is how one of them ends up
 * set while the others are not.
 */
export const rootRow = (rootNodeId: string): Change => ({
  node_id: rootNodeId,
  parent_id: null,
  name_enc: null,
  name_hmac: null,
  name_key_id: null,
  op: 'put',
  rev: 1,
  sha256: null,
  size: null,
  mtime: AT,
  share_id: null,
  author_id: null,
});

/** A blob the server can hand a key for, and the scope that key is wrapped under. */
export interface Offer {
  sha256: string;
  contentKey: Uint8Array;
  scopeId: string;
  /** The scope key the content key is wrapped with. */
  key: Uint8Array;
}

/**
 * `blobKeys`, for the addresses actually asked about.
 *
 * **An address with no offer is answered with nothing, and that is not an error.** A blob whose key
 * belongs to a scope this device cannot open is a real server answer and a real situation — it is
 * what `engine-unopenable-share` exists to walk through. Throwing here would make that case
 * untestable in the name of strictness.
 */
export const envelopesFor = (offers: readonly Offer[], addresses: readonly string[]): Map<string, Envelope[]> => {
  const out = new Map<string, Envelope[]>();
  for (const o of offers) {
    if (!addresses.includes(o.sha256)) continue;
    const held = out.get(o.sha256) ?? [];
    held.push({ scopeId: o.scopeId, wrappedKey: wrapContentKey(o.key, o.contentKey) });
    out.set(o.sha256, held);
  }
  return out;
};
