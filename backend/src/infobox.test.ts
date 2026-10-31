jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { alreadySaid, boxBacksPlace, boxBacksYear, boxMisfit, PLATFORM_TAG, boxProducers, boxWriters, earliestYear, factsFromInfobox, infoboxFacts, items, parseInfobox, sameCredits, valuesIn } from "./infobox";

const texts = (page: string, wikitext: string) => {
  const box = parseInfobox(wikitext);
  return box ? factsFromInfobox(page, box).map((f) => f.text) : [];
};

describe("parseInfobox", () => {
  it("reads the first infobox's fields past nested templates, links and comments", () => {
    const box = parseInfobox(`{{Short description|x}}\n{{Infobox song\n| name = Paper Lantern <!-- note -->\n| writer = {{hlist|[[Jane Doe]]|Sam Roe}}\n| released = {{Start date|2011|3|4}}\n}}\nText.`);
    expect(box?.type).toBe("song");
    expect(box?.fields.name).toBe("Paper Lantern");
    expect(items(box?.fields.writer ?? "")).toEqual(["Jane Doe", "Sam Roe"]);
  });

  it("returns null without an infobox", () => {
    expect(parseInfobox("Just prose.")).toBeNull();
  });
});

describe("items", () => {
  it("drops references and splits plain lists and line breaks", () => {
    expect(items("{{plainlist|\n* [[Ann Vale|Ann]]\n* Bo Lund<ref>cite</ref>\n}}")).toEqual(["Ann", "Bo Lund"]);
    expect(items("Kit Marsh<br />Lee Park")).toEqual(["Kit Marsh", "Lee Park"]);
  });

  it("reads nothing from templates it doesn't know", () => {
    expect(items("{{Video game release|JP|1990|NA|1991}}")).toEqual([]);
  });
});

describe("earliestYear", () => {
  it("takes the first year of any release listed", () => {
    expect(earliestYear("{{Video game release|NA|August 1995|JP|March 11, 1994}}")).toBe("1994");
    expect(earliestYear("Unknown")).toBeNull();
  });
});

