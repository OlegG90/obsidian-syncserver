/**
 * What an administrator can do to somebody else's account, and what they cannot.
 *
 * The console is a later milestone; this is the surface underneath it, because inviting,
 * disabling and re-quotaing are server behaviour that a web client merely calls. Written
 * first for the same reason the protocol was: a screen built on top of decisions that have
 * not been made is a screen that makes them by accident.
 *
 * **Three things are refused here by being impossible rather than by being checked.**
 * The last active administrator cannot be demoted, disabled or deleted — a trigger says so
 * (#88), because locking yourself out of your own server is otherwise one keystroke. An
 * account cannot be created server-side, only invited: `pubkey` and the wrapped seed are
 * born on the user's device, and no column here can produce them. And nobody can read
 * anybody's vault, administrator or not, since the server holds no key (AC-08).
 *
 * **Lowering a quota deletes nothing.** It freezes the account (SH-20), across every vault
 * and share at once, with reads and deletions still working — so the answer says how much
 * they are using, and the caller can say that out loud before doing it rather than after.
 */
import type { AccountRow } from '@syncserver/shared';
import { hashToken, newToken } from '../crypto.js';
import type { Db } from '../db.js';
import { refusalFromDatabase, txGuarded, type Refusal } from '../refusal.js';
import { record, type Actor } from './audit.js';

/**
 * Every account, with what it holds and when it was last seen.
 *
 * Usage is summed here rather than read from a counter: `user_blobs` is reconciled nightly
 * and quota counts the row, not the number on it (docs/03), so the sum over the rows *is*
 * the figure — and it is the same one `GET /usage` reports to the user themselves, which is
 * the point. Two numbers for one account is how a support conversation goes wrong.
 */
export const listAccounts = (db: Db): Promise<AccountRow[]> =>
  db.query<AccountRow>(
    `SELECT u.id, u.login, u.state::text AS state, u.role::text AS role,
            u.quota_bytes::text AS "quotaBytes",
            COALESCE((SELECT sum(b.size) FROM user_blobs ub JOIN blobs b ON b.sha256 = ub.sha256
                       WHERE ub.user_id = u.id), 0)::text AS "usedBytes",
            u.frozen_at AS "frozenAt",
            (SELECT max(d.last_seen_at) FROM devices d WHERE d.user_id = u.id) AS "lastSeenAt",
            u.created_at AS "createdAt",
            u.invite_expires_at AS "inviteExpiresAt"
       FROM users u
      WHERE u.state <> 'tombstone'
      ORDER BY u.login`,
  );

/**
 * Create an unclaimed invitation, and hand back the token exactly once.
 *
 * The row *is* the invitation — there is no separate table — which is why revoking one is a
 * `DELETE` and why an account cannot exist half-initialised: the schema's shape constraint
 * refuses a `provisioned` row that carries keys, and refuses a live one that carries a token.
 *
 * **The plaintext is returned and never stored.** Only its hash goes in, so a database dump
 * does not hand somebody an account, and re-reading the invitation later is impossible by
 * construction rather than by policy — which is also why reissuing exists.
 */
export const invite = async (
  db: Db,
  actor: Actor,
  input: { login: string; quotaBytes: string; ttlSeconds: number },
): Promise<{ userId: string; token: string; expiresAt: string } | Refusal> =>
  txGuarded(db, async (c) => {
    const token = newToken();
    const created = await c.query<{ id: string; expires: string }>(
      `INSERT INTO users (login, state, quota_bytes, invite_token_hash, invite_expires_at)
       VALUES ($1, 'provisioned', $2, $3, now() + make_interval(secs => $4::double precision))
       RETURNING id, invite_expires_at AS expires`,
      [input.login, input.quotaBytes, hashToken(token), input.ttlSeconds],
    );
    const row = created.rows[0]!;

    await record(c, {
      actor,
      action: 'account.invite',
      target: { id: row.id, login: input.login },
      details: { quota_bytes: input.quotaBytes, expires_at: row.expires },
    });
    return { userId: row.id, token, expiresAt: row.expires };
  });

/**
 * Issue a fresh token for an invitation nobody redeemed.
 *
 * Not "resend": the old token stops working the moment this returns, because a link that was
 * forwarded to the wrong person is the usual reason to want a new one, and one that quietly
 * kept working would answer the opposite of what was asked.
 */
export const reissue = async (
  db: Db,
  actor: Actor,
  userId: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: string } | Refusal> =>
  txGuarded(db, async (c) => {
    const token = newToken();
    const updated = await c.query<{ login: string; expires: string }>(
      `UPDATE users
          SET invite_token_hash = $2,
              invite_expires_at = now() + make_interval(secs => $3::double precision)
        WHERE id = $1 AND state = 'provisioned'
        RETURNING login, invite_expires_at AS expires`,
      [userId, hashToken(token), ttlSeconds],
    );
    if (updated.rowCount === 0) return { kind: 'not_found' } as Refusal;

    const row = updated.rows[0]!;
    await record(c, { actor, action: 'invitation.reissue', target: { id: userId, login: row.login } });
    return { token, expiresAt: row.expires };
  });

/** Withdraw an invitation nobody redeemed. The row is the invitation, so this removes it. */
export const revokeInvitation = async (db: Db, actor: Actor, userId: string): Promise<Refusal | undefined> =>
  txGuarded(db, async (c) => {
    const gone = await c.query<{ login: string }>(
      `DELETE FROM users WHERE id = $1 AND state = 'provisioned' RETURNING login`,
      [userId],
    );
    if (gone.rowCount === 0) return { kind: 'not_found' } as Refusal;

    await record(c, {
      actor,
      action: 'invitation.revoke',
      target: { id: userId, login: gone.rows[0]!.login },
    });
    return undefined;
  });

