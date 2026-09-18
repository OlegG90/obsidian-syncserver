import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { isUuid } from '../uuid.js';

export interface Caller {
  userId: string;
  deviceId: string;
  /**
   * The vault this device syncs, or `null` while the server has not learned it yet (D-139). Filled in by
   * `requireAuth`; a caller built from a token alone — the WebSocket handshake — leaves it out.
   */
  vaultId?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
  interface FastifyInstance {
    /** Decorated by `buildApp`, so a guard can ask the database what a token cannot say (#373). */
    db: Db;
  }
  interface FastifyContextConfig {
    /**
     * This route may reach any vault of the account, not only the caller's own (D-140). One route has it —
     * removing a vault from the list — and it asks for a proof the token cannot carry instead.
     */
    anyVaultOfTheAccount?: boolean;
  }
}

/**
 * The one answer to "who does this token name". The HTTP guard and the WebSocket
 * handshake share it, so a token the API refuses is refused on the socket too — two
 * weaker policies for one server is exactly how the newest path drifts.
 *
 * The access token must name both the account and the **device**, because a caller that
 * is not attributed to a device cannot be throttled and a session that cannot be signed
 * out one device at a time is a session nobody signs out (D-90).
 */
export const verifyCaller = (
  claims: { sub?: string; device?: string } | undefined,
): Caller | undefined => {
  if (!claims?.sub || !claims.device) return undefined;
  return { userId: claims.sub, deviceId: claims.device };
};

/**
 * Every route outside `/auth` runs behind this.
 *
 * **A valid signature is not enough** (#373). Revoking a device stops it minting new access tokens, and
 * the one it holds stays valid for its whole lifetime — fifteen minutes by default. Blobs were the only
 * family that asked, so a phone somebody revoked went on reading notes, writing them and walking the
 * delta until the token aged out, while D-90 and the plugin both say it stops at once. So the guard asks
 * the database, which is the only place that knows.
 *
 * One indexed lookup per request, deliberately uncached: a cache would hold exactly the answer whose
 * being stale is the whole problem, and the server talks to a database on the same machine.
 *
 * The account's state is read with it. An account may not leave `active` while it owns devices, so in
 * practice the devices are revoked first and this is the second line — but a guard that reads one and
 * trusts the other is a guard with a gap in it.
 */
export const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const claims = await req.jwtVerify<{ sub?: string; device?: string }>().catch(() => undefined);
  const caller = verifyCaller(claims);
  if (!caller) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  const device = await liveDevice(req.server.db, caller);
  if (!device) {
    await reply.code(401).send({ error: 'device_revoked' });
    return;
  }
  req.caller = { ...caller, vaultId: device.vaultId };
  if (!(await withinItsVault(req, req.caller))) {
    // The answer another account's vault gets (D-20): which vaults this account holds is not this
    // device's business either (D-140).
    await reply.code(404).send({ error: 'not_found' });
    return;
  }
};

/**
 * This device's row, if it may still act for this account: not revoked, and the account still active.
 * Its vault comes with it, which is what `withinItsVault` checks against.
 */
export const liveDevice = (db: Db, caller: Caller): Promise<{ vaultId: string | null } | undefined> =>
  db.one<{ vaultId: string | null }>(
    `SELECT d.vault_id::text AS "vaultId" FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.id = $1 AND d.user_id = $2 AND d.revoked_at IS NULL AND u.state = 'active'`,
    [caller.deviceId, caller.userId],
  );

/**
 * Whether this request stays inside the vault its device syncs (D-140).
 *
 * A device is a vault connected on a machine (D-139), and its token used to reach every vault of the
 * account. End-to-end encryption already keeps a stolen token from reading anything; what this closes is
 * the rest — listing another vault's tree, writing into it, resetting it, emptying its trash.
 *
 * Checked here rather than in each route, because the vault is named in three ways and a new route would
 * have to remember all three: the `:vaultId` of the path, a `vault_id` in the body (creating a share,
 * joining one), and a share the path names, whose vault is this one's only if this vault takes part.
 *
 * **A device whose vault is not known yet passes.** A device that has just paired has not chosen one,
 * and the first vault it opens becomes its vault (D-139). The console's device never has one, and holds
 * no vault to reach.
 */
const withinItsVault = async (req: FastifyRequest, caller: Caller): Promise<boolean> => {
  const own = caller.vaultId;
  if (!own || req.routeOptions.config.anyVaultOfTheAccount) return true;

  const params = req.params as { vaultId?: string; shareId?: string };
  if (params.vaultId !== undefined && params.vaultId !== own) return false;

  const named = (req.body as { vault_id?: unknown } | undefined)?.vault_id;
  if (typeof named === 'string' && named !== own) return false;

  // A share is this vault's when this account's membership in it lives here — or is still an invitation,
  // which has no vault until it is accepted, and accepting it names this one in the body above.
  if (params.shareId !== undefined && isUuid(params.shareId)) {
    const member = await req.server.db.one<{ ok: boolean }>(
      `SELECT true AS ok FROM share_members
        WHERE share_id = $1 AND user_id = $2 AND (vault_id = $3 OR vault_id IS NULL)`,
      [params.shareId, caller.userId, own],
    );
    if (!member) return false;
  }
  return true;
};
