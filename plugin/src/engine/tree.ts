/**
 * A flat listing turned into the tree this pass walks, and the folders it could not read.
 *
 * The server sends nodes, not paths: it holds `name_enc` and no key, so **the path of every node is
 * something this device works out** by decrypting each name and hanging it off its parent's path. That
 * is the whole of what happens here, and two of its rules are easy to get subtly wrong.
 *
 * **A node under something skipped is skipped, without a second complaint.** A folder whose share key
 * never arrived has no readable name, so nothing below it has a path to be built from either. The
 * cascade is why `skipped` exists; reporting each descendant would turn one missing key into a list as
 * long as the folder, and the person can act on the folder.
 *
 * **The report is per scope, not per node** — one missing key is one thing to fix, however many nodes
 * sit under it — and it names the *parent* path, because the unreadable node's own name is exactly what
 * could not be read.
 *
 * **A file is a node with an address; a folder is one without.** The server does not label them, and
 * asking it to would be asking it to know something about content it cannot see.
 *
 * Extracted from the walk so these can be asserted directly. They were reachable only through a pass
 * against a live server, which is a slow way to ask whether one missing key produces one entry or ten.
 */
import type { Change } from '@syncserver/shared';
import { decryptName } from '../crypto/scope.js';
import type { ServerNode } from './wire.js';

/**
 * A shared folder this pass could not read, and therefore must leave alone on both sides.
 *
 * One entry per SHARE, not per file: one undelivered key makes every name inside a folder
 * unreadable together, so a list per node would be the same fact repeated as many times as
 * the folder has files. The `path` is the folder itself, which is readable because a share
 * root's own label is under `KV` (SH-01) — it is both what a person needs told and what the
 * walk must not treat as its business.
 */
export interface UnreadableFolder {
  path: string;
  scopeId: string;
}

/**
 * The keys this reads names with — the two methods it uses, not the class (`CONTEXT.md`, VaultScopes).
 *
 * `keyIfOpenable` is the lenient form on purpose: a share whose key has not arrived is a state to report
 * and carry on from, not a pass that stops.
 */
export interface NameKeys {
  vaultKey: Uint8Array;
  keyIfOpenable(nameKeyId: string | null | undefined): Uint8Array | undefined;
}

export const treeFrom = (
  nodes: readonly Change[],
  rootNodeId: string,
  keys: NameKeys,
): { tree: Map<string, ServerNode>; unreadable: UnreadableFolder[] } => {
  const pathOf = new Map<string, string>([[rootNodeId, '']]);
  const tree = new Map<string, ServerNode>();
  const skipped = new Set<string>();
  const unreadable: UnreadableFolder[] = [];

  for (const n of nodes) {
    if (n.node_id === rootNodeId) continue;
    if (n.parent_id && skipped.has(n.parent_id)) {
      skipped.add(n.node_id);
      continue;
    }
    const parentPath = pathOf.get(n.parent_id ?? '') ?? '';
    // A node's name is encrypted under the scope it is named in — the vault's, or a share's `KS` for a
    // node inside a shared folder (SH-28). The wire names that scope.
    const key = n.name_enc ? keys.keyIfOpenable(n.name_key_id) : keys.vaultKey;
    if (!key) {
      skipped.add(n.node_id);
      // An empty parent path would mean excluding the whole vault, which no missing share key can
      // justify. It is also unreachable — a node named under a share scope has a share root above it,
      // and that root is never the vault root.
      const scopeId = n.name_key_id!;
      if (parentPath && !unreadable.some((u) => u.scopeId === scopeId)) {
        unreadable.push({ path: parentPath, scopeId });
      }
      continue;
    }
    const name = n.name_enc ? decryptName(key, n.name_enc) : n.node_id;
    const path = parentPath ? `${parentPath}/${name}` : name;
    pathOf.set(n.node_id, path);

    tree.set(path, {
      nodeId: n.node_id,
      parentId: n.parent_id,
      path,
      rev: n.rev,
      address: n.sha256,
      isFile: n.sha256 !== null,
      nameKeyId: n.name_key_id,
      shareId: n.share_id,
    });
  }

  return { tree, unreadable };
};
