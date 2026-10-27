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
    temperature: 0,
    factVerification: false,
    sourceRisk: true,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
  },
}));

// The real sentence builders, loaded when first called: loading them inside the factory would
// copy fact-verifier's exports before it finished loading (the two import each other).
const actual = <T>(name: string, fn: string) => (...args: unknown[]): T => jest.requireActual(name)[fn](...args);
jest.mock("./wikidata", () => ({
  wikidataFacts: jest.fn().mockResolvedValue([]),
  artistFacts: jest.fn().mockResolvedValue([]),
  articleItem: jest.fn().mockResolvedValue(null),
  songItemFacts: actual("./wikidata", "songItemFacts"),
}));
jest.mock("./musicbrainz", () => ({
  musicbrainzFacts: jest.fn().mockResolvedValue([]),
  artistByTitle: jest.fn().mockResolvedValue(""),
  cachedArtistByTitle: jest.fn().mockReturnValue(""),
  statedYear: actual("./musicbrainz", "statedYear"),
  statesAlbum: actual("./musicbrainz", "statesAlbum"),
  withoutYear: actual("./musicbrainz", "withoutYear"),
}));

jest.mock("./fact-verifier", () => ({
  ...jest.requireActual("./fact-verifier"),
  fetchGrounding: jest.fn().mockResolvedValue(""),
  summaryGate: jest.fn().mockResolvedValue(""),
  // No article text, and no real request to Wikipedia: the mocked config above has no timeout for it either.
  loadWikitext: jest.fn().mockResolvedValue(""),
}));

