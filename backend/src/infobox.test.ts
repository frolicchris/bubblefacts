jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { alreadySaid, earliestYear, factsFromInfobox, items, parseInfobox, valuesIn } from "./infobox";

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
      '"Paper Lantern" is usually filed under dream pop.',
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

  it("names the subject from the page, and says when more names are left out", () => {
    expect(texts("Star Orchard Red and Blue", `{{Infobox video game\n| title = Star Orchard Red\n| developer = Pinecone Works\n}}`)).toEqual(["Star Orchard Red and Blue was developed by Pinecone Works."]);
    expect(texts("Glass Bird (Ola Brandt song)", `{{Infobox song\n| producer = Ann Vale, Bo Lund, Kit Marsh, Lee Park\n}}`)).toEqual(['"Glass Bird" was produced by Ann Vale, Bo Lund, Kit Marsh and others.']);
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
