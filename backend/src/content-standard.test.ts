jest.mock("./config", () => ({
  config: {
    factsPerSong: 5,
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    groundingTimeoutMs: 5000,
    groundingExtractTimeoutMs: 15000,
    topic: "video-game,classical,film,pop,piano,general",
  },
}));

import { isPrivateHeading, isStandardReason, sentencesOf, standardBreach, withinStandard } from "./content-standard";
import { STABLE_AGE_MS, clearGroundingCache, fetchGrounding, screenClaims, wikiExtract } from "./fact-verifier";
import { htmlToText } from "./wiki-html";

// Every person, band and song here is made up.

describe("the content standard's word lists (issue #242)", () => {
  const cases: Array<[string, string]> = [
    ["crime or lawsuits", "Mara Quillon was arrested in 1998 after a show in Dorrance."],
    ["crime or lawsuits", "The Tinfoil Lanterns sued their label over the royalties in 2004."],
    ["drugs or addiction", "During the sessions, Tobin Varr struggled with heroin addiction."],
    ["sexual content", "A tabloid wrote about Lisette Moraine's sexual relationship with her manager."],
    ["private life", "Dax Holloway divorced his wife in 2003, a year after the album came out."],
    ["private life", "Petra Lunde wrote it for her daughter, who was born that spring."],
    ["health", "Ines Calloway was diagnosed with cancer during the tour."],
    ["how someone died", "Ronan Vey died in a car crash in 2004."],
    ["how someone died", "Ronan Vey died after a fall from a stage in 2004."],
  ];

  it.each(cases)("leaves out a sentence about %s", (label, sentence) => {
    const lead = "Glass Orchard is a 1999 song by Mara Quillon. It was recorded in two days at a church in Vellmar.";
    const kept = withinStandard(`${lead} ${sentence} The strings were added later.`, "Glass Orchard");
    expect(kept.text).not.toContain(sentence);
    expect(kept.text).toContain("It was recorded in two days at a church in Vellmar.");
    expect(kept.text).toContain("The strings were added later.");
    expect(kept.dropped).toBe(1);
    expect(standardBreach(sentence)).toBe(`content standard: ${label}`);
  });

  it("keeps a plain death year", () => {
    const sentence = "Ronan Vey died in 2004, two years after the record came out.";
    expect(standardBreach(sentence)).toBeNull();
    expect(withinStandard(`Ronan Vey was a fiddler. ${sentence}`).text).toContain(sentence);
  });

  it("keeps how the music was made when it names a spouse, a funeral march, lines that came out long or a score divorced from its film", () => {
    expect(standardBreach("Ivo Marsh set the poem to music with his wife Lena and the singer Ada Penn.")).toBeNull();
    expect(standardBreach("The bridge borrows from funeral-march jazz.")).toBeNull();
    expect(standardBreach("Some translated lines came out as longer than the originals.")).toBeNull();
    expect(standardBreach("Divorced from the film, the score is still a fine listen.")).toBeNull();
    expect(standardBreach("The band's name caused a controversy when a mayor kept it off a New Year's Eve bill.")).toBeNull();
    expect(standardBreach("In 1969, after separating from his wife, Ivo Marsh moved to Dorrance.")).not.toBeNull();
  });

  it("matches whole words in any case, not parts of words", () => {
    expect(standardBreach("THE SINGER WAS ARRESTED IN 1998.")).not.toBeNull();
    expect(standardBreach("The druggist's daughter-in-law hummed it.")).toBeNull();
    expect(standardBreach("A manuscript dating from 1805 survives in Vellmar.")).toBeNull();
    expect(standardBreach("The second movement is a sober, slow march.")).not.toBeNull();
  });

  it("reads a listed word inside a name or a title as the name", () => {
    // A band, a game's level and a quoted song title.
    expect(standardBreach("The Crime Lords recorded it in two days.")).toBeNull();
    expect(standardBreach("The theme plays in the Fatal Harbor stage.")).toBeNull();
    expect(standardBreach('Her cover of "Heroin" opened the set.')).toBeNull();
    // The song's own title, even where it opens a sentence.
    expect(standardBreach("Velvet Felony was recorded in 1991.", ["Velvet Felony"])).toBeNull();
    expect(withinStandard("Velvet Felony is a 1991 song by the Marlowe Sisters.", "Velvet Felony (song)").dropped).toBe(0);
    // An all-capitals word is the word itself.
    expect(standardBreach("The lyrics were said to be about LSD.")).not.toBeNull();
  });

  it("leaves out private sections whole, with their subsections, and keeps the music", () => {
    const full = [
      "Marten Oaks is a singer and guitarist. Her debut album came out in 2001.",
      "",
      "== Career ==",
      "Oaks recorded the album in a barn in four weeks.",
      "",
      "== Personal life ==",
      "Oaks lives on a farm with two dogs.",
      "=== Home ===",
      "She restored the farmhouse herself.",
      "",
      "== Death and legacy ==",
      "Oaks died in 2019.",
      "",
      "== Death Mountain ==",
      "The cave theme was written for a harp.",
      "",
      "== Legal issues ==",
      "A former drummer claimed unpaid wages.",
      "",
      "== Discography ==",
      "Glass Orchard (2001)",
    ].join("\n");
    const kept = withinStandard(full, "Marten Oaks");
    expect(kept.sections).toBe(3);
    expect(kept.text).not.toMatch(/Personal life|dogs|farmhouse|Death and legacy|died in 2019|Legal issues|unpaid wages/);
    expect(kept.text).toContain("== Career ==\nOaks recorded the album in a barn in four weeks.");
    expect(kept.text).toContain("== Death Mountain ==\nThe cave theme was written for a harp.");
    expect(kept.text).toContain("== Discography ==\nGlass Orchard (2001)");
    expect(kept.sentences).toBe(9);
    expect(kept.dropped).toBe(4);
  });

  it("knows a private heading from a song's, a place's, gameplay's or a career period's", () => {
    for (const h of ["Personal life", "Family", "Legal issues", "Controversies", "Health", "Health problems", "Health and death", "Illness and death", "Death", "Arrest and trial", "Lawsuit"]) {
      expect(isPrivateHeading(h)).toBe(true);
    }
    for (const h of ["Recording", "Death Mountain", "Composition and lyrics", "Personnel", "Velvet Felony", "Health, lives, and power-ups", "2011–2018: Second album, tour and legal troubles"]) {
      expect(isPrivateHeading(h)).toBe(false);
    }
  });

  it("splits sentences without breaking at a capital and a period", () => {
    expect(sentencesOf("J. S. Mora wrote it. It was recorded in Vellmar.")).toEqual(["J. S. Mora wrote it.", "It was recorded in Vellmar."]);
  });
});

