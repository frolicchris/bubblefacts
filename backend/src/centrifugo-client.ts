import WebSocket from "ws";

/**
 * Minimal Centrifugo client for the rebuilt StreamerSongList realtime feed.
 *
 * The old platform used Socket.IO v2 with `join-room` / `queue-update`. The
 * new one publishes through Centrifugo. We use its *unidirectional* WebSocket
 * endpoint (`/connection/uni_websocket`) rather than the bidirectional
 * protocol: we only ever consume public `streamer:{id}-*` channels, which
 * need no auth and no subscribe/unsubscribe handshake. The whole client
 * protocol reduces to "connect, send the channel list once, read frames" —
 * which is why this is ~100 lines instead of a dependency.
 *
 * Frames we can see:
 *   {}                                    server ping (uni streams can't reply)
 *   {"connect":{"client":"…","ping":25}}  connect acknowledgement
 *   {"push":{"channel":"…","pub":{"data":…}}}  a publication
 *   {"disconnect":{"code":…,"reason":"…"}}     server closing the stream
 *
 * Older/looser Centrifugo builds emit publications unwrapped as
 * {"channel":…,"pub":…}, so both shapes are accepted.
 */

/** The application-level event envelope StreamerSongList publishes. */
export interface SSLEvent {
  /** e.g. "now_playing_update", "queue_update", "queue_add" */
  type: string;
  /** Event payload. Null means "refetch the resource over REST". */
  data: unknown;
}

type PublicationHandler = (channel: string, event: SSLEvent) => void;

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export class CentrifugoStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly channels: string[],
    private readonly onPublication: PublicationHandler
  ) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Detach handlers first so closing doesn't schedule a reconnect.
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private open(): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      // The uni_websocket connect command: channels are subscribed here and
      // never change for the lifetime of the connection.
      ws.send(JSON.stringify({ channels: this.channels }));
      console.log(`[Events] Connected, subscribing to ${this.channels.join(", ")}`);
    });

    ws.on("message", (raw) => this.handleFrame(raw.toString()));

    ws.on("close", (code, reason) => {
      if (this.stopped) return;
      console.log(`[Events] Disconnected (${code} ${reason.toString()}) — reconnecting`);
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      // 'close' always follows, so reconnection is scheduled there.
      console.error("[Events] Socket error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_MS);
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
      return; // Not something we can act on; never worth crashing a stream.
    }

    // Server ping. Unidirectional clients cannot pong — it exists purely to
    // keep intermediaries from idling the connection out.
    if (!frame || Object.keys(frame).length === 0) return;

    if (frame.connect) {
      // A successful connect means the previous backoff is stale.
      this.reconnectDelayMs = MIN_RECONNECT_MS;
      return;
    }

    if (frame.disconnect) {
      console.log(
        `[Events] Server disconnect: ${frame.disconnect.code} ${frame.disconnect.reason ?? ""}`
      );
      return; // The 'close' handler reconnects.
    }

    const push = frame.push ?? frame;
    const data = push?.pub?.data;
    if (!push?.channel || !data || typeof data.type !== "string") return;

    this.onPublication(push.channel, { type: data.type, data: data.data ?? null });
  }
}
