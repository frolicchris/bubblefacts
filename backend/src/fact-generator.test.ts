const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    streamerDisplayName: "Test Streamer",
    originals: true,
    instrument: "",
    topic: "video-game,classical,film,pop,piano,general",
    aiProvider: "anthropic",
    anthropicApiKey: "test-key",
    anthropicModel: "test-model",
    temperature: 0.2,
    factVerification: false,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
  },
}));

jest.mock("./wikidata", () => ({ wikidataFacts: jest.fn().mockResolvedValue([]) }));
jest.mock("./musicbrainz", () => ({ musicbrainzFacts: jest.fn().mockResolvedValue([]) }));

jest.mock("./fact-verifier", () => ({
  ...jest.requireActual("./fact-verifier"),
  fetchGrounding: jest.fn().mockResolvedValue(""),
}));

import { config } from "./config";
import { clearFactCache, factStats, generateFacts } from "./fact-generator";
import { fetchGrounding } from "./fact-verifier";
import { SSLQueueItem, SSLSong } from "./types";

const MODEL_LINES = [
  "The soundtrack was recorded with a small string section in one weekend.",
  "Its main melody was first sketched on an upright piano at the studio.",
  "The composer later arranged the theme for a full orchestra.",
  "An acoustic guitar carries the melody in the quieter second half.",
  "The final track fades out on a sustained organ chord.",
  "A choir joins the arrangement only in the closing minute.",
  "The bass line was played on a fretless electric bass.",
].join("\n");

const reply = (text: string) => ({ content: [{ type: "text", text }] });
const song: SSLSong = { title: "Test Song", artist: "Test Artist" };

function entry(song: Partial<SSLQueueItem["song"]>, rest: Partial<SSLQueueItem> = {}): SSLQueueItem {
  return {
    id: 1, songId: 1, nonlistSong: null, note: null, streamerId: 1, createdAt: "", requests: [],
    song: { title: "A Song", artist: "An Artist", ...song },
    ...rest,
  };
}

beforeEach(() => {
  clearFactCache();
  mockCreate.mockReset().mockResolvedValue(reply(MODEL_LINES));
  (fetchGrounding as jest.Mock).mockClear();
  (config as { factVerification: boolean }).factVerification = false;
});

describe("generateFacts", () => {
  it("returns FACTS_PER_SONG facts, spaced by the interval, at CSS positions", async () => {
    const facts = await generateFacts(song);
    expect(facts).toHaveLength(5);
    facts.forEach((f, i) => {
      expect(f.delaySeconds).toBe(i * 15);
      expect(f.durationSeconds).toBe(8);
      expect(f.position.top).toMatch(/^\d+%$/);
    });
  });

  it("doesn't repeat facts already shown for an earlier song (issue #19)", async () => {
    // Two songs by the same artist, both written from the artist's article.
    const first = (await generateFacts({ title: "Song One", artist: "Same Artist" })).map((f) => f.text);
    const second = (await generateFacts({ title: "Song Two", artist: "Same Artist" })).map((f) => f.text);
    expect(first).toHaveLength(5);
    expect(second.filter((t) => first.includes(t))).toEqual([]);
  });

  it("caches a song's facts", async () => {
    const first = await generateFacts(song);
    expect(await generateFacts(song)).toBe(first);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("shares one generation between concurrent requests for the same song", async () => {
    const results = await Promise.all([generateFacts(song), generateFacts(song), generateFacts(song)]);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it("still screens the model's output when verification is off", async () => {
    mockCreate.mockResolvedValue(reply(`Here are 5 trivia lines about Test Song:\n1. ${MODEL_LINES}`));
    const texts = (await generateFacts(song)).map((f) => f.text);
    expect(texts.some((t) => /^Here are/.test(t))).toBe(false);
    expect(texts.some((t) => /^\d+\./.test(t))).toBe(false);
  });

  it("falls back to entry and curated facts when the model fails", async () => {
    mockCreate.mockRejectedValue(new Error("API Error"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const facts = await generateFacts(song, entry({ timesPlayed: 3 }));
    expect(facts).toHaveLength(5);
    expect(facts[0].text).toContain("3 times");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("uses no model and no lookup for a live learn, even with verification on", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const before = factStats.liveLearn;
    const facts = await generateFacts({ ...song, liveLearn: true }, entry({}, { nonlistSong: "Test Song" }));
    expect(facts).toEqual([]);
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(factStats.liveLearn).toBe(before + 1);
  });

  it("builds an original's facts from the song entry, with no model or lookup", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const facts = await generateFacts(
      { title: "Laura's Wedding", artist: "Test Streamer" },
      entry({ title: "Laura's Wedding", artist: "Test Streamer" })
    );
    expect(facts[0].text).toContain("original composition");
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("looks an original up like any other song when the streamer doesn't play originals", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (config as { originals: boolean }).originals = false;
    try {
      await generateFacts({ title: "Laura's Theme", artist: "Test Streamer" }, entry({ title: "Laura's Theme", artist: "Test Streamer" }));
      expect(fetchGrounding).toHaveBeenCalled();
    } finally {
      (config as { originals: boolean }).originals = true;
    }
  });

  it("rebuilds an original's facts each time, so requester and play count stay current", async () => {
    const original = { title: "Laura's Wedding", artist: "Test Streamer" };
    await generateFacts(original, entry({ ...original, timesPlayed: 1 }));
    const later = await generateFacts(original, entry({ ...original, timesPlayed: 2 }));
    expect(later.some((f) => f.text.includes("2 times"))).toBe(true);
  });

  it("uses entry and curated facts, with no model call, when there is no article", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const facts = await generateFacts(song, entry({ timesPlayed: 0 }));
    expect(fetchGrounding).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(facts[0].text).toMatch(/First time on stream/);
  });
});