describe("captions under the content standard (issue #242)", () => {
  const context = "Glass Orchard\nGlass Orchard is a 1999 song by Mara Quillon. It was recorded in two days at a church in Vellmar. Quillon was charged with assault in 1998, but the charges were dropped.";

  it('drops "charged" retold as "convicted", whatever the reference says', () => {
    const { kept, rejected } = screenClaims(["Mara Quillon was convicted of assault in 1998.", "Glass Orchard was recorded in two days at a church in Vellmar."], context);
    expect(kept).toEqual(["Glass Orchard was recorded in two days at a church in Vellmar."]);
    expect(rejected).toEqual([{ text: "Mara Quillon was convicted of assault in 1998.", reason: "content standard: crime or lawsuits" }]);
    expect(isStandardReason(rejected[0].reason)).toBe(true);
  });

  it("drops a caption that adds a private detail its source never gave", () => {
    const { kept, rejected } = screenClaims(["Mara Quillon recorded it while pregnant with her daughter."], context);
    expect(kept).toEqual([]);
    expect(rejected[0].reason).toBe("content standard: private life");
  });

  it("reads the artist's name as a name", () => {
    const { kept } = screenClaims(["Sober Harbor recorded it in two days at a church in Vellmar."], "Sober Harbor\nSober Harbor is a band. Sober Harbor recorded it in two days at a church in Vellmar.", { artists: ["Sober Harbor"] });
    expect(kept).toHaveLength(1);
  });
});