describe("factsFromInfobox", () => {
  it("writes a song's makers, album and year, naming the song", () => {
    expect(
      texts("Paper Lantern (Moth Choir song)", `{{Infobox song\n| name = Paper Lantern\n| writer = Jane Doe, Sam Roe\n| producer = [[Ola Brandt]]\n| album = ''[[Night Ferry]]''\n| released = May 2, 2011\n| label = Gullwing\n| genre = [[Dream pop]]\n}}`)
    ).toEqual([
      '"Paper Lantern" was written by Jane Doe and Sam Roe.',
      '"Paper Lantern" was produced by Ola Brandt.',
      '"Paper Lantern" appears on Night Ferry.',
      '"Paper Lantern" came out in 2011.',
      '"Paper Lantern" was released on Gullwing.',
      'The genres of "Paper Lantern" include dream pop.',
    ]);
  });

  it("writes a game's composers, makers, year and platforms, naming the game", () => {
    expect(
      texts("Star Orchard (video game)", `{{Infobox video game\n| title = Star Orchard\n| developer = Pinecone Works\n| publisher = Lumen Soft\n| composer = {{ubl|Mira Tal|Oren Fisk}}\n| platforms = [[Super Famicom]]\n| released = {{vgrelease|JP|April 1993|NA|1994}}\n}}`)
    ).toEqual([
      "The music of Star Orchard is by Mira Tal and Oren Fisk.",
      "Star Orchard was developed by Pinecone Works.",
      "Star Orchard first came out in 1993.",
      "Star Orchard was published by Lumen Soft.",
      "Star Orchard came out on the Super Famicom.",
    ]);
  });

  it("names the subject from the page, and every name a field lists", () => {
    expect(texts("Star Orchard Red and Blue", `{{Infobox video game\n| title = Star Orchard Red\n| developer = Pinecone Works\n}}`)).toEqual(["Star Orchard Red and Blue was developed by Pinecone Works."]);
    expect(texts("Glass Bird (Ola Brandt song)", `{{Infobox song\n| producer = Ann Vale, Bo Lund, Kit Marsh, Lee Park\n}}`)).toEqual(['"Glass Bird" was produced by Ann Vale, Bo Lund, Kit Marsh and Lee Park.']);
    expect(texts("Glass Bird (Hey Hey)", `{{Infobox song\n| producer = Ann Vale\n}}`)).toEqual(['"Glass Bird (Hey Hey)" was produced by Ann Vale.']);
  });

  it("leaves out a field whose names carry notes or roles", () => {
    const facts = texts("Star Orchard", `{{Infobox video game\n| composer = Mira Tal (arranged by Oren Fisk)\n| developer = Pinecone Works\n}}`);
    expect(facts).toEqual(["Star Orchard was developed by Pinecone Works."]);
  });

  it("names a soundtrack album's composers, but not a band's own album artist", () => {
    expect(texts("Music of Star Orchard", `{{Infobox album\n| name = Star Orchard Sound Collection\n| type = soundtrack\n| artist = Mira Tal\n| released = 1993\n}}`)).toEqual([
      "The album Star Orchard Sound Collection is by Mira Tal.",
      "The album Star Orchard Sound Collection came out in 1993.",
    ]);
    expect(texts("Night Ferry", `{{Infobox album\n| name = Night Ferry\n| type = studio\n| artist = Moth Choir\n| released = 2011\n}}`)).toEqual(["The album Night Ferry came out in 2011."]);
  });

  it("gives nothing for an artist's or a series' infobox", () => {
    expect(texts("Moth Choir", `{{Infobox musical artist\n| name = Moth Choir\n| genre = Dream pop\n}}`)).toEqual([]);
    expect(texts("Star Orchard (series)", `{{Infobox video game series\n| developer = Pinecone Works\n}}`)).toEqual([]);
  });
});

describe("alreadySaid and valuesIn", () => {
  it("tells when captions already state every value", () => {
    expect(alreadySaid(["Mira Tal"], ["Mira Tal wrote the theme in a week."])).toBe(true);
    expect(alreadySaid(["Mira Tal", "Oren Fisk"], ["Mira Tal wrote the theme."])).toBe(false);
  });

  it("finds the names and years in a fixed sentence", () => {
    expect(valuesIn('"Paper Lantern" was written by Jane Doe and Sam Roe.')).toEqual(["Jane Doe", "Sam Roe"]);
    expect(valuesIn('"Paper Lantern" came out in 2011.')).toEqual(["2011"]);
  });
});

describe("markup nested to survive one pass is stripped until none is left", () => {
  it("parseInfobox: a comment rebuilt by removing an inner one", () => {
    const box = parseInfobox(`{{Infobox song\n| writer = Mira Tal<!<!---->-- Oren Fisk -->\n| producer = Sam Roe\n}}`);
    expect(box?.fields.writer).toBe("Mira Tal");
    expect(box?.fields.producer).toBe("Sam Roe");
  });

  it("items: a reference or a tag rebuilt by removing an inner one", () => {
    expect(items("Mira Tal<re<ref>x</ref>f>note</ref>, Oren Fisk")).toEqual(["Mira Tal", "Oren Fisk"]);
    expect(items("Mira Tal<sm<small>all>, Oren Fisk")).toEqual(["Mira Tal", "Oren Fisk"]);
  });

  it("earliestYear: no year from inside a rebuilt comment", () => {
    expect(earliestYear("2004<!<!---->-- 1999 -->")).toBe("2004");
  });
});

