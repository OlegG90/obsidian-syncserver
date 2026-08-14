/**
 * The transport as Obsidian requires it.
 *
 * `requestUrl` rather than `fetch`, and this is not a preference. A plugin runs inside a page
 * with an origin, so `fetch` to a self-hosted server on any other origin is a cross-origin
 * request the browser refuses before it is sent — and the refusal looks like the server being
 * down. `requestUrl` goes through Obsidian's own networking, which has no such restriction.
 */
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
import type { HttpResponse, Transport } from '../api/transport.js';
import { arrayBufferOf } from './buffer.js';

/**
 * What this module needs from Obsidian, which is one function — named as a **type**.
 *
 * `obsidian` ships no runtime: it is a package of declarations, and importing a value from
 * it makes a module impossible to load outside the application, no matter how many
 * parameters it takes. That single fact decides which modules in this plugin can ever have
 * a test. `main.ts` is the one place allowed to import a value from it.
 */
export type RequestFn = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

/**
 * The transport, with its one dependency taken rather than imported.
 *
 * `adapter.ts` next door takes its `Vault` as a TYPE and could therefore be given a test the
 * day a real device found a bug in it; this module imported `requestUrl` as a value and
 * could not even be loaded outside Obsidian. The difference between the two neighbours was
 * one word, and it decided which of them was testable.
 *
 * **What this seam does and does not buy.** It cannot reach inside `requestUrl` — the place
 * where Electron and the Android WebView actually differ, and where a `415` came from — so
 * it does not make platform differences testable. What it makes testable is everything on
 * this side of the call, and that half is not small: `throw: false` (drop it and every
 * meaningful `404`/`409`/`410` becomes an exception), the lower-casing that lets the client
 * read `retry-after` and `content-range`, and the body conversion that must copy a
 * `subarray` rather than lend its whole buffer.
 */
export const makeObsidianTransport = (request: RequestFn): Transport => async (req): Promise<HttpResponse> => {
  const res = await request({
    url: req.url,
    method: req.method,
    headers: req.headers,
    // `Uint8Array` is not an `ArrayBuffer`, and a view is not its buffer: passing `.buffer`
    // of a subarray would send the whole underlying allocation, which for a resumable
    // upload's parts is the entire file per part. `arrayBufferOf` copies exactly when that
    // is the case and lends the buffer when it is not.
    ...(req.body === undefined
      ? {}
      : { body: typeof req.body === 'string' ? req.body : arrayBufferOf(req.body) }),
    // Statuses carry meaning in this protocol — 404, 409, 410 are all instructions — so the
    // transport must hand them over rather than turn them into exceptions.
    throw: false,
  });

  const bytes = new Uint8Array(res.arrayBuffer);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);

  let decoded: string | undefined;
  return {
    status: res.status,
    headers,
    text: () => (decoded ??= bytes.length > 0 ? new TextDecoder().decode(bytes) : ''),
    bytes,
  };
};


