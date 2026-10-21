import type http from "http";
import WebSocket from "ws";
import type { Fact, FactsPayload, SSLQueueItem, SSLSong } from "./types";

/**
 * The real server, with a stand-in song list and fact generator, and overlays
 * as WebSocket clients: what an overlay that connects or reloads mid-song is
 * sent (issue #279).
 */

const mockServers: http.Server[] = [];
jest.mock("http", () => {
  const actual = jest.requireActual("http");
  return {
    ...actual,
    createServer: (...args: unknown[]) => {
      const server = actual.createServer(...args);
      mockServers.push(server);
      return server;
    },
  };
});
jest.mock("./config", () => {
  // Made-up settings: nothing here reaches StreamerSongList or an AI.
  Object.assign(process.env, { SONG_SOURCE: "streamersonglist", SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", AI_PROVIDER: "none" });
  const actual = jest.requireActual("./config");
  return { ...actual, config: { ...actual.config, port: 0, host: "127.0.0.1", songSource: "streamersonglist", creditBubble: false } };
});
jest.mock("./local-only", () => ({ allowedHost: () => true, allowedOrigin: () => true }));

const mockSource: { current: SSLQueueItem | null; onChange: (c: SSLQueueItem | null) => void } = { current: null, onChange: () => {} };
jest.mock("./songlist-client", () => ({
  setAccessToken: () => {},
  SongListClient: class {
    name = "StreamerSongList";
    onCurrentSongChange(cb: (c: SSLQueueItem | null) => void) { mockSource.onChange = cb; }
    getCurrentSong() { return mockSource.current; }
    toSong(item: SSLQueueItem & { bfSong: SSLSong }) { return item.bfSong; }
    displayTitle() { return ""; }
    connect() { return Promise.resolve(); }
  },
}));

const mockFacts: { list: Fact[] } = { list: [] };
jest.mock("./fact-generator", () => ({
  allowedFacts: (_s: unknown, facts: unknown[]) => facts,
  pulledWithWrong: () => [],
  positionsFor: () => [{ top: "8%", left: "33%" }],
  positionsForSong: () => [{ top: "8%", left: "33%" }],
  primeFacts: () => {},
  showsBanner: () => true,
  recentShown: () => [],
  restoreRecent: () => {},
  forgetSong: () => {},
  selfTest: () => Promise.resolve({}),
  setCurrentSong: () => {},
  // Every call gives the song's full list, as a regenerated batch would.
  generateFacts: () => Promise.resolve(mockFacts.list.map((f) => ({ ...f }))),
  factStats: {},
  markWrong: () => "Some article",
  outcomeFor: () => "",
  ownFactKind: () => null,
  STRUCTURED: "structured",
  unmarkWrong: () => {},
  warmUpBuiltin: () => Promise.resolve(),
}));

let now = 1_000_000;
jest.spyOn(Date, "now").mockImplementation(() => now);

let port = 0;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  await import("./server");
  const server = mockServers[0];
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  sockets.forEach((ws) => ws.terminate());
  if (mockServers[0]) await new Promise((r) => mockServers[0].close(r));
});

const settle = (ms = 100) => new Promise((r) => jest.requireActual<typeof globalThis>("timers").setTimeout(r, ms));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await settle(20);
  if (!check()) throw new Error("timed out");
}

/** An overlay: connects and records every message the server sends it. */
async function overlay() {
  const messages: FactsPayload[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise((r) => ws.once("open", r));
  const batch = async () => {
    await until(() => messages.some((m) => m.type === "facts_ready"));
    return messages.find((m) => m.type === "facts_ready")!.facts!;
  };
  return { ws, messages, batch };
}

const fact = (text: string, delaySeconds: number): Fact => ({ text, delaySeconds, durationSeconds: 8, position: { top: "8%", left: "33%" } });
const texts = (facts: Fact[]) => facts.map((f) => f.text);

let songs = 0;
/** A new song starts, with these facts, and they go out to whatever overlays are connected. */
async function play(facts: Fact[]): Promise<SSLSong> {
  const song = { title: `Harbor Lights ${++songs}`, artist: "Paper Comets" };
  mockFacts.list = facts;
  mockSource.current = { id: songs, bfSong: song } as unknown as SSLQueueItem;
  mockSource.onChange(mockSource.current);
  await settle();
  return song;
}

const post = (route: string, body: object) =>
  fetch(`http://127.0.0.1:${port}/control/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-BubbleFacts": "1" }, body: JSON.stringify(body) }).then((r) => r.json());

afterEach(async () => {
  sockets.splice(0).forEach((ws) => ws.terminate());
  mockSource.current = null;
  mockSource.onChange(null);
  await settle();
});

describe("an overlay that connects mid-song (issue #279)", () => {
  it("gets the bubbles that haven't finished showing, on the other overlays' schedule", async () => {
    const first = await overlay();
    await play([fact("One.", 0), fact("Two.", 15), fact("Three.", 30)]);
    expect(texts(await first.batch())).toEqual(["One.", "Two.", "Three."]);

    now += 5000;
    // Two overlays at once, as with a second output: each gets the same bubbles.
    const [second, third] = await Promise.all([overlay(), overlay()]);
    const caughtUp = await second.batch();
    // "One." is on screen for 3 seconds more; the rest keep their places in the schedule.
    expect(caughtUp.map((f) => [f.text, f.delaySeconds])).toEqual([["One.", 0], ["Two.", 10], ["Three.", 25]]);
    expect(caughtUp[0].durationSeconds).toBe(3);
    expect(await third.batch()).toEqual(caughtUp);
    // No second NOW PLAYING banner.
    expect(second.messages[0]).toMatchObject({ type: "new_song", quiet: true });
  });

  it("gets no repeats of what's already shown when it reconnects", async () => {
    await overlay();
    await play([fact("One.", 0), fact("Two.", 15), fact("Three.", 30)]);
    now += 20_000;
    const reloaded = await overlay();
    expect(texts(await reloaded.batch())).toEqual(["Two.", "Three."]);
    reloaded.ws.terminate();

    now += 4000;
    const again = await overlay();
    // "Two." finished at 23 seconds; only "Three." is still to come, 6 seconds from now.
    expect((await again.batch()).map((f) => [f.text, f.delaySeconds])).toEqual([["Three.", 6]]);
  });

  it("never gets a fact taken off with Wrong, even when no overlay was there when it went out", async () => {
    const song = await play([fact("One.", 0), fact("Two.", 15), fact("Three.", 30)]);
    expect(await post("wrong", { text: "Two.", song, live: true })).toMatchObject({ removed: true, live: true });

    const first = await overlay();
    expect(texts(await first.batch())).toEqual(["One.", "Three."]);
    now += 5000;
    const second = await overlay();
    expect(texts(await second.batch())).toEqual(["One.", "Three."]);
  });

  it("gets nothing between songs", async () => {
    await overlay();
    await play([fact("One.", 0)]);
    mockSource.current = null;
    mockSource.onChange(null);
    await settle();
    const late = await overlay();
    await settle();
    expect(late.messages).toEqual([]);
  });

  it("gets nothing while bubbles are paused", async () => {
    await overlay();
    await play([fact("One.", 0), fact("Two.", 15)]);
    await post("pause", { paused: true });
    const late = await overlay();
    await settle();
    expect(late.messages).toEqual([]);
    await post("pause", { paused: false });
  });
});
