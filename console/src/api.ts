/**
 * The console's half of the protocol, and deliberately a thin one.
 *
 * M4 put every decision behind the API — who may act, what a refusal means, what a quota
 * change will do — so this reads and calls and decides nothing. The one thing it owns is the
 * access token, which lives in memory: a console session that survived a closed tab would be
 * a session nobody chose to keep.
 *
 * **No key material passes through here, ever.** A console account has none (#115) — that is
 * what makes a browser an acceptable place for it, and it is why this file imports no crypto.
 */
import type { AccountRow, HealthResponse } from '@syncserver/shared';

// The console's screens read these by name; the wire shape lives in shared so the server
// and this browser agree about a column before it reaches the table as `undefined`.
export type { AccountRow, HealthResponse };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

let access: string | undefined;

export const signedIn = (): boolean => access !== undefined;

/** Forget the token. The server keeps the device row; ending it properly is a later screen. */
export const forgetSession = (): void => {
  access = undefined;
};

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
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
  const out = await call<{ access: string }>('POST', '/auth/console', { login, password });
  access = out.access;
};

export const accounts = (): Promise<{ accounts: AccountRow[] }> => call('GET', '/admin/accounts');

export const invite = (login: string, quotaBytes: string): Promise<{ user_id: string; token: string }> =>
  call('POST', '/admin/invitations', { login, quota_bytes: quotaBytes });
