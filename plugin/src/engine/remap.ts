/**
 * The rewrite a folder move leaves behind, in the walk's own two views.
 *
 * A folder move is one call to the server, and then two maps this pass is holding are wrong: the tree it
 * walked still says the children are at their old paths, and the local state still remembers them there.
 * Neither can be re-read — the tree was decrypted once at the top of the pass, and re-reading it mid-pass
 * would cost a second full listing and see a different moment.
 *
 * **So the rewrite is a transformation, and here it is one in the type as well.** It used to be two
 * methods reaching into a `PassContext` to mutate two of its thirteen fields, which meant the only way to
 * ask "does this rewrite handle a folder moved to the vault root" was to stage a whole pass and infer the
 * answer from what got uploaded. Given a map and two paths, it now answers directly.
 *
 * **The empty `from` or `to` is the vault root**, which is why the prefixes are built rather than
 * concatenated: `''` must not become `'/'`, and a node AT `from` is renamed rather than re-parented.
 */
import type { VaultState } from './state.js';
import type { ServerNode } from './wire.js';

/**
 * The walked tree with `from/…` rewritten to `to/…`, and the moved folder itself carrying its new rev.
 *
 * The rev matters and only for the folder: the server just moved it, so the pass's copy is one behind,
 * and a later write against the stale number would be refused as a conflict it is not.
 */
export const remapTree = (
  tree: Map<string, ServerNode>,
  from: string,
  to: string,
  rev: number,
): Map<string, ServerNode> => {
  const prefix = from ? `${from}/` : '';
  const dest = to ? `${to}/` : '';
  const next = new Map<string, ServerNode>();
  for (const [path, node] of tree) {
    if (path === from) {
      next.set(to, { ...node, path: to, rev });
    } else if (path.startsWith(prefix)) {
      const moved = dest + path.slice(prefix.length);
      next.set(moved, { ...node, path: moved });
    } else {
      next.set(path, node);
    }
  }
  return next;
};

/**
 * The same rewrite over what this device remembers, so the moved files are known at their new paths.
 *
 * No rev here: state records what was last seen per path, and the move changed where, not what.
 */
export const remapState = (nodes: VaultState['nodes'], from: string, to: string): VaultState['nodes'] => {
  const prefix = from ? `${from}/` : '';
  const dest = to ? `${to}/` : '';
  const next: VaultState['nodes'] = {};
  for (const [path, known] of Object.entries(nodes)) {
    next[path.startsWith(prefix) ? dest + path.slice(prefix.length) : path] = known;
  }
  return next;
};
