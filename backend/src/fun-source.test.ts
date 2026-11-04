jest.mock("./config", () => ({
  config: {
    factsPerSong: 5,
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    groundingTimeoutMs: 5000,
    groundingExtractTimeoutMs: 15000,
    topic: "pop,general",
    funSource: true,
  },
}));

const pages: Record<string, string> = {};
const wikitext: Record<string, string> = {};
jest.mock("./fact-verifier", () => {
  const actual = jest.requireActual("./fact-verifier");
  return {
    ...actual,
    articleText: () => "",
    wikiExtract: jest.fn(async (p: string) => pages[p] ?? null),
    wikitextOf: jest.fn(async (p: string) => wikitext[p] ?? ""),
    performerPages: jest.fn(async () => ({ performer: "Velvet Harbor", song: null })),
  };
});

import { funSourceSentences, hasAlbumSentence, infoboxAlbum, thinOnFun, withFunSource } from "./fun-source";
import { wikiExtract } from "./fact-verifier";
import { SSLSong } from "./types";

// Made-up band, album and songs, written the way Wikipedia's plain-text extracts read.
const ALBUM = [
  `Tin Lanterns is the second studio album by the band Velvet Harbor, released in 2004.`,
  "== Background ==",
  `The band finished "Paper Comet" in one afternoon in a borrowed farmhouse kitchen after a power cut ended a session.`,
  `He said the record was meant to sound like a radio left on in another room, and "Paper Comet" most of all.`,
  "=== Recording ===",
  `Drummer Ola Brandt played "Paper Comet" on a borrowed kitchen pot because the snare drum was left in a van.`,
  `"Glass Orchard" was recorded in two days at a church in Lisbon.`,
  "== Track listing ==",
  `"Paper Comet" was inspired by a dream about 100 kites over a frozen lake, the singer said in liner notes.`,
  "== Reception ==",
  `Critics named "Paper Comet" one of the best songs of 2004, and it was nominated for an award.`,
].join("\n");

const THIN_SONG = [
  "Paper Comet",
  `"Paper Comet" is a song by the band Velvet Harbor from their 2004 album Tin Lanterns. It was released as the album's second single in 2004. It was released on vinyl and as a digital download.`,
].join("\n");

beforeEach(() => {
  for (const k of Object.keys(pages)) delete pages[k];
  for (const k of Object.keys(wikitext)) delete wikitext[k];
  (wikiExtract as jest.Mock).mockClear();
});

describe("funSourceSentences", () => {
  it("keeps fun sentences from making sections that name the song, best first", () => {
    const got = funSourceSentences(ALBUM, "Paper Comet").map((s) => s.text);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((s) => s.includes('"Paper Comet"'))).toBe(true);
    expect(got.some((s) => /kitchen/.test(s))).toBe(true);
  });

  it("skips another song's sentences, sentences that start with a pronoun, and lists, reception and the lead", () => {
    const got = funSourceSentences(ALBUM, "Paper Comet").map((s) => s.text).join(" ");
    expect(got).not.toMatch(/Glass Orchard/);
    expect(got).not.toMatch(/^He said|radio left on/);
    expect(got).not.toMatch(/100 kites/);
    expect(got).not.toMatch(/Critics/);
    expect(got).not.toMatch(/second studio album/);
  });

  it("reads a performer's career sections only when asked", () => {
    const band = `Velvet Harbor is a band.\n== 2003-2005: Tin Lanterns ==\nSinger Mara Quill finished "Paper Comet" in one afternoon in a borrowed farmhouse kitchen.`;
    expect(funSourceSentences(band, "Paper Comet")).toEqual([]);
    expect(funSourceSentences(band, "Paper Comet", "", 3, true).map((s) => s.text)).toEqual([`Singer Mara Quill finished "Paper Comet" in one afternoon in a borrowed farmhouse kitchen.`]);
  });

  it("keeps sentences that name the song's album, marked as about the album, but not ones quoting another song", () => {
    const got = funSourceSentences(ALBUM, "Paper Comet", "", 5, false, "Tin Lanterns (Velvet Harbor album)");
    const whole = got.filter((s) => s.album).map((s) => s.text);
    const art = `Tin Lanterns was recorded in two weeks in a borrowed barn after a fire closed the band's studio.`;
    expect(funSourceSentences(`X\n== Recording ==\n${art}`, "Paper Comet", "", 3, false, "Tin Lanterns")).toEqual([{ text: art, score: expect.any(Number), album: true }]);
    expect(whole.join(" ")).not.toMatch(/Glass Orchard/);
    expect(got.filter((s) => !s.album).every((s) => s.text.includes('"Paper Comet"'))).toBe(true);
  });

  it("skips sentences the reference has already and generic titles", () => {
    const pot = `Drummer Ola Brandt played "Paper Comet" on a borrowed kitchen pot because the snare drum was left in a van.`;
    expect(funSourceSentences(ALBUM, "Paper Comet", pot).map((s) => s.text)).not.toContain(pot);
    expect(funSourceSentences(`Intro\n== Background ==\nThe band wrote "Intro" in one afternoon in a borrowed farmhouse kitchen.`, "Intro")).toEqual([]);
  });
});

