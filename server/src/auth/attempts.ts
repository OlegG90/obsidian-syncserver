/**
 * The attempt limit on the endpoints where guessing pays.
 *
 * Recovery hands back a seed envelope to whoever proves they can open it (#112), so it is
 * the one place in this API where an attacker has something to gain by trying repeatedly.
 * `Argon2id` at 64 MiB already makes each candidate expensive for them — this makes a
 * *series* of candidates expensive in wall-clock time as well, which is the half the client
 * cannot enforce on itself.
 *
 * **Counted per key, and callers pass two**: the login being attacked, and where the attempt
 * came from. Either alone is bypassable — one login from a thousand addresses, or a thousand
 * logins from one — and neither is sufficient evidence on its own.
 *
 * **A refusal must not become an oracle.** The limiter answers only "wait this long"; who
 * decides what to say still owes an unknown login and a wrong proof the same refusal (#73),
 * which is why this module never sees whether the account exists.
 */

export interface AttemptLimiter {
  /** May this key try now, or how long until it may? */
  check(key: string): { ok: true } | { ok: false; retryAfterSeconds: number };
  /** Record a failed attempt. Consecutive lockouts back off. */
  fail(key: string): void;
  /** Forget this key's history — a proof that worked says the caller is not the attacker. */
  succeed(key: string): void;
}

/** How many failures inside the window before the key is locked out at all. */
const THRESHOLD = 5;

/** Failures older than this stop counting, so an honest typo years ago is not held. */
const WINDOW_MS = 15 * 60_000;

/** The first lockout, doubling per consecutive lockout up to `MAX_LOCKOUT_MS`. */
const BASE_LOCKOUT_MS = 60_000;
const MAX_LOCKOUT_MS = 60 * 60_000;

interface Entry {
  failures: number[];
  lockedUntil: number;
  /** Consecutive lockouts, which is what the backoff grows on. */
  lockouts: number;
}

/**
 * In-process, with the same limit the upload limiter states: two server instances behind one
 * address would each allow the full rate, so a shared counter becomes necessary the moment
 * this stops being one process. One process is what the deployment is (docs/02).
 */
export const inProcessAttemptLimiter = (now: () => number = Date.now): AttemptLimiter => {
  const entries = new Map<string, Entry>();

  const entry = (key: string): Entry => {
    const found = entries.get(key) ?? { failures: [], lockedUntil: 0, lockouts: 0 };
    entries.set(key, found);
    return found;
  };

  return {
    check(key) {
      const t = now();
      const e = entries.get(key);
      if (!e || e.lockedUntil <= t) return { ok: true };
      return { ok: false, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) };
    },

    fail(key) {
      const t = now();
      const e = entry(key);
      e.failures = e.failures.filter((at) => t - at < WINDOW_MS);
      e.failures.push(t);
      if (e.failures.length < THRESHOLD) return;

      // The window is cleared with the lockout: without that, every further attempt after
      // the threshold would re-lock instantly on the same five failures, and the backoff
      // would count attempts the caller never got to make.
      e.failures = [];
      e.lockouts += 1;
      e.lockedUntil = t + Math.min(BASE_LOCKOUT_MS * 2 ** (e.lockouts - 1), MAX_LOCKOUT_MS);
    },

    succeed(key) {
      entries.delete(key);
    },
  };
};
