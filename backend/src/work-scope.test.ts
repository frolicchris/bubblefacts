jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import {
  isConcertFilm,
  isCoverOf,
  italicSentences,
  originalsRecord,
  otherWorkSentences,
  repairQualifier,
  requestedWork,
  sectionExtract,
  withoutSentences,
} from "./fact-verifier";

// Made-up games, albums, films, people and songs.
const WIKITEXT = [
  "{{Infobox video game|title=Comet Runner}}",
  "'''''Comet Runner''''', known in Japan as '''''Hoshi Hashiri''''', is a 1991 platform game developed by Vell Soft.<ref>{{cite web|title=x}}</ref> It was scored by Rio Tanabe.",
  "A remake, ''[[Comet Runner Zero]]'', was released in 2017 with new stages. It sold one million copies.",
  "",
  "== Development ==",
  "Tanabe wrote the score for ''Comet Runner'' on a home computer in four months. The developers studied ''[[Sky Patrol (video game)|Sky Patrol]]'' for its controls.",
  "''Comet Runner 2'' followed in 1993. It added a two-player mode.",
  "The ''Comet Runner'' series sold ten million copies. A review in ''Game Weekly'' praised the music.",
  "The remake adds a hard mode.",
].join("\n");

const FULL = [
  "Comet Runner, known in Japan as Hoshi Hashiri, is a 1991 platform game developed by Vell Soft. It was scored by Rio Tanabe.",
  "A remake, Comet Runner Zero, was released in 2017 with new stages. It sold one million copies.",
  "",
  "== Development ==",
  "Tanabe wrote the score for Comet Runner on a home computer in four months. The developers studied Sky Patrol for its controls.",
  "Comet Runner 2 followed in 1993. It added a two-player mode.",
  "The Comet Runner series sold ten million copies. A review in Game Weekly praised the music.",
  "The remake adds a hard mode.",
].join("\n");

describe("italic titles", () => {
  test("finds each sentence's italic titles, link targets and the bold-italic subject", () => {
    const s = italicSentences(WIKITEXT);
    const lead = s.find((x) => x.text.startsWith("Comet Runner, known"));
    expect(lead?.works).toEqual([
      { title: "Comet Runner", target: "", subject: true },
      { title: "Hoshi Hashiri", target: "", subject: true },
    ]);
    expect(lead?.text).toContain("is a 1991 platform game developed by Vell Soft.");
    const studied = s.find((x) => x.text.startsWith("The developers studied"));
    expect(studied?.works).toEqual([{ title: "Sky Patrol", target: "Sky Patrol (video game)", subject: false }]);
    expect(s.find((x) => x.text.startsWith("A remake"))?.works[0]).toEqual({ title: "Comet Runner Zero", target: "Comet Runner Zero", subject: false });
  });

  test("the requested work: the request's field, the page's work, the lead's bold-italic names, a long subtitle", () => {
    const names = requestedWork("Comet Runner", "Comet Runner (video game)", italicSentences(WIKITEXT));
    expect(names).toEqual(expect.arrayContaining(["comet runner", "hoshi hashiri"]));
    expect(requestedWork("Ghost Manor: Dark Hall", "Music of Ghost Manor: Dark Hall")).toEqual(expect.arrayContaining(["ghost manor dark hall", "dark hall"]));
  });

  test("leaves out a remake, a sequel and what follows them; keeps the series, unrelated titles and the work itself", () => {
    const drop = otherWorkSentences(FULL, WIKITEXT, "Comet Runner", "Comet Runner");
    expect([...drop]).toEqual([
      "A remake, Comet Runner Zero, was released in 2017 with new stages.",
      "It sold one million copies.",
      "Comet Runner 2 followed in 1993.",
      "It added a two-player mode.",
      "The remake adds a hard mode.",
    ]);
  });

  test("a request for the remake keeps the remake's sentences", () => {
    const drop = otherWorkSentences(FULL, WIKITEXT, "Comet Runner Zero", "Comet Runner");
    expect(drop.has("A remake, Comet Runner Zero, was released in 2017 with new stages.")).toBe(false);
    expect(drop.has("Comet Runner 2 followed in 1993.")).toBe(true);
  });

  test("a section headed with another work, or Sequels, is left out whole", () => {
    const full = `${FULL}\n\n== Legacy ==\n\n=== Comet Runner Zero ===\nThe game has twelve stages.\n\n== Sequels ==\nThe game was followed by two more.`;
    const drop = otherWorkSentences(full, WIKITEXT, "Comet Runner", "Comet Runner");
    expect(drop.has("The game has twelve stages.")).toBe(true);
    expect(drop.has("The game was followed by two more.")).toBe(true);
    expect(drop.has("It was scored by Rio Tanabe.")).toBe(false);
  });

  test("the reference is built without them; a sentence naming the track stays", () => {
    const drop = otherWorkSentences(FULL, WIKITEXT, "Comet Runner", "Comet Runner");
    const text = withoutSentences(drop, true, () => sectionExtract(FULL, 3000, ["Moon Base"]));
    expect(text).toContain("scored by Rio Tanabe");
    expect(text).not.toContain("Comet Runner Zero");
    const kept = withoutSentences(drop, true, () => sectionExtract(FULL, 3000, ["New Stages"]));
    expect(kept).toContain("Comet Runner Zero");
  });
});

