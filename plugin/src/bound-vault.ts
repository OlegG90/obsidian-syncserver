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
 * So the opening is the value. `withVault` hands one out; nothing else can be assembled by accident,
 * because assembling it is no longer something a caller does.
 *
 * **`handle` is still here**, and deliberately narrow in use: two operations need the account identity
 * rather than the vault (receiving a share is sealed to the account, not to a vault), and hiding it
 * would only make those two reach around this value instead of through it.
 */
import type { SyncClient } from './api/client.js';
import type { SyncEngine } from './engine/engine.js';
import type { Handle } from './session/session.js';
import type { VaultScopes } from './share-keys.js';

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
  /** The session handle, for the two operations whose subject is the account rather than the vault. */
  handle: Handle;
}
