/**
 * Sharing a folder, from the side that owns it.
 *
 * The server verifies preparation; **performing** it is only ever this side's, and the
 * division is not administrative. Re-keying a name means decrypting it under `KV` and
 * encrypting it under `KS`, and re-keying content means unwrapping `KC` from the vault's
 * envelope and wrapping it again — the server holds none of those keys and could not do any
 * of it if it wanted to.
 *
 * The work splits the same way `rename.ts` does, for the same reason: `preparePlan` decides
 * what has to change and touches nothing, and the orchestrator below performs it. The hard
 * part is the plan, and a plan is cheap to assert.
 *
 * **What stays under `KV`.** The share's own root keeps its vault-key label for the life of
 * the share and after (SH-01, SH-25): it sits among private siblings, and a participant who
 * cannot read `KV` never needs to — they name their own copy's root themselves when they
 * join. Everything *below* it must move to `KS`, because a participant may create and rename
 * there and their names have to be readable by everyone else.
 */
import type { FinalizeNode, PrepareItem, ShareMember, SyncClient } from './api/client.js';
import { newShareKey, wrapShareKey } from './crypto/share.js';
import { dedupTag, encryptName, nameHmac, unwrapContentKey, wrapContentKey } from './crypto/scope.js';
import { sealTo } from './crypto/hpke.js';
import { concat, fromBase64, toBase64, utf8 } from './crypto/bytes.js';
import { WRAP_VERSION } from './crypto/sealed.js';

/** One node of the subtree being shared, as the client already knows it. */
export interface SharedNode {
  path: string;
  nodeId: string;
  /** The ciphertext address, for a file. Folders carry none. */
  address: string | null;
  /** The scope this node is named under today — the vault's, before preparation. */
  nameKeyId: string;
}

/** What one node needs to become part of the share, before any of it is performed. */
export interface PlannedItem {
  nodeId: string;
  /** Where the file is on this device — the dedup tag is over its plaintext, so it is read. */
  path: string;
  /** The plaintext name, which only this side can produce. */
  name: string;
  /** Present for a file: the bytes whose key and tag must move to `KS`. */
  address: string | null;
  /**
   * This node is in the trash, so its plaintext is not on disk.
   *
   * Only leaving ever sets it. The content key still has to move — a restore later must be
   * able to open the file — but the **dedup tag** cannot be computed, because it is over the
   * plaintext, and it is not needed either: deduplication answers "have I uploaded this
   * before", and a deleted node is not going to be uploaded.
   */
  deleted?: boolean;
  /**
   * Superseded blobs of the same node whose content key must move as well.
   *
   * The same argument as `deleted`, applied to time instead of the trash: their plaintext is
   * not on disk, so they get an **envelope and no tag**. A node is not one blob — every edit
   * made while the folder was shared left a version keyed only under the scope being left —
   * and a conversion that moves the head alone leaves a history nobody can open.
   */
  history?: readonly string[];
}

/** Everything after the last separator — the name a node is known by inside its folder. */
const basename = (path: string): string => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
};

/**
 * Which nodes preparation must convert, and what each needs.
 *
 * The root is excluded, and that is the whole subtlety: it is not an oversight to be fixed
 * later but the rule SH-01 states. Including it would re-key a label that lives among the
 * initiator's private folders, where no participant can read it and none needs to.
 *
 * @param root the shared folder's own path. Everything strictly under it is interior.
 */
export const preparePlan = (root: string, nodes: readonly SharedNode[]): PlannedItem[] => {
  const prefix = root === '' ? '' : `${root}/`;
  return nodes
    .filter((n) => n.path !== root && n.path.startsWith(prefix))
    .map((n) => ({ nodeId: n.nodeId, path: n.path, name: basename(n.path), address: n.address }));
};

/** What `shareFolder` needs that it cannot know: the vault, its keys, and a way to talk. */
export interface SharingDeps {
  client: Pick<
    SyncClient,
    | 'createShare'
    | 'prepareShare'
    | 'preparationOwed'
    | 'activateShare'
    | 'blobKeys'
    | 'recipientPubkey'
    | 'invite'
  >;
  /** Reads a file's plaintext from this device — the dedup tag is over the plaintext. */
  read(path: string): Promise<Uint8Array>;
  vaultId: string;
  /** `KV`. Unwraps today's content keys and wraps `KS` for this account's own use. */
  vaultKey: Uint8Array;
  /** The vault's key scope, which every node is named under before preparation. */
  vaultScopeId: string;
  /** A fresh identifier for the share's key scope; the client chooses it (docs/04). */
  newScopeId(): string;
}