describe("concert films", () => {
  test("a concert film or documentary, by its brackets or first sentence", () => {
    expect(isConcertFilm("Night Owls: Live", "Night Owls: Live is a 2024 concert documentary film directed by Pat Doe.")).toBe(true);
    expect(isConcertFilm("Night Owls (2019 film)", "Night Owls is a 2019 drama film.")).toBe(false);
    expect(isConcertFilm("Lantern Road (live video)", "")).toBe(true);
    expect(isConcertFilm("Night Owls (band)", "Night Owls are an English rock band.")).toBe(false);
  });
});

describe("covers", () => {
  const SONG = [
    "\"Paper Kites\" is a song by English rock band the Lamplighters, released in 1977 as the lead single from their album Harbor. It was written by Ann Vale.",
    "",
    "== Composition ==",
    "Vale wrote the song in one night after a ferry trip.",
    "",
    "== Chart performance ==",
    "The song peaked at number 2 on the UK Singles Chart.",
    "",
    "== Cover versions ==",
    "Jo Marsh recorded the song for her 2023 album Northern Lights.",
  ].join("\n");

  test("a cover: the lead never names the requested artist, or the request says cover", () => {
    expect(isCoverOf("Paper Kites (song)", SONG, "Jo Marsh", "Paper Kites")).toBe(true);
    expect(isCoverOf("Paper Kites (song)", SONG, "The Lamplighters", "Paper Kites")).toBe(false);
    expect(isCoverOf("Paper Kites (song)", SONG, "Someone Else", "Paper Kites")).toBe(false);
    expect(isCoverOf("Jo Marsh", "Jo Marsh is an English singer.", "Jo Marsh", "Paper Kites (Lamplighters cover)")).toBe(true);
  });

  test("the original's release and charts are left out, its writing kept", () => {
    const drop = originalsRecord(SONG);
    expect(drop.has("The song peaked at number 2 on the UK Singles Chart.")).toBe(true);
    expect(drop.has("Vale wrote the song in one night after a ferry trip.")).toBe(false);
    const text = withoutSentences(drop, false, () => sectionExtract(SONG, 3000, ["Paper Kites"]));
    expect(text).toContain("ferry trip");
    expect(text).not.toContain("number 2");
  });
});

describe("qualifiers", () => {
  const ref = (s: string) => `Some Page\n${s}`;
  test("puts back a number's limit", () => {
    expect(repairQualifier("The band has sold 200 million records worldwide.", ref("The band has sold over 200 million records worldwide."))).toEqual({
      text: "The band has sold over 200 million records worldwide.",
    });
    expect(repairQualifier("The game sold 40,000 copies in its first month.", ref("The game sold an estimated 40,000 copies in its first month."))).toEqual({
      text: "The game sold an estimated 40,000 copies in its first month.",
    });
  });

  test("puts back usually before the word it limits, or drops the caption", () => {
    expect(repairQualifier("The hero is armed with a lantern on each level.", ref("The hero is usually armed with a lantern on each level."))).toEqual({
      text: "The hero is usually armed with a lantern on each level.",
    });
    expect("drop" in repairQualifier("The player controls Pip to reach the goal.", ref("The player controls a character, usually the small fox Pip, to reach the goal."))).toBe(true);
    expect("drop" in repairQualifier("The band have sold 90 million records.", ref("The band are estimated to have sold 90 million records."))).toBe(true);
  });

  test("a release's region when the sentence names several", () => {
    expect(
      repairQualifier("The game was re-released on the Wii U in October 2014.", ref("The game was re-released on the Wii U in North America in October 2014 and in Europe in March 2015."))
    ).toEqual({ text: "The game was re-released on the Wii U in North America in October 2014." });
  });

  test("leaves a caption alone that keeps the limit, says it another way, or doesn't retell it", () => {
    expect(repairQualifier("Ann Vale and Bo Lind composed most of the music.", ref("The music was mostly composed by Ann Vale and Bo Lind."))).toEqual({
      text: "Ann Vale and Bo Lind composed most of the music.",
    });
    const c = "The band has sold over 200 million records worldwide.";
    expect(repairQualifier(c, ref("The band has sold over 200 million records worldwide."))).toEqual({ text: c });
    expect(repairQualifier("Vale wrote the song after a ferry trip.", ref("The song usually closes the show. Vale wrote the song after a ferry trip."))).toEqual({
      text: "Vale wrote the song after a ferry trip.",
    });
  });
});
