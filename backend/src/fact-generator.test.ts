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
import { blockFor, clearFactCache, factStats, forgetSong, generateFacts, markWrong, liveLearnLookup, ownFactKind, SOURCE, STRUCTURED, taggedFactsFor, outcomeFor, positionsFor, positionsForSong, restoreRecent, showsBanner, unmarkWrong, VERTICAL_SAFE, verticalPositionsFor } from "./fact-generator";
import { blockedArticles } from "./wrong-facts";
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

  it("gives every bubble a spot in the vertical overlay too, clear of the phone apps' own buttons and chat (issue #175)", async () => {
    const pct = (v: string) => Number(v.replace("%", ""));
    for (const area of ["top", "above-chat"]) {
      for (const p of verticalPositionsFor(area, false)) {
        // Centered between the safe side margins by the overlay: no left or right of its own.
        expect(p.left ?? p.right).toBeUndefined();
        if (p.top) expect(pct(p.top)).toBeGreaterThanOrEqual(VERTICAL_SAFE.top);
        // A bubble that grows upward from the chat line never starts inside the chat.
        if (p.bottom) expect(pct(p.bottom)).toBeGreaterThanOrEqual(VERTICAL_SAFE.bottom);
      }
    }
    // One spot each: the clear area is too short for two long bubbles at once.
    expect(verticalPositionsFor("top")).toEqual([{ top: "15%" }]);
    expect(verticalPositionsFor("above-chat", false)).toEqual([{ bottom: "39%" }]);
    expect(verticalPositionsFor("nonsense")).toEqual(verticalPositionsFor("top"));
    // Above the vertical Now Playing bubble while it shows, which sits on the chat line.
    const [above] = verticalPositionsFor("above-chat", true);
    expect(above.bottom).toMatch(/^calc\(39% \+ [\d.]+vw \* var\(--bf-vertical-scale, 1\)\)$/);

    // Separate from the landscape setting, so both scenes can run at once.
    const c = config as { bubbleArea?: string; verticalArea?: string };
    c.bubbleArea = "left";
    c.verticalArea = "above-chat";
    try {
      const facts = await generateFacts({ title: "Tall Song", artist: "Tall Artist" });
      expect(facts.length).toBeGreaterThan(0);
      expect(facts.every((f) => f.position.left === "3%" && f.vertical?.bottom !== undefined)).toBe(true);
    } finally {
      c.bubbleArea = "anywhere";
      c.verticalArea = "top";
    }
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
