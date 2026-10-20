jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" } }));
jest.mock("./fact-verifier", () => ({
  fetchGrounding: jest.fn(),
  looksLikeArtistName: (s: string) => /^[A-Z][a-z]+ [A-Z][a-z]+$/.test(s),
  normalizeTitle: (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(),
}));

import fs from "fs";
import path from "path";
import { CHECK_FILE, CHECK_VERSION, LookupResult, loadCheckCache, riskReason, riskySongs, runSongListCheck, songKey, suspicion } from "./song-list-check";

const file = path.join(process.env.BUBBLEFACTS_DATA_DIR as string, CHECK_FILE);
beforeEach(() => fs.rmSync(file, { force: true }));

const noWait = { sleep: async () => {}, paceMs: 0 };
const found = (article: string, fallback = false): LookupResult => ({ article, fallback, throttled: false });
const songs = [
  { title: "Moonlit Harbor", artist: "Test Quartet" },
  { title: "Cherry", artist: "Nobody Special" },
  { title: "Paper Lanterns", artist: "Brass Fable" },
];
const answers: Record<string, LookupResult> = {
  "Moonlit Harbor": found("Moonlit Harbor (song)"),
  Cherry: found("Cherry Blossom Festival"),
  "Paper Lanterns": found(""),
};

describe("riskReason", () => {
  it("flags no article, an article that shares nothing, and a title-alone match; passes a clean one", () => {
    expect(riskReason(songs[2], answers["Paper Lanterns"])).toBe("no article");
    expect(riskReason(songs[1], answers.Cherry)).toBe("");
    expect(suspicion({ title: "Quiet Orchard", artist: "Glass Choir" }, "Volcano Racing")).toMatch(/shares no words/);
    expect(riskReason(songs[0], found("Moonlit Harbor (song)", true))).toBe("matched from the title alone");
  });
});

describe("runSongListCheck", () => {
  it("looks up each song once, saves the answers, and lists only the risky ones", async () => {
    const lookup = jest.fn(async (s: { title: string }) => answers[s.title]);
    const r = await runSongListCheck({ songs, lookup, ...noWait });
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ total: 3, checked: 3, cached: 0, stopped: false });
    expect(r.risky.map((c) => c.title)).toEqual(["Paper Lanterns"]);
    expect(Object.keys(loadCheckCache())).toHaveLength(3);
  });

  it("the next run only checks new songs, and the same song spelled differently counts once", async () => {
    const lookup = jest.fn(async (s: { title: string }) => answers[s.title] ?? found("Lonely Pines Theme"));
    await runSongListCheck({ songs, lookup, ...noWait });
    lookup.mockClear();
    const more = [...songs, { title: "cherry (Live)", artist: "nobody special" }, { title: "Lonely Pines", artist: "Mossy Trio" }];
    const r = await runSongListCheck({ songs: more, lookup, ...noWait });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0].title).toBe("Lonely Pines");
    expect(r).toMatchObject({ checked: 1, cached: 4 });
  });

  it("checks everything again when the cache is from another version", async () => {
    fs.writeFileSync(file, JSON.stringify({ version: CHECK_VERSION + 1, songs: { [songKey(songs[0])]: { title: "x", artist: "y", article: "z", why: "", checkedAt: "" } } }));
    const lookup = jest.fn(async (s: { title: string }) => answers[s.title]);
    await runSongListCheck({ songs, lookup, ...noWait });
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("waits while a song is playing and never looks during it", async () => {
    let playing = 3;
    let looked = false;
    const lookup = jest.fn(async () => {
      looked = true;
      return found("Moonlit Harbor (song)");
    });
    const sleep = jest.fn(async () => {
      if (looked) return;
      playing--;
    });
    await runSongListCheck({ songs: [songs[0]], lookup, isPlaying: () => playing > 0 && !looked, sleep, paceMs: 0 });
    expect(sleep).toHaveBeenCalledTimes(4); // three waits for the song, then the pace
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("asks again after Wikipedia says to slow down", async () => {
    const lookup = jest
      .fn<Promise<LookupResult>, []>()
      .mockResolvedValueOnce({ article: "", fallback: false, throttled: true })
      .mockResolvedValueOnce(found("Moonlit Harbor (song)"));
    const sleep = jest.fn(async () => {});
    const r = await runSongListCheck({ songs: [songs[0]], lookup, sleep, paceMs: 0 });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(r.risky).toEqual([]);
  });

  it("stops when asked, keeping what was done", async () => {
    let n = 0;
    const lookup = jest.fn(async () => (n++, found("Moonlit Harbor (song)")));
    const r = await runSongListCheck({ songs, lookup, shouldStop: () => n >= 1, ...noWait });
    expect(r).toMatchObject({ checked: 1, stopped: true });
    expect(Object.keys(loadCheckCache())).toHaveLength(1);
  });

  it("only one check runs at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = runSongListCheck({ songs: [songs[0]], lookup: async () => (await gate, found("Moonlit Harbor (song)")), ...noWait });
    const second = await runSongListCheck({ songs, lookup: jest.fn(), ...noWait });
    expect(second.stopped).toBe(true);
    release();
    expect((await first).checked).toBe(1);
  });
});

describe("riskySongs", () => {
  it("leaves out songs that are no longer on the list", async () => {
    await runSongListCheck({ songs, lookup: async (s) => answers[s.title], ...noWait });
    expect(riskySongs(loadCheckCache(), songs.slice(0, 2))).toEqual([]);
    expect(riskySongs(loadCheckCache())).toHaveLength(1);
  });
});