import { config } from "./config";
import { RETELL_EXAMPLES, SYSTEM_PROMPT, allowedFacts, pulledWithWrong, songsLogLine, blockFor, copiesExample, clearFactCache, factStats, forgetSong, generateFacts, markWrong, liveLearnLookup, ownFactKind, SOURCE, STRUCTURED, taggedFactsFor, outcomeFor, positionsFor, positionsForSong, restoreRecent, setCurrentSong, showsBanner, unmarkWrong, useBuiltinSession } from "./fact-generator";
import { blockedArticles, resetWrongFacts } from "./wrong-facts";
import fs from "fs";
import path from "path";
import { topic } from "./topic";
import { saveSongFacts, setFactsOff } from "./song-facts";
import { loadSession, remainingFacts, saveSession } from "./session";
import { Fact } from "./types";
import { BoxSubject } from "./infobox";
import { fetchGrounding } from "./fact-verifier";
import { articleItem, artistFacts, wikidataFacts } from "./wikidata";
import { artistByTitle, cachedArtistByTitle, musicbrainzFacts } from "./musicbrainz";
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
/** The model's lines citing reference sentences, as the grounded prompt asks: sentence `from + i` for line i. */
const citing = (lines: string, from = 1) => lines.split("\n").map((l, i) => `${from + i} | ${l}`).join("\n");
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
  delete process.env.CITE_SENTENCES;
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
    for (const artist of ["Jane (@janeplayskeys)", "@janeplayskeys"]) {
      await generateFacts({ title: `Piece by ${artist}`, artist });
    }
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(wikidataFacts).not.toHaveBeenCalled();
    // An email-like or mid-name "@" is not a handle.
    await generateFacts({ title: "Other Piece", artist: "P@ssion Pit" });
    expect(fetchGrounding).toHaveBeenCalled();
  });

  it("keeps bubbles to the chosen part of the screen, always on screen (issue #66)", async () => {
    const pct = (v: string) => Number(v.replace("%", ""));
    for (const area of ["anywhere", "top", "bottom", "left", "right"]) {
      for (const p of positionsFor(area)) {
        expect(pct(p.left ?? "")).toBeLessThanOrEqual(66);
        if (p.top) expect(pct(p.top)).toBeLessThanOrEqual(70);
      }
    }
    expect(positionsFor("top").every((p) => p.top && pct(p.top) <= 20)).toBe(true);
    // "Bottom" means the bottom edge: measured up from it, never down from the top (a tester's
    // bubble set to the bottom showed just below the middle).
    expect(positionsFor("bottom").every((p) => !p.top && p.bottom && pct(p.bottom) <= 20)).toBe(true);
    // The Now Playing bubble sits bottom-center as a song starts: the first two bubbles keep clear of it.
    expect(positionsFor("bottom").slice(0, 2).every((p) => pct(p.left ?? "") < 20 || pct(p.left ?? "") > 60)).toBe(true);
    expect(positionsFor("left").every((p) => pct(p.left ?? "") <= 5)).toBe(true);
    expect(positionsFor("right").every((p) => pct(p.left ?? "") >= 66)).toBe(true);
    expect(positionsFor("nonsense")).toBe(positionsFor("anywhere"));

    (config as { bubbleArea?: string }).bubbleArea = "left";
    const facts = await generateFacts({ title: "Area Song", artist: "Area Artist" });
    (config as { bubbleArea?: string }).bubbleArea = "anywhere";
    expect(facts.every((f) => f.position.left === "3%")).toBe(true);
  });

  it("can keep every bubble in one spot the streamer chose", async () => {
    expect(positionsFor("top-left")).toEqual([{ top: "6%", left: "3%" }]);
    expect(positionsFor("top-right")).toEqual([{ top: "6%", right: "3%" }]);
    expect(positionsFor("bottom-left")).toEqual([{ bottom: "5%", left: "3%" }]);
    expect(positionsFor("bottom-right")).toEqual([{ bottom: "5%", right: "3%" }]);
    // Centered: neither side is set, so the overlay centers a bubble of any length.
    expect(positionsFor("top-center")).toEqual([{ top: "6%" }]);
    const [low] = positionsFor("bottom-center", true);
    expect(low.left ?? low.right ?? low.top).toBeUndefined();
    // Above the Now Playing bubble (60px from the bottom), and higher at a bigger bubble size.
    expect(low.bottom).toMatch(/^calc\(6\dpx \+ [\d.]+vh \* var\(--bf-scale, 1\)\)$/);
    // With Now Playing off, the true bottom center, level with the other bottom spots (a tester's request).
    expect(positionsFor("bottom-center", false)).toEqual([{ bottom: "5%" }]);
    // A live learn still shows its banner there, so its bubbles wait above it.
    const c = config as { bubbleArea?: string; nowPlaying?: boolean; liveLearnBanner?: boolean };
    c.bubbleArea = "bottom-center";
    c.nowPlaying = false;
    c.liveLearnBanner = true;
    try {
      expect(positionsForSong({ title: "Any", artist: "Any" })).toEqual([{ bottom: "5%" }]);
      expect(positionsForSong({ title: "Any", artist: "Any", liveLearn: true })).toEqual([low]);
      c.nowPlaying = true;
      expect(positionsForSong({ title: "Any", artist: "Any" })).toEqual([low]);
      // Its own setting turns the LIVE LEARN bubble off, and the spot moves down with it.
      c.liveLearnBanner = false;
      expect(showsBanner({ title: "Any", artist: "Any", liveLearn: true })).toBe(false);
      expect(positionsForSong({ title: "Any", artist: "Any", liveLearn: true })).toEqual([{ bottom: "5%" }]);
    } finally {
      c.bubbleArea = "anywhere";
      delete c.nowPlaying;
      delete c.liveLearnBanner;
    }

    (config as { bubbleArea?: string }).bubbleArea = "bottom-right";
    const facts = await generateFacts({ title: "Spot Song", artist: "Spot Artist" });
    (config as { bubbleArea?: string }).bubbleArea = "anywhere";
    expect(facts.length).toBeGreaterThan(1);
    expect(facts.every((f) => f.position.right === "3%" && f.position.bottom === "5%")).toBe(true);
  });

  it("doesn't log facts as shown when it writes them: the server logs them when they go out (shown-log.ts)", async () => {
    // From review: a skipped, paused or superseded song's facts were logged as [Shown] though never sent.
    // console.log is already muted for all tests (test-setup.ts): read that mock, don't replace it.
    const log = console.log as unknown as jest.Mock;
    log.mockClear();
    const facts = await generateFacts({ title: "Logged Song", artist: "Logged Artist" });
    expect(facts.length).toBeGreaterThan(0);
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[Shown]"))).toEqual([]);
  });

  it("puts facts about the song first when the article is only about the artist", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Michael Jackson\nThe soundtrack was recorded with a small string section in one weekend. ${MODEL_LINES}`);
    process.env.CITE_SENTENCES = "on";
    mockCreate.mockResolvedValue(reply(citing(MODEL_LINES, 2)));
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(['"Whatever Happens" came out in 2001.']);
    const facts = (await generateFacts({ title: "Whatever Happens", artist: "Michael Jackson" })).map((f) => f.text);
    expect(facts[0]).toBe('"Whatever Happens" came out in 2001.');
    expect(facts.length).toBeGreaterThan(1);
  });

  it("puts facts about the song first when the article is only about the artist (citations off, the default)", async () => {
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
    saveSongFacts({ title: "Evening Rain", artist: "Robin", songwriters: ["Jane Composer"], facts: ["Jane wrote it in one night."] });
    const facts = await generateFacts({ title: "Evening Rain", artist: "Robin" });
    expect(facts.map((f) => [f.text, f.source])).toEqual([
      ['"Evening Rain" was written by Jane Composer.', SOURCE.yours],
      ["Jane wrote it in one night.", SOURCE.yours],
    ]);
    expect(mockCreate).not.toHaveBeenCalled();
    saveSongFacts({ title: "Evening Rain", artist: "Robin", facts: [] });
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

  describe("facts tagged for a game or artist (a pool many songs share)", () => {
    // From a tester with nearly 200 songs from one game: every one of them opened with the same facts.
    const pool = [
      { tag: "Moonfall Saga", text: "Pool fact A." },
      { tag: "Moonfall Saga", text: "Pool fact B." },
      { tag: "Moonfall Saga", text: "Pool fact C." },
    ];
    const isPool = (t: string) => t.startsWith("Pool fact");
    beforeEach(() => ((topic as { taggedFacts: typeof pool }).taggedFacts = pool));
    afterEach(() => ((topic as { taggedFacts: typeof pool }).taggedFacts = []));

    it("gives each song one, second, taking turns, beside the facts about the song", async () => {
      const picked: string[] = [];
      for (const title of ["Theme One", "Theme Two", "Theme Three", "Theme Four"]) {
        // The mock writes the same lines for every song: let each count as new.
        restoreRecent([]);
        const facts = await generateFacts({ title, artist: "Moonfall Saga" });
        const theirs = facts.filter((f) => isPool(f.text));
        expect(theirs).toHaveLength(1);
        expect(facts[1]).toMatchObject({ text: theirs[0].text, source: SOURCE.custom });
        expect(isPool(facts[0].text)).toBe(false);
        picked.push(theirs[0].text);
      }
      expect(picked).toEqual(["Pool fact A.", "Pool fact B.", "Pool fact C.", "Pool fact A."]);
    });

    it("fills the bubbles first when no source knows the song", async () => {
      (config as { factVerification: boolean }).factVerification = true;
      const facts = (await generateFacts({ title: "Unknown Theme", artist: "Moonfall Saga" })).map((f) => f.text);
      expect(facts.slice(0, 3)).toEqual(["Pool fact A.", "Pool fact B.", "Pool fact C."]);
    });

    it("adds one to a song with its own facts, ahead of the creator's link, while there's room", async () => {
      saveSongFacts({ title: "Featured Piece", artist: "Moonfall Saga", facts: ["Arranged for a festival."], link: "https://example.com/piece" });
      try {
        const facts = await generateFacts({ title: "Featured Piece", artist: "Moonfall Saga" });
        expect(facts.map((f) => [f.text, f.source])).toEqual([
          ["Arranged for a festival.", SOURCE.yours],
          ["Pool fact A.", SOURCE.custom],
          ["More from this song's creator: https://example.com/piece", SOURCE.yours],
        ]);
        saveSongFacts({ title: "Featured Piece", artist: "Moonfall Saga", facts: ["One.", "Two.", "Three.", "Four.", "Five."] });
        expect((await generateFacts({ title: "Featured Piece", artist: "Moonfall Saga" })).some((f) => isPool(f.text))).toBe(false);
      } finally {
        saveSongFacts({ title: "Featured Piece", artist: "Moonfall Saga", facts: [] });
      }
    });

    it("still shows every fact tagged for the song itself, first", async () => {
      (topic as { taggedFacts: typeof pool }).taggedFacts = [...pool, { tag: "Theme One", text: "Own tag one." }, { tag: "Theme One", text: "Own tag two." }];
      const facts = (await generateFacts({ title: "Theme One", artist: "Moonfall Saga" })).map((f) => f.text);
      expect(facts.slice(0, 3)).toEqual(["Own tag one.", "Own tag two.", "Pool fact A."]);
    });
  });

  it("keeps a custom fact tagged for one version off the song's other versions", () => {
    // From review: the tag's brackets were dropped, so "[Night Drive (Acoustic)]" showed on the remix.
    const tagged = [
      { tag: "Night Drive (Acoustic)", text: "Recorded in one take." },
      { tag: "Tag Artist - Night Drive (Remix)", text: "The remix came first." },
      { tag: "Take On Me", text: "Any version of this one." },
    ];
    (topic as { taggedFacts: typeof tagged }).taggedFacts = tagged;
    try {
      expect(taggedFactsFor({ title: "Night Drive (Acoustic)", artist: "Tag Artist" })).toEqual(["Recorded in one take."]);
      expect(taggedFactsFor({ title: "night drive [acoustic]", artist: "Someone" })).toEqual(["Recorded in one take."]);
      // The list's own performance tag after the version doesn't hide it.
      expect(taggedFactsFor({ title: "Night Drive (Acoustic) [Instrumental]", artist: "Someone" })).toEqual(["Recorded in one take."]);
      expect(taggedFactsFor({ title: "Night Drive (Remix)", artist: "Tag Artist" })).toEqual(["The remix came first."]);
      expect(taggedFactsFor({ title: "Night Drive (Remix)", artist: "Someone Else" })).toEqual([]);
      expect(taggedFactsFor({ title: "Night Drive", artist: "Tag Artist" })).toEqual([]);
      // A tag with no version matches every version, and the list's tags.
      expect(taggedFactsFor({ title: "Take On Me [Instrumental]", artist: "Someone" })).toEqual(["Any version of this one."]);
      expect(taggedFactsFor({ title: "Take On Me (Acoustic)", artist: "Someone" })).toEqual(["Any version of this one."]);
    } finally {
      (topic as { taggedFacts: typeof tagged }).taggedFacts = [];
    }
  });

  it("on the artist's article, drops a caption about an unnamed musical: it reads as this song's (second fact check)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const article = "Dana Reyes\nDana Reyes is an English singer and pianist. In 2005 Reyes wrote the music for Harbor Lights the Musical. Opening to strong reviews, the show won four stage awards, including Best New Musical. Her ballad Paper Lanterns reached number two in 1974.";
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(article);
    process.env.CITE_SENTENCES = "on";
    mockCreate.mockResolvedValue(reply([
      "3 | The musical won four stage awards, including Best New Musical.",
      "2 | Dana Reyes wrote the music for Harbor Lights the Musical in 2005.",
      "4 | The song reached number two in 1974.",
    ].join("\n")));
    const shown = (await generateFacts({ title: "Glass Harbor", artist: "Dana Reyes" })).map((f) => f.text);
    expect(shown).toContain("Dana Reyes wrote the music for Harbor Lights the Musical in 2005.");
    expect(shown).not.toContain("The musical won four stage awards, including Best New Musical.");
    // "The song" retelling a sentence about another of her songs reads as this one too.
    expect(shown).not.toContain("The song reached number two in 1974.");
  });

  it("on the artist's article, drops a caption about an unnamed musical: it reads as this song's (second fact check) (citations off, the default)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const article = "Dana Reyes\nDana Reyes is an English singer and pianist. In 2005 Reyes wrote the music for Harbor Lights the Musical. Opening to strong reviews, the show won four stage awards, including Best New Musical. Her ballad Paper Lanterns reached number two in 1974.";
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(article);
    mockCreate.mockResolvedValue(reply([
      "The musical won four stage awards, including Best New Musical.",
      "Dana Reyes wrote the music for Harbor Lights the Musical in 2005.",
      "The song reached number two in 1974.",
    ].join("\n")));
    const shown = (await generateFacts({ title: "Glass Harbor", artist: "Dana Reyes" })).map((f) => f.text);
    expect(shown).toContain("Dana Reyes wrote the music for Harbor Lights the Musical in 2005.");
    expect(shown).not.toContain("The musical won four stage awards, including Best New Musical.");
    // "The song" retelling a sentence about another of her songs reads as this one too.
    expect(shown).not.toContain("The song reached number two in 1974.");
  });

  it("gives each article fact a link and the sentence it rests on, for the dashboard", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Sourced Song (song)\n${MODEL_LINES}`);
    process.env.CITE_SENTENCES = "on";
    mockCreate.mockResolvedValue(reply(citing(MODEL_LINES)));
    const facts = await generateFacts({ title: "Sourced Song", artist: "Someone" });
    expect(facts[0].source).toBe("Wikipedia: Sourced Song (song)");
    expect(facts[0].url).toBe("https://en.wikipedia.org/wiki/Sourced_Song_(song)");
    expect(facts[0].evidence).toBe(facts[0].text);
  });

  it("gives each article fact a link and the sentence it rests on, for the dashboard (citations off, the default)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Sourced Song (song)\n${MODEL_LINES}`);
    const facts = await generateFacts({ title: "Sourced Song", artist: "Someone" });
    expect(facts[0].source).toBe("Wikipedia: Sourced Song (song)");
    expect(facts[0].url).toBe("https://en.wikipedia.org/wiki/Sourced_Song_(song)");
    expect(facts[0].evidence).toBe(facts[0].text);
  });

  it("shows at most four of an article's captions, the most interesting first (fact-ranking.ts)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Ranked Song (song)\n${MODEL_LINES}`);
    const exact = MODEL_LINES.split("\n").slice(1, 6);
    process.env.CITE_SENTENCES = "on";
    mockCreate.mockResolvedValue(reply(["1 | The soundtrack was taped quickly with a small string section.", ...exact.map((l, i) => `${i + 2} | ${l}`)].join("\n")));
    const facts = (await generateFacts({ title: "Ranked Song", artist: "Someone" })).map((f) => f.text);
    expect(facts).toHaveLength(4);
    // A first the source states, on a piano, beats a plain one.
    expect(facts[0]).toBe("Its main melody was first sketched on an upright piano at the studio.");
    expect(facts).not.toContain("The soundtrack was taped quickly with a small string section.");
  });

  it("leaves the reference unnumbered and takes plain captions unless CITE_SENTENCES is on", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Plain Song (song)\n${MODEL_LINES}`);
    const facts = await generateFacts({ title: "Plain Song", artist: "Someone" });
    const prompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toMatch(/\[1\]/);
    expect(prompt).not.toContain(" | ");
    expect(MODEL_LINES.split("\n")).toEqual(expect.arrayContaining(facts.map((f) => f.text)));
    expect(facts.length).toBeGreaterThan(0);
  });

  it("shows the AI worked examples of keeping who said it and naming the subject, before the reference", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Example Song (song)\n${MODEL_LINES}`);
    await generateFacts({ title: "Example Song", artist: "Someone" });
    const prompt: string = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain(RETELL_EXAMPLES);
    expect(prompt.indexOf("EXAMPLES")).toBeLessThan(prompt.indexOf('"""'));
  });

  it("drops a caption that pins an example's story on a name the reference has", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Pinned Song (song)\nMara Quinn composed the score in 2011.\n${MODEL_LINES}`);
    const copied = "Mara Quinn said the band wanted the chorus to sound like a storm.";
    mockCreate.mockResolvedValue(reply([copied, ...MODEL_LINES.split("\n")].join("\n")));
    const facts = await generateFacts({ title: "Pinned Song", artist: "Someone" });
    expect(facts.map((f) => f.text)).not.toContain(copied);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("drops a caption that copies an example's sales figure instead of the reference", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Figure Song (song)\n${MODEL_LINES}`);
    const copied = "In Japan, the song sold 40,000 copies by March 2009.";
    mockCreate.mockResolvedValue(reply([copied, ...MODEL_LINES.split("\n")].join("\n")));
    const facts = await generateFacts({ title: "Figure Song", artist: "Someone" });
    expect(facts.map((f) => f.text)).not.toContain(copied);
  });

  it("drops a caption that copies an example's made-up names instead of the reference", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Copy Song (song)\n${MODEL_LINES}`);
    const copied = "Producer Dana Reyes said the band wanted the chorus to sound like a storm.";
    mockCreate.mockResolvedValue(reply([copied, ...MODEL_LINES.split("\n")].join("\n")));
    const facts = await generateFacts({ title: "Copy Song", artist: "Someone" });
    expect(facts.map((f) => f.text)).not.toContain(copied);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("gives the AI the same system prompt as every other provider (the built-in model had node-llama-cpp's own)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`System Song (song)\n${MODEL_LINES}`);
    await generateFacts({ title: "System Song", artist: "System Artist" });
    expect(mockCreate.mock.calls[0][0].system).toBe(SYSTEM_PROMPT);
    expect(mockCreate.mock.calls[0][0].temperature).toBe(0);
  });

  it("doesn't promise a reference in the system prompt when fact checking is off (#202)", async () => {
    await generateFacts({ title: "Unchecked Song", artist: "System Artist" });
    expect(mockCreate.mock.calls[0][0].system).not.toMatch(/reference/);
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
    for (const artist of ["Traditional", "Trad.", "Anon.", "Anonymous", "Folk"]) expect(liveLearnLookup({ title: "Some Tune", artist, liveLearn: true })).toBeNull();
    expect(liveLearnLookup({ title: "Some Tune", artist: "Folk Lanterns", liveLearn: true })).toEqual({ title: "Some Tune", artist: "Folk Lanterns" });
    expect(liveLearnLookup({ title: "Some Tune", artist: "Jane Composer", liveLearn: true })).toEqual({ title: "Some Tune", artist: "Jane Composer" });

    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Never Gonna Give You Up\n${MODEL_LINES}`);
    process.env.CITE_SENTENCES = "on";
    mockCreate.mockResolvedValue(reply(citing(MODEL_LINES)));
    const request = { title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Unknown", liveLearn: true };
    const facts = await generateFacts(request);
    expect(facts).toHaveLength(4);
    // The work is filed under the request, not the reading: under the reading's name the
    // built-in model saw a song that wasn't playing and refused (review).
    expect(outcomeFor(request)).not.toBe("");
    expect((fetchGrounding as jest.Mock).mock.calls.at(-1)?.[0]).toMatchObject({ title: "Never Gonna Give You Up", artist: "Rick Astley" });
  });

  it("looks up a live learn typed as a video title, and shows its facts (issue #45) (citations off, the default)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    expect(liveLearnLookup({ title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Unknown", liveLearn: true }))
      .toMatchObject({ title: "Never Gonna Give You Up", artist: "Rick Astley" });
    expect(liveLearnLookup({ title: "Some Tune", artist: "Unknown", liveLearn: true })).toBeNull();
    expect(liveLearnLookup({ title: "Some Tune", artist: "Jane Composer", liveLearn: true })).toEqual({ title: "Some Tune", artist: "Jane Composer" });

    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Never Gonna Give You Up\n${MODEL_LINES}`);
    const request = { title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)", artist: "Unknown", liveLearn: true };
    const facts = await generateFacts(request);
    expect(facts).toHaveLength(4);
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

  it("logs a caption off the content standard by its reason alone, never its words (issue #242)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Glass Orchard\nGlass Orchard is a 1999 song by Mara Quillon. ${MODEL_LINES}`);
    mockCreate.mockResolvedValue(reply(`Mara Quillon was arrested in 1998.\n${MODEL_LINES}`));
    const log = console.log as unknown as jest.Mock;
    log.mockClear();
    const facts = (await generateFacts({ title: "Glass Orchard", artist: "Mara Quillon" })).map((f) => f.text);
    expect(facts).not.toContain("Mara Quillon was arrested in 1998.");
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[Screen] DROP (content standard: crime or lawsuits)");
    expect(lines.some((l) => l.includes("arrested"))).toBe(false);
  });

  it("drops a data fact off the content standard, as it drops a caption (issue #242)", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(["Glass Orchard came out in 1999.", "Mara Quillon was convicted of fraud in 2002."]);
    const facts = (await generateFacts({ title: "Glass Orchard", artist: "Mara Quillon" })).map((f) => f.text);
    expect(facts).toEqual(["Glass Orchard came out in 1999."]);
  });

  it("uses entry and curated facts, with no model call, when there is no article", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    const facts = await generateFacts(song, entry({ timesPlayed: 0 }));
    expect(fetchGrounding).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(facts[0].text).toMatch(/First time on stream/);
  });
});