describe("thinOnFun and infoboxAlbum", () => {
  it("calls a reference of release details thin", () => {
    expect(thinOnFun(THIN_SONG)).toBe(true);
  });

  it("reads the album an infobox links", () => {
    expect(infoboxAlbum("{{Infobox song\n| name = Paper Comet\n| album = ''[[Tin Lanterns]]''\n}}")).toBe("Tin Lanterns");
    expect(infoboxAlbum("{{Infobox song\n| name = Paper Comet\n}}")).toBeNull();
  });
});

describe("withFunSource", () => {
  const song = { title: "Paper Comet", artist: "Velvet Harbor", id: "1" } as unknown as SSLSong;

  it("adds a labelled line from the album's article after the title line", async () => {
    pages["Tin Lanterns"] = ALBUM;
    wikitext["Paper Comet"] = "| album = ''[[Tin Lanterns]]''";
    const out = await withFunSource(THIN_SONG, song, () => true);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Paper Comet");
    expect(lines[1]).toMatch(/^From the article "Tin Lanterns": .*"Paper Comet"/);
    expect(out).toContain(THIN_SONG.split("\n")[1]);
  });

  it("flags a reference given a sentence about the whole album, for the prompt's album rule", async () => {
    const art = `Tin Lanterns was recorded in two weeks in a borrowed barn after a fire closed the band's studio.`;
    pages["Tin Lanterns"] = `Tin Lanterns is an album.\n== Recording ==\n${art}`;
    wikitext["Paper Comet"] = "| album = ''[[Tin Lanterns]]''";
    const out = await withFunSource(THIN_SONG, { ...song, artist: "Velvet Harbor Four" } as SSLSong, () => true);
    expect(out).toContain(`From the article "Tin Lanterns": ${art}`);
    expect(hasAlbumSentence(out)).toBe(true);
    expect(hasAlbumSentence(THIN_SONG)).toBe(false);
  });

  it("leaves out an article the streamer marked wrong", async () => {
    pages["Tin Lanterns"] = ALBUM;
    wikitext["Paper Comet"] = "| album = ''[[Tin Lanterns]]''";
    expect(await withFunSource(THIN_SONG, song, (t) => t !== "Tin Lanterns")).toBe(THIN_SONG);
  });

  it("reads nothing more when the reference has fun to tell", async () => {
    const rich = `${THIN_SONG}\nRecording: The band recorded it in one afternoon in a farmhouse kitchen inspired by a dream. The drummer played a kitchen pot after the snare drum was left in a van, inspired by a busker.`;
    expect(thinOnFun(rich)).toBe(false);
    expect(await withFunSource(rich, { ...song, artist: "Velvet Harbor Three" } as SSLSong, () => true)).toBe(rich);
    expect(wikiExtract).not.toHaveBeenCalled();
  });

  it("serves the reference alone when Wikipedia can't be asked", async () => {
    (wikiExtract as jest.Mock).mockRejectedValueOnce(new Error("HTTP 429"));
    wikitext["Paper Comet"] = "| album = ''[[Tin Lanterns]]''";
    expect(await withFunSource(THIN_SONG, { ...song, title: "Paper Comet", artist: "Velvet Harbor Two" } as SSLSong, () => true)).toBe(THIN_SONG);
  });
});
