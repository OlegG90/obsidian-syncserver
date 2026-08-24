/**
 * `SyncClient` against a fake transport: the refresh-on-401 retry, its de-duplication under
 * concurrency, and the timeout. None of this needs a server — it is a property of the client
 * alone, which is the point of the transport seam.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError, SyncClient } from '../src/api/client.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/api/transport.js';

const ok = (body: unknown, status = 200): HttpResponse => {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  return { status, headers: {}, text: () => text, bytes };
};
const fail = (status: number, error: string): HttpResponse => ok({ error }, status);

describe('SyncClient refreshes an expired access token', () => {
  it('retries the original request once the refresh succeeds', async () => {
    const calls: string[] = [];
    const transport: Transport = async (req) => {
      calls.push(`${req.method} ${req.url}`);
      if (req.url.endsWith('/usage')) {
        // Expired on the first try, good on the second — the retry IS the assertion.
        return calls.filter((c) => c.endsWith('/usage')).length === 1 ? fail(401, 'unauthenticated') : ok({ used: 1, quota: 2, frozen: false });
      }
      if (req.url.endsWith('/auth/refresh')) return ok({ access: 'new-access' });
      throw new Error(`unexpected request: ${req.url}`);
    };

    const client = new SyncClient('http://x', transport);
    client.setAccessToken('stale-access');
    client.setRefreshToken('a-refresh-token');

    const usage = await client.usage();
    assert.deepEqual(usage, { used: 1, quota: 2, frozen: false });
    assert.deepEqual(calls, ['GET http://x/usage', 'POST http://x/auth/refresh', 'GET http://x/usage']);
  });

  it('sends exactly one /auth/refresh for several requests that 401 together', async () => {
    let refreshes = 0;
    let refreshed = false;
    const transport: Transport = async (req) => {
      if (req.url.endsWith('/auth/refresh')) {
        refreshes++;
        refreshed = true;
        return ok({ access: 'new-access' });
      }
      if (req.url.includes('/blobs/')) return refreshed ? ok({}) : fail(401, 'unauthenticated');
      throw new Error(`unexpected request: ${req.url}`);
    };

    const client = new SyncClient('http://x', transport);
    client.setAccessToken('stale-access');
    client.setRefreshToken('a-refresh-token');

    // Five concurrent calls that all meet the same expired token — the storm this exists for.
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map((h) => client.hasBlob(h.repeat(64))));
    assert.equal(refreshes, 1, 'one shared refresh, not one per caller');
  });

  it('does not retry a 401 that refreshing cannot fix', async () => {
    // device_revoked: also 401, but /auth/refresh excludes a revoked device's token by the
    // same condition, so retrying it would only trade one failure for a less specific one.
    let refreshCalls = 0;
    const transport: Transport = async (req) => {
      if (req.url.endsWith('/auth/refresh')) {
        refreshCalls++;
        return fail(401, 'invalid_refresh');
      }
      return fail(401, 'device_revoked');
    };

    const client = new SyncClient('http://x', transport);
    client.setAccessToken('access');
    client.setRefreshToken('a-refresh-token');

    await assert.rejects(
      () => client.putBlob({ sha256: 'a'.repeat(64), bytes: new Uint8Array(1), keyId: 'k' }),
      (e: unknown) => e instanceof ApiError && e.code === 'device_revoked',
    );
    assert.equal(refreshCalls, 0, 'never tried a refresh error refreshing cannot fix');
  });

  it('stops retrying once the refresh token itself is spent', async () => {
    let refreshCalls = 0;
    const transport: Transport = async (req) => {
      if (req.url.endsWith('/auth/refresh')) {
        refreshCalls++;
        return fail(401, 'invalid_refresh');
      }
      return fail(401, 'unauthenticated');
    };

    const client = new SyncClient('http://x', transport);
    client.setAccessToken('stale');
    client.setRefreshToken('also-spent');

    await assert.rejects(() => client.usage());
    assert.equal(refreshCalls, 1, 'tried once, then gave up rather than looping');

    // And the second call after that does not even try — the refresh token was cleared.
    await assert.rejects(() => client.usage());
    assert.equal(refreshCalls, 1);
  });

  it('does not attempt a refresh with no refresh token to spend', async () => {
    let calls = 0;
    const transport: Transport = async () => {
      calls++;
      return fail(401, 'unauthenticated');
    };
    const client = new SyncClient('http://x', transport);
    client.setAccessToken('stale');
    // setRefreshToken never called.
    await assert.rejects(() => client.usage());
    assert.equal(calls, 1, 'one request, no retry attempted');
  });
});

describe('SyncClient bounds how long it waits', () => {
  it('gives up on a call that never answers', async () => {
    const hang: Transport = () => new Promise(() => {});
    // The real default lives in transport.ts and is not what is under test here — only that
    // SOME bound applies and a hung transport cannot wedge the caller forever.
    const client = new SyncClient('http://x', hang, 20);
    await assert.rejects(client.health(), /timed out/i);
  });
});

/**
 * The batched lookups, and the request line they have to fit inside (issue #230).
 *
 * The defect this suite exists for was not subtle and no suite had an opinion about it: `dedupLookup`
 * put every tag of every scanned file into one query string, so a vault of a few hundred notes met
 * `431 Request Header Fields Too Large` on its first sync and could never sync again. It was found by
 * connecting a real vault, which is the only place the threshold lives — a fixture vault is small.
 *
 * So the assertions are about **bytes**, not about a count. A count would pass a rewrite that kept the
 * batch size and doubled the identifier length.
 */
