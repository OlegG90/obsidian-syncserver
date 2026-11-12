/**
 * One vault, opened once, with everything bound to it for the length of one operation.
 *
 * **Not `OpenedVault`, and the near-miss is the point.** `shared` has carried that name since the
 * beginning for what `GET /vaults/:id` returns — the root, the head and the key scopes — and this value
 * *contains* one of those, as `scopes.opened`. Two types one letter apart in meaning and identical in
 * name is how a reader ends up importing the wrong one and only finding out from a field that is not
 * there. **Bound** is what this adds: the client, the scopes and the engine, all bound to one vault id
 * and to one moment.
 *
 * Every operation this plugin performs needs the same four things, and each one used to assemble them by
 * hand: borrow a session handle, read `data.connection!.vaultId`, open the vault to get its
 * `VaultScopes`, and build a `SyncEngine` around all three. Seven call sites did it, nine read the vault
 * id out of the settings object directly, and the rule that held it together — *the vault is opened once
 * per operation, and everything in that operation uses the same opening* — lived in a comment.
 *
 * A comment is not an invariant. An operation that opened the vault twice would have two `VaultScopes`
 * for one vault, and the second could disagree with the first about which share keys arrived — the exact
 * failure `VaultScopes` was built to make impossible **within** one opening.
 *
 * So the opening is the value. `bindVault` is the only thing that makes one — the plugin's `withVault`
 * hands it to an operation, and a sync pass calls it on a session that is already open — so nothing
 * can be assembled by accident, because assembling it is not something a caller does.
 *
 * No session handle rides along. The two operations it was kept for — leaving and inviting, which
 * need a share key sealed to the account — reopened that key from the handle, and `scopes` already
 * holds it (`VaultScopes.shareKey`).
 */
import { ApiError, type SyncClient } from './api/client.js';
import { SyncEngine } from './engine/engine.js';
import type { StateStore } from './engine/state.js';
import type { VaultAdapter } from './engine/vault.js';
import type { Handle } from './session/index.js';
import { VaultScopes } from './share-keys.js';
import { VAULT_GONE } from './vault-removal.js';

export interface BoundVault {
  /** The vault this operation is about — read once, from the connection, and never again by a caller. */
  id: string;
  /** The authenticated client, straight from the session handle. */
  client: SyncClient;
  /** Which key opens which name, for this opening (`CONTEXT.md`). */
  scopes: VaultScopes;
  /** Built from the three above, so no caller can build one for a different vault than it opened. */
  engine: SyncEngine;
  /**
   * Where each node lives, by node id — the tree turned around.
   *
   * A method rather than a field because two callers out of many need it and it costs a read of the
   * whole tree; the ones that do not should not pay for it to exist.
   */
  paths(): Promise<Map<string, string>>;
}

/**
 * What binding a vault takes from the plugin: the pieces only it holds, read once per operation.
 *
 * The vault id is here, once, and the opening, the engine and `id` all take it from this value — so
 * the engine is built for the vault whose scopes it was handed by construction, not because separate
 * reads of the settings happened to agree while the open was in flight.
 */
export interface VaultBinding {
  vaultId: string;
  vault: VaultAdapter;
  store: StateStore;
  /** Named in a conflict file's filename (docs/04). */
  deviceLabel: string;
  /** Synchronise `.obsidian/` configuration (D-7). */
  syncObsidian: boolean;
}

/**
 * Open the vault once and bind everything an operation needs to that opening.
 *
 * **With the share keys**, and that is not optional: reading the tree means decrypting every name,
 * and the interior of any share this vault is in is named under `KS`. An engine built without them
 * fails on the first such name — which is exactly what happened on the first live share, one press
 * after preparation had re-keyed two nodes.
 *
 * A share whose key did not arrive is **not** announced here, though this is where it is
 * discovered: the pass reports it, once, naming the folder (`SyncReport.unreadable`). A notice here
 * said it again on every press of anything.
 *
 * `openIdentity` stays a function all the way down, so the seed never leaves the session to satisfy
 * a share that may not even need the account form.
 */
export const bindVault = async (
  h: Pick<Handle, 'client' | 'kv' | 'userId' | 'openIdentity' | 'treeCache'>,
  b: VaultBinding,
): Promise<BoundVault> => {
  const opened = await h.client.openVault(b.vaultId).catch((e: unknown) => {
    // A vault that is gone is not a broken server, and a bare `404 not_found` surfacing out of the
    // middle of a sync reads exactly like one (#175). Said once, here, because every operation goes
    // through this to reach its tree.
    if (e instanceof ApiError && e.status === 404) throw new Error(VAULT_GONE);
    throw e;
  });
  const scopes = VaultScopes.open(opened, { vaultKey: h.kv, openIdentity: () => h.openIdentity(), userId: h.userId });
  const engine = new SyncEngine(h.client, b.vaultId, scopes, b.vault, b.store, b.deviceLabel, b.syncObsidian, h.treeCache);
  return {
    id: b.vaultId,
    client: h.client,
    scopes,
    engine,
    paths: async () => {
      const tree = await engine.readTree();
      return new Map([...tree.entries()].map(([path, n]) => [n.nodeId, path]));
    },
  };
};
