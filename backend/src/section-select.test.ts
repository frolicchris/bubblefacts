jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { composerNames, gameTrackText, isChartFact, receptionFilter, sectionExtract, sectionSelection, selectSections } from "./fact-verifier";

// Made-up song, people and game.
const SONG = [
  `"Paper Lanterns" is a song by the band Quiet Harbor, released in 2011 as the lead single from their album Low Tide. It was written by Mara Velde and Tobin Ashworth.`,
  "",
  "== Background ==",
  "Velde grew up in a small fishing town and moved to the city at nineteen. She later said the move shaped everything she wrote.",
  `Velde wrote "Paper Lanterns" on a borrowed piano in one night.`,
  `The band first played "Paper Lanterns" live at a festival in 2010.`,
  "Ashworth composed the bridge melody after a long tour of coastal towns.",
  "",
  "== Composition ==",
  `"Paper Lanterns" is in the key of D major and runs at 92 beats per minute.`,
  "",
  "== Release history ==",
  "The single was released on 4 March 2011 in the United Kingdom and a week later elsewhere.",
  "",
  "== Critical reception ==",
  "A reviewer for an imaginary weekly called the chorus the band's best yet.",
  "",
  "== Charts ==",
  "The song peaked at number 12 on the national singles chart.",
  "Chart (2011)",
  "",
  "== References ==",
  "Some citation text that is long enough to look like a sentence.",
].join("\n");

const GAME = [
  "Starlit Voyage is a 2004 role-playing video game developed by Moonbeam Works. Its music was composed by Ilka Frost.",
  "",
  "== Gameplay ==",
  "The player sails between islands and trades goods with the people who live on them.",
  `The theme "Harbor Lights" plays whenever the ship docks at a port town.`,
  "",
  "== Development ==",
  "Development began in 2001 with a team of twelve people working out of a small office.",
  "Frost wrote the soundtrack over six months using only a synthesizer and a flute.",
  "",
  "=== Music ===",
  "The score mixes folk instruments with electronic drums throughout the game.",
  "",
  "=== Art direction ===",
  "The art team drew every island by hand before it was modeled for the game.",
  "",
  "== Plot ==",
  "A young sailor named Rin searches for her missing brother across the sea.",
  "",
  "== Reception ==",
  "Starlit Voyage sold 400,000 copies in its first year and won a regional design award.",
].join("\n");