describe("an article that may be about another work (issue #255)", () => {
  const series = "Rocket Drift\nRocket Drift is a video game series developed by Pellmore. It began with a 1988 game, and a 2017 reboot followed with new levels and a new score by Ivo Marsh.";
  const track = { title: "Area 3", artist: "Rocket Drift" };
  const abstain = (on: boolean) => ((config as { abstain?: boolean }).abstain = on);
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    abstain(true);
  });
  afterAll(() => abstain(false));

  it("writes no AI captions: the song's data facts, then two about its game", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(series);
    (artistFacts as jest.Mock).mockResolvedValueOnce(["The music of Rocket Drift is by Ada Penn.", "Rocket Drift was developed by Pellmore."]);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const facts = await generateFacts(track);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(facts.map((f) => f.text)).toEqual(["The music of Rocket Drift is by Ada Penn.", "Rocket Drift was developed by Pellmore."]);
    expect(facts.every((f) => f.source === SOURCE.wikidata)).toBe(true);
    expect(log.mock.calls.some(([line]) => /^\[Grounding\] unsure: a series' article/.test(String(line)))).toBe(true);
    log.mockRestore();
  });

  it("asks for nothing about the artist when the song's own data fills two bubbles", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(series);
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(['"Area 3" came out in 1988.', '"Area 3" was composed by Ada Penn.']);
    (artistFacts as jest.Mock).mockClear();
    const facts = (await generateFacts(track)).map((f) => f.text);
    expect(facts).toEqual(['"Area 3" came out in 1988.', '"Area 3" was composed by Ada Penn.']);
    expect(artistFacts).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("falls back to the song list and the streamer's facts when no data knows the song or its artist", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(series);
    const facts = await generateFacts(track, entry({ timesPlayed: 4 }));
    expect(mockCreate).not.toHaveBeenCalled();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.some((f) => f.source === SOURCE.songList)).toBe(true);
  });

  it("still writes captions from a game's own article, and from the series' article only with ABSTAIN=off", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValueOnce("Starfall Saga\nStarfall Saga is a 1996 role-playing video game developed by Hollow Pine. " + MODEL_LINES);
    expect((await generateFacts({ title: "Lunar Tide", artist: "Starfall Saga" })).length).toBeGreaterThan(1);
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(series + " " + MODEL_LINES);
    await generateFacts(track);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    abstain(false);
    clearFactCache();
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(series + " " + MODEL_LINES);
    await generateFacts(track);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

describe("a now playing title with no artist", () => {
  const ghost: SSLSong = { title: "Lantern Static", artist: "Unknown", titleOnly: true };
  const article = "Lantern Static\nLantern Static is a 2017 song by the singer Wren Halvard. " + MODEL_LINES;
  const lookedUpAs = () => ((fetchGrounding as jest.Mock).mock.calls[0]?.[0] as SSLSong | undefined)?.artist;
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    (artistByTitle as jest.Mock).mockReset().mockResolvedValue("");
    (cachedArtistByTitle as jest.Mock).mockReset().mockReturnValue("");
  });

  it("is looked up with the only artist who has the title, and shows facts from data only", async () => {
    (artistByTitle as jest.Mock).mockResolvedValue("Wren Halvard");
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(article);
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(['"Lantern Static" came out in 2017.']);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const facts = await generateFacts(ghost);
    expect(artistByTitle).toHaveBeenCalledWith("Lantern Static");
    expect(lookedUpAs()).toBe("Wren Halvard");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(facts.map((f) => f.text)).toEqual(['"Lantern Static" came out in 2017.']);
    expect(log.mock.calls.some(([line]) => /^\[Grounding\] unsure: the artist was found by the title alone/.test(String(line)))).toBe(true);
    log.mockRestore();
  });

  it("is looked up with no artist when several artists have the title", async () => {
    await generateFacts(ghost);
    expect(artistByTitle).toHaveBeenCalledWith("Lantern Static");
    expect(lookedUpAs()).toBe("Unknown");
  });

  it("never asks for a song that names its artist, or one from a song list", async () => {
    await generateFacts({ title: "Lantern Static", artist: "Wren Halvard" });
    await generateFacts({ title: "Lantern Static", artist: "Unknown" });
    expect(artistByTitle).not.toHaveBeenCalled();
  });

  it("blocks a fact marked Wrong for the song it was looked up as too", () => {
    (cachedArtistByTitle as jest.Mock).mockReturnValue("Wren Halvard");
    const lookup = { title: "Lantern Static", artist: "Wren Halvard" };
    markWrong(ghost, "Some caption.", "Wikipedia: Lantern Static");
    expect(blockedArticles(lookup).has("Lantern Static")).toBe(true);
    unmarkWrong(ghost, "Lantern Static");
    expect(blockedArticles(lookup).size).toBe(0);
  });
});

