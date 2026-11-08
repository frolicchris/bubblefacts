jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    streamerDisplayName: "Test Streamer",
    originals: true,
    topic: "",
    aiProvider: "builtin",
    temperature: 0,
    factVerification: true,
    sourceRisk: true,
    abstain: true,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
  },
}));
jest.mock("./wikidata", () => ({
  wikidataFacts: jest.fn().mockResolvedValue([]),
  artistFacts: jest.fn().mockResolvedValue([]),
  articleItem: jest.fn().mockResolvedValue(null),
  songItemFacts: jest.fn().mockReturnValue({ facts: [], dropYear: false }),
}));
jest.mock("./artist-good", () => ({ artistGoodFacts: jest.fn().mockResolvedValue([]), clearArtistGoodCache: jest.fn() }));
jest.mock("./infobox", () => ({ ...jest.requireActual("./infobox"), infoboxFacts: jest.fn().mockResolvedValue([]) }));
jest.mock("./musicbrainz", () => ({
  musicbrainzFacts: jest.fn().mockResolvedValue([]),
  artistByTitle: jest.fn().mockResolvedValue(""),
  cachedArtistByTitle: jest.fn().mockReturnValue(""),
  statedYear: () => null,
  statesAlbum: () => false,
  withoutYear: (l: string[]) => l,
}));
jest.mock("./fact-verifier", () => ({
  ...jest.requireActual("./fact-verifier"),
  fetchGrounding: jest.fn().mockResolvedValue(""),
  summaryGate: jest.fn().mockResolvedValue(""),
  loadWikitext: jest.fn().mockResolvedValue(""),
}));

import { clearFactCache, factStats, generateFacts, paceReport, prepareSong, resetPace, restoreRecent, setCurrentSong, useBuiltinSession } from "./fact-generator";
import { fetchGrounding } from "./fact-verifier";
import { wikidataFacts } from "./wikidata";
import { LATE_MS, ON_TIME_MS, QUICK_PROBE_EVERY, RECOVER_SONGS } from "./pace";
import { SSLSong } from "./types";

/** Made-up songs: each play is a new song, so nothing comes from the cache */
let played = 0;
const nextSong = (): SSLSong => ({ title: `Lantern Tide ${++played}`, artist: "Wren Halloway" });

/** The article's sentences for one play, numbered by play so none was shown for an earlier song */
const lines = (n: number) => [
  `Wren Halloway recorded the song with ${n} string players in one weekend.`,
  `Its main melody was first sketched on an upright piano at studio ${n}.`,
  `Wren Halloway later arranged the theme for an orchestra of ${n + 40} players.`,
  `An acoustic guitar carries the melody for ${n + 60} seconds in the quieter second half.`,
];
/** Far past the shorter part's end: only the full article has it */
const LATE_LINE = "A choir joins the arrangement only in the closing minute.";
const FILLER = "The song is in the key of C major. ".repeat(60);
const article = (song: SSLSong) => `${song.title} (Wren Halloway song)\n"${song.title}" is a song by Wren Halloway. ${lines(played).join(" ")} ${FILLER}${LATE_LINE}`;

let now = 1_000_000;
const prompts: string[] = [];
/** How long the model takes for the next prompt; null: until the song changes */
let takes: number | null = 10_000;
/** What the model writes; by default the article's lines for the play */
let answer: string | null = null;

beforeAll(() => {
  jest.spyOn(Date, "now").mockImplementation(() => now);
  useBuiltinSession({
    resetChatHistory: () => undefined,
    prompt: (text, { signal }) => {
      prompts.push(text);
      if (takes === null) return new Promise((r) => signal.addEventListener("abort", () => r("")));
      now += takes;
      return Promise.resolve(answer ?? [...lines(played), LATE_LINE].join("\n"));
    },
  });
});

beforeEach(() => {
  resetPace();
  clearFactCache();
  prompts.length = 0;
  takes = 10_000;
  answer = null;
  (fetchGrounding as jest.Mock).mockImplementation(async (song: SSLSong) => article(song));
  (wikidataFacts as jest.Mock).mockResolvedValue([]);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  setCurrentSong(null);
  (console.log as jest.Mock).mockRestore();
});

/** Plays a new song with the AI taking `ms`; returns its captions */
async function play(ms: number, song = nextSong()) {
  takes = ms;
  // Each song's captions are new to the stream: none held back as already shown
  restoreRecent([]);
  setCurrentSong(song);
  const facts = await generateFacts(song);
  return facts.map((f) => f.text);
}

/** A song that ends after `onFor` while the AI still writes for it; returns the next song, now on */
async function missSong(onFor = 3 * 60_000): Promise<SSLSong> {
  const song = nextSong();
  takes = null;
  setCurrentSong(song);
  const pending = generateFacts(song);
  while (!prompts.length || !prompts[prompts.length - 1].includes(song.title)) await new Promise((r) => setImmediate(r));
  now += onFor;
  const after = nextSong();
  setCurrentSong(after);
  await pending;
  takes = 10_000;
  return after;
}

/** Facts late on average: two songs whose AI facts took 90 s */
async function runLate() {
  await play(LATE_MS + 30_000);
  await play(LATE_MS + 30_000);
}