describe("section-aware selection", () => {
  it("puts the lead first, then checkable sections, then the rest", () => {
    const parts = selectSections(SONG, ["Paper Lanterns"]);
    // "Critical reception" has only a reviewer's verdict, so nothing of it is kept.
    expect(parts.map((p) => p.heading)).toEqual(["", "Composition", "Release history", "Charts", "Background"]);
  });

  it("keeps a narrative sentence only when it names the song or its composer and is about music", () => {
    const background = selectSections(SONG, ["Paper Lanterns"]).find((p) => p.heading === "Background")!.sentences;
    // Names the song but says nothing musical: "wrote" and "played live" aren't music words here.
    expect(background).not.toContain(`Velde wrote "Paper Lanterns" on a borrowed piano in one night.`);
    // Names a writer from the lead ("written by ... Tobin Ashworth") and a melody.
    expect(background).toEqual(["Ashworth composed the bridge melody after a long tour of coastal towns."]);
  });

  it("drops list rows and reference sections", () => {
    const all = selectSections(SONG, ["Paper Lanterns"]).flatMap((p) => p.sentences);
    expect(all).not.toContain("Chart (2011)");
    expect(all.some((s) => s.startsWith("Some citation"))).toBe(false);
  });

  it("lets a subsection's own heading decide, and otherwise follows its section", () => {
    const parts = selectSections(GAME, ["Harbor Lights"]);
    expect(parts.map((p) => p.heading)).toEqual(["", "Music", "Reception", "Gameplay", "Development"]);
    // "Art direction" sits under Development and has no telling heading of its own: left out with it.
    expect(parts.some((p) => p.heading === "Art direction")).toBe(false);
    expect(parts.find((p) => p.heading === "Development")!.sentences).toEqual(["Frost wrote the soundtrack over six months using only a synthesizer and a flute."]);
    expect(parts.find((p) => p.heading === "Gameplay")!.sentences).toEqual([`The theme "Harbor Lights" plays whenever the ship docks at a port town.`]);
    expect(parts.some((p) => p.heading === "Plot")).toBe(false);
  });

  it("reads composers from the article", () => {
    expect(composerNames(GAME)).toEqual(["ilka frost", "frost"]);
    expect(composerNames("The score was composed by Ann Example, Bo Sample and Cy Person.")).toEqual([
      "ann example",
      "example",
      "bo sample",
      "sample",
      "cy person",
      "person",
    ]);
  });

  it("keeps to the budget in whole sentences and labels each section", () => {
    const text = sectionExtract(SONG, 330, ["Paper Lanterns"]);
    expect(text.length).toBeLessThanOrEqual(330);
    expect(text.split("\n\n")[1]).toBe(`Composition: "Paper Lanterns" is in the key of D major and runs at 92 beats per minute.`);
    expect(text).not.toContain("Release history");
  });

  it("gives nothing, so the usual ordering is used, when fewer than 2 usable sentences are kept", () => {
    const stub = "Rocket Song is a 1999 song by Ann Example.\n\n== Background ==\nExample grew up by the sea and later moved inland for work.";
    expect(sectionExtract(stub, 3000, ["Rocket Song"])).toBe("");
  });

  it("builds a game track's reference from the selection, and the usual way when switched off", () => {
    const articles = { page: "Starlit Voyage", full: GAME, music: null };
    const on = gameTrackText(articles, "Harbor Lights");
    expect(on.startsWith(`Starlit Voyage\nAbout this piece: The theme "Harbor Lights"`)).toBe(true);
    expect(on).toContain("\n\nStarlit Voyage is a 2004 role-playing video game");
    expect(on).not.toContain("Rin searches");
    expect(on).not.toContain("team of twelve");
    sectionSelection.on = false;
    try {
      expect(gameTrackText(articles, "Harbor Lights")).toContain("team of twelve");
    } finally {
      sectionSelection.on = true;
    }
  });

  describe("verdict sections", () => {
    // Made-up song, band, critics and publications.
    const VERDICTS = [
      `"Copper Kite" is a song by the band Low Meridian, released in 1984 as a single from their album Northbound.`,
      "",
      "== Release ==",
      "The single was released in May 1984 with a live version of another song on the B-side.",
      `An imaginary trade weekly described the song as "a breezy little gem".`,
      "",
      "== Reception ==",
      "Critic Ada Fenwick wrote that the chorus was the band's finest moment.",
      "The single peaked at number 7 on the national chart and sold 250,000 copies.",
      "",
      "=== Commercial performance ===",
      "It spent eleven weeks on the chart, the band's longest run at the time.",
      "",
      "=== Year-end lists ===",
      "An imaginary monthly ranked it the 4th best single of 1984.",
      "",
      "== Accolades ==",
      "The song won the Silver Reel Award for Best Rock Single in 1985.",
      "A later poll listed it among the greatest singles of the decade.",
      "",
      "== Legacy ==",
      "The song has been covered by more than twenty artists since its release.",
      "It is widely regarded as one of the best songs of its era.",
    ].join("\n");
    const kept = () => selectSections(VERDICTS, ["Copper Kite"]).flatMap((p) => p.sentences);

    it("keeps only chart, sales and certification numbers from reception", () => {
      expect(kept()).toContain("The single peaked at number 7 on the national chart and sold 250,000 copies.");
      expect(kept().some((s) => s.startsWith("Critic Ada Fenwick"))).toBe(false);
      // A subsection with its own telling heading keeps everything; one under Reception follows it.
      expect(kept()).toContain("It spent eleven weeks on the chart, the band's longest run at the time.");
      expect(kept().some((s) => s.includes("4th best single"))).toBe(false);
    });

    it("drops opinions from release, accolades and legacy, and keeps their facts", () => {
      expect(kept()).toContain("The single was released in May 1984 with a live version of another song on the B-side.");
      expect(kept().some((s) => s.includes("breezy little gem"))).toBe(false);
      expect(kept()).toContain("The song won the Silver Reel Award for Best Rock Single in 1985.");
      expect(kept().some((s) => s.includes("greatest singles"))).toBe(false);
      expect(kept()).toContain("The song has been covered by more than twenty artists since its release.");
      expect(kept().some((s) => s.includes("widely regarded"))).toBe(false);
    });

    it("tells chart facts from a critic's list", () => {
      expect(isChartFact("It was certified platinum in three countries.")).toBe(true);
      expect(isChartFact("The album reached number one in Japan.")).toBe(true);
      expect(isChartFact("The magazine ranked it number 3 on its list of the best songs.")).toBe(false);
      expect(isChartFact("Reviewers called the chart-topping band's song a triumph.")).toBe(false);
    });

    it("falls back to the usual ordering when reception was all there was", () => {
      const thin = [
        "Glass Bell is a 1979 song by Ann Example.",
        "",
        "== Reception ==",
        "A reviewer called it the best song Example ever recorded.",
        "Another critic praised its arrangement and its restraint.",
      ].join("\n");
      expect(sectionExtract(thin, 3000, ["Glass Bell"])).toBe("");
    });

    it("keeps everything when switched off", () => {
      receptionFilter.on = false;
      try {
        expect(kept().some((s) => s.startsWith("Critic Ada Fenwick"))).toBe(true);
      } finally {
        receptionFilter.on = true;
      }
    });
  });
});