describe("data facts from the matched article's own item, with no AI (issue #256)", () => {
  const request = { title: "Harbr Lights (2004)", artist: "Velvet Lark" };
  const songPage = 'Harbor Lights (Velvet Lark song)\n"Harbor Lights" is a song by American dream pop band Velvet Lark, released in 2004 as the lead single from their album Paper Boats.';
  const albumPage = "Harbor Lights (album)\nHarbor Lights is the second studio album by American dream pop band Velvet Lark, released in 2004.";
  const item = { kind: "song" as const, title: "Harbor Lights", year: "2004", partOf: "Paper Boats", genres: ["dream pop"] };
  const provider = (p: string) => ((config as { aiProvider: string }).aiProvider = p);
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    provider("none");
    (articleItem as jest.Mock).mockReset().mockResolvedValue(item);
    (musicbrainzFacts as jest.Mock).mockReset().mockResolvedValue([]);
  });
  afterAll(() => provider("anthropic"));

  it("gives a song the database search missed its article's item facts", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue(songPage);
    const facts = await generateFacts(request);
    expect(facts.map((f) => [f.text, f.source])).toEqual([['"Harbor Lights" came out in 2004 and appears on Paper Boats. Its genres include dream pop.', SOURCE.wikidata]]);
    expect(articleItem).toHaveBeenCalledWith("Harbor Lights (Velvet Lark song)", ["velvet lark"], ["Harbr Lights (2004)", "Harbr Lights"]);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("adds only what MusicBrainz didn't say, and shows neither year when Wikidata's is earlier", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue(songPage);
    // MusicBrainz answers after the item is in.
    const mb = ['"Harbr Lights (2004)" came out in 2009 and is on the album Paper Boats.'];
    (musicbrainzFacts as jest.Mock).mockImplementation(() => new Promise((r) => setTimeout(() => r(mb), 20)));
    const facts = await generateFacts(request);
    expect(facts.map((f) => [f.text, f.source])).toEqual([
      ['"Harbr Lights (2004)" is on the album Paper Boats.', SOURCE.musicbrainz],
      ['The genres of "Harbor Lights" include dream pop.', SOURCE.wikidata],
    ]);
  });

  it("doesn't hold MusicBrainz's facts back for an item still on its way", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue(songPage);
    (musicbrainzFacts as jest.Mock).mockResolvedValue(['"Harbr Lights (2004)" came out in 2009.']);
    (articleItem as jest.Mock).mockReturnValue(new Promise(() => undefined));
    expect((await generateFacts(request)).map((f) => f.text)).toEqual(['"Harbr Lights (2004)" came out in 2009.']);
  });

  it("takes nothing from the item of an article that may be another work", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue(albumPage);
    const facts = await generateFacts(request);
    expect(articleItem).not.toHaveBeenCalled();
    expect(facts.some((f) => f.source === SOURCE.wikidata)).toBe(false);
  });

  it("leaves the database search's own facts as they are", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue(songPage);
    (wikidataFacts as jest.Mock).mockResolvedValueOnce(['"Harbr Lights (2004)" was written by Ada Penn.']);
    expect((await generateFacts(request)).map((f) => f.text)).toEqual(['"Harbr Lights (2004)" was written by Ada Penn.']);
    expect(musicbrainzFacts).not.toHaveBeenCalled();
  });

  it("doesn't look up the article for data facts when the AI writes from it", async () => {
    provider("anthropic");
    (fetchGrounding as jest.Mock).mockResolvedValue("");
    await generateFacts(request);
    expect(articleItem).not.toHaveBeenCalled();
  });

  afterEach(() => (fetchGrounding as jest.Mock).mockReset().mockResolvedValue(""));
});

