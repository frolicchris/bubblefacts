jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { isCleanSentence, keepsAttribution, sectionExtract, tieredExtract, tieredSelection } from "./fact-verifier";

// Made-up song, band and people.
const SONG = [
  `"Paper Lanterns" is a song by the band Quiet Harbor, released in 2011 as the lead single from their album Low Tide. It was written by Mara Velde and Tobin Ashworth.`,
  "",
  "== Composition ==",
  `"Paper Lanterns" is in the key of D major and runs at 92 beats per minute. The bridge uses a borrowed chord from the minor key.`,
  `Velde said that the song "was about the night the power went out in our town" and that it took one evening to write.`,
  "",
  "== Release ==",
  "The single was released on 4 March 2011 in the United Kingdom. It came out a week later in other countries on the band's own label.",
  "",
  "== Charts ==",
  "The song peaked at number 12 on the national singles chart.",
  "",
  "== References ==",
].join("\n");

describe("tiered source selection", () => {
  test("tells clean sentences from long, quoted or reported ones", () => {
    expect(isCleanSentence("The song peaked at number 12 on the national singles chart.")).toBe(true);
    // A quoted title is fine.
    expect(isCleanSentence(`"Paper Lanterns" is in the key of D major.`)).toBe(true);
    expect(isCleanSentence(`The band played "the long version of the song" every night.`)).toBe(false);
    expect(isCleanSentence("Velde told a reporter the song came quickly.")).toBe(false);
    expect(isCleanSentence(`According to Ashworth, the chorus came first.`)).toBe(false);
    expect(isCleanSentence(Array(30).fill("word").join(" ") + ".")).toBe(false);
  });

  test("offers the lead, then paragraph openers, then other clean sentences; the rest only when short", () => {
    const text = tieredExtract(SONG, 3000, ["Paper Lanterns"]);
    const at = (s: string) => text.indexOf(s);
    expect(at(`"Paper Lanterns" is a song by the band Quiet Harbor`)).toBe(0);
    // Paragraph openers before the sentences that follow them.
    expect(at("The single was released on 4 March 2011")).toBeLessThan(at("The bridge uses a borrowed chord"));
    expect(at("The song peaked at number 12")).toBeLessThan(at("It came out a week later"));
    // Only 7 clean sentences: the reported one is offered too, last.
    expect(at("Velde said that the song")).toBeGreaterThan(at("It came out a week later"));
  });

  test("leaves out unclean body sentences when the clean ones are enough", () => {
    const more = SONG.replace("== References ==", ["== Live performances ==", "The band played the song at every show of its 2012 tour.", "A live version was released on a 2013 concert album.", "", "== References =="].join("\n"));
    const text = tieredExtract(more, 3000, ["Paper Lanterns"]);
    expect(text).toContain("A live version was released");
    expect(text).not.toContain("Velde said");
  });

  test("is what section-aware selection gives the writer, unless turned off", () => {
    expect(sectionExtract(SONG, 3000, ["Paper Lanterns"])).toBe(tieredExtract(SONG, 3000, ["Paper Lanterns"]));
    tieredSelection.on = false;
    try {
      expect(sectionExtract(SONG, 3000, ["Paper Lanterns"]).indexOf("Velde said")).toBeLessThan(sectionExtract(SONG, 3000, ["Paper Lanterns"]).indexOf("The single was released"));
    } finally {
      tieredSelection.on = true;
    }
  });

  test("a caption from a reported sentence offered last must keep who said it and that it was said", () => {
    const context = `Paper Lanterns\n${tieredExtract(SONG, 3000, ["Paper Lanterns"])}`;
    expect(keepsAttribution(`Velde said the song was about the night the power went out in her town.`, context)).toBe(true);
    expect(keepsAttribution(`The song was about the night the power went out in the town.`, context)).toBe(false);
    expect(keepsAttribution(`Velde wrote the song about the night the power went out in one evening.`, context)).toBe(true);
    expect(keepsAttribution(`Mara Velde: the song took one evening, about the night the power went out.`, context)).toBe(false);
    // Captions from clean sentences are never touched.
    expect(keepsAttribution("The song peaked at number 12 on the national singles chart.", context)).toBe(true);
  });
});
