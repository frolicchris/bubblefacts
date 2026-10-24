import { AddressInfo } from "net";
import { WebSocket, WebSocketServer } from "ws";
import { CentrifugoStream, SSLEvent } from "./centrifugo-client";

// A local stand-in for StreamerSongList's Centrifugo, speaking its unidirectional protocol.
describe("CentrifugoStream", () => {
  let server: WebSocketServer;
  let url: string;
  let stream: CentrifugoStream | null;
  let requests: unknown[];
  let reply: (request: Record<string, any>, socket: WebSocket) => void;
  const CHANNELS = ["streamer:4242", "streamer:4242-queue"];

  beforeEach(async () => {
    requests = [];
    stream = null;
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on("connection", (socket) =>
      socket.once("message", (raw) => {
        const request = JSON.parse(raw.toString());
        requests.push(request);
        reply(request, socket);
      })
    );
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    stream?.stop();
    for (const c of server.clients) c.terminate();
    await new Promise((r) => server.close(r));
    jest.restoreAllMocks();
  });

  /** What Centrifugo 6 answers: `subs` lists only the channels it subscribed. */
  const centrifugo = (request: Record<string, any>, socket: WebSocket) => {
    const subs = Object.fromEntries(Object.keys(request.subs ?? {}).map((c) => [c, { recoverable: true, epoch: "abc", offset: 7, positioned: true }]));
    socket.send(JSON.stringify({ connect: { client: "c-1", version: "6.9.4 OSS", ...(Object.keys(subs).length ? { subs } : {}), ping: 25, session: "s-1" } }));
  };

  async function start(onPublication: (channel: string, event: SSLEvent) => void = () => undefined) {
    const connected = jest.fn();
    stream = new CentrifugoStream(url, CHANNELS, onPublication, connected);
    stream.start();
    await waitFor(() => connected.mock.calls.length > 0);
    return connected;
  }

  it("asks for the channels as Centrifugo's subs, and counts as connected only when subscribed", async () => {
    reply = centrifugo;
    await start();
    expect(requests).toEqual([{ subs: { "streamer:4242": {}, "streamer:4242-queue": {} } }]);
    expect(stream!.isConnected()).toBe(true);
  });

  it("is not connected when the server subscribed nothing, so polling isn't slowed for events that never come", async () => {
    // 2.0's request: Centrifugo connects it, ignores the unknown field, and subscribes nothing.
    reply = (_request, socket) => socket.send(JSON.stringify({ connect: { client: "c-1", version: "6.9.4 OSS", ping: 25, session: "s-1" } }));
    const connected = await start();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(stream!.isConnected()).toBe(false);
  });

  it("passes on every publication, with or without a type, including several frames in one message", async () => {
    reply = (request, socket) => {
      centrifugo(request, socket);
      // As StreamerSongList sends them: a bare publication, the same one on both channels.
      for (const channel of CHANNELS) {
        socket.send(JSON.stringify({ channel, pub: { data: { type: "queue_reorder", data: { streamerId: 4242, items: [{ id: 11 }, { id: 12 }], playingId: 11 } }, offset: 8 } }));
      }
      socket.send("{}");
      // Wrapped in "push", with no type, and two frames in one message.
      socket.send(
        [
          JSON.stringify({ push: { channel: "streamer:4242-queue", pub: { data: { queueId: 12 }, offset: 9 } } }),
          JSON.stringify({ channel: "streamer:4242", pub: { data: null, offset: 10 } }),
        ].join("\n")
      );
    };
    const seen: Array<[string, string]> = [];
    await start((channel, event) => seen.push([channel, event.type]));
    await waitFor(() => seen.length >= 4);
    expect(seen).toEqual([
      ["streamer:4242", "queue_reorder"],
      ["streamer:4242-queue", "queue_reorder"],
      ["streamer:4242-queue", ""],
      ["streamer:4242", ""],
    ]);
  });
});

async function waitFor(ok: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