describe("facts from data go out before a slow AI (issue #256)", () => {
  const request = { title: "Harbor Lights", artist: "Velvet Lark" };
  const songPage = 'Harbor Lights (Velvet Lark song)\n"Harbor Lights" is a song by American dream pop band Velvet Lark, released in 2004 as the lead single from their album Paper Boats. ' + MODEL_LINES;
  const item = { kind: "song" as const, title: "Harbor Lights", year: "2004", partOf: "Paper Boats", genres: ["dream pop"] };
  const dataFact = '"Harbor Lights" came out in 2004 and appears on Paper Boats. Its genres include dream pop.';
  /** A fake AI that answers after `ms`, as a busy streaming PC does. */
  const slowAI = (ms: number, text = MODEL_LINES) => mockCreate.mockImplementation(() => new Promise((r) => setTimeout(() => r(reply(text)), ms)));
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    (config as { abstain?: boolean }).abstain = true;
    (fetchGrounding as jest.Mock).mockResolvedValue(songPage);
    (articleItem as jest.Mock).mockReset().mockResolvedValue(item);
    (musicbrainzFacts as jest.Mock).mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    (config as { abstain?: boolean }).abstain = false;
    (fetchGrounding as jest.Mock).mockReset().mockResolvedValue("");
  });

  it("sends the data facts while the AI is still writing, then puts the captions after them", async () => {
    slowAI(300);
    const started = Date.now();
    let earlyAt = 0;
    let early: Fact[] = [];
    const facts = await generateFacts(request, null, (data) => {
      earlyAt = Date.now() - started;
      early = data;
    });
    const total = Date.now() - started;
    expect(early.map((f) => [f.text, f.source])).toEqual([[dataFact, SOURCE.wikidata]]);
    expect(earlyAt).toBeLessThan(150);
    expect(total).toBeGreaterThanOrEqual(290);
    // The full list starts with what went out early, unchanged; the AI's captions follow.
    expect(facts[0]).toEqual(early[0]);
    expect(facts.length).toBeGreaterThan(1);
    expect(facts.length).toBeLessThanOrEqual(4);
    expect(facts.slice(1).every((f) => f.source === "Wikipedia: Harbor Lights (Velvet Lark song)")).toBe(true);
    expect(new Set(facts.map((f) => f.text)).size).toBe(facts.length);
  });

  it("sends nothing early when the AI is faster, and the data facts still lead", async () => {
    const early = jest.fn();
    (articleItem as jest.Mock).mockImplementation(() => new Promise((r) => setTimeout(() => r(item), 100)));
    const facts = await generateFacts(request, null, early);
    expect(early).not.toHaveBeenCalled();
    expect(facts[0].text).toBe(dataFact);
  });

  it("drops a caption that repeats a fact sent early, and never shows a fact twice", async () => {
    slowAI(50, `Harbor Lights came out in 2004 and appears on Paper Boats.\n${MODEL_LINES}`);
    const facts = await generateFacts(request, null, () => undefined);
    const texts = facts.map((f) => f.text);
    expect(texts.filter((t) => /came out in 2004/.test(t))).toEqual([dataFact]);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("keeps the data facts when the AI fails after they went out", async () => {
    mockCreate.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("overloaded")), 50)));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const facts = await generateFacts(request, null, () => undefined);
    warn.mockRestore();
    expect(facts.map((f) => f.text)).toEqual([dataFact]);
  });

  it("adds the article's infobox fact after the ones sent early (merge of #243 and #298)", async () => {
    slowAI(200);
    const writer = '"Harbor Lights" was written by Mara Quill.';
    const box = jest.spyOn(jest.requireActual("./infobox"), "infoboxFacts").mockResolvedValue([{ text: writer, evidence: "writer: Mara Quill", values: ["Mara Quill"] }]);
    let early: Fact[] = [];
    const facts = await generateFacts(request, null, (data) => (early = data));
    box.mockRestore();
    expect(early.map((f) => f.text)).toEqual([dataFact]);
    expect(facts[0]).toEqual(early[0]);
    expect(facts.find((f) => f.text === writer)?.source).toBe(`${SOURCE.infobox}Harbor Lights (Velvet Lark song)`);
    expect(facts.length).toBeLessThanOrEqual(5);
  });

  it("shows no infobox facts about another work than the request (#256)", async () => {
    const shown = async (about: BoxSubject, mb: string[] = []) => {
      (musicbrainzFacts as jest.Mock).mockResolvedValue(mb);
      const text = `${about.name} was developed by Pinecone Works.`;
      const box = jest.spyOn(jest.requireActual("./infobox"), "infoboxFacts").mockResolvedValue([{ text, evidence: "developer: Pinecone Works", values: ["Pinecone Works"], about }]);
      const facts = await generateFacts(request);
      box.mockRestore();
      clearFactCache();
      return facts.some((f) => f.text === text);
    };
    // The song's own infobox under another title, and a game named like the band.
    expect(await shown({ kind: "song", name: "Harbor Nights", artists: [] })).toBe(false);
    expect(await shown({ kind: "game", name: "Velvet Lark", artists: [] }, ['"Harbor Lights" came out in 2004 and is on the album Paper Boats.'])).toBe(false);
    expect(await shown({ kind: "song", name: "Harbor Lights", artists: [] })).toBe(true);
  });

  it("never caches a fact marked Wrong while the AI was still writing", async () => {
    let release: (v: unknown) => void = () => undefined;
    mockCreate.mockImplementationOnce(() => new Promise((r) => (release = r)));
    let early: Fact[] = [];
    const first = generateFacts(request, null, (data) => (early = data));
    while (!early.length) await new Promise((r) => setImmediate(r));
    expect(early.map((f) => f.text)).toEqual([dataFact]);
    // The streamer marks the early data fact Wrong before the AI is done.
    expect(markWrong(request, dataFact, SOURCE.wikidata)).toBe(STRUCTURED);
    release(reply(MODEL_LINES));
    expect((await first).map((f) => f.text)).not.toContain(dataFact);
    expect((await generateFacts(request)).map((f) => f.text)).not.toContain(dataFact);
    resetWrongFacts();
  });

  it("takes nothing from the article's item when the match is unsure", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValue("Harbor Lights (album)\nHarbor Lights is the second studio album by American dream pop band Velvet Lark, released in 2004.");
    const early = jest.fn();
    await generateFacts(request, null, early);
    expect(articleItem).not.toHaveBeenCalled();
    expect(early).not.toHaveBeenCalled();
  });
});

