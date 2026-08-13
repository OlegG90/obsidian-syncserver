/**
 * Encoding helpers, written against what BOTH runtimes have.
 *
 * The bundle runs in Electron and in a Capacitor WebView (docs/02), so `Buffer` is not
 * available and must not creep in — it exists in Electron and would work in every desktop
 * test right up until a phone. `btoa`/`atob` exist in both, and in Node, which is what lets
 * these be tested outside Obsidian at all.
 */

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export const toHex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += HEX[x]!;
  return s;
};

export const fromHex = (s: string): Uint8Array => {
  if (s.length % 2 !== 0) throw new Error('hex string of odd length');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('not hex');
    out[i] = byte;
  }
  return out;
};

// btoa works on a "binary string" — one character per byte — so the bytes are widened
// first. Chunked because a spread of a large array overflows the argument limit, and a
// vault migration hands this whole files.
export const toBase64 = (b: Uint8Array): string => {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

export const fromBase64 = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Join byte strings. RFC 9180 is written in `a || b || c` and reads that way here; the two
 * sealing formats build their own output buffers instead, because for them the allocation
 * is the file (see `blob.ts`).
 */
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/**
 * The one source of randomness. Present in Electron, the WebView and Node 22.
 *
 * Filled in chunks because `getRandomValues` refuses more than 65,536 bytes per call, with
 * a message about a length rather than about randomness. Nothing here asks for more than 32
 * today — but a helper that works up to a size and then throws is a trap laid for whoever
 * asks for the first big one.
 */
export const randomBytes = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  const LIMIT = 65536;
  for (let at = 0; at < n; at += LIMIT) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + LIMIT, n)));
  }
  return out;
};

export const randomUuid = (): string => crypto.randomUUID();
