/**
 * The sentences the console puts under a login, and nothing else.
 *
 * Separate from `main.ts` because that file touches `document` at import time and can
 * therefore only run in a browser, while this is where the console's actual judgement lives:
 * which of two account kinds a row is, whether usage means anything for it, and whether to
 * say it is over its limit. Those are the parts worth a test, and they are pure.
 */

import type { AccountRow, AuditRow } from '@syncserver/shared';

/**
 * An account as the admin API reports it — the fields this file reads (#89).
 *
 * Picked from the shared row rather than re-declared. It was a field-for-field copy, in the
 * same milestone that moved `AccountRow` into `shared/` *because* the console depended on that
 * package and imported nothing from it. A copy compiles perfectly while the server renames a
 * column underneath it, and the value arrives as `undefined` in a table.
 *
 * Still a `Pick` and not the whole row: which fields this file's judgement rests on is worth
 * saying, and saying it this way means a rename breaks the pick instead of a screen.
 *
 * `role` and `state` stay `string`, which is what the shared row already says — widening JSON
 * into a union here would be this file claiming to have validated what it only read.
 */
export type AccountLine = Pick<
  AccountRow,
  'role' | 'state' | 'quotaBytes' | 'usedBytes' | 'frozenAt' | 'inviteExpiresAt'
>;

