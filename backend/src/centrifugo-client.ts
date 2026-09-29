import WebSocket from "ws";

/**
 * Minimal reader for Centrifugo's unidirectional WebSocket endpoint. The
 * public StreamerSongList channels need no auth, so the whole protocol is:
 * connect, send the channel list once, read frames.
 *
 *   {}                                         ping (uni streams cannot reply)
 *   {"connect":{...}}                          connected
 *   {"push":{"channel":"…","pub":{"data":…}}}  publication
 *   {"disconnect":{"code":…,"reason":"…"}}     server closing
 */

/** StreamerSongList's event envelope. `data: null` means "refetch over REST". */
export interface SSLEvent {
  type: string;
  data: unknown;
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export class CentrifugoStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private connected = false;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly channels: string[],
    private readonly onPublication: (channel: string, event: SSLEvent) => void,
    /** Called on every (re)connect: anything published while disconnected was missed. */
    private readonly onConnect: () => void = () => undefined
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // Keep a no-op error listener: closing a socket that is still connecting emits one.
    this.ws?.removeAllListeners().on("error", () => undefined);
    this.ws?.terminate();
    this.ws = null;
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ channels: this.channels }));
      console.log(`[Events] Connected, subscribing to ${this.channels.join(", ")}`);
    });
    ws.on("message", (raw) => this.handleFrame(raw.toString()));
    ws.on("close", (code, reason) => {
      this.connected = false;
      if (this.stopped) return;
      console.log(`[Events] Disconnected (${code} ${reason.toString()}), reconnecting`);
      this.scheduleReconnect();
    });
    // "close" always follows "error"; reconnection happens there.
    ws.on("error", (err) => console.error("[Events] Socket error:", err.message));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleFrame(raw: string): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || !Object.keys(frame).length) return;

    if (frame.connect) {
      this.connected = true;
      this.reconnectDelayMs = MIN_RECONNECT_MS;
      this.onConnect();
      return;
    }
    if (frame.disconnect) {
      console.log(`[Events] Server disconnect: ${frame.disconnect.code} ${frame.disconnect.reason ?? ""}`);
      return;
    }

    // Older Centrifugo builds send publications unwrapped.
    const push = frame.push ?? frame;
    const data = push?.pub?.data;
    if (push?.channel && typeof data?.type === "string") {
      this.onPublication(push.channel, { type: data.type, data: data.data ?? null });
    }
  }
}
