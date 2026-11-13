/**
 * The change-notification listener (docs/04): wake the plugin when a vault we sync gains a
 * revision, so the user does not have to press the button.
 *
 * This is a hint, not an order — a lost or late notification costs nothing, because the
 * ordinary sync cycle would find the change anyway. That is why the reconnect logic is
 * allowed to be simple: the worst case of a failed channel is the pre-push behaviour, not
 * data loss.
 *
 * The socket is injectable (`socketFactory`) for the same reason the transport is: inside
 * Obsidian it is the browser `WebSocket`, in the tests it is a fake. The token comes from a
 * `tokenSource` so the module never holds the session or the key material — it asks.
 *
 * Each reason the server refuses or closes for has one answer; docs/04 states them. The one
 * worth a word here: a revoked device stops and calls `onRevoked` on its way out — the plugin
 * runs a sync there, which meets the same `401`, and that sync, not this module, is how the
 * user is told (`session.ts`).
 */

import type { EventsRefusal, EventsTokenExpired } from '@syncserver/shared';

export interface PushSocket {
  send(data: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  /** `code` is the WebSocket close code: the server's reason for a close it made (docs/04). */
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
  readonly readyState: number;
}

export type PushSocketFactory = (url: string) => PushSocket;

export interface PushListenerOptions {
  /** `ws(s)://host/events` — docs/04. */
  url: string;
  /** Only a notification for this vault can wake this device (AC-Q4: one vault per instance). */
  vaultId: string;
  /** The current access token, or `undefined` when the session is locked. */
  tokenSource: () => string | undefined;
  /** Refresh the token (the connection lives as long as the access token does). */
  refresh: () => Promise<boolean>;
  /** Called when a notification names our vault. */
  onNotify: (vaultId: string) => void;
  /**
   * Called once when the server refuses this device as revoked, as the listener stops. A hook of
   * its own rather than a borrowed `onNotify`, which is documented as a hint and may one day be
   * throttled — and a revocation is the one thing this channel says that must reach somebody.
   */
  onRevoked: () => void;
  socketFactory?: PushSocketFactory;
  /** Backoff between attempts, milliseconds; a test shrinks it. */
  delays?: number[];
}

/** Short, capped backoff: the channel is a hint, so a slow reconnect is acceptable. */
const DEFAULT_DELAYS = [1_000, 2_000, 4_000, 8_000];

const TOKEN_EXPIRED: EventsTokenExpired = 4004;

export class PushListener {
  private readonly factory: PushSocketFactory;
  private readonly delays: number[];
  private socket: PushSocket | undefined;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;

  constructor(private readonly options: PushListenerOptions) {
    this.factory = options.socketFactory ?? ((url) => new BrowserSocket(url));
    this.delays = options.delays ?? DEFAULT_DELAYS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const s = this.socket;
    this.socket = undefined;
    s?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const token = this.options.tokenSource();
    if (!token) {
      // No session: nothing to wake for. Retry later rather than spin.
      this.schedule(0);
      return;
    }
    const socket = this.factory(this.options.url);
    this.socket = socket;
    let authed = false;
    // A refusal frame decides what follows; the close behind it only confirms it, and must not
    // schedule a second reconnect beside the one the refusal chose.
    let decided = false;

    socket.onmessage = (ev) => {
      const text = String(ev.data);
      let msg: { status?: string; error?: string; reason?: EventsRefusal; vault_id?: string };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return; // not JSON — ignore
      }

      if (!authed) {
        if (msg.status === 'ok') {
          authed = true;
          this.attempt = 0;
          return;
        }
        if (msg.error === 'refused') {
          decided = true;
          socket.close();
          this.afterRefusal(msg.reason, token);
          return;
        }
        return; // anything else before auth is ignored
      }

      if (msg.vault_id === this.options.vaultId) this.options.onNotify(msg.vault_id);
    };

    socket.onclose = (ev) => {
      if (this.socket === socket) this.socket = undefined;
      if (decided) return;
      // The ordinary end of a socket's life, not a failure: a new token first, then a socket
      // that can use it — rather than a reconnect the server is bound to refuse.
      if (ev.code === TOKEN_EXPIRED) return this.refreshThenReconnect(0, token);
      // Anything else — a server going away, `1011` when it could not ask its database — is
      // no comment on the token, so the same token tries again.
      this.schedule(this.attempt);
    };
    socket.onerror = () => {
      socket.close();
    };

    socket.onopen = () => {
      // Auth is the first message, not the URL (docs/04): a token in the query string
      // settles into access logs.
      socket.send(JSON.stringify({ token }));
    };
  }

  /** What a refusal's reason asks for. */
  private afterRefusal(reason: EventsRefusal | undefined, sent: string): void {
    switch (reason) {
      case 'device_revoked':
        // Nothing this device holds will be accepted again, a refreshed token included. Stopping
        // alone would leave the user to find out whenever a sync next happened to run.
        this.options.onRevoked();
        void this.stop();
        return;
      case 'no_token':
      case 'auth_timeout':
        // The handshake went wrong, not the token: a fresh one would be refused the same way.
        this.schedule(this.attempt);
        return;
      default:
        // `invalid_token`, or a server too old to say: the token is stale.
        this.refreshThenReconnect(this.attempt + 1, sent);
    }
  }

  /**
   * Reconnect with a token newer than `sent`, refreshing for one only when nobody already has.
   *
   * A sync meets the same expiry on its own requests and refreshes for them, so by the time a
   * socket's end arrives the session may hold a new token already — and a second refresh would
   * be a round trip spent on nothing.
   *
   * Whatever the refresh answers, a reconnect follows: a refresh fails offline as well as for a
   * spent token, and a channel that gave up on a moment's outage would stay silent until the
   * vault was next unlocked.
   */
  private refreshThenReconnect(attempt: number, sent: string): void {
    if (this.options.tokenSource() !== sent) return this.schedule(attempt);
    void this.options
      .refresh()
      .catch(() => false)
      .then(() => this.schedule(attempt));
  }

  private schedule(attempt: number): void {
    if (this.stopped || this.timer) return;
    const delay = this.delays[Math.min(attempt, this.delays.length - 1)];
    this.attempt = attempt + 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, delay);
  }
}

/** The browser `WebSocket`, which exists in Electron and the Capacitor WebView. */
class BrowserSocket implements PushSocket {
  private readonly ws: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onopen?.();
    this.ws.onmessage = (ev) => this.onmessage?.(ev);
    this.ws.onclose = (ev) => this.onclose?.({ code: ev.code });
    this.ws.onerror = () => this.onerror?.();
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  send(data: string): void {
    this.ws.send(data);
  }

  close(): void {
    this.ws.close();
  }
}