/** Bytes as something a person reads. Mebibytes, because quotas are set in them. A `null` is "no number", drawn as a dash. */
export const mib = (bytes: string | null): string =>
  bytes === null ? '—' : `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * Bytes at whatever scale makes them readable.
 *
 * Separate from `mib`, which stays: the quota FIELD is in mebibytes because that is the unit
 * an operator types, and a field that showed "9.3 GiB" and expected a number back would be
 * asking a question in one unit and reading the answer in another. Display picks the unit;
 * input does not get to.
 */
export const human = (bytes: string | null): string => {
  if (bytes === null) return '—';
  const n = Number(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
};

/**
 * How full this account is, as a fraction for the bar — **capped at one**.
 *
 * Over the limit is drawn as full-and-red, not as a bar running past the edge of its card: a
 * bar overflowing its track reads as a rendering fault, and the thing being communicated is
 * an account, not a broken screen. The number beside it is uncapped and says the truth.
 *
 * A zero quota answers zero rather than dividing by it — that is the console account, which
 * has no limit to be a fraction of.
 */
export const usageFraction = (a: AccountLine): number => {
  const quota = Number(a.quotaBytes);
  if (!(quota > 0)) return 0;
  return Math.min(1, Number(a.usedBytes) / quota);
};

/**
 * The badge under a login: what to write in it, and which of three tones it takes.
 *
 * `frozen` outranks the state, because it is the one that changes what the account can DO —
 * a disabled account and a frozen one are both "not working right now" for different reasons,
 * and the reason is the useful half.
 */
export const accountBadge = (a: AccountLine): { text: string; tone: 'active' | 'frozen' | 'neutral' } => {
  if (a.state === 'provisioned') return { text: 'invitation', tone: 'neutral' };
  if (a.role === 'admin') return { text: 'console', tone: 'neutral' };
  if (a.frozenAt) return { text: 'frozen', tone: 'frozen' };
  return { text: a.state, tone: a.state === 'active' ? 'active' : 'neutral' };
};

/**
 * What kind of thing this row is.
 *
 * Three, not two, and the third is the one that matters: **an invitation is not an account
 * yet** (#115). It has a login and a quota and nothing else — no keys, no vault, nobody has
 * claimed it — so calling it an account in the kind column would be the table asserting
 * something the row does not support.
 */
export const accountKind = (a: AccountLine): string =>
  a.state === 'provisioned' ? 'invitation' : a.role === 'admin' ? 'console account' : 'vault account';

/**
 * Where this row stands, in the words the state means rather than the enum's spelling.
 *
 * An invitation reports what an operator actually wants to know about one — whether it can
 * still be redeemed — because `provisioned` describes the row and the date describes the
 * decision.
 */
export const accountState = (a: AccountLine): string => {
  if (a.state !== 'provisioned') return a.state;
  return a.inviteExpiresAt ? `expires ${new Date(a.inviteExpiresAt).toLocaleDateString()}` : 'unclaimed';
};

/**
 * What this account is storing, or a dash where the question does not apply.
 *
 * **Omitted for a console account and for an invitation**, and not because it would look
 * untidy: a console account owns no vault and holds a zero quota (#115), so "0.0 MiB of
 * 0.0 MiB" would be a true statement that reads as a broken one, and an invitation has not
 * become an account yet. A dash says "not a question about this row"; a zero says "this row
 * answered, and the answer is nothing".
 *
 * **Just the two numbers.** Being over the limit is said by the bar and by the marker beside
 * it (#123), and this used to append it as well — so a frozen account read "over its limit"
 * twice on one line, in two different weights, which makes a reader look for the difference
 * between them. There is none. One fact, one place.
 */
export const accountUsage = (a: AccountLine): string => {
  if (a.role === 'admin' || a.state === 'provisioned') return '—';
  return `${mib(a.usedBytes)} of ${mib(a.quotaBytes)}`;
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
 * What was done, as a person reads it.
 *
 * The action is a dotted machine name (`quota.change`), which is right for a column that gets
 * filtered and wrong for one that gets read, so it is spelled out. An action this build does
 * not recognise is still shown under its own name — the log is append-only and older than any
 * particular console, so hiding an entry because the word is unfamiliar would be the one
 * failure a log must not have.
 *
 * Only the verb. Who did it and to whom are columns of their own now (#123): a sentence per
 * row read well at seven rows and stopped reading at seventy, and the parts a person scans a
 * log for — one actor, one target, one action — are exactly the parts a sentence buries in
 * the middle of itself.
 */
export const auditAction = (entry: AuditLine): string => ACTIONS[entry.action] ?? entry.action;

/**
 * The audit fields this file reads, picked from the wire shape rather than restated.
 *
 * The docblock here already said the shape "is `AuditRow` in `shared/`" — a comment doing the
 * work a type could, and the same copy `AccountLine` was.
 */
export type AuditLine = Pick<AuditRow, 'action' | 'actorLogin' | 'targetLogin'>;

/**
 * Every action the server records today, spelled out. Taken from the `record()` call sites
 * rather than invented — a map of names nothing writes would read as coverage and be none.
 */
const ACTIONS: Record<string, string> = {
  'account.bootstrap': 'first administrator created',
  'account.invite': 'invited',
  'account.activate': 'invitation redeemed',
  'account.recover': 'account recovered',
  'account.recovery_code': 'recovery code set',
  'account.delete.begin': 'deletion started',
  'account.delete.finish': 'deletion finished',
  'account.enable': 'enabled',
  'account.disable': 'disabled',
  'invitation.reissue': 'invitation reissued',
  'invitation.revoke': 'invitation revoked',
  'quota.change': 'quota changed',
  'restore.confirm': 'restore confirmed',
};

/**
 * The version line under the sign-out button: which server this console is talking to.
 *
 * **One number, not two.** The console is served BY the server — its assets are in the same
 * image — so its own build and the server's are the same string by construction, and printing
 * both would invite somebody to compare two numbers that cannot differ. That is the opposite
 * of the plugin's line, which shows both precisely because they can (#111).
 *
 * A server too old to report one is not an unknown: `/health` has carried `version` since
 * 0.1.0, so its absence dates the server rather than hiding it. `undefined` from a failed
 * request is a different thing and says so — a console that cannot reach `/health` should not
 * claim the server is ancient.
 */
export const serverLine = (version: string | null | undefined, reachable = true): string => {
  if (!reachable) return 'Server version unknown';
  return `Server ${version ?? 'before 0.1.0'}`;
};
