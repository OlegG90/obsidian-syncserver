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
import { describeAccount, describeAudit, freezeWarning, mib, type AccountLine } from '../src/format.js';

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

describe('a line under a login', () => {
  it('names which kind of account it is', () => {
    assert.match(describeAccount(line()), /^vault account · active/);
    assert.match(describeAccount(line({ role: 'admin' })), /^console account · active/);
  });

  it('leaves usage off a console account, which owns no vault (#115)', () => {
    // Its quota is zero by construction, so the honest number reads as a broken one.
    const admin = describeAccount(line({ role: 'admin', quotaBytes: '0', usedBytes: '0' }));
    assert.equal(admin, 'console account · active');
    assert.doesNotMatch(admin, /MiB/);
  });

  it('shows usage against the quota for a vault account', () => {
    assert.equal(describeAccount(line()), 'vault account · active · 2.0 MiB of 10.0 MiB');
  });

  it('says an invitation is one, and when it runs out', () => {
    const invited = describeAccount(line({ state: 'provisioned', inviteExpiresAt: '2026-08-24T10:00:00Z' }));
    assert.match(invited, /^invitation, expires /);
    assert.doesNotMatch(invited, /MiB/, 'nothing is stored yet');
  });

  it('says an account is over its limit, whatever else is true of it', () => {
    assert.match(describeAccount(line({ frozenAt: '2026-08-17T00:00:00Z' })), / · over its limit$/);
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

describe('one line of the audit log', () => {
  const line = (over: Partial<Parameters<typeof describeAudit>[0]> = {}) => ({
    action: 'quota.change',
    actorLogin: 'admin',
    targetLogin: 'alice',
    ...over,
  });

  it('spells the dotted action out, and names both parties', () => {
    assert.equal(describeAudit(line()), 'quota changed — alice, by admin');
  });

  it('leaves the target out when an act was about nobody in particular', () => {
    assert.equal(describeAudit(line({ action: 'restore.confirm', targetLogin: null })), 'restore confirmed, by admin');
  });

  it('shows an action it does not recognise under its own name', () => {
    // The log is append-only and outlives any particular console build. Hiding an entry
    // because the word is unfamiliar is the one failure a log must not have.
    assert.equal(describeAudit(line({ action: 'something.new' })), 'something.new — alice, by admin');
  });
});
