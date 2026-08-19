/**
 * Which local folder each live share is, and the badge that says so in the file tree.
 *
 * Six closures on the plugin class owned this once: `resolveSharedFolders`, `pathsByNode`,
 * `refreshSharedFolders`, `rememberShared`, `forgetShared`, `applySharedMarks`. None of them
 * could be tested — they were bound to the class, and the tree-read cost decision was spelled
 * twice (list resolved unconditionally; refresh guarded on the id list). The one rule they
 * all circled is what lives here: *a share is the folder its root node resolves to in THIS
 * vault*.
 *
 * Everything Obsidian or the server is a port, bound in `main.ts` at the edge exactly like
 * the other coordinators. The module owns the map, the reconcile guard, and the decision of
 * what to draw; a fake port is all a test needs.
 */
import { sharedFolderCss } from './obsidian/shared-marks.js';
import type { ShareRow } from './share-flow.js';

/**
 * What `GET /shares` says about one share this account is in, cut to what the marks need.
 *
 * `vault_id` is omitted on purpose — nothing here cares which vault a share was created in,
 * only where its root lands in this one.
 */
export interface JoinedShareWire {
  share_id: string;
  is_initiator: boolean;
  state: string;
  /** This member's OWN root for the share — a different node in each participant's vault. */
  root_node_id: string | null;
}

/** What the marks module needs that only main.ts can supply. */
export interface SharedFolderMarksDeps {
  /** The persisted map, keyed by share id. Absent when this device has never shared anything. */
  load(): Record<string, string>;
  /** Persist the whole map — the map lives in `PluginData`, and that is main.ts's field. */
  save(map: Record<string, string>): Promise<void>;
  /**
   * Turn each share into the path of its folder in this vault.
   *
   * The one expensive step, bound to a tree read: only the client can turn a node id into a
   * path, because only it can read a name. A share whose root has not been synced here yet
   * simply has no folder in the result.
   */
  resolve(joined: readonly { share_id: string; root_node_id: string | null }[]): Promise<Map<string, string>>;
  /** The subset of these paths that still exist on disk — a renamed folder gets no badge. */
  existing(paths: readonly string[]): readonly string[];
  /** Put the badge stylesheet on screen, or take it away. */
  render(css: string): void;
}

export interface SharedFolderMarks {
  /**
   * The one reconciliation rule: resolve when the share list changed, always return the rows.
   *
   * `list` and a sync pass both land here, so the tree-read cost decision is spelled once.
   * The guard compares `share_id:root_node_id` pairs rather than ids alone — a share that
   * survives a re-materialisation keeps its id but changes its root, and a list that did not
   * notice would keep offering the old path as a badge. It also re-resolves when a stored
   * path is gone from disk — the rename case, where nothing on the server moved but the
   * badge would otherwise stay filtered out until the settings screen happened to repair it.
   */
  reconcile(joined: readonly JoinedShareWire[]): Promise<ShareRow[]>;
  /** This device has just shared or joined a folder, and knows which one it is. */
  remember(shareId: string, folderPath: string): Promise<void>;
  /** The share is over for this device; the folder is not, and keeps everything but the badge. */
  forget(shareId: string): Promise<void>;
  /** Every share is over: this device left the server entirely. */
  clear(): Promise<void>;
  /** Draw the badge from what was written down — no session, no server, no tree read. */
  applyMarks(): void;
}

export const openSharedFolderMarks = (deps: SharedFolderMarksDeps): SharedFolderMarks => {
  let map: Record<string, string> = deps.load();
  // `undefined` so the first reconcile always resolves: a map that predates this feature is
  // exactly the state that needs fixing, and an empty list must still reach the server's side.
  let lastKey: string | undefined;

  /** The badge, redrawn from the current map. Always cheap — only the resolve is expensive. */
  const applyMarks = (): void => {
    deps.render(sharedFolderCss(deps.existing(Object.values(map))));
  };

  const guardKey = (joined: readonly JoinedShareWire[]): string =>
    joined
      .map((s) => `${s.share_id}:${s.root_node_id ?? ''}`)
      .sort()
      .join(',');

  const reconcile = async (joined: readonly JoinedShareWire[]): Promise<ShareRow[]> => {
    const key = guardKey(joined);
    // The rename case: nothing on the server moved, but a stored path that is gone from
    // disk means the badge would be filtered out until the settings screen happened to
    // repair it — so a vanished path is as much a reason to re-resolve as a changed id.
    const storedPaths = Object.values(map);
    const vanished = deps.existing(storedPaths).length < storedPaths.length;
    if (key !== lastKey || vanished) {
      map = Object.fromEntries(await deps.resolve(joined));
      await deps.save(map);
      lastKey = key;
    }
    applyMarks();
    return joined.map((s) => {
      const folder = map[s.share_id];
      return {
        shareId: s.share_id,
        isInitiator: s.is_initiator,
        state: s.state,
        ...(folder === undefined ? {} : { folder }),
      };
    });
  };

  const remember = async (shareId: string, folderPath: string): Promise<void> => {
    map = { ...map, [shareId]: folderPath };
    await deps.save(map);
    applyMarks();
  };

  const forget = async (shareId: string): Promise<void> => {
    if (!(shareId in map)) return;
    const { [shareId]: _gone, ...rest } = map;
    map = rest;
    await deps.save(map);
    applyMarks();
  };

  const clear = async (): Promise<void> => {
    map = {};
    lastKey = undefined;
    await deps.save(map);
    applyMarks();
  };

  return { reconcile, remember, forget, clear, applyMarks };
};