/**
 * Switch an account off, or back on. Data is untouched either way.
 *
 * **Sessions go first, and the order is not cosmetic.** A disabled account may not own or
 * write devices — `owned_rows_require_active_user` refuses the row outright — so revoking
 * afterwards would be refused by the very state it is meant to accompany. Revoke, then
 * disable.
 *
 * Enabling does not un-revoke anything: the devices stay signed out and the person signs in
 * again, which is the honest meaning of having been switched off. Re-enabling into live
 * sessions would make "disabled" a pause rather than a state.
 */
export const setEnabled = async (
  db: Db,
  actor: Actor,
  userId: string,
  enabled: boolean,
): Promise<Refusal | undefined> =>
  txGuarded(db, async (c) => {
    const target = await c.query<{ login: string; state: string }>(
      `SELECT login, state::text AS state FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (target.rowCount === 0) return { kind: 'not_found' } as Refusal;
    const row = target.rows[0]!;
    if (row.state === 'provisioned' || row.state === 'tombstone' || row.state === 'deleting') {
      return { kind: 'invalid_write', detail: `an account in state ${row.state} cannot be switched` } as Refusal;
    }

    if (!enabled) {
      await c.query(`UPDATE devices SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    }
    try {
      await c.query(`UPDATE users SET state = $2::user_state WHERE id = $1`, [userId, enabled ? 'active' : 'disabled']);
    } catch (e) {
      // The last-administrator trigger lands here, and it is the one refusal in this module
      // a caller can act on: promote somebody else first.
      const refusal = refusalFromDatabase(e);
      if (refusal) return refusal;
      throw e;
    }

    await record(c, {
      actor,
      action: enabled ? 'account.enable' : 'account.disable',
      target: { id: userId, login: row.login },
      details: { from: row.state },
    });
    return undefined;
  });

/**
 * Change what an account is allowed to hold.
 *
 * The answer reports what they use, because the interesting case is lowering a limit below
 * it: nothing is deleted, the account freezes (SH-20), and everything they have stays
 * exactly where it is with reads and deletions still available. Saying that **before** the
 * change is the difference between a considered decision and a surprise, so the number goes
 * back to the caller rather than being left for them to look up.
 */
export const setQuota = async (
  db: Db,
  actor: Actor,
  userId: string,
  quotaBytes: string,
): Promise<{ usedBytes: string; freezes: boolean } | Refusal> =>
  txGuarded(db, async (c) => {
    const target = await c.query<{ login: string; used: string; quota: string }>(
      `SELECT u.login, u.quota_bytes::text AS quota,
              COALESCE((SELECT sum(b.size) FROM user_blobs ub JOIN blobs b ON b.sha256 = ub.sha256
                         WHERE ub.user_id = u.id), 0)::text AS used
         FROM users u WHERE u.id = $1 AND u.state NOT IN ('provisioned', 'tombstone') FOR UPDATE`,
      [userId],
    );
    if (target.rowCount === 0) return { kind: 'not_found' } as Refusal;
    const row = target.rows[0]!;

    await c.query(`UPDATE users SET quota_bytes = $2 WHERE id = $1`, [userId, quotaBytes]);
    await record(c, {
      actor,
      action: 'quota.change',
      target: { id: userId, login: row.login },
      details: { from: row.quota, to: quotaBytes, used: row.used },
    });

    // Not frozen here. The freeze is `freezeIfOverQuota`, which runs where a write crosses
    // the line, and a second place deciding the same thing is the drift this repository
    // spends its comments on. What this reports is what the next write will find.
    return { usedBytes: row.used, freezes: BigInt(row.used) > BigInt(quotaBytes) };
  });

/**
 * What the storage is doing, for the one screen that has to answer "why is the disk full".
 *
 * Deduplication is reported as the difference between what accounts are charged and what is
 * actually stored, because that is the number somebody is looking for: the same file in two
 * vaults is two claims on one blob (AC-09), and the gap between those two sums is the whole
 * of what sharing and re-uploading save.
 */
export const storage = async (db: Db): Promise<{
  storedBytes: string;
  chargedBytes: string;
  blobs: string;
  quarantined: string;
}> => {
  const row = await db.one<{ stored: string; charged: string; blobs: string; quarantined: string }>(
    `SELECT COALESCE(sum(b.size), 0)::text AS stored,
            count(*)::text AS blobs,
            count(*) FILTER (WHERE b.gc_marked_at IS NOT NULL)::text AS quarantined,
            COALESCE((SELECT sum(b2.size) FROM user_blobs ub JOIN blobs b2 ON b2.sha256 = ub.sha256), 0)::text
              AS charged
       FROM blobs b`,
  );
  return {
    storedBytes: row?.stored ?? '0',
    chargedBytes: row?.charged ?? '0',
    blobs: row?.blobs ?? '0',
    quarantined: row?.quarantined ?? '0',
  };
};

export type AuditRow = {
  id: string;
  at: string;
  actorLogin: string;
  action: string;
  targetLogin: string | null;
  details: Record<string, unknown>;
};

/** The log, newest first. Filterable by who it was about, which is how it is actually read. */
export const listAudit = (db: Db, opts: { targetUserId?: string | undefined; limit: number }): Promise<AuditRow[]> =>
  db.query<AuditRow>(
    `SELECT id::text AS id, at, actor_login AS "actorLogin", action,
            target_login AS "targetLogin", details
       FROM audit_log
      WHERE ($1::uuid IS NULL OR target_user_id = $1)
      ORDER BY id DESC
      LIMIT $2`,
    [opts.targetUserId ?? null, opts.limit],
  );
