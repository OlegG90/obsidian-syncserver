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

/** Bytes as something a person reads. Mebibytes, because quotas are set in them. */
export const mib = (bytes: string): string => `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;

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
