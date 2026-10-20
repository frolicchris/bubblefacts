jest.mock("./config", () => ({
  config: {
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    topic: "general",
    aiProvider: "none",
    factVerification: false,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
    originals: true,
    instrument: "",
  },
}));
jest.mock("./wikidata", () => ({ wikidataFacts: jest.fn().mockResolvedValue([]) }));
jest.mock("./musicbrainz", () => ({ musicbrainzFacts: jest.fn().mockResolvedValue([]) }));

import fs from "fs";
import path from "path";
import { markWrong, SOURCE } from "./fact-generator";
import { WRONG_LOG_FILE, WRONG_LOG_LINES, logWrong } from "./wrong-log";

const file = path.join(process.env.BUBBLEFACTS_DATA_DIR as string, WRONG_LOG_FILE);
const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const song = { title: "Moonlit Harbor", artist: "Test Quartet", songId: 9001 };

beforeEach(() => fs.rmSync(file, { force: true }));

describe("the Wrong log", () => {
  it("one Wrong press writes one line with the song, caption, source, article, version and date", () => {
    process.env.BUBBLEFACTS_VERSION = "2.1.0-test";
    expect(markWrong(song, "It was recorded in a harbor.", "Wikipedia: Harbor Game")).toBe("Harbor Game");
    expect(lines()).toEqual([
      {
        song: { title: "Moonlit Harbor", artist: "Test Quartet", songId: 9001 },
        caption: "It was recorded in a harbor.",
        source: "Wikipedia: Harbor Game",
        article: "Harbor Game",
        appVersion: "2.1.0-test",
        date: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ]);
  });

  it("leaves out a note after the artist's name (issue #262)", () => {
    logWrong({ title: "Moonlit Harbor", artist: "Test Quartet (note words)" }, "A caption.", "Wikipedia: Harbor Game", "Harbor Game");
    expect(lines()[0].song).toEqual({ title: "Moonlit Harbor", artist: "Test Quartet" });
  });

  it("keeps lines private to the streamer's account on this computer", () => {
    logWrong(song, "A caption.", undefined, null);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("is not written when the streamer's own fact is wrong", () => {
    markWrong(song, "My typo.", SOURCE.custom);
    markWrong(song, "My song fact.", SOURCE.yours);
    expect(lines()).toHaveLength(0);
  });

  it("keeps only the newest lines once past the cap", () => {
    for (let i = 0; i < WRONG_LOG_LINES + 5; i++) logWrong(song, `Caption ${i}.`, "Wikipedia: Harbor Game", "Harbor Game");
    const kept = lines();
    expect(kept).toHaveLength(WRONG_LOG_LINES);
    expect(kept[0].caption).toBe("Caption 5.");
    expect(kept[kept.length - 1].caption).toBe(`Caption ${WRONG_LOG_LINES + 4}.`);
  });

  it("starts a new line after one a crash cut short", () => {
    fs.writeFileSync(file, '{"song":{"title":"Cut');
    logWrong(song, "After the crash.", undefined, null);
    const text = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(text).toHaveLength(2);
    expect(JSON.parse(text[1]).caption).toBe("After the crash.");
  });

  it("never throws, even when the data folder can't be written", () => {
    fs.mkdirSync(file);
    try {
      expect(() => logWrong(song, "A caption.", undefined, null)).not.toThrow();
    } finally {
      fs.rmdirSync(file);
    }
  });
});