describe("Wrong decides what to block from the fact's own label (audit)", () => {
  it("reads the label: an article, Wikidata and MusicBrainz, or nothing", () => {
    expect(blockFor("Wikipedia: Chrono Trigger")).toBe("Chrono Trigger");
    expect(blockFor(SOURCE.wikidata)).toBe(STRUCTURED);
    expect(blockFor(SOURCE.musicbrainz)).toBe(STRUCTURED);
    expect(blockFor(SOURCE.custom)).toBeNull();
    expect(blockFor(SOURCE.yours)).toBeNull();
    expect(blockFor(undefined)).toBeUndefined();
  });

  it("blocks the article for a fact from it, even with nothing in memory (after a restart, or after the song)", () => {
    const song = { title: "Label Song", artist: "Label Game", songId: 4242 };
    expect(markWrong(song, "A fact.", "Wikipedia: Label Game")).toBe("Label Game");
    expect(blockedArticles(song).has("Label Game")).toBe(true);
  });

  it("blocks nothing when the streamer's own fact is wrong", () => {
    const song = { title: "Own Song", artist: "Own Game" };
    expect(markWrong(song, "My typo.", SOURCE.custom)).toBeNull();
    expect(blockedArticles(song).size).toBe(0);
  });

  it("tells the app when the wrong fact is the streamer's own, so it offers Edit instead of promising a block (musician review #3)", () => {
    expect(ownFactKind(SOURCE.yours)).toBe("song");
    expect(ownFactKind(SOURCE.custom)).toBe("custom");
    expect(ownFactKind(SOURCE.songList)).toBeNull();
    expect(ownFactKind("Wikipedia: Chrono Trigger")).toBeNull();
    expect(ownFactKind(SOURCE.wikidata)).toBeNull();
    expect(ownFactKind(undefined)).toBeNull();
  });

  it("Undo lifts the block for a list song, found by its ID", () => {
    const song = { title: "Listed Song", artist: "Listed Game", songId: 777 };
    markWrong(song, "A fact.", "Wikipedia: Listed Game");
    unmarkWrong(song, "Listed Game");
    expect(blockedArticles(song).size).toBe(0);
  });

  it("blocks a live learn's article under the song it was looked up as too", () => {
    const request = { title: "Some Artist - Some Song (Official Video)", artist: "Unknown", liveLearn: true };
    markWrong(request, "A fact.", "Wikipedia: Some Song");
    const lookup = liveLearnLookup(request)!;
    expect(blockedArticles(lookup).has("Some Song")).toBe(true);
    unmarkWrong(request, "Some Song");
    expect(blockedArticles(lookup).size).toBe(0);
  });
});

