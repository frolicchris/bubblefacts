import WebSocket from "ws";

// Minimal reader for Centrifugo's one-way WebSocket endpoint; StreamerSongList's channels need no auth
// Frames, possibly several per message, one per line:
//   sent: {"subs":{"<channel>":{}}}            connect request; unknown fields are ignored, so no `subs` means no channel
//   {}                                         ping (one-way streams cannot reply)
//   {"connect":{…,"subs":{"<channel>":{…}}}}   connected; `subs` lists what it subscribed
//   {"channel":"…","pub":{"data":…,"offset":…}}  publication (also seen wrapped in "push"), data {"type":"queue_add","data":{…}}
//   {"disconnect":{"code":…,"reason":"…"}}     server closing

/** StreamerSongList's event envelope, as far as known; `type` is "" when a publication has none */
export interface SSLEvent {
  type: string;
  data: unknown;
}

const MIN_RECONNECT_MS = 1_000; // ms before the first reconnect, doubling each time
const MAX_RECONNECT_MS = 30_000; // ms, longest wait between reconnects
const STABLE_MS = 60_000; // ms a connection must hold before the wait resets, so a flapping server is backed off from
const READ_TIMEOUT_MS = 90_000; // ms without any frame before the socket counts as dead; Centrifugo pings about every 25 s

export interface StreamTiming {
  stableMs: number;
  readTimeoutMs: number;
}

export class CentrifugoStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private connected = false;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly channels: string[],
    private readonly onPublication: (channel: string, event: SSLEvent) => void,
    /** Called on every (re)connect: anything published while disconnected was missed */
    private readonly onConnect: () => void = () => undefined,
    private readonly timing: StreamTiming = { stableMs: STABLE_MS, readTimeoutMs: READ_TIMEOUT_MS }
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
    this.clearConnectionTimers();
    // Keep a no-op error listener: closing a socket that is still connecting emits one
    this.ws?.removeAllListeners().on("error", () => undefined);
    this.ws?.terminate();
    this.ws = null;
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.armWatchdog(ws);
      ws.send(JSON.stringify({ subs: Object.fromEntries(this.channels.map((c) => [c, {}])) }));
    });
    ws.on("message", (raw) => {
      this.armWatchdog(ws);
      for (const line of raw.toString().split("\n")) if (line.trim()) this.handleFrame(line);
    });
    ws.on("close", (code, reason) => {
      this.connected = false;
      this.clearConnectionTimers();
      if (this.stopped) return;
      console.log(`[Events] Disconnected (${code} ${reason.toString()}), reconnecting`);
      this.scheduleReconnect();
    });
    // "close" always follows "error"; reconnection happens there
    ws.on("error", (err) => console.error("[Events] Socket error:", err.message));
  }

  /** Drops a socket gone quiet (not even a ping); its close starts the reconnect */
  private armWatchdog(ws: WebSocket): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      console.log("[Events] Nothing heard for a while, reconnecting");
      ws.terminate();
    }, this.timing.readTimeoutMs);
  }

  private clearConnectionTimers(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.watchdog = this.stableTimer = null;
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
      // The wait resets only once the connection has held, not on every connect
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => (this.reconnectDelayMs = MIN_RECONNECT_MS), this.timing.stableMs);
      // Connected only with a channel subscribed: without one, no event ever comes
      const subscribed = this.channels.filter((c) => frame.connect.subs?.[c]);
      this.connected = subscribed.length > 0;
      console.log(
        this.connected
          ? `[Events] Connected, subscribed to ${subscribed.join(", ")}`
          : `[Events] Connected, but not subscribed to ${this.channels.join(", ")}: following by polling only`
      );
      this.onConnect();
      return;
    }
    if (frame.disconnect) {
      console.log(`[Events] Server disconnect: ${frame.disconnect.code} ${frame.disconnect.reason ?? ""}`);
      return;
    }

    // Bare here; Centrifugo's other protocols wrap publications in "push"
    // Any publication means "fetch again", whatever its data: StreamerSongList's own pages don't read it either
    const push = frame.push ?? frame;
    const pub = push?.pub;
    if (typeof push?.channel === "string" && pub && typeof pub === "object") {
      const data = pub.data;
      this.onPublication(push.channel, { type: typeof data?.type === "string" ? data.type : "", data: data?.data ?? data ?? null });
    }
  }
}
