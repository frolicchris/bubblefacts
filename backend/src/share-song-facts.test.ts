import http from "http";
import { AddressInfo } from "net";
import { CONTENT_LIMIT, shareContent, shareTtl, SongFactSharer } from "./share-song-facts";
import { Fact, SSLSong } from "./types";

const KEY = "made-up-key-12345";
const song: SSLSong = { title: "Paper Lanterns", artist: "The Made Up Band", requestedBy: "viewer_name" };
const fact = (text: string, source = "Wikipedia: Paper Lanterns"): Fact => ({ text, source, delaySeconds: 0, durationSeconds: 8, position: {} });
const facts = [fact("It was recorded in one take."), fact("It came out in 1999.", "Wikidata")];

/** A stand-in for the events API: records what it's sent and answers with `status`. */
function standIn() {
  const server = { status: 200, delayMs: 0, requests: [] as Array<{ auth?: string; body: { eventType: string; data: Record<string, unknown> } }>, url: "" };
  const http_ = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      server.requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      setTimeout(() => {
        res.statusCode = server.status;
        res.end();
      }, server.delayMs);
    });
  });
  const ready = new Promise<void>((resolve) =>
    http_.listen(0, "127.0.0.1", () => {
      server.url = `http://127.0.0.1:${(http_.address() as AddressInfo).port}/v1/events`;
      resolve();
    })
  );
  return { server, ready, close: () => new Promise((resolve) => { http_.closeAllConnections(); http_.close(resolve); }) };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(done()).toBe(true);
};
const settled = () => new Promise((r) => setTimeout(r, 40));

describe("shareContent", () => {
  it("says the song, its checked facts, and to add nothing", () => {
    expect(shareContent(song, facts)).toBe(
      "Now playing: Paper Lanterns by The Made Up Band. Checked facts from Wikipedia, Wikidata and MusicBrainz: It was recorded in one take. It came out in 1999. Answer questions about this song only from these facts and add nothing."
    );
  });

  it("never sends who requested the song", () => {
    expect(shareContent(song, facts)).not.toContain("viewer_name");
  });

  it("doesn't call the streamer's own facts checked", () => {
    const text = shareContent(song, [facts[0], fact("Written on a train.", "Your facts for this song")]);
    expect(text).toContain("It was recorded in one take. From the streamer: Written on a train. Answer");
  });

  it("has nothing to share without facts", () => {
    expect(shareContent(song, [])).toBe("");
  });

  it("leaves out an unknown artist", () => {
    expect(shareContent({ title: "Paper Lanterns", artist: "Unknown" }, facts)).toMatch(/^Now playing: Paper Lanterns\. Checked/);
  });

  it("stays within the limit with whole facts", () => {
    const many = Array.from({ length: 12 }, (_, i) => fact(`Fact ${i} ${"x".repeat(280)}.`));
    const long = shareContent({ title: "T".repeat(500), artist: "A".repeat(500) }, many);
    expect(long.length).toBeLessThanOrEqual(CONTENT_LIMIT);
    expect(long).toMatch(/add nothing\.$/);
    expect(long.match(/Fact \d+ x{280}\./g)?.length).toBeGreaterThan(0);
  });

  it("keeps a title to one line", () => {
    expect(shareContent({ title: "One\n\nTwo\u0007", artist: "Band" }, facts)).toMatch(/^Now playing: One Two by Band\./);
  });
});

describe("shareTtl", () => {
  it("lasts about the song, with a default when its length isn't known", () => {
    expect(shareTtl(200)).toBe(230);
    expect(shareTtl(null)).toBe(420);
    expect(shareTtl(100000)).toBe(3600);
  });
});

