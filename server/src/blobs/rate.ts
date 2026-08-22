/**
 * The volume limit on uploads: bytes per minute, per account (D-33).
 *
 * This is deliberately not the request rate limit. The problem it addresses is **volume** —
 * without it, filling the disk is the simplest thing anyone can do, and it takes no
 * attacker, just a client stuck in a retry loop. A request limiter would let a hundred
 * megabyte-sized requests through while stopping a thousand empty ones.
 *
 * Charged **before** the bytes arrive, from the declared size, for the same reason quota
 * is: a limit applied afterwards is a limit checked once the disk it protects is already
 * holding the data.
 */

export interface RateLimiter {
  /** Reserve `bytes` for this account, or say how long to wait. */
  reserve(userId: string, bytes: number): { ok: true } | { ok: false; retryAfterSeconds: number };
}

const WINDOW_MS = 60_000;

/**
 * In-process, and that is a real limit on the limit: with two server instances behind one
 * address each would allow the full rate, so a shared counter becomes necessary the moment
 * this stops being one process. It is written down rather than discovered, and one process
 * is what the deployment is (docs/02).
 */
export const inProcessRateLimiter = (bytesPerMinute: number, now: () => number = Date.now): RateLimiter => {
  const windows = new Map<string, { at: number; bytes: number }[]>();

  return {
    reserve(userId, bytes) {
      const t = now();
      const recent = (windows.get(userId) ?? []).filter((e) => t - e.at < WINDOW_MS);

      const used = recent.reduce((sum, e) => sum + e.bytes, 0);
      if (used + bytes > bytesPerMinute) {
        // How long until enough of the window has rolled off to fit this upload. Telling
        // the client is what turns a retry loop into a wait; without it, the client that
        // caused the problem is the one that keeps causing it.
        const needed = used + bytes - bytesPerMinute;
        let freed = 0;
        let waitUntil = t;
        for (const e of recent) {
          freed += e.bytes;
          waitUntil = e.at + WINDOW_MS;
          if (freed >= needed) break;
        }
        windows.set(userId, recent);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((waitUntil - t) / 1000)) };
      }

      recent.push({ at: t, bytes });
      windows.set(userId, recent);
      return { ok: true };
    },
  };
};
