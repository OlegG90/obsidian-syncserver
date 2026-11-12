/**
 * The four sharing operations on one bound vault: share a folder, invite, accept, leave.
 *
 * `sharing.ts` performs each protocol step and `share-flow.ts` decides when a button may run one.
 * Between them sat the part that ties a step to *this* vault — which tree, which keys, where a
 * file is read from, which badge changes afterwards — and it lived in closures in the plugin's
 * root, where nothing could ask it anything without Obsidian. It is here now, over a `BoundVault`
 * and three things only the plugin has, so the order those closures relied on can be tested:
 * nothing is refused after the server has been changed, and a badge follows the change it marks.
 */
import { replicaForLeave } from './departure.js';
import type { BoundVault } from './bound-vault.js';
import type { InvitationRow } from './share-flow.js';
import { landingFor } from './share-landing.js';
import type { SharedFolderMarks } from './shared-folder-marks.js';
import { acceptInvitation, inviteTo, leaveShare, requireEveryNameReadable, shareFolder, type SharedNode } from './sharing.js';

/** What the operations take from the plugin: the disk, the folder badges, and the one question asked. */
export interface VaultShareDeps {
  /** A file's plaintext, from this vault — dedup tags under a new scope are over it. */
  read(path: string): Promise<Uint8Array>;
  marks: Pick<SharedFolderMarks, 'remember' | 'forget'>;
  /** Asks what to call an accepted folder; `undefined` when the person dismissed the question. */
  askFolderName(suggestion: string): Promise<string | undefined>;
  /** A fresh key scope id for a new share. */
  newScopeId(): string;
}

/** Share a folder of this vault: its subtree re-keyed under a new `KS`, and its badge remembered. */
export const shareFrom = async (v: BoundVault, d: VaultShareDeps, folderPath: string): Promise<{ shareId: string }> => {
  // The tree comes from the engine, which is the one place that turns encrypted names back into
  // paths — and a share is rooted at a node id.
  const tree = await v.engine.readTree();
  const nodes: SharedNode[] = [...tree.entries()].map(([path, n]) => ({ path, nodeId: n.nodeId, address: n.address }));
  const out = await shareFolder(
    {
      client: v.client,
      read: (p) => d.read(p),
      vaultId: v.id,
      vaultKey: v.scopes.vaultKey,
      vaultScopeId: v.scopes.vaultScopeId,
      newScopeId: () => d.newScopeId(),
    },
    folderPath,
    nodes,
  );
  await d.marks.remember(out.shareId, folderPath);
  return { shareId: out.shareId };
};

/** Invite somebody to a share this vault holds, sealing its key to them. */
export const inviteFrom = async (v: BoundVault, shareId: string, login: string): Promise<void> => {
  const { key } = v.scopes.shareKey(shareId);
  await inviteTo({ client: v.client }, shareId, login, key);
};

/**
 * Accept an invitation into this vault, under a name the person chooses.
 *
 * Asked, not invented. The initiator's own label for that folder is under THEIR vault key (SH-01)
 * and cannot be read here — so the joiner names their copy, as docs/05 says they do. Offering who
 * shared it is the one fact this side holds, and it arrived with the invitation the button was
 * drawn from: fetching the whole share list again to recover it was a round trip for a field
 * already on screen (#330). What to offer, what may collide with it, and what to do with the
 * answer are `share-landing.ts`.
 */
export const acceptInto = async (
  v: BoundVault,
  d: VaultShareDeps,
  invitation: InvitationRow,
): Promise<void> => {
  const tree = await v.engine.readTree();
  const landing = landingFor(tree.keys(), invitation.initiatorLogin);
  const name = landing.settle((await d.askFolderName(landing.suggestion)) ?? '');
  await acceptInvitation(
    { client: v.client, vaultId: v.id, vaultKey: v.scopes.vaultKey, vaultScopeId: v.scopes.vaultScopeId },
    invitation.shareId,
    v.scopes.opened.root_node_id,
    name,
  );
  // The replica's root lands directly under the vault root, so its path is its name.
  await d.marks.remember(invitation.shareId, name);
};

/**
 * Leave a share: this vault's copy returns to `KV` and stays, and its badge goes (SH-05).
 *
 * The set to convert is asked of the server rather than assembled from the tree: it includes nodes
 * no listing this client has would show — a folder in the trash carries the mark, has no versions,
 * and appears in neither. Where each node actually LIVES is the tree's, because the server has no
 * paths at all; the dedup tag is over a file's plaintext, so leaving reads it from disk — and a
 * bare name is not a path. `Baby.md` was looked for at the vault root while it sat inside the
 * shared folder.
 */
export const leaveFrom = async (v: BoundVault, d: VaultShareDeps, shareId: string) => {
  const { key, keyId: scopeId } = v.scopes.shareKey(shareId);
  const pathOfNode = await v.paths();
  const rows = await v.client.shareReplica(shareId);

  // Before anything starts, and it has to be before: `leaveShare` opens by stopping propagation,
  // and past that point there is no unaltered share left to refuse on behalf of.
  requireEveryNameReadable(rows, v.scopes);

  const out = await leaveShare(
    { client: v.client, read: (p) => d.read(p), vaultId: v.id, vaultKey: v.scopes.vaultKey, vaultScopeId: v.scopes.vaultScopeId },
    shareId,
    key,
    scopeId,
    replicaForLeave(rows, v.scopes, pathOfNode),
  );
  // What ends is the folder's being shared, not the folder, so the badge is what has to go.
  await d.marks.forget(shareId);
  return out;
};