describe("SongFactSharer", () => {
  let stand: ReturnType<typeof standIn>;
  const lines: string[] = [];
  const sharer = () =>
    new SongFactSharer({ url: stand.server.url, apiKey: KEY, channel: "madeupchannel", settleMs: 1, timeoutMs: 200, log: (l) => lines.push(l) });

  beforeEach(async () => {
    lines.length = 0;
    stand = standIn();
    await stand.ready;
  });
  afterEach(() => stand.close());

  it("sends one snapshot of the song to the events endpoint, with the key as a bearer token", async () => {
    sharer().update(song, facts, 200);
    await until(() => stand.server.requests.length === 1);
    const [{ auth, body }] = stand.server.requests;
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(body.eventType).toBe("INTEGRATION_STATE");
    expect(body.data).toEqual({ channelName: "madeupchannel", sourceId: "bubblefacts", content: shareContent(song, facts), ttl: 230 });
  });

  it("sends only the latest of changes made close together, and nothing when they repeat", async () => {
    const s = sharer();
    s.update(song, [facts[0]]);
    s.update(song, facts);
    await until(() => stand.server.requests.length === 1);
    s.update(song, facts);
    await settled();
    expect(stand.server.requests).toHaveLength(1);
    expect(stand.server.requests[0].body.data.content).toContain("1999");
  });

  it("clears the snapshot when the song ends or its facts are gone", async () => {
    const s = sharer();
    s.update(song, facts);
    await until(() => stand.server.requests.length === 1);
    s.update(null, []);
    await until(() => stand.server.requests.length === 2);
    expect(stand.server.requests[1].body.data).toEqual({ channelName: "madeupchannel", sourceId: "bubblefacts", content: "" });
  });

  it("sends nothing when there was never anything to share", async () => {
    sharer().update(null, []);
    await settled();
    expect(stand.server.requests).toHaveLength(0);
  });

  it("doesn't wait on a slow answer, and sends the newer song after it", async () => {
    stand.server.delayMs = 50;
    const s = sharer();
    const started = Date.now();
    s.update(song, facts);
    expect(Date.now() - started).toBeLessThan(20);
    await until(() => stand.server.requests.length === 1);
    s.update({ title: "Second Song", artist: "Band" }, facts);
    await until(() => stand.server.requests.length === 2);
    expect(stand.server.requests[1].body.data.content).toContain("Second Song");
    await new Promise((r) => setTimeout(r, stand.server.delayMs + 30)); // Lets the last answer land before the stand-in closes.
  });

  it("logs a failure once, by reason, without the key or the song", async () => {
    stand.server.status = 500;
    const s = sharer();
    s.update(song, facts);
    await until(() => lines.length === 1);
    s.update(song, [facts[0]]);
    await until(() => stand.server.requests.length === 2);
    await settled();
    expect(lines).toEqual(["[Share] Song facts not shared: HTTP 500"]);
  });

  it("stops after the key is refused, until a restart", async () => {
    stand.server.status = 401;
    const s = sharer();
    s.update(song, facts);
    await until(() => lines.length === 1);
    s.update({ title: "Second Song", artist: "Band" }, facts);
    await settled();
    expect(stand.server.requests).toHaveLength(1);
    expect(lines[0]).toBe("[Share] Song facts not shared: the key or channel was refused");
    expect(lines.join()).not.toContain(KEY);
  });

  it("says a dead connection and a timeout quietly", async () => {
    const dead = new SongFactSharer({ url: "http://127.0.0.1:9/v1/events", apiKey: KEY, channel: "c", settleMs: 1, log: (l) => lines.push(l) });
    dead.update(song, facts);
    await until(() => lines.length === 1);
    expect(lines[0]).toBe("[Share] Song facts not shared: no connection");
    stand.server.delayMs = 400;
    const slow = new SongFactSharer({ url: stand.server.url, apiKey: KEY, channel: "c", settleMs: 1, timeoutMs: 20, log: (l) => lines.push(l) });
    slow.update(song, facts);
    await until(() => lines.length === 2);
    expect(lines[1]).toBe("[Share] Song facts not shared: timed out");
  });

  it("sends a long song again before its snapshot runs out", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const posts: string[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (_url: string, init: RequestInit) => {
      posts.push(String(init.body));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      sharer().update(song, facts, 300);
      await jest.advanceTimersByTimeAsync(5);
      expect(posts).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(299_000);
      expect(posts).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(posts).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(4 * 3_600_000);
      expect(posts.length).toBeLessThanOrEqual(13);
    } finally {
      global.fetch = realFetch;
      jest.useRealTimers();
    }
  });
});