describe("copiesExample", () => {
  it("catches the examples' wording when the reference doesn't have it", () => {
    const ref = "Mara Quinn composed the score in 2011. The album reached number 4 in Canada.";
    expect(copiesExample("Mara Quinn said the band wanted the chorus to sound like a storm.", ref)).toBe(true);
    expect(copiesExample("The album reached number 9 on the Oricon chart.", ref)).toBe(true);
  });

  it("lets through common wording and wording the reference has", () => {
    expect(copiesExample("The band's lyrics are about loss and distance.", "Its lyrics are about loss and distance.")).toBe(false);
    expect(copiesExample("Lee wanted the chorus to sound like a storm.", "Lee said she wanted the chorus to sound like a storm at sea.")).toBe(false);
    expect(copiesExample("The album reached number 4 in Canada.", "The album reached number 4 in Canada.")).toBe(false);
  });
});

describe("a note after the artist's name (issue #262)", () => {
  const noted = { title: "Glass Orchard", artist: "Wren Halloway (note words)" };
  const article = `Glass Orchard\nGlass Orchard is a 1999 song by Wren Halloway. ${MODEL_LINES}`;

  it("is never searched, sent to the AI, put in a bubble or logged", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(article);
    (wikidataFacts as jest.Mock).mockClear();
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const facts = await generateFacts(noted);
    expect(facts.length).toBeGreaterThan(0);
    const searched = JSON.stringify([(fetchGrounding as jest.Mock).mock.calls, (wikidataFacts as jest.Mock).mock.calls, (artistFacts as jest.Mock).mock.calls]);
    expect(searched).toContain("Wren Halloway");
    expect(searched).not.toContain("note words");
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain("note words");
    expect(JSON.stringify(facts)).not.toContain("note words");
    expect(JSON.stringify(log.mock.calls)).not.toContain("note words");
    log.mockRestore();
  });

  it("never searches, prompts, shows or logs who commissioned or requested the song", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockClear().mockResolvedValueOnce(article);
    (wikidataFacts as jest.Mock).mockClear();
    mockCreate.mockClear();
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const facts = await generateFacts({ title: "Glass Orchard (requested by Moss Tinker)", artist: "Wren Halloway, Commissioned by Moss Tinker" });
    expect(facts.length).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalled();
    const searched = JSON.stringify([(fetchGrounding as jest.Mock).mock.calls, (wikidataFacts as jest.Mock).mock.calls, (artistFacts as jest.Mock).mock.calls]);
    expect(searched).toContain("Wren Halloway");
    expect(searched).not.toContain("Tinker");
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain("Tinker");
    expect(JSON.stringify(facts)).not.toContain("Tinker");
    expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain("Tinker");
    expect(songsLogLine({ title: "Glass Orchard (requested by Moss Tinker)", artist: "Wren Halloway, Commissioned by Moss Tinker" }, "grounded", 4)).not.toContain("Tinker");
    log.mockRestore();
    warn.mockRestore();
  });

  it("is left out of a live learn's lookup too", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    await generateFacts({ ...noted, liveLearn: true });
    expect(JSON.stringify((fetchGrounding as jest.Mock).mock.calls)).not.toContain("note words");
  });

  it("is left out of logs/songs.log", () => {
    const line = songsLogLine(noted, "grounded", 4, new Date("2026-10-21T20:00:00Z"));
    expect(line).toBe("2026-10-21T20:00:00.000Z\tGlass Orchard\tWren Halloway\tarticle\t4\n");
  });

  it("still finds the streamer's own facts saved under the note, or under an alias with it", async () => {
    saveSongFacts({ title: "Glass Orchard", artist: "Wren Halloway (note words)", facts: ["Wren wrote it on a porch."] });
    saveSongFacts({ title: "Night Ferry", artist: "Wren Halloway", aliases: ["Wren Halloway (other note) - Night Ferry"], facts: ["Recorded on a boat."] });
    try {
      expect((await generateFacts(noted)).map((f) => f.text)).toEqual(["Wren wrote it on a porch."]);
      expect((await generateFacts({ title: "Night Ferry", artist: "Wren Halloway (other note)" })).map((f) => f.text)).toEqual(["Recorded on a boat."]);
    } finally {
      saveSongFacts({ title: "Glass Orchard", artist: "Wren Halloway (note words)", facts: [] });
      saveSongFacts({ title: "Night Ferry", artist: "Wren Halloway", facts: [] });
    }
  });

  it("doesn't split a song's Wrong marks: one saved with the note before is still found", () => {
    const file = path.join(process.env.BUBBLEFACTS_DATA_DIR as string, "wrong-facts.json");
    fs.writeFileSync(file, JSON.stringify({ "wren halloway (note words):::glass orchard": ["Old Article"] }));
    resetWrongFacts();
    try {
      expect(blockedArticles({ title: "Glass Orchard", artist: "Wren Halloway" }).has("Old Article")).toBe(true);
      expect(blockedArticles(noted).has("Old Article")).toBe(true);
      markWrong(noted, "A fact.", "Wikipedia: New Article");
      expect(blockedArticles({ title: "Glass Orchard", artist: "Wren Halloway" }).has("New Article")).toBe(true);
      unmarkWrong(noted, "Old Article");
      expect(blockedArticles(noted).has("Old Article")).toBe(false);
    } finally {
      fs.writeFileSync(file, "{}");
      resetWrongFacts();
    }
  });
});

