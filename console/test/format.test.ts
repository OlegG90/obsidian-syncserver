/**
 * What the console says about an account.
 *
 * The rest of this workspace is drawing — `main.ts` reads answers the API already decided
 * and puts them on the page — so this is the one part with a judgement to get wrong, and the
 * judgement is #115's: a console account and a vault account are different things, and only
 * one of them stores anything.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accountBadge, accountKind, accountState, accountUsage, auditAction, freezeWarning, human, mib, serverLine, usageFraction, type AccountLine } from '../src/format.js';

// Both nullable fields are spelled, because `AccountLine` is picked from the shared row now
// (#89) and the server always sends them. Leaving them out built a shape no response has —
// which compiled while they were optional here and stopped compiling when the type stopped
// being a copy.
const line = (over: Partial<AccountLine> = {}): AccountLine => ({
  role: 'user',
  state: 'active',
  quotaBytes: String(10 * 1024 * 1024),
  usedBytes: String(2 * 1024 * 1024),
  frozenAt: null,
  inviteExpiresAt: null,
  ...over,
});

describe('what a row of the accounts table says', () => {
  // One sentence per account became four columns (#123). The judgement did not move: which
  // kind of thing a row IS, and whether storage is even a question about it, are still
  // decided here — a table that answered those in its markup would decide them twice.
  it('names which kind of thing the row is', () => {
    assert.equal(accountKind(line()), 'vault account');
    assert.equal(accountKind(line({ role: 'admin' })), 'console account');
  });

  it('calls an invitation an invitation, because it is not an account yet (#115)', () => {
    assert.equal(accountKind(line({ state: 'provisioned' })), 'invitation');
  });

  it('leaves usage off a console account, which owns no vault (#115)', () => {
    // Its quota is zero by construction, so the honest number reads as a broken one. A dash
    // says "not a question about this row"; a zero would say "asked, and the answer is none".
    assert.equal(accountUsage(line({ role: 'admin', quotaBytes: '0', usedBytes: '0' })), '—');
  });

  it('leaves usage off an invitation, which stores nothing yet', () => {
    assert.equal(accountUsage(line({ state: 'provisioned' })), '—');
  });

  it('shows usage against the quota for a vault account', () => {
    assert.equal(accountUsage(line()), '2.0 MiB of 10.0 MiB');
  });

  it('says the two numbers and nothing about being over them', () => {
    // The card draws a red bar and a marker for that (#123); saying it here as well printed
    // "over its limit" twice on one line, in two weights, inviting a reader to look for a
    // difference that is not there.
    const frozen = line({ frozenAt: '2026-08-17T00:00:00Z' });
    assert.equal(accountUsage(frozen), '2.0 MiB of 10.0 MiB');
    assert.equal(accountState(frozen), 'active', 'and the state stays the state');
  });

  it('badges a frozen account as frozen, which is what changed about it', () => {
    // The badge carries it instead, and outranks the state: disabled and frozen are both "not
    // working now" for different reasons, and the reason is the useful half.
    assert.deepEqual(accountBadge(line({ frozenAt: '2026-08-17T00:00:00Z' })), { text: 'frozen', tone: 'frozen' });
    assert.deepEqual(accountBadge(line()), { text: 'active', tone: 'active' });
    assert.deepEqual(accountBadge(line({ state: 'provisioned' })), { text: 'invitation', tone: 'neutral' });
    assert.deepEqual(accountBadge(line({ role: 'admin' })), { text: 'console', tone: 'neutral' });
  });

  it('caps the bar at full rather than letting it run off the card', () => {
    // A bar overflowing its track reads as a rendering fault; the thing being communicated is
    // an account, not a broken screen. The number beside it stays uncapped and true.
    assert.equal(usageFraction(line({ usedBytes: String(20 * 1024 * 1024) })), 1);
    assert.equal(usageFraction(line({ role: 'admin', quotaBytes: '0' })), 0, 'no limit is not a division');
  });

  it('tells an operator what they want to know about an invitation, not the enum', () => {
    // `provisioned` describes the row; whether it can still be redeemed describes the decision.
    assert.match(accountState(line({ state: 'provisioned', inviteExpiresAt: '2026-08-24T10:00:00Z' })), /^expires /);
    assert.equal(accountState(line({ state: 'provisioned' })), 'unclaimed');
  });

  it('reads bytes as mebibytes, because that is what a quota is set in', () => {
    assert.equal(mib('0'), '0.0 MiB');
    assert.equal(mib(String(1536 * 1024)), '1.5 MiB');
  });

  it('draws a dash for a run with no byte count, rather than a fabricated number', () => {
    // A backup run that failed before either leg ran has no bytes; "0.0 MiB" would be a
    // true statement that reads as a broken one.
    assert.equal(mib(null), '—');
  });
});

describe('what lowering a limit will do, said before it is done', () => {
  const MiB = 1024 * 1024;

  it('says nothing when the new limit is at or above what is stored', () => {
    // Silence is the answer, not an empty string: the caller branches on it to decide whether
    // a confirmation is owed at all.
    assert.equal(freezeWarning(String(10 * MiB), String(2 * MiB)), undefined);
    assert.equal(freezeWarning(String(2 * MiB), String(2 * MiB)), undefined, 'exactly at the limit is not over it');
  });

  it('explains the freeze, and that nothing is deleted', () => {
    // The part operators assume wrongly. Lowering a limit reads like trimming an account, and
    // what actually happens is that the files stay and writes stop (SH-20) — so the sentence
    // has to carry both halves, and the way out.
    const warning = freezeWarning(String(1 * MiB), String(5 * MiB))!;

    assert.match(warning, /5\.0 MiB/, 'what is stored');
    assert.match(warning, /1\.0 MiB/, 'and what it is being lowered to');
    assert.match(warning, /Nothing is deleted/);
    assert.match(warning, /reading and deleting keep working/, 'and the way out');
  });
});

describe('the action column of the audit log', () => {
  const line = (over: Partial<Parameters<typeof auditAction>[0]> = {}) => ({
    action: 'quota.change',
    actorLogin: 'admin',
    targetLogin: 'alice',
    ...over,
  });

  // Only the verb now (#123). Who did it and to whom are columns, which is what a person
  // scans a log by — a sentence put each of those in a different position on every row.
  it('spells the dotted action out', () => {
    assert.equal(auditAction(line()), 'quota changed');
  });

  it('is the same verb whether or not the act had a target', () => {
    // Confirming a restore is done to the server, not to somebody. That is the target
    // column's problem, and it draws a dash — the verb does not change shape for it.
    assert.equal(auditAction(line({ action: 'restore.confirm', targetLogin: null })), 'restore confirmed');
  });

  it('shows an action it does not recognise under its own name', () => {
    // The log is append-only and outlives any particular console build. Hiding an entry
    // because the word is unfamiliar is the one failure a log must not have.
    assert.equal(auditAction(line({ action: 'something.new' })), 'something.new');
  });
});

describe('which server this console is talking to', () => {
  it('names the version', () => {
    assert.equal(serverLine('0.5.0-d'), 'Server 0.5.0-d');
  });

  it('dates a server too old to report one, rather than calling it unknown', () => {
    // `/health` has carried `version` since 0.1.0, so its absence is a fact about the server.
    assert.equal(serverLine(null), 'Server before 0.1.0');
    assert.equal(serverLine(undefined), 'Server before 0.1.0');
  });

  it('keeps "cannot ask" separate from "answered without one"', () => {
    // A console that could not reach /health must not claim the server is ancient. Two
    // different situations, and only one of them is about the server's age.
    assert.equal(serverLine(undefined, false), 'Server version unknown');
    assert.equal(serverLine('0.5.0-d', false), 'Server version unknown');
  });
});
