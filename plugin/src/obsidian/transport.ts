/**
 * The transport as Obsidian requires it.
 *
 * `requestUrl` rather than `fetch`, and this is not a preference. A plugin runs inside a page
 * with an origin, so `fetch` to a self-hosted server on any other origin is a cross-origin
 * request the browser refuses before it is sent — and the refusal looks like the server being
 * down. `requestUrl` goes through Obsidian's own networking, which has no such restriction.
 */
import { requestUrl } from 'obsidian';
import type { HttpResponse, Transport } from '../api/transport.js';

export const obsidianTransport: Transport = async (req): Promise<HttpResponse> => {
  const res = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    // `Uint8Array` is not an `ArrayBuffer`, and a view is not its buffer: passing `.buffer`
    // of a subarray would send the whole underlying allocation. `slice` is the honest copy.
    ...(req.body === undefined
      ? {}
      : { body: typeof req.body === 'string' ? req.body : toArrayBuffer(req.body) }),
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

const toArrayBuffer = (b: Uint8Array): ArrayBuffer => {
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return copy;
};
