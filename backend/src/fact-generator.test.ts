const mockCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })),
}));

jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
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
import { clearFactCache, factStats, forgetSong, generateFacts, markWrong, liveLearnLookup, SOURCE, STRUCTURED, taggedFactsFor, outcomeFor } from "./fact-generator";
import { topic } from "./topic";
import { saveSongFacts } from "./song-facts";
import { fetchGrounding } from "./fact-verifier";
import { wikidataFacts } from "./wikidata";
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

  it("tells the AI about the song only, nothing about the streamer (final QA #7)", async () => {
    await generateFacts({ title: "Prompt Song", artist: "Prompt Artist" });
    const prompt = JSON.stringify(mockCreate.mock.calls[0]);
    expect(prompt).toContain("Prompt Song");
    expect(prompt).not.toContain("Test Streamer");
  });

  it("doesn't repeat facts already shown for an earlier song (issue #19)", async () => {
    // Two songs by the same artist, both written from the artist's article.
    const first = (await generateFacts({ title: "Song One", artist: "Same Artist" })).map((f) => f.text);
    const second = (await generateFacts({ title: "Song Two", artist: "Same Artist" })).map((f) => f.text);
    expect(first).toHaveLength(5);
    expect(second.filter((t) => first.includes(t))).toEqual([]);
  });

  it("looks nothing up for a fellow streamer's piece: the artist is a handle", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (wikidataFacts as jest.Mock).mockClear();
    for (const artist of ["Lennon (@lennonpiano)", "@nalaniproctor"]) {
      await generateFacts({ title: `Piece by ${artist}`, artist });
    }
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(wikidataFacts).not.toHaveBeenCalled();
    // An email-like or mid-name "@" is not a handle.
    await generateFacts({ title: "Other Piece", artist: "P@ssion Pit" });
    expect(fetchGrounding).toHaveBeenCalled();
  });

  it("logs each fact it shows with its source, so a stream can be read back", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const facts = await generateFacts({ title: "Logged Song", artist: "Logged Artist" });
    const shown = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[Shown] "Logged Song"'));
    log.mockRestore();
    expect(shown).toHaveLength(facts.length);
    expect(shown[0]).toContain(facts[0].text);
  });

  it("puts facts about the song first when the article is only about the artist", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Michael Jackson\nThe soundtrack was recorded with a small string section in one weekend. ${MODEL_LINES}`);
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(['"Whatever Happens" came out in 2001.']);
    const facts = (await generateFacts({ title: "Whatever Happens", artist: "Michael Jackson" })).map((f) => f.text);
    expect(facts[0]).toBe('"Whatever Happens" came out in 2001.');
    expect(facts.length).toBeGreaterThan(1);
  });

  it("Wrong on a Wikidata fact blocks Wikidata for the song, and the song falls back instead of going empty", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const song = { title: "Data Song", artist: "Data Artist" };
    (wikidataFacts as jest.Mock).mockResolvedValue(['"Data Song" came out in 1999.']);
    const first = (await generateFacts(song, entry({ timesPlayed: 2 }))).map((f) => f.text);
    expect(first).toEqual(['"Data Song" came out in 1999.']);
    expect(markWrong(song, first[0])).toBe(STRUCTURED);
    const next = (await generateFacts(song, entry({ timesPlayed: 2 }))).map((f) => f.text);
    expect(next).not.toContain('"Data Song" came out in 1999.');
    expect(next.length).toBeGreaterThan(0);
    (wikidataFacts as jest.Mock).mockResolvedValue([]);
  });

  it("shows the streamer's own facts for a song first, exactly as written, and labels every source", async () => {
    saveSongFacts({ title: "Evening Rain", artist: "Chris", songwriters: ["Jane Composer"], facts: ["Jane wrote it in one night."] });
    const facts = await generateFacts({ title: "Evening Rain", artist: "Chris" });
    expect(facts.map((f) => [f.text, f.source])).toEqual([
      ['"Evening Rain" was written by Jane Composer.', SOURCE.yours],
      ["Jane wrote it in one night.", SOURCE.yours],
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
    saveSongFacts({ title: "Evening Rain", artist: "Chris", facts: [] });
  });

  it("never lets a generation that was running overwrite facts saved meanwhile (QA follow-up #2)", async () => {
    const song = { title: "Held Song", artist: "Held Artist" };
    let release: (v: unknown) => void = () => undefined;
    mockCreate.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = generateFacts(song);
    await new Promise((r) => setImmediate(r));
    saveSongFacts({ title: "Held Song", artist: "Held Artist", facts: ["The streamer's approved fact."] });
    forgetSong(song);
    release(reply(MODEL_LINES));
    expect((await first).map((f) => f.text)).toEqual(["The streamer's approved fact."]);
    expect((await generateFacts(song)).map((f) => f.text)).toEqual(["The streamer's approved fact."]);
    saveSongFacts({ title: "Held Song", artist: "Held Artist", facts: [] });
  });

  it("shows the streamer's own facts for a live learn too (QA follow-up #6)", async () => {
    saveSongFacts({ title: "Off List", artist: "Jane Composer", facts: ["Jane's own song, played off the list."] });
    const facts = await generateFacts({ title: "Off List", artist: "Jane Composer", liveLearn: true });
    expect(facts.map((f) => f.text)).toEqual(["Jane's own song, played off the list."]);
    saveSongFacts({ title: "Off List", artist: "Jane Composer", facts: [] });
  });

  it("shows a custom fact tagged for the song first, and never for another song", async () => {
    const tagged = [
      { tag: "Storm Song", text: "It plays in a windmill." },
      { tag: "Tag Artist", text: "Tag Artist learned piano at six." },
      { tag: "Other Game - Other Song", text: "Only for the other one." },
    ];
    (topic as { taggedFacts: typeof tagged }).taggedFacts = tagged;
    expect(taggedFactsFor({ title: "Storm Song", artist: "Tag Artist" })).toEqual(["It plays in a windmill.", "Tag Artist learned piano at six."]);
    expect(taggedFactsFor({ title: "STORM SONG!", artist: "Someone" })).toEqual(["It plays in a windmill."]);
    expect(taggedFactsFor({ title: "Other Song", artist: "Other Game" })).toEqual(["Only for the other one."]);
    expect(taggedFactsFor({ title: "Unrelated", artist: "Nobody" })).toEqual([]);

    const facts = await generateFacts({ title: "Storm Song", artist: "Someone" });
    expect(facts[0]).toMatchObject({ text: "It plays in a windmill.", source: SOURCE.custom, delaySeconds: 0 });
    expect(facts).toHaveLength(5);
    expect(facts[1].delaySeconds).toBe(15);
    (topic as { taggedFacts: typeof tagged }).taggedFacts = [];
  });

  it("gives each article fact a link and the sentence it rests on, for the dashboard", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Sourced Song (song)\n${MODEL_LINES}`);
    const facts = await generateFacts({ title: "Sourced Song", artist: "Someone" });
    expect(facts[0].source).toBe("Wikipedia: Sourced Song (song)");
    expect(facts[0].url).toBe("https://en.wikipedia.org/wiki/Sourced_Song_(song)");
    expect(facts[0].evidence).toBe(facts[0].text);
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

  it("shows nothing for a live learn no source knows: no song-list or custom filler", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const before = factStats.liveLearn;
    const facts = await generateFacts({ ...song, liveLearn: true }, entry({}, { nonlistSong: "Test Song" }));
    expect(facts).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(factStats.liveLearn).toBe(before + 1);
  });

  it("looks up a live learn typed as a video title, and shows its facts (issue #45)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    expect(liveLearnLookup({ title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Unknown", liveLearn: true }))
      .toMatchObject({ title: "Never Gonna Give You Up", artist: "Rick Astley" });
    expect(liveLearnLookup({ title: "Some Tune", artist: "Unknown", liveLearn: true })).toBeNull();
    expect(liveLearnLookup({ title: "Some Tune", artist: "Jane Composer", liveLearn: true })).toEqual({ title: "Some Tune", artist: "Jane Composer" });

    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Never Gonna Give You Up\n${MODEL_LINES}`);
    const request = { title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Unknown", liveLearn: true };
    const facts = await generateFacts(request);
    expect(facts).toHaveLength(5);
    // The work is filed under the request, not the reading: under the reading's name the
    // built-in model saw a song that wasn't playing and refused (review).
    expect(outcomeFor(request)).not.toBe("");
    expect((fetchGrounding as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({ title: "Never Gonna Give You Up", artist: "Rick Astley" });
  });

  it("builds an original's facts from the song entry, with no model or lookup", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const facts = await generateFacts(
      { title: "Laura's Wedding", artist: "Test Streamer" },
      entry({ title: "Laura's Wedding", artist: "Test Streamer" })
    );
    // The streamer's notes about their compositions lead; nothing repeats the title and artist.
    expect(facts[0].source).toBe(SOURCE.custom);
    expect(facts.some((f) => /original composition/.test(f.text))).toBe(false);
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
