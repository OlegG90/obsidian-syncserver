/**
 * The one seam between the protocol client and the runtime it happens to be inside.
 *
 * Inside Obsidian, requests must go through `requestUrl`: an ordinary `fetch` from a plugin
 * is subject to the page's CORS policy, and a self-hosted server on another origin will
 * refuse it. Outside Obsidian — in the tests — there is no such restriction and `fetch` is
 * the whole implementation.
 *
 * Keeping that behind an interface is what lets the client be exercised against a REAL
 * server from a test runner. A client that imported `obsidian` could only ever be tested by
 * launching Obsidian, which in practice means it would not be tested.
 */

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  url: string;
  headers: Record<string, string>;
  /** A string for JSON, bytes for a blob upload. */
  body?: string | Uint8Array | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /**
   * The body as text, decoded **on demand**.
   *
   * A method rather than a field, so the cost appears at the call site. Blob downloads are
   * the whole reason: they are read as `bytes`, and eagerly decoding them would mean a full
   * UTF-8 pass and a second copy of a file that may be tens of megabytes, to produce a
   * string nothing ever looks at. On a phone that is not a rounding error (docs/02).
   */
  text(): string;
  bytes: Uint8Array;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * How long `SyncClient` waits for one call before giving up on it (`client.ts`).
 *
 * One value split in two: ordinary metadata calls are bounded tightly, because a server that
 * has not answered in that long is not going to; blob transfers get much more room, because
 * "large file, slow home upload link" is not the same failure as "server is not there" and
 * must not be punished with the same clock.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const BLOB_TIMEOUT_MS = 5 * 60_000;

/**
 * Raced against a transport call so nothing waits forever — see `client.ts`, which is the
 * only caller. It bounds WAITING, not necessarily the underlying request: `fetchTransport`
 * below actually cancels its `fetch` when this fires, because `AbortSignal` makes that free;
 * `obsidianTransport` cannot, since `requestUrl` accepts no signal at all. The distinction
 * matters for a caller deciding whether to retry — a merely-abandoned wait may still land on
 * the server, where a genuinely cancelled one cannot.
 */
export class TimeoutError extends Error {}

export const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/**
 * Never throws on a status. Every non-2xx in this protocol carries meaning the client acts
 * on — 404 says "you do not hold this blob", 409 says "your base is stale", 410 says
 * "resync and here is why" — so turning them into exceptions would mean immediately
 * catching them again to read the status back out.
 */
export const fetchTransport: Transport = async (req) => {
  // Built rather than spread with an `undefined` body: `exactOptionalPropertyTypes` treats
  // "absent" and "present and undefined" as different things, and `RequestInit` means the
  // first one.
  const init: RequestInit = { method: req.method, headers: req.headers };
  // A Uint8Array is an acceptable BodyInit; the cast is for the DOM lib's narrower type.
  if (req.body !== undefined) init.body = req.body as BodyInit;
  // Real cancellation, since `fetch` supports it and `SyncClient`'s own timeout only stops
  // waiting — this stops the request. The generous blob figure is used here too: this
  // transport cannot tell a metadata call from an upload, so it must not be the tighter one.
  init.signal = AbortSignal.timeout(BLOB_TIMEOUT_MS);

  const res = await fetch(req.url, init);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  // Decoded at most once, and only if asked. Every JSON caller asks; no blob caller does.
  let decoded: string | undefined;

  return {
    status: res.status,
    headers,
    text: () => (decoded ??= bytes.length > 0 ? new TextDecoder().decode(bytes) : ''),
    bytes,
  };
};