describe("a slow or busy computer (issue #314)", () => {
  it("asks for the usual captions while facts come in time", async () => {
    await play(10_000);
    const last = prompts[prompts.length - 1];
    expect(last).toMatch(/Write 8 captions/);
    expect(last).toContain(LATE_LINE);
    expect(paceReport().line).toBe("");
  });

  it("asks for 2 captions from a shorter part of the article once facts are late", async () => {
    await runLate();
    expect(paceReport().pace).toBe("short");
    expect(paceReport().line).toBe("Your computer is busy, so fewer facts");
    await play(10_000);
    const last = prompts[prompts.length - 1];
    expect(last).toMatch(/Write 2 captions/);
    expect(last).not.toContain(LATE_LINE);
    expect(last).toContain(lines(played)[0]);
  });

  it("still screens every caption the same way", async () => {
    await runLate();
    const loaded = "It is widely considered the greatest masterpiece of its decade.";
    answer = `${loaded}\n${lines(played + 1)[0]}`;
    const texts = await play(10_000);
    expect(texts).toEqual([lines(played)[0]]);
    expect(texts).not.toContain(loaded);
  });

  it("shows the quick facts only, with no AI, once a song ended before its facts came", async () => {
    const song = await missSong();
    expect(paceReport().pace).toBe("quick");
    expect(paceReport().line).toBe("Your computer is busy, so quick facts only");
    (wikidataFacts as jest.Mock).mockResolvedValue(["It came out in 2003."]);
    const asked = prompts.length;
    const texts = await play(10_000, song);
    expect(prompts.length).toBe(asked);
    expect(texts).toEqual(["It came out in 2003."]);
  });

  it("doesn't slow down for a song skipped before its facts could have been late", async () => {
    await missSong(LATE_MS - 1_000);
    expect(paceReport().pace).toBe("full");
  });

  it("recovers on its own when the computer is fast again", async () => {
    // The song after the late one gets quick facts, and so do the next few
    let song = await missSong();
    const tries: number[] = [];
    for (let i = 1; i < QUICK_PROBE_EVERY; i++) {
      const before = prompts.length;
      await play(5_000, song);
      tries.push(prompts.length - before);
      song = nextSong();
    }
    expect(tries.every((n) => n === 0)).toBe(true);
    // Every few songs the AI tries again, the short way; it was on time
    await play(5_000, song);
    expect(prompts[prompts.length - 1]).toMatch(/Write 2 captions/);
    expect(paceReport().pace).toBe("short");
    for (let i = 0; i < RECOVER_SONGS; i++) await play(ON_TIME_MS - 5_000);
    expect(paceReport().pace).toBe("full");
    await play(5_000);
    expect(prompts[prompts.length - 1]).toMatch(/Write 8 captions/);
  });

  it("never paces a song prepared ahead of time: full captions, quick facts never, and the stream's pace untouched (#293)", async () => {
    await runLate();
    expect(paceReport().pace).toBe("short");
    const { freeMemoryMb: _m, ...before } = paceReport();
    const song = nextSong();
    takes = LATE_MS * 3;
    const ready = await prepareSong(song, new AbortController().signal, { revisionOf: async () => 1 });
    expect(prompts[prompts.length - 1]).toMatch(/Write 8 captions/);
    expect(prompts[prompts.length - 1]).toContain(LATE_LINE);
    expect(ready.outcome).toBe("facts");
    // A slow prepared turn neither counts as late nor sets the stream model's speed
    expect(paceReport()).toMatchObject(before);
    // Even once the stream is down to quick facts, a prepared song still gets the AI
    await missSong();
    expect(paceReport().pace).toBe("quick");
    const asked = prompts.length;
    await prepareSong(nextSong(), new AbortController().signal, { revisionOf: async () => 1 });
    expect(prompts.length).toBe(asked + 1);
  });

  it("leaves an online AI alone", async () => {
    const c = (await import("./config")).config as { aiProvider: string };
    c.aiProvider = "anthropic";
    try {
      setCurrentSong(nextSong());
      now += 5 * 60_000;
      setCurrentSong(nextSong());
      expect(paceReport().pace).toBe("full");
    } finally {
      c.aiProvider = "builtin";
    }
  });
});

describe("preparing with the faster model while another is on stream (issue #296)", () => {
  /** The prep model's captions, none of which passes the screen: nobody is named */
  const FAILING = ["He did it in one night.", "They liked it a lot more than before.", "I wrote it at home."].join("\n");
  const prepPrompts: string[] = [];
  let c: { modelPath: string; prepareModelPath: string };

  beforeEach(async () => {
    c = (await import("./config")).config as typeof c;
    c.modelPath = "/models/high.gguf";
    c.prepareModelPath = "/models/standard.gguf";
    prepPrompts.length = 0;
    useBuiltinSession(
      { resetChatHistory: () => undefined, prompt: (text) => (prompts.push(text), Promise.resolve(answer ?? [...lines(played), LATE_LINE].join("\n"))) },
      { resetChatHistory: () => undefined, prompt: (text) => (prepPrompts.push(text), Promise.resolve(FAILING)) }
    );
  });
  afterEach(() => {
    c.modelPath = "";
    c.prepareModelPath = "";
  });

  it("still asks the model on stream for a song the faster model got nothing usable for", async () => {
    const song = nextSong();
    const ready = await prepareSong(song, new AbortController().signal, { revisionOf: async () => 1 });
    expect(ready.outcome).toBe("none");
    expect(ready.model).toBe("standard.gguf");
    expect(prepPrompts).toHaveLength(1);
    // Every caption failed, but from the faster model: the one on stream gets its own try (#203 is per model)
    const asked = prompts.length;
    setCurrentSong(song);
    expect((await generateFacts(song)).length).toBeGreaterThan(0);
    expect(prompts.length).toBe(asked + 1);
  });

  it("leaves the stream's own measures to the stream: a preparing turn sets no endpoint or time on /health", async () => {
    factStats.lastEndpoint = "";
    factStats.lastDurationMs = 0;
    await prepareSong(nextSong(), new AbortController().signal, { revisionOf: async () => 1 });
    expect(factStats.lastEndpoint).toBe("");
    expect(factStats.lastDurationMs).toBe(0);
    await play(10_000);
    expect(factStats.lastEndpoint).toBe("built-in model");
  });
});