describe("no facts for this song, or for this artist (issue #262)", () => {
  const glass = { title: "Glass Orchard", artist: "Wren Halloway" };
  const article = `Glass Orchard\nGlass Orchard is a 1999 song by Wren Halloway. ${MODEL_LINES}`;
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    (wikidataFacts as jest.Mock).mockClear();
    (topic as { taggedFacts: unknown }).taggedFacts = [
      { tag: "Glass Orchard", text: "Wren hums the bridge before every show." },
      { tag: "Wren Halloway", text: "Wren learned fiddle from a neighbor." },
    ];
  });
  afterEach(() => {
    saveSongFacts({ ...glass, facts: [], noFacts: false, noArtistFacts: false });
    saveSongFacts({ title: "Night Ferry", artist: "Wren Halloway", facts: [], noFacts: false, noArtistFacts: false });
    (topic as { taggedFacts: unknown }).taggedFacts = [];
  });

  it("shows only the streamer's own facts for the song: nothing looked up or written", async () => {
    saveSongFacts({ ...glass, facts: ["Wren wrote it on a porch."], noFacts: true });
    const facts = await generateFacts(glass, entry({ ...glass, timesPlayed: 3 }));
    expect(facts.map((f) => [f.text, f.source])).toEqual([
      ["Wren wrote it on a porch.", SOURCE.yours],
      ["Wren hums the bridge before every show.", SOURCE.custom],
      ["Wren learned fiddle from a neighbor.", SOURCE.custom],
    ]);
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(wikidataFacts).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(outcomeFor(glass)).toBe("factsOff");
  });

  it("shows nothing when the streamer has no facts of their own for it", async () => {
    (topic as { taggedFacts: unknown }).taggedFacts = [];
    setFactsOff(glass, "song", true);
    expect(await generateFacts(glass, entry({ ...glass, timesPlayed: 3 }))).toEqual([]);
    expect(fetchGrounding).not.toHaveBeenCalled();
  });

  it("covers every song by the artist, a live learn too, from the switch on one of their songs", async () => {
    (topic as { taggedFacts: unknown }).taggedFacts = [];
    setFactsOff({ title: "Night Ferry", artist: "Wren Halloway" }, "artist", true);
    expect(await generateFacts({ title: "Harbor Lights", artist: "Wren Halloway (note words)" })).toEqual([]);
    expect(await generateFacts({ title: "Harbor Lights", artist: "Wren Halloway", liveLearn: true })).toEqual([]);
    expect(fetchGrounding).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("applies at once to a song whose facts were already found, and lifts the same way", async () => {
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(article);
    const found = await generateFacts(glass);
    expect(found.some((f) => f.source === "Wikipedia: Glass Orchard")).toBe(true);
    setFactsOff(glass, "song", true);
    expect((await generateFacts(glass)).every((f) => f.source === SOURCE.custom)).toBe(true);
    setFactsOff(glass, "song", false);
    expect(await generateFacts(glass)).toEqual(found);
  });

  it("keeps only the streamer's own facts from a play saved before a restart", () => {
    const saved = [
      { text: "From the article.", source: "Wikipedia: Glass Orchard", delaySeconds: 0, durationSeconds: 8, position: {} },
      { text: "From Wikidata.", source: SOURCE.wikidata, delaySeconds: 15, durationSeconds: 8, position: {} },
      { text: "Wren wrote it on a porch.", source: SOURCE.yours, delaySeconds: 30, durationSeconds: 8, position: {} },
      { text: "Requested by Robin.", source: SOURCE.songList, delaySeconds: 45, durationSeconds: 8, position: {} },
    ];
    expect(allowedFacts(glass, saved)).toEqual(saved);
    setFactsOff({ title: "Night Ferry", artist: "Wren Halloway" }, "artist", true);
    expect(allowedFacts(glass, saved).map((f) => f.text)).toEqual(["Wren wrote it on a porch."]);
  });
});

describe("Wrong on the song that's on pulls the rest of its bubbles from that source (issue #262)", () => {
  const bubble = (text: string, source: string, i: number): Fact => ({ text, source, delaySeconds: i * 15, durationSeconds: 8, position: {} });
  const facts = [
    bubble("First from the article.", "Wikipedia: Glass Orchard", 0),
    bubble("From Wikidata.", SOURCE.wikidata, 1),
    bubble("Second from the article.", "Wikipedia: Glass Orchard", 2),
    bubble("From MusicBrainz.", SOURCE.musicbrainz, 3),
    bubble("Wren wrote it on a porch.", SOURCE.yours, 4),
    bubble("Requested by Robin.", SOURCE.songList, 5),
    bubble("From another article.", "Wikipedia: Wren Halloway", 6),
  ];
  const texts = (list: Fact[]) => list.map((f) => f.text);

  it("takes the marked bubble and every other one from the same article", () => {
    expect(texts(pulledWithWrong(facts, facts[0]))).toEqual(["First from the article.", "Second from the article."]);
  });

  it("takes Wikidata and MusicBrainz together, as Wrong blocks them together", () => {
    expect(texts(pulledWithWrong(facts, facts[3]))).toEqual(["From Wikidata.", "From MusicBrainz."]);
  });

  it("takes only the marked one when it's the streamer's own or from the song list", () => {
    expect(texts(pulledWithWrong(facts, facts[4]))).toEqual(["Wren wrote it on a porch."]);
    expect(texts(pulledWithWrong(facts, facts[5]))).toEqual(["Requested by Robin."]);
  });

  it("doesn't bring them back when the session resumes after a restart", () => {
    const pulled = new Set(texts(pulledWithWrong(facts, facts[0])));
    const left = facts.filter((f) => !pulled.has(f.text));
    const shownAt = Date.now() - 5_000;
    saveSession({ song: { title: "Glass Orchard", artist: "Wren Halloway" }, facts: left, shownAt, recent: [], savedAt: Date.now() });
    const resumed = loadSession();
    expect(resumed).not.toBeNull();
    const toCome = texts(remainingFacts(resumed!.facts, resumed!.shownAt));
    expect(toCome).not.toContain("Second from the article.");
    expect(toCome).toContain("From another article.");
  });
});

describe("logs say why a fact was dropped, never what it said (issue #262)", () => {
  it("logs a dropped caption, data fact or restatement by its reason alone", async () => {
    (config as { factVerification: boolean }).factVerification = true;
    (fetchGrounding as jest.Mock).mockResolvedValueOnce(`Glass Orchard\nGlass Orchard is a 1999 song by Wren Halloway. ${MODEL_LINES}`);
    mockCreate.mockResolvedValue(reply(`Glass Orchard is widely considered a towering masterpiece of its decade.\nWren Halloway is a devout Quaker from Vellmar.\nGlass Orchard is a song by Wren Halloway.\n${MODEL_LINES}`));
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await generateFacts({ title: "Glass Orchard", artist: "Wren Halloway" });
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.filter((l) => l.startsWith("[Screen] DROP (")).length).toBeGreaterThanOrEqual(2);
      expect(lines).toContain("[Screen] DROP (content standard: identity)");
      expect(lines.some((l) => /masterpiece|Quaker/.test(l))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe("a song that comes back while its stopped generation winds down", () => {
  const request = { title: "Copper Kite", artist: "Marlo Venn" };
  const page = `Copper Kite (Marlo Venn song)\n"Copper Kite" is a song by Marlo Venn. ${MODEL_LINES}`;
  beforeEach(() => {
    (config as { factVerification: boolean }).factVerification = true;
    (config as { aiProvider: string }).aiProvider = "builtin";
    (fetchGrounding as jest.Mock).mockResolvedValue(page);
    (articleItem as jest.Mock).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    (config as { aiProvider: string }).aiProvider = "anthropic";
    (fetchGrounding as jest.Mock).mockReset().mockResolvedValue("");
    setCurrentSong(null);
  });

  it("gets its facts after a quick skip away and back", async () => {
    const prompts: AbortSignal[] = [];
    useBuiltinSession({
      resetChatHistory: () => undefined,
      // Like node-llama-cpp with stopOnAbortSignal: a stopped prompt ends a moment later with what it wrote.
      prompt: (_text, { signal }) => {
        prompts.push(signal);
        if (prompts.length > 1) return Promise.resolve(MODEL_LINES);
        return new Promise((r) => signal.addEventListener("abort", () => setTimeout(() => r(""), 10)));
      },
    });
    setCurrentSong(request);
    const first = generateFacts(request);
    while (!prompts.length) await new Promise((r) => setImmediate(r));
    // Skipped to another song and straight back, before the stopped prompt has ended.
    setCurrentSong({ title: "Tin Harbor", artist: "Marlo Venn" });
    setCurrentSong(request);
    const back = generateFacts(request);
    expect(await first).toEqual([]);
    expect((await back).length).toBeGreaterThan(0);
  });
});
