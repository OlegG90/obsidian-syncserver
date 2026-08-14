/**
 * The Obsidian transport — the second module of that edge to get a seam, after the vault
 * adapter earned one the hard way.
 *
 * **What these tests can and cannot see.** They drive the module with a stub in place of
 * `requestUrl`, so they cover this side of the call and nothing beyond it. The difference
 * between Electron and the Android WebView lives *inside* `requestUrl`; no test here would
 * have caught the `415` that difference produced. What they do cover is the half that is
 * this module's own, where the failures are quiet and expensive: statuses turning into
 * exceptions, headers the client can no longer find, and a body that sends a whole file in
 * place of one part.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestUrlParam } from 'obsidian';

import { makeObsidianTransport, type RequestFn } from '../src/obsidian/transport.js';

/** Records what the module asked Obsidian for, and answers with what the test dictates. */
const stub = (answer: Partial<{ status: number; arrayBuffer: ArrayBuffer; headers: Record<string, string> }> = {}) => {
  // `requestUrl` also accepts a bare URL string; this module always passes the object form,
  // and the stub records that rather than re-stating the wider signature.
  const calls: RequestUrlParam[] = [];
  const request: RequestFn = async (params: RequestUrlParam) => {
    calls.push(params);
    // `RequestUrlResponse` declares more than this module reads; the cast says so once
    // rather than filling in fields no assertion here depends on.
    return {
      status: answer.status ?? 200,
      arrayBuffer: answer.arrayBuffer ?? new ArrayBuffer(0),
      headers: answer.headers ?? {},
      text: '',
    } as Awaited<ReturnType<RequestFn>>;
  };
  return { request, calls };
};

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('what the transport asks Obsidian for', () => {
  it('never lets Obsidian throw on a status, because statuses are instructions here', async () => {
    // The single most consequential word in the module. `404` means "you hold no live
    // reference", `409` a failed precondition, `410` resync and why — every one of them is
    // read by the engine. Without `throw: false` they arrive as exceptions and the protocol
    // stops being a protocol.
    const { request, calls } = stub({ status: 409 });
    const res = await makeObsidianTransport(request)({ method: 'GET', url: 'http://x/y', headers: {} });

    assert.equal(calls[0]!.throw, false, 'the refusal to throw is explicit');
    assert.equal(res.status, 409, 'and the status comes back as a value');
  });

  it('sends a part as the part, not as the file it was cut from', async () => {
    // A resumable upload slices one sealed blob into `subarray`s. Handing over `.buffer`
    // would send the entire file for every part; `arrayBufferOf` is what prevents it, and
    // this asserts the transport actually reaches for it.
    const whole = utf8('....PART....');
    const part = whole.subarray(4, 8);

    const { request, calls } = stub();
    await makeObsidianTransport(request)({ method: 'PUT', url: 'http://x/p', headers: {}, body: part });

    const sent = calls[0]!.body as ArrayBuffer;
    assert.equal(sent.byteLength, 4, 'the view, not the allocation behind it');
    assert.deepEqual(new Uint8Array(sent), utf8('PART'));
  });

  it('passes a string body through untouched', async () => {
    const { request, calls } = stub();
    await makeObsidianTransport(request)({ method: 'POST', url: 'http://x/j', headers: {}, body: '{"a":1}' });

    assert.equal(calls[0]!.body, '{"a":1}', 'JSON is already a string; converting it would be a second encoding');
  });

  it('omits the body entirely when there is none', async () => {
    // Not `body: undefined` — absent. Some request layers treat the key's presence as a
    // reason to set a content length.
    const { request, calls } = stub();
    await makeObsidianTransport(request)({ method: 'GET', url: 'http://x/y', headers: {} });

    assert.ok(!('body' in calls[0]!), 'a GET carries no body key at all');
  });
});

describe('what the transport hands back', () => {
  it('lower-cases the response headers, which is how the client finds them', async () => {
    // `retry-after` decides how long a rate-limited client waits; `content-range` is what a
    // ranged read reads. Both are looked up in lower case, and a server may send either
    // casing.
    const { request } = stub({ headers: { 'Retry-After': '30', 'Content-Range': 'bytes 0-9/100' } });
    const res = await makeObsidianTransport(request)({ method: 'GET', url: 'http://x/y', headers: {} });

    assert.equal(res.headers['retry-after'], '30');
    assert.equal(res.headers['content-range'], 'bytes 0-9/100');
  });

  it('decodes text once and answers empty for an empty body', async () => {
    const body = utf8('{"error":"not_found"}');
    const { request } = stub({ status: 404, arrayBuffer: body.buffer as ArrayBuffer });
    const res = await makeObsidianTransport(request)({ method: 'GET', url: 'http://x/y', headers: {} });

    assert.equal(res.text(), '{"error":"not_found"}');
    assert.equal(res.text(), '{"error":"not_found"}', 'memoised, and the second call agrees with the first');
    assert.deepEqual(res.bytes, body, 'the bytes stay available beside the text');

    const empty = await makeObsidianTransport(stub({ status: 204 }).request)({
      method: 'DELETE',
      url: 'http://x/y',
      headers: {},
    });
    assert.equal(empty.text(), '', 'an empty body is an empty string, not a decode of nothing');
  });

  it('survives a response with no headers at all', async () => {
    const { request } = stub();
    const res = await makeObsidianTransport(request)({ method: 'GET', url: 'http://x/y', headers: {} });
    assert.deepEqual(res.headers, {});
  });
});
