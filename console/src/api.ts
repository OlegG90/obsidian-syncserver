/**
 * The console's half of the protocol, and deliberately a thin one.
 *
 * M4 put every decision behind the API — who may act, what a refusal means, what a quota
 * change will do — so this reads and calls almost nothing of its own. What it owns is the
 * **session**: both tokens, in memory, and the rule for spending one to replace the other.
 * A session that survived a closed tab would be a session nobody chose to keep, so nothing is
 * written down — and because nothing is written down, a reload is a fresh sign-in.
 *
 * **No key material passes through here, ever.** A console account has none (#115) — that is
 * what makes a browser an acceptable place for it, and it is why this file imports no crypto.
 */
import type { AccountRow, AuditRow, BackupRun, HealthResponse, RestoreStatus } from '@syncserver/shared';

// The console's screens read these by name; the wire shape lives in shared so the server
// and this browser agree about a column before it reaches the table as `undefined`.
export type { AccountRow, AuditRow, BackupRun, HealthResponse, RestoreStatus };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * Both halves of the session, in memory, for as long as the tab is open (#102).
 *
 * The access token expires in fifteen minutes; the refresh token is what buys another one. The
 * server has minted both from `/auth/console` since M4 and this file kept only the first — so
 * a console left open stopped working after a quarter of an hour, and the comment above
 * describing a session that lives and dies with its tab described something nothing
 * implemented. The lifetime was not chosen; it was what remained after throwing half of it
 * away.
 *
 * **Still nothing persisted.** That is the guarantee, and it is unchanged: no storage, no
 * cookie, no `localStorage`. Closing the tab ends the session, and so does a reload — which
 * is consistent with this console's one structural promise, that a reload is never wrong.
 *
 * The refresh token is worth more than the access token, because it lasts longer, and it sits
 * in the same place under the same access: anything running script in this tab already holds
 * the access token. What it buys is bounded by the console device row, which is one row an
 * administrator can revoke (#90).
 */
let access: string | undefined;
let refresh: string | undefined;

export const signedIn = (): boolean => access !== undefined;

/** Forget the session — both halves. The server keeps the device row; ending it is a later screen. */
export const forgetSession = (): void => {
  access = undefined;
  refresh = undefined;
};

/**
 * Trade the refresh token for a new access token. Answers whether it worked.
 *
 * Never retried and never queued: a refresh that is refused means the device was revoked or
 * the token is spent, and asking again is asking the same question. The caller's next move is
 * the sign-in screen, which is #101's.
 */
const renew = async (): Promise<boolean> => {
  if (refresh === undefined) return false;
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return false;
    access = ((await res.json()) as { access: string }).access;
    return true;
  } catch {
    // A network fault is not a dead session. Say no, let the original refusal surface as
    // itself, and leave the tokens alone so the next call can try again.
    return false;
  }
};

const call = async <T>(method: string, path: string, body?: unknown, renewed = false): Promise<T> => {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(access === undefined ? {} : { authorization: `Bearer ${access}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  if (!res.ok) {
    // The server's refusals carry a code and often a sentence naming what to do instead
    // (AGENTS.md: failures explain themselves). Both are passed through rather than replaced
    // — a second, vaguer message composed here would only make the reader guess.
    let code = String(res.status);
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: string; detail?: string };
      code = parsed.error ?? code;
      detail = parsed.detail;
    } catch {
      detail = text || undefined;
    }

    // An expired access token, once. `unauthenticated` is the server's word for "this token
    // is no good" and nothing else — a wrong password is `invalid_credentials`, a forbidden
    // act is `forbidden` — so it is the one refusal a fresh token can answer.
    //
    // Once, and tracked by a parameter rather than by a counter: a renewed call that is
    // refused again has been refused for a reason a third token will not change, and a
    // request that could retry itself indefinitely is a page that hangs instead of saying so.
    if (code === 'unauthenticated' && !renewed && (await renew())) {
      return call<T>(method, path, body, true);
    }
    throw new ApiError(res.status, code, detail);
  }
  return (text ? JSON.parse(text) : undefined) as T;
};

/** Open before authentication and before an administrator exists — which is when it is needed. */
export const health = (): Promise<HealthResponse> => call('GET', '/health');

/** The first run: creates the password rather than replacing one (#107). */
export const bootstrap = (password: string): Promise<{ login: string }> =>
  call('POST', '/auth/bootstrap', { password });

export const signIn = async (login: string, password: string): Promise<void> => {
  // Both halves. The server has answered with both since M4; keeping only the access token is
  // what made a console session fifteen minutes long instead of tab-long (#102).
  const out = await call<{ access: string; refresh: string }>('POST', '/auth/console', { login, password });
  access = out.access;
  refresh = out.refresh;
};

export const accounts = (): Promise<{ accounts: AccountRow[] }> => call('GET', '/admin/accounts');

export const invite = (login: string, quotaBytes: string): Promise<{ user_id: string; token: string }> =>
  call('POST', '/admin/invitations', { login, quota_bytes: quotaBytes });

/**
 * Change what an account may store.
 *
 * Answers with the account's CURRENT usage and whether this limit freezes it — the server
 * computes both inside the same transaction that writes the change, so the number cannot be
 * stale by the time it is read. Lowering a limit below usage deletes nothing (SH-20).
 */
export const setQuota = (userId: string, quotaBytes: string): Promise<{ used_bytes: string; freezes: boolean }> =>
  call('PUT', `/admin/accounts/${userId}/quota`, { quota_bytes: quotaBytes });

/** The administrative log, newest first (#87, #94). Append-only on the server; read-only here. */
export const audit = (limit = 100): Promise<{ entries: AuditRow[] }> =>
  call('GET', `/admin/audit?limit=${limit}`);

/** Start a backup now. Refused with `backup_not_configured` when the server has none. */
export const runBackup = (): Promise<{ id?: string; status: string; bytes?: number; blob_count?: number }> =>
  call('POST', '/admin/backups');

/** The previous runs, newest first. */
export const backups = (): Promise<{ backups: BackupRun[] }> => call('GET', '/admin/backups');

/** Ask whether a run's blob copy holds every blob the database references. */
export const verify = (id: string): Promise<{ checked: number; missing: string[]; whole: boolean }> =>
  call('POST', `/admin/backups/${id}/verify`);

/** What the server knows about a possible restore. Reachable even in the halt state. */
export const restoreStatus = (): Promise<RestoreStatus> => call('GET', '/admin/restore');

/** Confirm a restore: raise the epoch above anything this server has issued. */
export const confirmRestore = (): Promise<{ epoch: number }> => call('POST', '/admin/restore/confirm');
