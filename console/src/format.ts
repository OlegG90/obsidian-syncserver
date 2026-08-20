/**
 * The sentences the console puts under a login, and nothing else.
 *
 * Separate from `main.ts` because that file touches `document` at import time and can
 * therefore only run in a browser, while this is where the console's actual judgement lives:
 * which of two account kinds a row is, whether usage means anything for it, and whether to
 * say it is over its limit. Those are the parts worth a test, and they are pure.
 */

/** An account as the admin API reports it — the fields this file reads. */
export interface AccountLine {
  // Both are `string` rather than unions of the enum's values, because that is what arrives:
  // widening them here would be this file claiming to have validated JSON it only read.
  role: string;
  state: string;
  quotaBytes: string;
  usedBytes: string;
  frozenAt?: string | null;
  inviteExpiresAt?: string | null;
}

/** Bytes as something a person reads. Mebibytes, because quotas are set in them. A `null` is "no number", drawn as a dash. */
export const mib = (bytes: string | null): string =>
  bytes === null ? '—' : `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * One line describing what an account is and how it is doing.
 *
 * **Usage is omitted for a console account and for an invitation**, and not because it would
 * look untidy: a console account owns no vault and holds a zero quota (#115), so "0.0 MiB of
 * 0.0 MiB" would be a true statement that reads as a broken one, and an invitation has not
 * become an account yet.
 */
export const describeAccount = (a: AccountLine): string => {
  const what =
    a.state === 'provisioned'
      ? `invitation${a.inviteExpiresAt ? `, expires ${new Date(a.inviteExpiresAt).toLocaleDateString()}` : ''}`
      : `${a.role === 'admin' ? 'console' : 'vault'} account · ${a.state}`;

  const storing = a.role !== 'admin' && a.state !== 'provisioned';
  const usage = storing ? ` · ${mib(a.usedBytes)} of ${mib(a.quotaBytes)}` : '';

  return `${what}${usage}${a.frozenAt ? ' · over its limit' : ''}`;
};

/**
 * What lowering a limit to this number will do, said BEFORE it is applied.
 *
 * The server answers the same question after the fact — `setQuota` returns `freezes` computed
 * inside the transaction that wrote the change — and that is the authoritative answer. This is
 * the one shown first, from the usage the accounts list already carries, because an operator
 * asked to confirm needs to know what they are confirming.
 *
 * The sentence carries the consequence rather than the word: "frozen" tells somebody nothing
 * they can act on, while naming that reads and deletions keep working says both what breaks
 * and what the way out is (SH-20). Nothing is deleted, ever — that is the part people assume
 * wrongly about a lowered quota, and the reason this is a confirmation and not a warning.
 *
 * @returns the sentence, or `undefined` when the new limit is at or above what is stored.
 */
export const freezeWarning = (newQuotaBytes: string, usedBytes: string): string | undefined => {
  if (BigInt(newQuotaBytes) >= BigInt(usedBytes)) return undefined;
  return (
    `This account already stores ${mib(usedBytes)}, which is more than ${mib(newQuotaBytes)}. ` +
    'Nothing is deleted. The account freezes: nothing that grows usage is accepted, while ' +
    'reading and deleting keep working — deleting is the way out.'
  );
};

/**
 * One line of the audit log as a person reads it.
 *
 * The action is a dotted machine name (`quota.change`), which is right for a column that gets
 * filtered and wrong for one that gets read, so it is spelled out. An action this build does
 * not recognise is still shown under its own name — the log is append-only and older than any
 * particular console, so hiding an entry because the word is unfamiliar would be the one
 * failure a log must not have.
 */
export const describeAudit = (entry: AuditLine): string => {
  const target = entry.targetLogin ? ` — ${entry.targetLogin}` : '';
  return `${ACTIONS[entry.action] ?? entry.action}${target}, by ${entry.actorLogin}`;
};

/** The audit fields this file reads; the wire shape is `AuditRow` in `shared/`. */
export interface AuditLine {
  action: string;
  actorLogin: string;
  targetLogin: string | null;
}

/**
 * Every action the server records today, spelled out. Taken from the `record()` call sites
 * rather than invented — a map of names nothing writes would read as coverage and be none.
 */
const ACTIONS: Record<string, string> = {
  'account.bootstrap': 'first administrator created',
  'account.invite': 'invited',
  'account.activate': 'invitation redeemed',
  'account.recover': 'account recovered',
  'account.delete.begin': 'deletion started',
  'account.delete.finish': 'deletion finished',
  'account.enable': 'enabled',
  'account.disable': 'disabled',
  'invitation.reissue': 'invitation reissued',
  'invitation.revoke': 'invitation revoked',
  'quota.change': 'quota changed',
  'restore.confirm': 'restore confirmed',
};