/**
 * How many nodes travel in one prepare request.
 *
 * Batches exist so a subtree can outgrow a single request and a phone can lose the
 * connection halfway. Nothing tracks which batches landed: a repeat writes the same name and
 * the same envelope, and `activate` recomputes what is still missing — which is the same
 * answer whether a batch was lost, repeated, or never sent.
 */
const BATCH = 50;

/**
 * Open a share over a folder this account owns, prepare its interior, and activate it.
 *
 * Activation is the point of no return for invitations, not for the data: a share that
 * cannot be activated is still `preparing`, and the initiator can cancel it and lose
 * nothing. So the order here is deliberate — everything that can fail happens before
 * anybody has been asked to join.
 */
export const shareFolder = async (
  deps: SharingDeps,
  root: string,
  nodes: readonly SharedNode[],
): Promise<{ shareId: string; shareKey: Uint8Array; scopeId: string }> => {
  const rootNode = nodes.find((n) => n.path === root);
  if (!rootNode) throw new Error(`the folder to share is not on the server yet: ${root || '(vault root)'}`);

  const shareKey = newShareKey();
  const scopeId = deps.newScopeId();

  const { share_id: shareId } = await deps.client.createShare({
    vault_id: deps.vaultId,
    node_id: rootNode.nodeId,
    subtree_key_id: scopeId,
    wrapped_key_initiator: wrapShareKey(deps.vaultKey, shareKey),
  });

  // Asked only now, because the subtree is marked by creating the share and not before.
  // The tree this client keeps holds the head of each file; the versions behind it are the
  // server's to name, and activation wants an envelope for every one of them.
  const owed = new Map(
    (await deps.client.preparationOwed(shareId)).map((n) => [n.node_id, n.history_needing_material]),
  );
  const plan = preparePlan(root, nodes).map((item) => ({ ...item, history: owed.get(item.nodeId) ?? [] }));
  for (let i = 0; i < plan.length; i += BATCH) {
    const batch = plan.slice(i, i + BATCH);
    const converted = await Promise.all(
      batch.map((item) =>
        rekey(deps, item, { key: deps.vaultKey, scopeId: deps.vaultScopeId }, { key: shareKey, scopeId }),
      ),
    );
    await deps.client.prepareShare(shareId, converted.map(asPrepareItem));
  }

  await deps.client.activateShare(shareId);
  return { shareId, shareKey, scopeId };
};

/** One node's conversion: its name under `KS`, and for a file its key and tag as well. */
/**
 * A node moved from one key scope to another: its name, and for a file its content key and
 * dedup tag.
 *
 * One function for both directions, because they ARE one operation. Preparing a share moves
 * the interior from `KV` to `KS`; leaving moves it back. Written twice they would drift, and
 * the drift would be silent — a folder that converts one way and not quite the other leaves
 * files nobody can open, discovered long after the share is gone.
 *
 * **The bytes are never re-encrypted.** Conversion adds a second envelope for the same `KC`,
 * so the very blob already on the server keeps opening. Re-encrypting would double the
 * storage and change every address the tree points at, for no gain: whoever held the old
 * scope key has already seen the plaintext.
 */
