import { randomUUID } from "crypto";
import WebSocket from "ws";

/**
 * Minimal reader for StreamElements' realtime service, "Astro". The whole
 * protocol used here:
 *
 *   server  {"type":"welcome", ...}
 *   client  {"type":"subscribe","nonce":"…","data":{"topic","room","token","token_type":"jwt"}}
 *   server  {"type":"response","nonce":"…","data":{"message":"…"}}          subscribed
 *   server  {"type":"response","nonce":"…","error":"…","data":{"message"}}  refused
 *   server  {"type":"message","topic":"…","room":"…","data":{"event":"…","payload":{…}}}
 *   server  {"type":"reconnect"}                                               please reconnect
 *
 * The server's pings are WebSocket ping frames, which the ws library answers.
 */

export interface AstroEvent {
  topic: string;
  event: string;
}

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 60_000;
/** Subscribe anyway if the welcome never comes. */
const WELCOME_WAIT_MS = 5_000;

export class AstroStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private subscribed = false;
  private reconnectDelayMs = MIN_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeTimer: ReturnType<typeof setTimeout> | null = null;
  private nonce = "";
  /** Astro refused the token on the last subscribe. */
  private rejected = false;

  constructor(
    private readonly url: string,
    private readonly topic: string,
    private readonly room: string,
    private readonly token: () => string,
    private readonly onMessage: (event: AstroEvent) => void,
    /** Called on every successful (re)subscribe: anything sent while disconnected was missed. */
    private readonly onConnect: () => void = () => undefined
  ) {}

  isConnected(): boolean {
    return this.subscribed;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.subscribed = false;
    for (const t of [this.reconnectTimer, this.welcomeTimer]) if (t) clearTimeout(t);
    this.reconnectTimer = this.welcomeTimer = null;
    // Keep a no-op error listener: closing a socket that is still connecting emits one.
    this.ws?.removeAllListeners().on("error", () => undefined);
    this.ws?.terminate();
    this.ws = null;
  }

  private open(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.subscribed = false;

    ws.on("open", () => {
      this.welcomeTimer = setTimeout(() => this.subscribe(ws), WELCOME_WAIT_MS);
    });
    ws.on("message", (raw) => this.handleFrame(ws, raw.toString()));
    ws.on("close", (code, reason) => {
      this.subscribed = false;
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      if (this.stopped) return;
      console.log(`[Events] StreamElements disconnected (${code} ${reason.toString()}), reconnecting`);
      this.scheduleReconnect();
    });
    // "close" always follows "error"; reconnection happens there.
    ws.on("error", (err) => console.error("[Events] StreamElements socket error:", err.message));
  }

  private subscribe(ws: WebSocket): void {
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.welcomeTimer = null;
    if (ws !== this.ws || ws.readyState !== WebSocket.OPEN) return;
    this.nonce = randomUUID();
    ws.send(
      JSON.stringify({
        type: "subscribe",
        nonce: this.nonce,
        data: { topic: this.topic, room: this.room, token: this.token(), token_type: "jwt" },
      })
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    // A refused token won't start working on its own; don't hammer the service with it.
    const delay = this.rejected ? MAX_RECONNECT_MS : this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleFrame(ws: WebSocket, raw: string): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;

    switch (frame.type) {
      case "welcome":
        this.subscribe(ws);
        return;
      case "response":
        if (frame.nonce && frame.nonce !== this.nonce) return;
        if (frame.error) {
          this.rejected = /unauthori[sz]ed|forbidden|token|auth/i.test(`${frame.error} ${frame.data?.message ?? ""}`);
          console.error(`[Events] StreamElements refused the subscription: ${frame.error} ${frame.data?.message ?? ""}`);
          ws.close();
          return;
        }
        this.rejected = false;
        this.subscribed = true;
        this.reconnectDelayMs = MIN_RECONNECT_MS;
        console.log(`[Events] Connected to StreamElements, listening to ${this.topic}`);
        this.onConnect();
        return;
      case "reconnect":
        ws.close();
        return;
      case "message":
        if (frame.topic === this.topic) {
          this.onMessage({ topic: frame.topic, event: typeof frame.data?.event === "string" ? frame.data.event : "" });
        }
        return;
      default:
        return;
    }
  }
}