describe("only article versions at least 72 hours old (issue #242)", () => {
  const OLD = "Glass Orchard is a 1999 song by Mara Quillon. It was recorded in two days at a church in Vellmar.";
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  let latest: { extract: string; timestamp?: string };
  let older: { revid?: number; html?: string; status?: number };
  const asked: URLSearchParams[] = [];
  const defaultFetch = async (url: string) => {
    const p = new URL(url).searchParams;
    asked.push(p);
    let body: unknown;
    if (p.get("action") === "parse") {
      if (older.status) return { ok: false, status: older.status, json: async () => ({}) } as Response;
      body = { parse: { text: older.html } };
    } else if (p.get("prop") === "revisions") {
      body = { query: { pages: { 1: older.revid ? { revisions: [{ revid: older.revid, timestamp: ago(4 * 24 * 3600e3) }] } : {} } } };
    } else {
      body = { query: { pages: { 1: { extract: latest.extract, ...(latest.timestamp ? { revisions: [{ timestamp: latest.timestamp }] } : {}) } } } };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  };
  const fetchMock = jest.fn(defaultFetch);

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  beforeEach(() => {
    asked.length = 0;
    older = {};
  });

  it("reads the newest version when it is older than 72 hours, in one request", async () => {
    latest = { extract: OLD, timestamp: ago(STABLE_AGE_MS + 60_000) };
    expect(await wikiExtract("Glass Orchard")).toBe(OLD);
    expect(asked).toHaveLength(1);
    expect(asked[0].get("prop")).toBe("extracts|revisions");
  });

  it("reads the version from before a fresh edit, never the edit", async () => {
    latest = { extract: `${OLD} Mara Quillon is the greatest liar alive.`, timestamp: ago(3600e3) };
    older = { revid: 4242, html: `<div class="mw-parser-output"><p>${OLD}<sup class="reference">[1]</sup></p><div class="mw-heading mw-heading2"><h2 id="Recording">Recording</h2></div><p>The strings were added later.</p></div>` };
    const text = await wikiExtract("Glass Orchard");
    expect(text).toBe(`${OLD}\n\n\n== Recording ==\nThe strings were added later.`);
    const revisions = asked[1];
    expect(revisions.get("rvdir")).toBe("older");
    expect(revisions.get("rvlimit")).toBe("1");
    const start = Date.parse(revisions.get("rvstart") ?? "");
    expect(Math.abs(Date.now() - STABLE_AGE_MS - start)).toBeLessThan(60_000);
    expect(asked[2].get("oldid")).toBe("4242");
  });

  it("remembers an older version it has read", async () => {
    latest = { extract: OLD, timestamp: ago(60_000) };
    older = { revid: 4343, html: `<p>${OLD}</p>` };
    await wikiExtract("Glass Orchard");
    asked.length = 0;
    expect(await wikiExtract("Glass Orchard")).toBe(OLD);
    expect(asked.map((p) => p.get("action"))).toEqual(["query", "query"]);
  });

  it("counts a version with no date as fresh", async () => {
    latest = { extract: `${OLD} Fresh words.` };
    older = { revid: 4444, html: `<p>${OLD}</p>` };
    expect(await wikiExtract("Glass Orchard")).toBe(OLD);
  });

  it("skips an article that is younger than 72 hours", async () => {
    latest = { extract: OLD, timestamp: ago(3600e3) };
    expect(await wikiExtract("Glass Orchard")).toBeNull();
  });

  it("skips Wikipedia for the song when the older version can't be read", async () => {
    latest = { extract: OLD, timestamp: ago(3600e3) };
    older = { revid: 4545, status: 500 };
    await expect(wikiExtract("Glass Orchard")).rejects.toThrow();
  });

  it("skips Wikipedia for the whole song, not just that article, when an older version can't be read", async () => {
    const LONG = " The strings were recorded in one take in a church in Vellmar.".repeat(12);
    const articles: Record<string, { extract: string; timestamp: string }> = {
      "Glass Orchard": { extract: OLD + LONG, timestamp: ago(3600e3) },
      "Mara Quillon": { extract: `Mara Quillon is a singer and songwriter.${LONG}`, timestamp: ago(30 * 24 * 3600e3) },
    };
    const hits: Record<string, string[]> = { "Glass Orchard Mara Quillon": ["Glass Orchard"], "Glass Orchard": ["Glass Orchard"], "Mara Quillon": ["Mara Quillon"] };
    fetchMock.mockImplementation(async (url: string) => {
      const p = new URL(url).searchParams;
      asked.push(p);
      const term = p.get("srsearch");
      let body: unknown = { query: { search: [], pages: {} } };
      if (term !== null) body = { query: { search: (hits[term] ?? []).map((title) => ({ title })) } };
      else if (p.get("action") === "parse") return { ok: false, status: 500, json: async () => ({}) } as Response;
      else if (p.get("prop") === "revisions") body = { query: { pages: { 1: { revisions: [{ revid: 4747, timestamp: ago(4 * 24 * 3600e3) }] } } } };
      else if (p.get("prop") === "extracts|revisions") {
        const a = articles[p.get("titles") ?? ""];
        body = { query: { pages: { 1: a ? { extract: a.extract, revisions: [{ timestamp: a.timestamp }] } : {} } } };
      }
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    try {
      expect(await fetchGrounding({ title: "Glass Orchard", artist: "Mara Quillon" })).toBe("");
      // The artist's article was found and fits, but isn't used this time.
      expect(asked.some((p) => p.get("titles") === "Mara Quillon")).toBe(true);
    } finally {
      fetchMock.mockImplementation(defaultFetch);
      clearGroundingCache();
    }
  });

  it("applies the content standard to the older version too", async () => {
    latest = { extract: `${OLD} Fresh words.`, timestamp: ago(3600e3) };
    older = { revid: 4646, html: `<p>${OLD} Mara Quillon was arrested in 1998.</p><h2>Personal life</h2><p>Quillon keeps bees.</p>` };
    expect(await wikiExtract("Glass Orchard")).toBe(OLD);
  });
});

describe("an older version's HTML as plain text", () => {
  it("keeps headings and paragraphs, and leaves out references, tables, styles and notes", () => {
    const html = [
      '<div class="mw-content-ltr mw-parser-output" lang="en">',
      '<div class="shortdescription nomobile">1999 song</div><style>.x{color:red}</style>',
      '<table class="infobox"><tr><td>Released <b>1999</b></td></tr></table>',
      "<p><b>Glass Orchard</b> is a song by Mara&nbsp;Quillon &amp; the Lanterns.<sup>[1]</sup></p>",
      "<!-- a comment <p>not text</p> -->",
      '<div class="mw-heading mw-heading3"><h3 id="Strings">Strings &#8211; and <i>brass</i></h3></div>',
      "<ul><li>Strings</li><li>Brass</li></ul>",
      '<div class="reflist"><div><ol class="references"><li>A source</li></ol></div></div>',
      "<p>&lt;b&gt; stays text, and &amp;lt; stays &amp;lt;.</p>",
      "</div>",
    ].join("");
    expect(htmlToText(html)).toBe(
      "Glass Orchard is a song by Mara Quillon & the Lanterns.\n\n\n=== Strings – and brass ===\nStrings\nBrass\n<b> stays text, and &lt; stays &lt;."
    );
  });
});
