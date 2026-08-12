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
 */

export interface PushSocket {
  send(data: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
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
  socketFactory?: PushSocketFactory;
  /** Backoff between attempts, milliseconds; a test shrinks it. */
  delays?: number[];
}

/** Short, capped backoff: the channel is a hint, so a slow reconnect is acceptable. */
const DEFAULT_DELAYS = [1_000, 2_000, 4_000, 8_000];

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

    socket.onmessage = (ev) => {
      const text = String(ev.data);
      let msg: { status?: string; error?: string; vault_id?: string };
      try {
        msg = JSON.parse(text) as { status?: string; error?: string; vault_id?: string };
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
          // Stale token: refresh once and reconnect, instead of retrying the same refusal.
          socket.close();
          void this.options.refresh().then(() => this.schedule(this.attempt + 1));
          return;
        }
        return; // anything else before auth is ignored
      }

      if (msg.vault_id === this.options.vaultId) this.options.onNotify(msg.vault_id);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
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
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onopen?.();
    this.ws.onmessage = (ev) => this.onmessage?.(ev);
    this.ws.onclose = () => this.onclose?.();
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
