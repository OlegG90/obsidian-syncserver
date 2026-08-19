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
import { describeAccount, mib, type AccountLine } from '../src/format.js';

const line = (over: Partial<AccountLine> = {}): AccountLine => ({
  role: 'user',
  state: 'active',
  quotaBytes: String(10 * 1024 * 1024),
  usedBytes: String(2 * 1024 * 1024),
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