const rekey = async (
  // Exactly what it uses: one endpoint and one read. Asking for the whole sharing client
  // would make every caller supply methods this never touches.
  deps: { client: Pick<SyncClient, 'blobKeys'>; read(path: string): Promise<Uint8Array>; vaultId: string },
  item: PlannedItem,
  from: { key: Uint8Array; scopeId: string },
  to: { key: Uint8Array; scopeId: string },
  /**
   * What to do when the source scope holds no envelope for this file.
   *
   * Preparing, that is a fault worth stopping for: the share is being built and a file
   * nobody can open would be built into it. **Leaving, it must not stop anything.** A
   * departure that cannot finish strands the whole vault — the names stay under a key that
   * is about to be withdrawn — and the content is not in danger either way, since the
   * envelope being converted TO is the one the file already had. Data that reached this
   * state through an earlier defect is exactly what a departure has to be able to walk out
   * of.
   */
  onMissingSource: 'throw' | 'skip' = 'throw',
): Promise<Rekeyed> => {
  const out: Rekeyed = {
    node_id: item.nodeId,
    name_enc: encryptName(to.key, item.name),
    name_hmac: nameHmac(to.key, item.name),
    name_key_id: to.scopeId,
  };
  // The head and every superseded version it still owes, in one round trip.
  const addresses = [...new Set([item.address, ...(item.history ?? [])].filter((a): a is string => !!a))];
  if (addresses.length === 0) return out;

  const envelopes = await deps.client.blobKeys(deps.vaultId, addresses);
  const moved = [];
  for (const address of addresses) {
    const source = envelopes.get(address)?.find((e) => e.scopeId === from.scopeId);
    if (!source) {
      if (onMissingSource === 'skip') continue;
      throw new Error(`no content key under scope ${from.scopeId} for ${item.name}`);
    }
    const contentKey = unwrapContentKey(from.key, source.wrappedKey);
    moved.push({ sha256: address, scope_id: to.scopeId, wrapped_key: wrapContentKey(to.key, contentKey) });
  }
  if (moved.length > 0) out.envelopes = moved;

  // The tag belongs to the head alone, and only while it is readable from disk — see
  // `PlannedItem.deleted` and `.history` for why the other blobs neither can have one nor
  // need one.
  if (!item.address || item.deleted) return out;
  if (!moved.some((e) => e.sha256 === item.address)) return out;

  // The tag is over the PLAINTEXT, so the file is read. Deduplication is per scope: two
  // participants holding the same file under one share share a blob, while the same file in
  // a private vault is another scope and is charged again.
  const plaintext = await deps.read(item.path);
  out.tags = [{ sha256: item.address, scope_id: to.scopeId, content_tag: dedupTag(to.key, plaintext) }];
  return out;
};

/** The neutral shape, before it is spelled as a prepare item or a finalize node. */
interface Rekeyed {
  node_id: string;
  name_enc: string;
  name_hmac: string;
  name_key_id: string;
  envelopes?: { sha256: string; scope_id: string; wrapped_key: string }[];
  tags?: { sha256: string; scope_id: string; content_tag: string }[];
}

const asPrepareItem = (r: Rekeyed): PrepareItem => ({
  node_id: r.node_id,
  name_enc: r.name_enc,
  name_hmac: r.name_hmac,
  name_key_id: r.name_key_id,
  ...(r.envelopes ? { blob_envelopes: r.envelopes } : {}),
  ...(r.tags ? { dedup_tags: r.tags } : {}),
});

const asFinalizeNode = (r: Rekeyed): FinalizeNode => ({
  node_id: r.node_id,
  name_enc: r.name_enc,
  name_hmac: r.name_hmac,
  name_key_id: r.name_key_id,
  ...(r.envelopes ? { vault_envelopes: r.envelopes } : {}),
  ...(r.tags ? { vault_dedup_tags: r.tags } : {}),
});

/**
 * Seal `KS` to somebody so they can be invited.
 *
 * Two calls that must stay together: the recipient's public key, and the envelope made for
 * it. `/recipients/{login}/pubkey` answers an unknown login with a deterministic FAKE key
 * rather than a 404 (#73) — so this cannot be used to discover who has an account, and a
 * caller must not read anything into a successful seal. The invitation that follows fails
 * generically for the same reason.
 */
export const inviteTo = async (
  deps: Pick<SharingDeps, 'client'>,
  shareId: string,
  login: string,
  shareKey: Uint8Array,
): Promise<void> => {
  const { user_id: userId, pubkey } = await deps.client.recipientPubkey(shareId, login);
  const sealed = sealTo(fromBase64(pubkey), new Uint8Array(0), shareEnvelopeAad(shareId, userId), shareKey);
  await deps.client.invite(shareId, {
    user_id: userId,
    wrapped_key: toBase64(concat(sealed.enc, sealed.ciphertext)),
  });
};

/**
 * What an envelope carrying `KS` is bound to: `format_version ‖ share_id ‖ recipient_user_id`
 * (docs/06).
 *
 * The binding is the point. Without it an envelope could be handed to a different
 * participant, or presented under a different share, and would open perfectly — the AEAD
 * only ever proves that whoever sealed it held the recipient's public key, not what they
 * meant by it. There is deliberately **no key epoch** in it: `KS` is never rotated (#10), so
 * an epoch would name a generation that cannot exist.
 */
export const shareEnvelopeAad = (shareId: string, recipientUserId: string): Uint8Array =>
  concat(new Uint8Array([WRAP_VERSION]), utf8(shareId), utf8(recipientUserId));

/** Who holds a copy of this folder, and who has not answered yet. */
export type Members = ShareMember[];

