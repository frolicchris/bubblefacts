import http from "http";
import { AddressInfo } from "net";
import { CONTENT_LIMIT, SHARE_TTL_SECONDS, shareAddress, shareContent, SongFactSharer } from "./share-song-facts";
import { buildStatFacts } from "./stat-facts";
import { Fact, SSLQueueItem, SSLSong } from "./types";

const KEY = "made-up-key-12345";
const song: SSLSong = { title: "Paper Lanterns", artist: "The Made Up Band", requestedBy: "viewer_name" };
const fact = (text: string, source = "Wikipedia: Paper Lanterns"): Fact => ({ text, source, delaySeconds: 0, durationSeconds: 8, position: {} });
const facts = [fact("It was recorded in one take."), fact("It came out in 1999.", "Wikidata")];
const HEAD = 'Now playing: "Paper Lanterns" by The Made Up Band.';
const NO_FACTS = `${HEAD} BubbleFacts has no checked facts for this song right now. Say what's playing if asked, and don't make up facts about it. Your own opinions are welcome, said as yours.`;

/** Stand-in events API: records what it's sent, answers with `status` */
function standIn() {
  const server = { status: 200, delayMs: 0, location: "", requests: [] as Array<{ auth?: string; body: { eventType: string; data: Record<string, unknown> } }>, url: "" };
  const http_ = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      server.requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      setTimeout(() => {
        res.statusCode = server.status;
        if (server.location) res.setHeader("Location", server.location);
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
  it("says the song, its checked facts and where they were checked, and to add no facts of its own", () => {
    expect(shareContent(song, facts)).toBe(
      `${HEAD} Facts from BubbleFacts, checked against Wikipedia and Wikidata: It was recorded in one take. It came out in 1999. State facts about this song only from these, add none, and credit BubbleFacts. Your own opinions are welcome, said as yours.`
    );
  });

  it("names only the sources its facts came from", () => {
    expect(shareContent(song, [facts[0]])).toContain("checked against Wikipedia: It was");
    expect(shareContent(song, [fact("It runs 3:41.", "MusicBrainz")])).toContain("checked against MusicBrainz: It runs");
    expect(shareContent(song, [...facts, fact("It runs 3:41.", "MusicBrainz"), fact("A single from 1999.", "Wikipedia infobox: Paper Lanterns")])).toContain(
      "checked against Wikipedia, Wikidata and MusicBrainz:"
    );
  });

  it("says the song as soon as it starts, and that there are no facts to state yet", () => {
    expect(shareContent(song, [])).toBe(NO_FACTS);
  });

  it("never sends who requested the song", () => {
    expect(shareContent(song, facts)).not.toContain("viewer_name");
    // The song list's own line about the requester, as the pipeline writes it.
    const entry: SSLQueueItem = { id: 1, songId: null, song: { title: song.title, artist: song.artist }, nonlistSong: null, note: null, streamerId: 1, createdAt: "", requests: [{ id: 1, name: "viewer_name" }] };
    const lines = buildStatFacts(entry, { streamerName: "madeupchannel" });
    expect(lines.join(" ")).toContain("viewer_name");
    const fromList = lines.map((l) => fact(l, "Your song list"));
    expect(shareContent(song, [...facts, ...fromList])).not.toContain("viewer_name");
    expect(shareContent(song, fromList)).toBe(NO_FACTS);
  });

  it("doesn't call the streamer's own facts checked, or credit them to BubbleFacts", () => {
    const text = shareContent(song, [facts[0], fact("Written on a train.", "Your facts for this song")]);
    expect(text).toContain("It was recorded in one take. From the streamer: Written on a train. State");
    expect(shareContent(song, [fact("Written on a train.", "Your facts for this song")])).toBe(
      `${HEAD} From the streamer: Written on a train. State facts about this song only from these, and add none. Your own opinions are welcome, said as yours.`
    );
  });

  it("keeps an artist's Twitch About as theirs, not the streamer's", () => {
    const text = shareContent(song, [fact("From their Twitch About: I write songs about trains.", "Twitch About: madeupartist")]);
    expect(text).toBe(`${HEAD} From their Twitch About: I write songs about trains. State facts about this song only from these, and add none. Your own opinions are welcome, said as yours.`);
  });

  it("leaves out an unknown artist", () => {
    expect(shareContent({ title: "Paper Lanterns", artist: "Unknown" }, facts)).toMatch(/^Now playing: "Paper Lanterns"\. Facts from/);
  });

  it("stays within the limit with whole facts", () => {
    const many = Array.from({ length: 12 }, (_, i) => fact(`Fact ${i} ${"x".repeat(280)}.`));
    const long = shareContent({ title: "T".repeat(500), artist: "A".repeat(500) }, many);
    expect(long.length).toBeLessThanOrEqual(CONTENT_LIMIT);
    expect(long).toMatch(/credit BubbleFacts\. Your own opinions are welcome, said as yours\.$/);
    expect(long.match(/Fact \d+ x{280}\./g)?.length).toBeGreaterThan(0);
    const mixed = shareContent(song, [...Array.from({ length: 8 }, (_, i) => fact(`Checked ${i} ${"y".repeat(150)}.`, "Wikidata")), fact("Written on a train.", "Your custom facts")]);
    expect(mixed.length).toBeLessThanOrEqual(CONTENT_LIMIT);
  });

  it("keeps a title to one line, in quotes", () => {
    expect(shareContent({ title: "One\n\nTwo\u0007", artist: "Band" }, facts)).toMatch(/^Now playing: "One Two" by Band\./);
    expect(shareContent({ title: 'Say "Hello"', artist: "Band" }, [])).toMatch(/^Now playing: "Say 'Hello'" by Band\./);
  });

  it("doesn't announce a track that isn't music, unless the streamer gave it facts", () => {
    const ad: SSLSong = { title: "Moonbrew Cola Commercial", artist: "" };
    expect(shareContent(ad, [])).toBe("");
    expect(shareContent(ad, [fact("Our sponsor tonight.", "Your facts for this song")])).toContain('Now playing: "Moonbrew Cola Commercial".');
    expect(shareContent({ title: " ", artist: "Band" }, facts)).toBe("");
  });
});

describe("shareAddress", () => {
  it.each([
    ["https://share.example.com/v1/events"],
    ["http://localhost:8123/events"],
    ["http://127.0.0.1:8123/events"],
    ["http://[::1]:8123/events"],
  ])("takes %s", (url) => expect(shareAddress(` ${url} `)).toBe(url));

  it.each([
    ["http://share.example.com/v1/events"],
    ["http://localhost.example.com/events"],
    ["ftp://share.example.com/"],
    ["https://name:secret@share.example.com/"],
    ["share.example.com"],
    [""],
  ])("refuses %s", (url) => expect(shareAddress(url)).toBeNull());
});

describe("SongFactSharer", () => {
  let stand: ReturnType<typeof standIn>;
  const lines: string[] = [];
  /** Every sharer a test starts, stopped when it ends: one left running would log into the next test. */
  const started: SongFactSharer[] = [];
  const track = (s: SongFactSharer) => (started.push(s), s);
  const sharer = (more: { refreshMs?: number } = {}) =>
    track(new SongFactSharer({ url: stand.server.url, apiKey: KEY, channel: "madeupchannel", settleMs: 1, timeoutMs: 200, log: (l) => lines.push(l), ...more }));

  beforeEach(async () => {
    lines.length = 0;
    stand = standIn();
    await stand.ready;
  });
  afterEach(() => {
    for (const s of started.splice(0)) s.stop();
    return stand.close();
  });

  it("sends one snapshot of the song to the events endpoint, with the key as a bearer token", async () => {
    sharer().update(song, facts);
    await until(() => stand.server.requests.length === 1);
    const [{ auth, body }] = stand.server.requests;
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(body.eventType).toBe("INTEGRATION_STATE");
    expect(body.data).toEqual({ channelName: "madeupchannel", sourceId: "bubblefacts", content: shareContent(song, facts), ttl: SHARE_TTL_SECONDS });
  });

  it("shares the song when it starts, then its facts when they arrive", async () => {
    const s = sharer();
    s.update(song, []);
    await until(() => stand.server.requests.length === 1);
    expect(stand.server.requests[0].body.data.content).toBe(NO_FACTS);
    s.update(song, facts);
    await until(() => stand.server.requests.length === 2);
    expect(stand.server.requests[1].body.data.content).toContain("It came out in 1999.");
  });

  it("sends only the latest of changes made close together, and nothing when they repeat", async () => {
    const s = sharer();
    s.update(song, []);
    s.update(song, [facts[0]]);
    s.update(song, facts);
    await until(() => stand.server.requests.length === 1);
    s.update(song, facts);
    await settled();
    expect(stand.server.requests).toHaveLength(1);
    expect(stand.server.requests[0].body.data.content).toContain("1999");
  });

  it("takes a fact off again when it comes off the stream", async () => {
    const s = sharer();
    s.update(song, facts);
    await until(() => stand.server.requests.length === 1);
    s.update(song, [facts[1]]);
    await until(() => stand.server.requests.length === 2);
    expect(stand.server.requests[1].body.data.content).not.toContain("one take");
  });

  it("clears the snapshot when the song ends", async () => {
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
    await new Promise((r) => setTimeout(r, stand.server.delayMs + 30)); // last answer lands before the stand-in closes
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

  it("tries again with each refresh after a failure, and shares once the other app answers", async () => {
    stand.server.status = 500;
    const s = sharer({ refreshMs: 15 });
    s.update(song, facts);
    await until(() => stand.server.requests.length >= 3);
    expect(lines).toEqual(["[Share] Song facts not shared: HTTP 500"]);
    stand.server.status = 200;
    const failed = stand.server.requests.length;
    await until(() => stand.server.requests.length > failed);
    s.stop();
    expect(stand.server.requests[failed].body.data.content).toBe(shareContent(song, facts));
  });

  it("says a refused event plainly", async () => {
    stand.server.status = 422;
    sharer().update(song, facts);
    await until(() => lines.length === 1);
    expect(lines[0]).toBe("[Share] Song facts not shared: the event was refused");
  });

  it("says nothing more once it's stopped, even when a request was on its way", async () => {
    stand.server.delayMs = 60;
    const s = sharer();
    s.update(song, facts);
    await until(() => stand.server.requests.length === 1);
    s.stop();
    // The connection goes away under the request that was still waiting for its answer.
    await stand.close();
    await settled();
    expect(lines).toEqual([]);
  });

  it("stops after the key is refused, until a restart", async () => {
    stand.server.status = 401;
    const s = sharer({ refreshMs: 15 });
    s.update(song, facts);
    await until(() => lines.length === 1);
    s.update({ title: "Second Song", artist: "Band" }, facts);
    await settled();
    expect(stand.server.requests).toHaveLength(1);
    expect(lines[0]).toBe("[Share] Song facts not shared: the key or channel was refused");
    expect(lines.join()).not.toContain(KEY);
  });

  it("says a dead connection and a timeout quietly", async () => {
    const dead = track(new SongFactSharer({ url: "http://127.0.0.1:9/v1/events", apiKey: KEY, channel: "c", settleMs: 1, log: (l) => lines.push(l) }));
    dead.update(song, facts);
    await until(() => lines.length === 1);
    expect(lines[0]).toBe("[Share] Song facts not shared: no connection");
    stand.server.delayMs = 400;
    const slow = track(new SongFactSharer({ url: stand.server.url, apiKey: KEY, channel: "c", settleMs: 1, timeoutMs: 20, log: (l) => lines.push(l) }));
    slow.update(song, facts);
    await until(() => lines.length === 2);
    expect(lines[1]).toBe("[Share] Song facts not shared: timed out");
  });

  it("doesn't follow a redirect, so the key stays with the address set", async () => {
    stand.server.status = 307;
    stand.server.location = "http://127.0.0.1:9/elsewhere";
    sharer().update(song, facts);
    await until(() => lines.length === 1);
    expect(lines[0]).toBe("[Share] Song facts not shared: no connection");
    expect(stand.server.requests).toHaveLength(1);
  });

  it("sends the song again every minute, well before it runs out, for an hour after it last changed", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const posts: Array<{ data: { content: string; ttl?: number } }> = [];
    const realFetch = global.fetch;
    global.fetch = (async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    try {
      const s = sharer();
      s.update(song, []);
      await jest.advanceTimersByTimeAsync(5);
      expect(posts).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(59_000);
      expect(posts).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(posts).toHaveLength(2);
      // Each one lasts longer than two refreshes, so a single missed send doesn't drop the song.
      expect(posts.every((p) => p.data.ttl === SHARE_TTL_SECONDS)).toBe(true);
      expect(SHARE_TTL_SECONDS).toBeGreaterThan(120);
      // A change starts the hour over, and its own refreshes.
      s.update(song, facts);
      await jest.advanceTimersByTimeAsync(5);
      expect(posts).toHaveLength(3);
      await jest.advanceTimersByTimeAsync(3_600_000);
      const afterAnHour = posts.length;
      expect(afterAnHour).toBeGreaterThanOrEqual(60);
      expect(afterAnHour).toBeLessThanOrEqual(63);
      await jest.advanceTimersByTimeAsync(4 * 3_600_000);
      expect(posts).toHaveLength(afterAnHour);
      // The song ending clears it, and nothing is sent after that.
      s.update(null, []);
      await jest.advanceTimersByTimeAsync(5);
      expect(posts[posts.length - 1].data).toEqual({ channelName: "madeupchannel", sourceId: "bubblefacts", content: "" });
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(posts).toHaveLength(afterAnHour + 1);
    } finally {
      global.fetch = realFetch;
      jest.useRealTimers();
    }
  });
});
