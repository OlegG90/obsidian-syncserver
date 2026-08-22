/**
 * The append-only record of what an administrator did to somebody else's account.
 *
 * One statement, in one place, for the reason the journal's statement is: a table written
 * from several modules is a table whose rows disagree about their own shape, and this one is
 * `INSERT`-only by trigger (D-87) — there is no correcting a row later, so a field forgotten
 * at the call site is forgotten for good.
 *
 * **The logins are snapshots, and the columns carry no foreign key** (D-93). An account can be
 * renamed or deleted, and the record has to keep naming who did what — "quota raised by an
 * account that no longer exists" is still the answer to the question somebody is asking six
 * months later, and a `CASCADE` would have erased exactly that.
 *
 * This is not compliance theatre on a family server. It is how a mistake is told from a
 * misunderstanding, and it is the only witness to the two acts nobody else sees: an account
 * recovered with nothing but a passphrase, and an administrator changing what somebody else
 * is allowed to hold.
 */
import type { PoolClient } from 'pg';

/** Who acted. Carried by value because the log outlives the row it came from. */
export interface Actor {
  id: string;
  login: string;
}

/**
 * Record one administrative act.
 *
 * `action` is a dotted name — `account.invite`, `account.disable`, `quota.change` — because
 * the log is read by a person scanning it, and a verb without its subject means re-reading
 * the details column to find out what was touched.
 */
export const record = async (
  c: PoolClient,
  entry: {
    actor: Actor;
    action: string;
    target?: Actor;
    /** Anything the sentence needs and the columns do not have: old and new values, a reason. */
    details?: Record<string, unknown>;
  },
): Promise<void> => {
  await c.query(
    `INSERT INTO audit_log (actor_user_id, actor_login, action, target_user_id, target_login, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.actor.id,
      entry.actor.login,
      entry.action,
      entry.target?.id ?? null,
      entry.target?.login ?? null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
};
