/**
 * How long a console session lasts, and what it does when its access token runs out.
 *
 * This workspace used to have exactly one judgement worth testing — the sentence under a
 * login — because everything else read an answer the API had already decided. Renewing is the
 * second: which refusal means "get a new token", how many times to try, and what a caller sees
 * when the answer is no. All three are decisions this file makes and no server can make for it.
 *
 * `fetch` is stubbed rather than a server started. What is under test is the rule, and a rule
 * about retrying is easiest to state as "these requests, in this order".
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ApiError, accounts, forgetSession, signIn } from '../src/api.js';

type Answer = { status: number; body: unknown };

/** The requests that were made, in order, and canned answers to give back. */
const stub = (answers: Answer[]): string[] => {
  const seen: string[] = [];
  globalThis.fetch = (async (path: string, init?: { method?: string }) => {
    seen.push(`${init?.method ?? 'GET'} ${path}`);
    const next = answers.shift();
    if (!next) throw new Error(`no answer left for ${path}`);
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  }) as unknown as typeof fetch;
  return seen;
};

const ok = (body: unknown = {}): Answer => ({ status: 200, body });
const expired: Answer = { status: 401, body: { error: 'unauthenticated' } };

/** Sign in, so both halves of the session are held, and forget the requests it took. */
const signedIn = async (): Promise<void> => {
  stub([ok({ access: 'first', refresh: 'r1' })]);
  await signIn('admin', 'pw');
};

afterEach(() => forgetSession());

describe('a console session that outlives its access token', () => {
  it('renews once and repeats the request that was refused', async () => {
    await signedIn();
    const seen = stub([expired, ok({ access: 'second' }), ok({ accounts: [] })]);

    await accounts();

    assert.deepEqual(seen, ['GET /admin/accounts', 'POST /auth/refresh', 'GET /admin/accounts']);
  });

  it('gives up after one renewal rather than asking a third token', async () => {
    // A renewed call refused again has been refused for a reason another token will not
    // change. Retrying on would be a page that hangs instead of one that says so.
    await signedIn();
    const seen = stub([expired, ok({ access: 'second' }), expired]);

    await assert.rejects(() => accounts(), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
    assert.equal(seen.filter((r) => r.includes('/auth/refresh')).length, 1, 'renewed once, not twice');
  });

  it('surfaces the refusal when the refresh itself is refused', async () => {
    // The device was revoked, or the token is spent. The caller's next move is the sign-in
    // screen (D-101), which needs to see the original refusal rather than a refresh failure.
    await signedIn();
    stub([expired, { status: 401, body: { error: 'invalid_refresh' } }]);

    await assert.rejects(() => accounts(), (e: unknown) => e instanceof ApiError && e.code === 'unauthenticated');
  });

  it('does not renew for a refusal that a new token cannot answer', async () => {
    // `forbidden` is a demoted or disabled administrator; a fresh token says the same thing.
    // Only `unauthenticated` means "this token is no good", which is why D-101 matches on the
    // code and not on the status.
    await signedIn();
    const seen = stub([{ status: 403, body: { error: 'forbidden' } }]);

    await assert.rejects(() => accounts(), (e: unknown) => e instanceof ApiError && e.code === 'forbidden');
    assert.deepEqual(seen, ['GET /admin/accounts'], 'no refresh was attempted');
  });

  it('has nothing to renew with once the session is forgotten', async () => {
    await signedIn();
    forgetSession();
    const seen = stub([expired]);

    await assert.rejects(() => accounts(), (e: unknown) => e instanceof ApiError);
    assert.deepEqual(seen, ['GET /admin/accounts'], 'both halves went, so there was nothing to try');
  });
});
