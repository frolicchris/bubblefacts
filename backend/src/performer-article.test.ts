jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { clearGroundingCache, fetchGrounding, isNonMusicWork, leadNamesPerformer } from "./fact-verifier";

// Made-up bands, songs, films and games.
describe("a performer's name shared with a film or a book", () => {
  let hits: Record<string, string[]>;
  let descriptions: Record<string, string>;
  let extracts: Record<string, string>;
  const LONG = " It was recorded in a small studio over three weeks.".repeat(20);
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    const term = p.get("srsearch");
    const names = (p.get("titles") ?? "").split("|");
    let body: unknown;
    if (term !== null) body = { query: { search: (hits[term] ?? []).map((title) => ({ title })) } };
    else if (p.get("prop") === "description")
      body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), descriptions[n] !== undefined ? { title: n, description: descriptions[n] } : { title: n, missing: "" }])) } };
    else if (p.get("redirects")) body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), { title: n, missing: "" }])) } };
    else body = { query: { pages: { 1: { extract: extracts[names[0]] ?? "", revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
    return { ok: true, status: 200, json: async () => body } as Response;
  });

  beforeAll(() => {
    global.fetch = mock as unknown as typeof fetch;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  beforeEach(() => {
    clearGroundingCache();
    mock.mockClear();
    descriptions = {};
    extracts = {
      "Glass Orchard (film)": `Glass Orchard is a 1971 horror anthology film directed by Ivo Marsh.${LONG}\n== Legacy ==\nThe band Glass Orchard took its name from the film.`,
      "Glass Orchard": `Glass Orchard are an English rock band formed in Leeds in 1969.${LONG}`,
      "Night Parade (song)": `"Night Parade" is a 1974 single by the English rock band Glass Orchard.${LONG}`,
    };
    hits = { "Glass Orchard (British) soundtrack": ["Glass Orchard (film)"], "Glass Orchard (British)": ["Glass Orchard (film)"] };
  });

  it("takes the song's own article over a film that shares the band's name", async () => {
    descriptions = { "Glass Orchard": "English rock band", "Night Parade (song)": "1974 single by Glass Orchard" };
    expect(await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" })).toMatch(/^Night Parade \(song\)\n/);
  });

  it("takes the band's article when the song has none", async () => {
    descriptions = { "Glass Orchard": "English rock band" };
    expect(await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" })).toMatch(/^Glass Orchard\n/);
  });

  it("never takes another artist's song of the same title", async () => {
    descriptions = { "Glass Orchard": "English rock band", "Night Parade (song)": "1988 song by Ann Example" };
    expect(await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" })).toMatch(/^Glass Orchard\n/);
  });

  it("never takes a redirect from the song's title to its album", async () => {
    descriptions = { "Glass Orchard": "English rock band", "Northbound (album)": "1974 album by Glass Orchard" };
    const real = mock.getMockImplementation()!;
    mock.mockImplementation(async (url: string) => {
      const p = new URL(url).searchParams;
      if (p.get("prop") !== "description") return real(url);
      const body = {
        query: {
          redirects: [{ from: "Night Parade (Glass Orchard song)", to: "Northbound (album)" }],
          pages: { 1: { title: "Northbound (album)", description: descriptions["Northbound (album)"] }, 2: { title: "Glass Orchard", description: "English rock band" } },
        },
      };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    try {
      expect(await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" })).toMatch(/^Glass Orchard\n/);
    } finally {
      mock.mockImplementation(real);
    }
  });

  it("asks Wikipedia whether a one-word name is a performer's", async () => {
    hits = { Marigold: ["Marigold (1988 film)"] };
    extracts = {
      "Marigold (1988 film)": `Marigold is a 1988 American drama film produced by an imaginary studio.${LONG}`,
      "Marigold (band)": `Marigold is an American glam metal band formed in 1983.${LONG}`,
    };
    descriptions = { Marigold: "Flowering plant", "Marigold (band)": "American glam metal band" };
    expect(await fetchGrounding({ title: "Tin Heart Highway", artist: "Marigold" })).toMatch(/^Marigold \(band\)\n/);
  });

  it("skips the film when no performer's article is found either", async () => {
    descriptions = {};
    const text = await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" });
    expect(text.startsWith("Glass Orchard (film)")).toBe(false);
  });

  it("keeps a film that names the requested piece: its own score", async () => {
    hits = { Marigold: ["Marigold (1988 film)"] };
    extracts = { "Marigold (1988 film)": `Marigold is a 1988 American drama film produced by an imaginary studio.${LONG}\n== Music ==\nThe score includes "Wishing Waltz", sung over the final scene.` };
    descriptions = { "Marigold (band)": "American glam metal band" };
    expect(await fetchGrounding({ title: "Wishing Waltz", artist: "Marigold" })).toMatch(/^Marigold \(1988 film\)\n/);
  });

  it("keeps a game's article: game music puts the game in the artist field", async () => {
    hits = { "Starfall video game": ["Starfall (video game)"] };
    extracts = { "Starfall (video game)": `Starfall is a 2003 platform video game.${LONG}` };
    descriptions = { "Starfall (band)": "Swedish pop band" };
    expect(await fetchGrounding({ title: "Comet Ridge", artist: "Starfall" })).toMatch(/^Starfall \(video game\)/);
    expect(mock.mock.calls.some(([u]) => new URL(u as string).searchParams.get("prop") === "description")).toBe(false);
  });

  it("tells non-music works and performers' mentions apart", () => {
    expect(isNonMusicWork("Glass Orchard (film)", "")).toBe(true);
    expect(isNonMusicWork("Rose Lane", "Rose Lane is a 1950 American animated musical fantasy film produced by a studio.")).toBe(true);
    expect(isNonMusicWork("Rose Lane", "Rose Lane is a folk tale with many variants.")).toBe(true);
    expect(isNonMusicWork("Rose Lane (song)", "")).toBe(false);
    expect(isNonMusicWork("Rose Lane", "Rose Lane is a 1990 song by an imaginary band.")).toBe(false);
    expect(isNonMusicWork("Rose Lane (video game)", "")).toBe(false);
    expect(leadNamesPerformer("Glass Orchard (film)", extracts["Glass Orchard (film)"], "Glass Orchard")).toBe(false);
    expect(leadNamesPerformer("Last Light (film)", "Last Light is a 2018 film about the English rock band Glass Orchard.", "Glass Orchard")).toBe(true);
    expect(leadNamesPerformer("Glass Orchard (film)", "Glass Orchard is a 2020 documentary film about the band Glass Orchard.", "Glass Orchard")).toBe(true);
  });
});
