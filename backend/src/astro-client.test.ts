import { AddressInfo } from "net";
import { WebSocketServer, WebSocket } from "ws";
import { AstroStream } from "./astro-client";

/** A stand-in for Astro on a local port, speaking just enough of the protocol. */
function fakeAstro(onSubscribe: (sub: Record<string, any>, ws: WebSocket) => void) {
  const server = new WebSocketServer({ port: 0 });
  const sockets: WebSocket[] = [];
  server.on("connection", (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: "welcome", data: { client_id: "c1" } }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "subscribe") onSubscribe(msg, ws);
    });
  });
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => {
    for (const ws of sockets) ws.terminate();
    server.close(() => resolve());
  });
  return { url, sockets, close };
}

const waitFor = async (check: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("AstroStream", () => {
  let stream: AstroStream | null = null;
  afterEach(() => stream?.stop());

  it("subscribes after the welcome, then passes on messages for its topic", async () => {
    let subscription: Record<string, any> = {};
    const astro = fakeAstro((sub, ws) => {
      subscription = sub;
      ws.send(JSON.stringify({ type: "response", nonce: sub.nonce, data: { message: "successfully subscribed" } }));
      ws.send(JSON.stringify({ type: "message", topic: "other.topic", room: "r", data: { event: "x" } }));
      ws.send(JSON.stringify({ type: "message", topic: "channel.songrequest", room: "room-1", data: { event: "song.next", payload: {} } }));
    });
    const events: string[] = [];
    const onConnect = jest.fn();
    try {
      stream = new AstroStream(astro.url(), "channel.songrequest", "room-1", () => "jwt-1", (e) => events.push(e.event), onConnect);
      stream.start();
      await waitFor(() => events.length > 0);
      expect(subscription.data).toEqual({ topic: "channel.songrequest", room: "room-1", token: "jwt-1", token_type: "jwt" });
      expect(subscription.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(stream.isConnected()).toBe(true);
      expect(events).toEqual(["song.next"]);
    } finally {
      stream?.stop();
      await astro.close();
    }
  });

  it("isn't connected when the subscription is refused", async () => {
    const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
    let refused = 0;
    const astro = fakeAstro((sub, ws) => {
      refused++;
      ws.send(JSON.stringify({ type: "response", nonce: sub.nonce, error: "err_unauthorized", data: { message: "invalid token" } }));
    });
    const onConnect = jest.fn();
    try {
      stream = new AstroStream(astro.url(), "channel.songrequest", "room-1", () => "bad", () => undefined, onConnect);
      stream.start();
      await waitFor(() => refused > 0);
      await new Promise((r) => setTimeout(r, 50));
      expect(stream.isConnected()).toBe(false);
      expect(onConnect).not.toHaveBeenCalled();
    } finally {
      stream?.stop();
      await astro.close();
      quiet.mockRestore();
    }
  });

  it("reconnects and subscribes again after the connection drops", async () => {
    let subscribes = 0;
    const astro = fakeAstro((sub, ws) => {
      subscribes++;
      ws.send(JSON.stringify({ type: "response", nonce: sub.nonce, data: { message: "ok" } }));
    });
    const onConnect = jest.fn();
    try {
      stream = new AstroStream(astro.url(), "channel.songrequest", "room-1", () => "jwt", () => undefined, onConnect);
      stream.start();
      await waitFor(() => onConnect.mock.calls.length === 1);
      astro.sockets[0].terminate();
      await waitFor(() => onConnect.mock.calls.length === 2, 4000);
      expect(subscribes).toBe(2);
    } finally {
      stream?.stop();
      await astro.close();
    }
  });
});
