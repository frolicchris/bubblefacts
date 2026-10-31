jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { clearGroundingCache, fetchGrounding, isNonMusicWork, leadNamesPerformer, listedTracks, themeOf } from "./fact-verifier";

// Made-up bands, songs, films and games.
describe("a performer's name shared with a film or a book", () => {
  let hits: Record<string, string[]>;
  let descriptions: Record<string, string>;
  let extracts: Record<string, string>;
  // Titles that redirect, titles a plain title lookup finds, and wikitext, by page.
  let redirects: Record<string, string>;
  let existing: string[];
  let wikitexts: Record<string, string>;
  let humans: string[];
  const LONG = " It was recorded in a small studio over three weeks.".repeat(20);
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    const term = p.get("srsearch");
    const names = (p.get("titles") ?? "").split("|");
    // Wikidata: an item for each page in `humans`, a person's.
    if (new URL(url).hostname === "www.wikidata.org") {
      const human = p.get("titles") && humans.includes(p.get("titles")!);
      const body = { entities: human ? { Q1: { id: "Q1", claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q5" } } } }] } } } : {} };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    const to = (n: string) => redirects[n] ?? n;
    const redirected = names.filter((n) => redirects[n]).map((n) => ({ from: n, to: redirects[n] }));
    let body: unknown;
    if (term !== null) body = { query: { search: (hits[term] ?? []).map((title) => ({ title })) } };
    else if (p.get("rvprop") === "content") body = { query: { pages: [{ revisions: [{ slots: { main: { content: wikitexts[names[0]] ?? "" } } }] }] } };
    else if (p.get("prop") === "description")
      body = {
        query: {
          redirects: redirected,
          pages: Object.fromEntries(names.map((n, i) => [String(i), descriptions[to(n)] !== undefined ? { title: to(n), description: descriptions[to(n)] } : { title: to(n), missing: "" }])),
        },
      };
    else if (p.get("redirects"))
      body = { query: { redirects: redirected, pages: Object.fromEntries(names.map((n, i) => [String(i), existing.includes(to(n)) ? { title: to(n) } : { title: to(n), missing: "" }])) } };
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
    redirects = {};
    existing = [];
    wikitexts = {};
    humans = [];
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

  it("never searches for who commissioned or requested the song", async () => {
    descriptions = { "Glass Orchard": "English rock band", "Night Parade (song)": "1974 single by Glass Orchard" };
    const plain = await fetchGrounding({ title: "Night Parade", artist: "Glass Orchard (British)" });
    expect(plain).toMatch(/^Night Parade \(song\)\n/);
    clearGroundingCache();
    mock.mockClear();
    expect(await fetchGrounding({ title: "Night Parade (requested by Moss Tinker)", artist: "Glass Orchard (British), Commissioned by Moss Tinker" })).toBe(plain);
    expect(mock).toHaveBeenCalled();
    expect(JSON.stringify(mock.mock.calls)).not.toMatch(/Tinker/);
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
  });

  it("takes a performer's article under a longer name, which no installment check reads", async () => {
    // The search finds a philosopher. Wikipedia's "Quillon (musician)" is "Aurelio Quillon", whose
    // first sentence breaks the identity list and is left out.
    hits = { Quillon: ["Quillon"] };
    extracts = {
      Quillon: `Quillon was a French writer and philosopher of the Enlightenment.${LONG}`,
      "Aurelio Quillon": `Aurelio Quillon (born 1967) is a Cuban-American musician. Known for his style of dress, Quillon is a leading figure in dark cabaret.${LONG}`,
    };
    redirects = { "Quillon (musician)": "Aurelio Quillon" };
    descriptions = { Quillon: "French philosopher", "Aurelio Quillon": "Cuban-American musician" };
    expect(await fetchGrounding({ title: "Lantern Hymn", artist: "Quillon" })).toMatch(/^Aurelio Quillon\n/);
  });

  describe("a show's name as the artist", () => {
    const SHOW = `Starlit Harbor is a Japanese anime television series that aired from 1998 to 1999.${LONG}`;
    const MUSIC = `The Starlit Harbor anime series was accompanied by several soundtrack albums composed by Mira Okada.${LONG}`;
    const listing = (...titles: string[]) =>
      `{{Track listing\n| headline = {{nowrap|Disc 1}}\n${titles.map((t, i) => `| title${i + 1} = ${t}\n| length${i + 1} = 2:0${i}`).join("\n")}\n}}`;
    beforeEach(() => {
      hits = { "Starlit Harbor soundtrack": ["Starlit Harbor"], "Starlit Harbor": ["Starlit Harbor"] };
      extracts = { "Starlit Harbor": SHOW, "Music of Starlit Harbor": MUSIC, "Starlit Harbor (band)": `Starlit Harbor is an American indie band.${LONG}` };
      existing = ["Music of Starlit Harbor"];
      redirects = { "Starlit Harbor (soundtrack)": "Music of Starlit Harbor" };
    });

    it("takes the show's music article when one of its track listings has the track", async () => {
      wikitexts = { "Music of Starlit Harbor": listing("Harbor Lights", "'''[[Paper Kite]]'''<ref>{{cite web|title=Paper Kite notes}}</ref>") };
      expect(await fetchGrounding({ title: "Paper Kite", artist: "Starlit Harbor" })).toMatch(/^Music of Starlit Harbor\n/);
    });

    it("skips the show and its music article when neither names the track", async () => {
      wikitexts = { "Music of Starlit Harbor": listing("Harbor Lights", "Paper Kites Over Tokyo") };
      expect(await fetchGrounding({ title: "Paper Kite", artist: "Starlit Harbor" })).toBe("");
    });

    it("takes a performer's article under the name over the show's music", async () => {
      wikitexts = { "Music of Starlit Harbor": listing("Paper Kite") };
      descriptions = { "Starlit Harbor (band)": "American indie band" };
      expect(await fetchGrounding({ title: "Paper Kite", artist: "Starlit Harbor" })).toMatch(/^Starlit Harbor \(band\)\n/);
    });

    it("reads only the titles of track listings", () => {
      const text = `{{Infobox album | title1 = Not A Track }}\n${listing("[[Tide Song|Tide Song (TV edit)]]", "'''Paper Kite'''")}\n{{cite web | title2 = Not A Track Either }}`;
      expect(listedTracks(text)).toEqual(["Tide Song (TV edit)", "Paper Kite"]);
    });
  });

  describe('"Some Name Theme" when nothing else matched', () => {
    const SONG = " The song loops a short chiptune melody over a bright synth bass line.".repeat(10);
    const VIDEO = "Pixel Otter is a YouTube video uploaded in 2012, which became an Internet meme. The video set a looping song to an animated otter riding a comet.";
    beforeEach(() => {
      hits = {};
      existing = ["Pixel Otter", "Mara Quell"];
    });

    it("takes the article of what the theme is named for, cut to its lead and its music", async () => {
      extracts = { "Pixel Otter": `${VIDEO}\n\n== Origin ==\n\n=== Song ===\nThe original song was uploaded to a video site in 2011.${SONG}\n\n== Sale ==\nThe animation was later sold as a token for a large sum.` };
      const text = await fetchGrounding({ title: "Pixel Otter Theme", artist: "Chipwave" });
      expect(text).toMatch(/^Pixel Otter\n/);
      expect(text).toContain("original song was uploaded");
      expect(text).not.toContain("token");
    });

    it("refuses an article that never says its subject has music", async () => {
      extracts = { "Pixel Otter": `Pixel Otter is a YouTube video uploaded in 2012, which became an Internet meme.\n\n== Reception ==\n${LONG}` };
      expect(await fetchGrounding({ title: "Pixel Otter Theme", artist: "Chipwave" })).toBe("");
    });

    it("refuses a person's article, even one with a music section", async () => {
      extracts = { "Mara Quell": `Mara Quell is a Canadian television host. Her show opened with a theme song.\n\n== Music ==\n${SONG}` };
      humans = ["Mara Quell"];
      expect(await fetchGrounding({ title: "Mara Quell Theme", artist: "Chipwave" })).toBe("");
    });

    it("never stands in for a performer of the artist's name", async () => {
      extracts = { "Pixel Otter": `${VIDEO}\n\n== Song ==\n${SONG}` };
      descriptions = { Chipwave: "American chiptune musician" };
      expect(await fetchGrounding({ title: "Pixel Otter Theme", artist: "Chipwave" })).not.toMatch(/^Pixel Otter\n/);
    });

    it("reads the name from the title", () => {
      expect(["Pixel Otter Theme", "Pixel Otter Main Theme", "Theme from Pixel Otter", "Main Theme", "Theme", "Love Theme"].map(themeOf)).toEqual([
        "Pixel Otter", "Pixel Otter", "Pixel Otter", "", "", "",
      ]);
    });
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