describe("data facts only from the requested work (#256)", () => {
  const about = (page: string, wikitext: string) => {
    const box = parseInfobox(wikitext);
    const subject = box ? factsFromInfobox(page, box)[0]?.about : undefined;
    if (!subject) throw new Error(`no facts from ${page}`);
    return subject;
  };
  const game = (page: string) => about(page, `{{Infobox video game\n| developer = Pinecone Works\n}}`);

  it("takes nothing from a remake's article for the original game", () => {
    const request = { game: "Star Orchard: Origins", titles: ["Lantern Theme"] };
    expect(boxMisfit(game("Star Orchard: Reforged"), request)).toMatch(/Star Orchard: Reforged/);
    expect(boxMisfit(game("Star Orchard: Origins"), request)).toBe("");
    expect(boxMisfit(game("Star Orchard: Origins Remastered"), request)).not.toBe("");
  });

  it("accepts the game's full name when the request shortens it", () => {
    expect(boxMisfit(game("The Legend of Star Orchard"), { game: "Star Orchard", titles: ["Lantern Theme"] })).toBe("");
    expect(boxMisfit(game("Star Orchard Red and Blue"), { game: "Star Orchard Red & Blue", titles: ["Lantern Theme"] })).toBe("");
  });

  it("takes nothing from a game's article when the artist field is a band of that name", () => {
    const request = { game: "Glass Comet", titles: ["Midnight Static"] };
    expect(boxMisfit(game("Glass Comet (video game)"), request)).toBe("");
    expect(boxMisfit(game("Glass Comet (video game)"), request, true)).toMatch(/performer/);
  });

  it("takes nothing from another album's infobox in a series' music article", () => {
    const box = (name: string, artist: string) =>
      about("Music of the Star Orchard series", `{{Infobox album\n| name = ${name}\n| type = soundtrack\n| artist = ${artist}\n| released = 1996\n}}`);
    const request = { game: "Star Orchard 2", titles: ["Lantern Theme"] };
    expect(boxMisfit(box("Moon Garden Sound Collection", "Various artists"), request)).toMatch(/Moon Garden/);
    expect(boxMisfit(box("Star Orchard 2 Original Soundtrack", "Various artists"), request)).toBe("");
    expect(boxMisfit(box("Night Ferry", "Moth Choir"), { game: "Moth Choir", titles: ["Paper Lantern"] })).toBe("");
  });

  it("takes nothing from a film's soundtrack album for a game's track of the same name", () => {
    const film = about("Glass Comet (soundtrack)", `{{Infobox album\n| name = Glass Comet: Original Motion Picture Soundtrack\n| type = soundtrack\n| artist = Ada Penn\n| released = 1987\n}}`);
    expect(boxMisfit(film, { game: "Glass Comet", titles: ["Title"], gameTrack: true })).toMatch(/film's or a show's soundtrack/);
    expect(boxMisfit(film, { game: "Glass Comet", titles: ["Title"] })).toBe("");
    expect(PLATFORM_TAG.test("Glass Comet (GB)")).toBe(true);
    expect(PLATFORM_TAG.test("Glass Comet (Live)")).toBe(false);
  });

  it("takes nothing from a song's infobox under another title", () => {
    const song = (page: string) => about(page, `{{Infobox song\n| writer = Jane Doe\n}}`);
    expect(boxMisfit(song("Paper Lanterns (Moth Choir song)"), { game: "Moth Choir", titles: ["Paper Lantern (1999)"] })).not.toBe("");
    expect(boxMisfit(song("Paper Lantern (Moth Choir song)"), { game: "Moth Choir", titles: ["Paper Lantern (1999)"] })).toBe("");
    expect(boxMisfit(song("Don't Wait (Moth Choir song)"), { game: "Moth Choir", titles: ["Dont Wait"] })).toBe("");
  });

  it("gives no song year after its album's: that is the single's", async () => {
    const pages: Record<string, string> = {
      "Paper Lantern (Moth Choir song)": "{{Infobox song\n| album = ''[[Night Ferry]]''\n| released = 1987\n| producer = Ola Brandt\n}}",
      "Night Ferry": "{{Infobox album\n| artist = Moth Choir\n| released = {{Start date|1986|11|15}}\n}}",
      "Glass Bird (Moth Choir song)": "{{Infobox song\n| album = [[Night Ferry]]\n| released = 1986\n}}",
    };
    const real = global.fetch;
    global.fetch = (async (url: string) => {
      const title = new URL(url).searchParams.get("titles") ?? "";
      return { ok: true, json: async () => ({ query: { pages: [{ revisions: [{ slots: { main: { content: pages[title] ?? "" } } }] }] } }) } as Response;
    }) as unknown as typeof fetch;
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const lantern = (await infoboxFacts("Paper Lantern (Moth Choir song)")).map((f) => f.text);
    const bird = (await infoboxFacts("Glass Bird (Moth Choir song)")).map((f) => f.text);
    log.mockRestore();
    global.fetch = real;
    expect(lantern).toEqual(['"Paper Lantern" was produced by Ola Brandt.', '"Paper Lantern" appears on Night Ferry.']);
    expect(bird).toContain('"Glass Bird" came out in 1986.');
  });

  it("checks a place Wikidata gives against the artist's article", () => {
    const artist = (fields: string) => parseInfobox(`{{Infobox musical artist\n${fields}\n}}`);
    expect(boxBacksPlace(artist("| origin = [[London]], England"), "Glasgow", false)).toBe(false);
    expect(boxBacksPlace(artist("| origin = [[London]], England"), "London", false)).toBe(true);
    expect(boxBacksPlace(artist("| birth_place = [[Belleville, Ontario]], Canada"), "Belleville", true)).toBe(true);
    expect(boxBacksPlace(artist("| birth_place = [[Harborview]], Canada"), "Belleville", true)).toBe(false);
    expect(boxBacksPlace(artist("| genre = Rock"), "Glasgow", false)).toBe(true);
  });

  it("checks a formation or birth year Wikidata gives against the artist's article", () => {
    const artist = (fields: string) => parseInfobox(`{{Infobox musical artist\n${fields}\n}}`);
    expect(boxBacksYear(artist("| years_active = 1997–present"), "1998", false)).toBe(false);
    expect(boxBacksYear(artist("| years_active = 1998–present"), "1998", false)).toBe(true);
    expect(boxBacksYear(artist("| birth_date = {{birth date and age|1984|9|27}}"), "1984", true)).toBe(true);
    expect(boxBacksYear(artist("| birth_date = {{birth date and age|1983|9|27}}"), "1984", true)).toBe(false);
    expect(boxBacksYear(artist("| genre = Rock"), "1998", false)).toBe(true);
  });

  it("lists every genre the infobox gives, as genres it includes", () => {
    expect(texts("Paper Lantern (Moth Choir song)", `{{Infobox song\n| genre = {{hlist|[[Dream pop]]|[[Shoegaze]]|[[Disco]]}}\n}}`)).toEqual([
      'The genres of "Paper Lantern" include dream pop, shoegaze and disco.',
    ]);
  });

  it("reads a song's writers and producers, to check another source's credits against", () => {
    const box = (fields: string) => {
      const parsed = parseInfobox(`{{Infobox song\n${fields}\n}}`);
      if (!parsed) throw new Error("no infobox");
      return parsed;
    };
    const full = box(`| writer = Jane Doe\n| lyricist = Sam Roe\n| producer = {{hlist|Moth Choir|[[Ola Brandt]]}}`);
    expect(boxWriters(full)).toEqual(["Jane Doe", "Sam Roe"]);
    expect(boxProducers(full)).toEqual(["Moth Choir", "Ola Brandt"]);
    expect(boxProducers(box("| producer = Ola Brandt (uncredited)"))).toBeNull();
    expect(boxProducers(box("| writer = Jane Doe"))).toEqual([]);
    expect(sameCredits(["Ola Brandt"], ["Moth Choir", "Ola Brandt"])).toBe(false);
    expect(sameCredits(["Ola Brant", "Moth Choir"], ["Moth Choir", "Ola Brandt"])).toBe(true);
  });
});