/** What accepting needs: where the copy lands, and what this device calls it. */
export interface AcceptDeps {
  client: Pick<SyncClient, 'joinShare'>;
  vaultId: string;
  /** `KV` — the replica's root is named under it, because it lands among private folders. */
  vaultKey: Uint8Array;
  vaultScopeId: string;
}

/**
 * Accept an invitation, materialising a copy in **this** vault.
 *
 * The vault is not asked for, it is observed (AC-Q4): a plugin instance can only reach the
 * vault it runs in, so accepting *is* choosing where the folder lands. There is no second
 * chance to place it elsewhere — an invitation is redeemed once.
 *
 * The name is this side's alone. The interior arrives under `KS` and stays there, but the
 * root sits among the joiner's own folders, so they name it under their own `KV` and may
 * call it whatever they like. That is also why a free name has to be chosen here: the
 * destination folder may already hold something called the same thing, and the server
 * enforces unique names among siblings.
 */
export const acceptInvitation = async (
  deps: AcceptDeps,
  shareId: string,
  parentNodeId: string,
  name: string,
): Promise<{ rootNodeId: string }> => {
  const { root_node_id: rootNodeId } = await deps.client.joinShare(shareId, {
    vault_id: deps.vaultId,
    parent_id: parentNodeId,
    name_enc: encryptName(deps.vaultKey, name),
    name_hmac: nameHmac(deps.vaultKey, name),
    name_key_id: deps.vaultScopeId,
  });
  return { rootNodeId };
};

/**
 * A name not already taken among `siblings`, by appending a counter.
 *
 * Joining is the one moment a share meets a vault it knows nothing about, so a collision is
 * ordinary rather than exceptional — two people can easily both have a folder called
 * "Notes". Refusing the join over it would be a poor trade for the person accepting.
 */
export const freeName = (wanted: string, siblings: ReadonlySet<string>): string => {
  if (!siblings.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted} ${n}`;
    if (!siblings.has(candidate)) return candidate;
  }
};

/** What leaving needs: the replica's own key, and a way to say it is gone. */
export interface LeaveDeps {
  client: Pick<SyncClient, 'leaveShare' | 'finalizeLeave' | 'blobKeys'>;
  /** Reads a file's plaintext — the dedup tag under the new scope is over it. */
  read(path: string): Promise<Uint8Array>;
  vaultId: string;
  /** `KV`, which the replica's names and content keys are returning to. */
  vaultKey: Uint8Array;
  vaultScopeId: string;
}

/**
 * Leave a share, converting this device's replica back to private files.
 *
 * **The copy is kept** (SH-05). That is the promise replication exists to make, and it is
 * why leaving is a metadata pass rather than a deletion: the files do not move and the bytes
 * are not re-encrypted. Only the naming changes, so the folder keeps working once `KS` stops
 * being shared with anybody.
 *
 * Two steps, and the order is the whole safety of it. `leave/begin` stops propagation
 * immediately, so nothing new arrives while the conversion runs; only then is the replica
 * converted and the departure recorded. A device that dies in between has stopped receiving
 * and has not yet left — it can finish later, which is exactly the state a revoked offline
 * device is in.
 *
 * **All of it in one request.** Unlike preparation, which is resumable batches, finalization
 * is checked for completeness: the server refuses a pass that misses a live node. A
 * half-converted replica is a folder whose files its owner can no longer open — silent,
 * permanent, and discovered long after the share is gone — so a partial finish is worse than
 * no finish at all.
 *
 * @param shareKey the `KS` this replica's interior is named under.
 * @param nodes every live node of the replica, the root included.
 * @returns whether this departure ended the share for everybody.
 */
export const leaveShare = async (
  deps: LeaveDeps,
  shareId: string,
  shareKey: Uint8Array,
  shareScopeId: string,
  nodes: readonly PlannedItem[],
): Promise<{ ended: boolean }> => {
  const { ended } = await deps.client.leaveShare(shareId);

  const converted = await Promise.all(
    nodes.map((item) =>
      // The root is in this list and is not like the others: it was already named under
      // `KV`, so re-encrypting its name changes nothing this device could not already read.
      // It is sent anyway, because the server asks for every live node rather than for the
      // ones that happen to need work — and a completeness check with exceptions in it is a
      // check nobody can verify.
      rekey(
        deps,
        item,
        { key: shareKey, scopeId: shareScopeId },
        { key: deps.vaultKey, scopeId: deps.vaultScopeId },
        'skip',
      ),
    ),
  );

  await deps.client.finalizeLeave(shareId, converted.map(asFinalizeNode));
  return { ended };
};
