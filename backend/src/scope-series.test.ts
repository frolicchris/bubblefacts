jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { gameTrackText, isSeriesWide, namesThisGame, normalizeTitle, repairScope, seriesScope } from "./fact-verifier";

// Made-up series, games, people and songs.
const SERIES = [
  "The music for the Star Quest video game series has been provided by a number of composers, from in-house staff to outside bands. The series is known for its music.",
  "",
  "== History ==",
  "",
  "=== Star Quest (1990) ===",
  "Producer Ana Vell asked her friend Rio Tanabe to write the score for the first game. Tanabe wrote every track on a home computer in four months.",
  "",
  "=== Star Quest 2 (1992) ===",
  "The sequel was scored by Mel Ostrova and Pim Saari, who drew on club music. Ostrova later called the sequel's soundtrack her favorite work.",
  "",
  "=== Star Quest Zero (1994) ===",
  "Star Quest Zero had two soundtracks, one for each region, by different composers.",
  "",
  "== Albums ==",
  "A box set of every Star Quest 2 track came out in 2011. A vinyl album of Star Quest music was released in 2015. The Comet Road theme from Star Quest was remixed for a concert in 2018.",
  "",
  "== References ==",
].join("\n");

describe("series-wide music articles", () => {
  test("names the game itself, not a sequel or the series", () => {
    expect(namesThisGame(normalizeTitle("Tanabe wrote the Star Quest score."), "Star Quest")).toBe(true);
    expect(namesThisGame(normalizeTitle("The Star Quest 2 score was new."), "Star Quest")).toBe(false);
    expect(namesThisGame(normalizeTitle("The Star Quest series is known for its music."), "Star Quest")).toBe(false);
  });

  test("tells a series' music article from one game's", () => {
    expect(isSeriesWide("Music of Star Quest", SERIES, "Star Quest")).toBe(true);
    expect(isSeriesWide("Music of the Star Quest series", "The music of the series ...", "Star Quest 2")).toBe(true);
    expect(isSeriesWide("Music of Star Quest 2", "The music of the video game Star Quest 2 was composed by regular series composer Mel Ostrova. It came out in 1992.", "Star Quest 2")).toBe(false);
    // A game's own article is never cut this way.
    expect(isSeriesWide("Star Quest (video game)", SERIES, "Star Quest")).toBe(false);
  });

  test("keeps the game's own section and what names it or the track, nothing about the sequels", () => {
    const text = seriesScope(SERIES, "Star Quest", "Comet Road");
    expect(text).toContain("Rio Tanabe to write the score");
    expect(text).toContain("The Comet Road theme from Star Quest was remixed");
    expect(text).toContain("A vinyl album of Star Quest music");
    expect(text).not.toMatch(/Ostrova|Saari|Zero|box set/);
    // The game's section isn't under "History" any more, so section-aware selection doesn't treat it as narrative.
    expect(text).not.toContain("== History ==");
  });

  test("with fewer than 2 sentences about the game, the lead alone", () => {
    const text = seriesScope(SERIES, "Star Quest Origins", "Lost Track");
    expect(text).toBe(SERIES.split("\n\n== History")[0]);
  });

  test("a game's track from a series article gets only that game's music", () => {
    const text = gameTrackText({ page: "Star Quest (video game)", full: "Star Quest is a 1990 video game.\n\n== Plot ==\nA pilot flies home.", music: { page: "Music of Star Quest", full: SERIES } }, "Comet Road", () => true, "Star Quest");
    expect(text.split("\n")[0]).toBe("Music of Star Quest");
    expect(text).toContain("Tanabe");
    expect(text).not.toMatch(/Ostrova|Saari/);
  });
});

const ref = (...lines: string[]) => ["Some Article", ...lines].join("\n");

describe("scope repair", () => {
  test("puts back a dropped region, after the words the source puts before it", () => {
    const context = ref(`"Paper Lanterns" sold 40,000 copies in Japan by March 2009.`);
    expect(repairScope(`"Paper Lanterns" sold 40,000 copies by March 2009.`, context)).toBe(`"Paper Lanterns" sold 40,000 copies in Japan by March 2009.`);
  });

  test("leaves a region alone when the sentence names more than one, or the caption already has one", () => {
    const two = ref("The game was released in Japan in 2005, and in Europe the following year.");
    expect(repairScope("The game was released in 2005.", two)).toBe("The game was released in 2005.");
    const one = ref("Night Harbor sold 12,000 copies in Japan in its first month.");
    expect(repairScope("Night Harbor sold 12,000 Japanese copies in its first month.", one)).toBe("Night Harbor sold 12,000 Japanese copies in its first month.");
  });

  test("leaves a region alone when the sentence also says internationally or other regions, or puts it in another clause", () => {
    const wide = ref("The games were released internationally in 1998, while a special edition was released in Japan in 1998 and in other regions in 1999.");
    expect(repairScope("The games were released internationally in 1998.", wide)).toBe("The games were released internationally in 1998.");
    const clause = ref("The album came out in 2004, and its single sold 30,000 copies in Japan.");
    expect(repairScope("The album came out in 2004.", clause)).toBe("The album came out in 2004.");
  });

  test("names the chart a peak was on", () => {
    const context = ref("The single peaked at number 3 on the Oricon weekly charts and stayed for nine weeks.");
    expect(repairScope("The single peaked at number 3 on the charts.", context)).toBe("The single peaked at number 3 on the Oricon weekly charts.");
  });

  test("puts back 'in its first week'", () => {
    const context = ref("Low Tide sold 16,000 copies in its first week, a record for the label.");
    expect(repairScope("Low Tide sold 16,000 copies, a record for the label.", context)).toBe("Low Tide sold 16,000 copies in its first week, a record for the label.");
  });

  test("says which year 'the same year' is, only when one year comes before it", () => {
    const context = ref("A jazz album of the songs was released in 2016 by Ann Example. A vinyl edition of the soundtrack was also released in the same year.");
    expect(repairScope("A vinyl edition of the soundtrack was also released in the same year.", context)).toBe("A vinyl edition of the soundtrack was also released in 2016.");
    const two = ref("Albums came out in 2015 and 2016. A vinyl edition of the soundtrack was also released in the same year.");
    expect(repairScope("A vinyl edition of the soundtrack was also released in the same year.", two)).toBe("A vinyl edition of the soundtrack was also released in the same year.");
  });

  test("names the edition a claim is about", () => {
    const context = ref("Release: The Mega Drive/Genesis version of the game was released in December 1992 in North America, and a month later in Europe.");
    expect(repairScope("The game was released in North America in December 1992.", context)).toBe("The Mega Drive/Genesis version of the game was released in North America in December 1992.");
    const song = ref(`The theme song for the Japanese version of the game, "Bright Hour", was released as a single by Example Records in 2009.`);
    expect(repairScope(`The theme song "Bright Hour" was released as a single by Example Records in 2009.`, song)).toBe(
      `The theme song for the Japanese version of the game "Bright Hour" was released as a single by Example Records in 2009.`
    );
  });

  test("leaves a caption that doesn't keep the sentence's number or words", () => {
    const context = ref("The game sold 97,000 units in Japan by the end of 2005.");
    expect(repairScope("The game sold well.", context)).toBe("The game sold well.");
    expect(repairScope("Tobin Ashworth composed the bridge melody.", context)).toBe("Tobin Ashworth composed the bridge melody.");
  });
});