describe('the batched lookups fit inside a request line', () => {
  const hex = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'));

  it('splits a dedup lookup into requests a proxy will carry, and merges the answers', async () => {
    const urls: string[] = [];
    const transport: Transport = async (req) => {
      urls.push(req.url);
      const asked = new URL(req.url).searchParams.get('tags')!.split(',');
      // Every tag answers with itself, so a dropped or duplicated batch is visible in the result.
      return ok({ matches: asked.map((t) => ({ content_tag: t, sha256: t })) });
    };
    const client = new SyncClient('http://x', transport);
    client.setAccessToken('a');

    const tags = hex(250);
    const found = await client.dedupLookup('v1', tags);

    assert.ok(urls.length > 1, `250 items cannot be one request: ${urls.length}`);
    for (const u of urls) {
      assert.ok(u.length < 4096, `a request line of ${u.length} bytes is past what a proxy will carry`);
    }
    assert.equal(found.size, 250, 'every batch was asked for, and every answer kept');
    assert.equal(found.get(tags[7]!), tags[7]!, 'and the merge is by tag, not by position');
  });

  it('splits a blob-keys lookup the same way, keeping every envelope', async () => {
    const urls: string[] = [];
    const transport: Transport = async (req) => {
      urls.push(req.url);
      const asked = new URL(req.url).searchParams.get('sha256')!.split(',');
      return ok({ keys: asked.map((a) => ({ sha256: a, scope_id: 's', wrapped_key: a })) });
    };
    const client = new SyncClient('http://x', transport);
    client.setAccessToken('a');

    const addresses = hex(130);
    const keys = await client.blobKeys('v1', addresses);

    assert.ok(urls.length > 1, `130 items cannot be one request: ${urls.length}`);
    for (const u of urls) assert.ok(u.length < 4096, `${u.length} bytes is too long a request line`);
    assert.equal(keys.size, 130);
    assert.deepEqual(keys.get(addresses[129]!), [{ scopeId: 's', wrappedKey: addresses[129]! }]);
  });

  it('asks nothing at all when there is nothing to look up', async () => {
    // The empty case used to be an early return beside the request; it is now a property of the
    // batching, and a loop that ran once on an empty list would send `tags=` and be refused.
    const urls: string[] = [];
    const transport: Transport = async (req) => {
      urls.push(req.url);
      return ok({ matches: [], keys: [] });
    };
    const client = new SyncClient('http://x', transport);
    client.setAccessToken('a');

    assert.equal((await client.dedupLookup('v1', [])).size, 0);
    assert.equal((await client.blobKeys('v1', [])).size, 0);
    assert.deepEqual(urls, [], 'no request was made');
  });
});
