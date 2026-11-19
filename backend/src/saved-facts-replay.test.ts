import type http from "http";
import WebSocket from "ws";
import type { Fact, FactsPayload, SSLQueueItem, SSLSong } from "./types";

// The real server with a stand-in song list and generator, one overlay as a WebSocket client:
// facts saved for the song on now, while its found facts are still being written

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
  // Made-up settings: nothing here reaches StreamerSongList or an AI
  Object.assign(process.env, { SONG_SOURCE: "streamersonglist", SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", AI_PROVIDER: "none", BUBBLEFACTS_HEARTBEAT_MS: "150", BUBBLEFACTS_DRAW_GRACE_MS: "150" });
  const actual = jest.requireActual("./config");
  return { ...actual, config: { ...actual.config, port: 0, host: "127.0.0.1", songSource: "streamersonglist", creditBubble: false } };
});
jest.mock("./local-only", () => ({ allowedHost: () => true, allowedOrigin: () => true }));
jest.mock("./credit", () => ({ ...jest.requireActual("./credit"), planCredit: (_count: unknown, facts: Fact[]) => ({ facts }) }));
// Nothing is written to the data folder
jest.mock("./song-facts", () => ({ ...jest.requireActual("./song-facts"), saveSongFacts: () => {}, findSongFacts: () => null, factsOff: () => ({ song: false, artist: false }) }));

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
    lastSuccessfulFetchAgeMs() { return 0; }
    authRejected() { return false; }
    pollIntervalMs() { return 15_000; }
    isEventStreamConnected() { return true; }
  },
}));

// generateFacts as fact-generator.ts behaves around a save: a call waits for its turn to end, and
// one whose song was forgotten meanwhile (forgetSong) gets the song's facts as they are now
const mockGen = { facts: [] as Fact[], revision: 0, turns: [] as (() => void)[], slow: false };
jest.mock("./fact-generator", () => ({
  allowedFacts: (_s: unknown, facts: unknown[]) => facts,
  pulledWithWrong: () => [],
  positionsFor: () => [{ top: "8%", left: "33%" }],
  spotsForSong: () => () => ({ position: { top: "8%", left: "33%" }, vertical: { top: "15%" } }),
  verticalPositionsFor: () => [{ top: "15%" }],
  primeFacts: () => {},
  showsBanner: () => true,
  recentShown: () => [],
  restoreRecent: () => {},
  forgetSong: () => { mockGen.revision++; },
  selfTest: () => Promise.resolve({}),
  setCurrentSong: () => {},
  generateFacts: () => {
    const now = () => mockGen.facts.map((f) => ({ ...f }));
    if (!mockGen.slow) return Promise.resolve(now());
    const revisionAtStart = mockGen.revision;
    const written = now();
    return new Promise<void>((r) => mockGen.turns.push(r)).then(() => (mockGen.revision === revisionAtStart ? written : now()));
  },
  factStats: {},
  markWrong: () => "Some article",
  outcomeFor: () => "",
  aiTimeFor: () => 0,
  paceReport: () => ({ line: "", pace: "full" }),
  ownFactKind: () => null,
  STRUCTURED: "structured",
  unmarkWrong: () => {},
  warmUpBuiltin: () => Promise.resolve(),
}));

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

afterEach(async () => {
  sockets.splice(0).forEach((ws) => ws.terminate());
  mockGen.slow = false;
  mockGen.turns.splice(0).forEach((end) => end());
  mockSource.current = null;
  mockSource.onChange(null);
  await settle();
});

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** An overlay: connects and records the batches of facts the server sends it */
async function overlay() {
  const messages: FactsPayload[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise((r) => ws.once("open", r));
  await settle();
  return { batches: () => messages.filter((m) => m.type === "facts_ready").map((m) => (m.facts ?? []).map((f) => f.text)) };
}

const fact = (text: string, delaySeconds: number): Fact => ({ text, delaySeconds, durationSeconds: 8, position: { top: "8%", left: "33%" } });

let songs = 0;
/** A new song starts; with `slow`, its facts wait for `mockGen.turns` */
async function play(facts: Fact[], slow = false): Promise<SSLSong> {
  const song = { title: `Harbor Lights ${++songs}`, artist: "Paper Comets" };
  mockGen.facts = facts;
  mockGen.slow = slow;
  mockSource.current = { id: songs, bfSong: song } as unknown as SSLQueueItem;
  mockSource.onChange(mockSource.current);
  await settle();
  return song;
}

const post = (route: string, body: object) =>
  fetch(`http://127.0.0.1:${port}/control/${route}`, { method: "POST", headers: { "Content-Type": "application/json", "X-BubbleFacts": "1" }, body: JSON.stringify(body) }).then((r) => r.json());

describe("facts saved for the song on now while its found facts are being written", () => {
  it("go out once: the turn that was running doesn't send them again", async () => {
    const screen = await overlay();
    const song = await play([fact("Found.", 0)], true);
    expect(screen.batches()).toEqual([]);

    // The streamer saves their own facts; the first turn is still running
    mockGen.facts = [fact("Mine one.", 0), fact("Mine two.", 15)];
    mockGen.slow = false;
    expect(await post("song-facts", { song, facts: ["Mine one.", "Mine two."] })).toMatchObject({ saved: true, shown: true });
    await settle();
    expect(screen.batches()).toEqual([["Mine one.", "Mine two."]]);

    // The first turn ends and gets the same saved facts: a second batch would replay the bubbles
    mockGen.turns.splice(0).forEach((end) => end());
    await settle();
    expect(screen.batches()).toEqual([["Mine one.", "Mine two."]]);
  });

  it("leave the next song's facts alone", async () => {
    const screen = await overlay();
    const song = await play([fact("Found.", 0)], true);
    mockGen.facts = [fact("Mine.", 0)];
    mockGen.slow = false;
    await post("song-facts", { song, facts: ["Mine."] });
    await settle();
    mockGen.turns.splice(0).forEach((end) => end());
    await settle();

    await play([fact("Next one.", 0), fact("Next two.", 15)], true);
    mockGen.turns.splice(0).forEach((end) => end());
    await settle();
    expect(screen.batches()).toEqual([["Mine."], ["Next one.", "Next two."]]);
  });

  it("still go out when the turn ends with nothing saved meanwhile", async () => {
    const screen = await overlay();
    await play([fact("Found.", 0)], true);
    mockGen.turns.splice(0).forEach((end) => end());
    await settle();
    expect(screen.batches()).toEqual([["Found."]]);
  });
});
