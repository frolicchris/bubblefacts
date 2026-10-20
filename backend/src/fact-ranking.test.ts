import { Candidate, FLOOR, MAX_BUBBLES, interest, isLeadSentence, rankFacts, sourceRisk } from "./fact-ranking";

// Made-up songs and people throughout ("Lantern Hill" by the Marmalade Owls).
const LONG_BODY =
  "Development: After the tour ended, the band spent the following winter rewriting the bridge, moving the chorus, changing the key and trying a dozen tempos before the label finally agreed to the version heard on the record.";

describe("sourceRisk: is the source sentence risky to retell? (S3, step 2)", () => {
  it("flags a reporting verb: the caption has to keep who said it", () => {
    expect(sourceRisk("Lantern Hill is about a lighthouse.", "Mara Quill said Lantern Hill is about a lighthouse.", true)).toContain("reporting verb");
    expect(sourceRisk("Lantern Hill is about a lighthouse.", "Lantern Hill is about a lighthouse.", true)).toEqual([]);
  });

  it("flags a quote of four or more words, but not a song title in quotes", () => {
    const speech = 'Quill remembered it as "the night the whole street sang along" in her diary.';
    expect(sourceRisk("The whole street sang along one night.", speech, true)).toContain("quote of 4+ words");
    const title = 'The band reused the riff in "Cutie Moth Moon Magic" a year later.';
    expect(sourceRisk("The band reused the riff in a later song.", title, true)).not.toContain("quote of 4+ words");
    expect(sourceRisk("It is known as the owl song.", 'It is known as "the owl song".', true)).toEqual([]);
  });

  it("flags a body sentence of 30 or more words, never a lead one", () => {
    expect(sourceRisk("The band tried a dozen tempos for the bridge.", LONG_BODY, false)).toContain("body sentence of 30+ words");
    expect(sourceRisk("The band tried a dozen tempos for the bridge.", LONG_BODY, true)).not.toContain("body sentence of 30+ words");
  });

  it("flags a hedge the caption lost, not one it kept", () => {
    const source = "The song was mostly recorded in a barn near Dayton.";
    expect(sourceRisk("The song was recorded in a barn near Dayton.", source, true)).toEqual(["hedge dropped"]);
    expect(sourceRisk("The song was mostly recorded in a barn near Dayton.", source, true)).toEqual([]);
  });

  it("flags a body sentence the caption kept less than half of, and a caption with no source sentence", () => {
    const source = "Recording: The strings were played in Lisbon by a quartet hired for two days by the producer Ana Ferro.";
    expect(sourceRisk("Ana Ferro hired a quartet.", source, false)).toContain("compressed under half");
    expect(sourceRisk("A quartet hired for two days played the strings in Lisbon.", source, false)).toEqual([]);
    expect(sourceRisk("A quartet hired for two days added the strings in Lisbon.", "", false)).toEqual(["compressed under half"]);
  });
});

describe("interest: what kind of fact is it, and how fun?", () => {
  it("ranks a number, an age or a place you can picture up", () => {
    expect(interest("Lantern Hill was recorded in one afternoon.")).toMatchObject({ hook: "picture" });
    expect(interest("The band used forty musicians on the chorus.").score).toBeGreaterThan(0);
    expect(interest("Mara Quill wrote it in a stairwell.").hook).toBe("picture");
  });

  it("ranks how it was made up: a borrowed object, a sample, an inspiration", () => {
    expect(interest("The cowbell on Lantern Hill was borrowed from a farm next door.")).toMatchObject({ hook: "making", score: 2 });
    expect(interest("The song was inspired by a lighthouse keeper.").hook).toBe("making");
  });

  it("counts a first only when the source says it, and holds an upgraded claim down", () => {
    const said = "Lantern Hill was the first song recorded at the new Dayton studio.";
    expect(interest("It was the first song recorded at the Dayton studio.", said).hook).toBe("picture");
    expect(interest("It was the first track made there.", said)).toMatchObject({ hook: "first", score: 1 });
    expect(interest("It was the first track made there.", "It was among the early tracks made there.").score).toBe(-2);
  });

  it("ranks a relatable person fact up, awards, charts and release details down", () => {
    expect(interest("Quill taught herself the banjo as a teenager.").reasons.join()).toMatch(/relatable/);
    expect(interest("The single peaked at number 12 on the Owl Chart.")).toMatchObject({ hook: "award", score: -1 });
    expect(interest("It was released on 3 May by Moth Records as a B-side.")).toMatchObject({ hook: "release", score: -1 });
    expect(interest("Lantern Hill is a song by the Marmalade Owls.")).toMatchObject({ hook: "plain", score: 0 });
  });
});

const caption = (text: string, sentence = text, lead = true): Candidate => ({ text, kind: "caption", sentence, lead });
const data = (text: string): Candidate => ({ text, kind: "data" });

describe("rankFacts: safety first, then fun", () => {
  it("shows no caption at all when the work match is unsure, and never brings one back", () => {
    const shown = rankFacts([data("Lantern Hill was written by Mara Quill."), caption("The cowbell was borrowed from a farm.")], { unsure: true });
    expect(shown.map((c) => c.text)).toEqual(["Lantern Hill was written by Mara Quill."]);
  });

  it("holds back a risky caption when three safe bubbles are left", () => {
    const log = jest.fn();
    const shown = rankFacts(
      [
        caption("The song is about a lighthouse.", "Quill said the song is about a lighthouse."),
        caption("The cowbell was borrowed from a farm next door."),
        caption("The drums were played in a stairwell."),
        caption("The band toured with it for two years."),
      ],
      { log }
    );
    expect(shown.map((c) => c.text)).not.toContain("The song is about a lighthouse.");
    expect(shown).toHaveLength(3);
    expect(log).toHaveBeenCalledWith("[Screen] DROP (risky source: reporting verb)");
    // The reason only, never the caption's words (issue #262).
    expect(JSON.stringify(log.mock.calls)).not.toContain("lighthouse");
  });

  it(`brings held-back captions back to reach ${FLOOR}, fewest flags first, after the safe ones`, () => {
    const shown = rankFacts([
      data("Lantern Hill came out in 2004."),
      caption("Quill hired a quartet.", "Recording: Quill hired a quartet for two days to add strings in Lisbon, according to the liner notes.", false),
      caption("The song was recorded in a barn.", "The song was mostly recorded in a barn.", true),
      caption("The chorus was rewritten.", LONG_BODY, false),
    ]);
    // A reporting verb, a hedge lost and heavy compression (3 flags) stay out; one long body sentence (2) comes back.
    expect(shown.map((c) => c.text)).toEqual(["Lantern Hill came out in 2004.", "The song was recorded in a barn.", "The chorus was rewritten."]);
    expect(shown.slice(1).every((c) => c.refill)).toBe(true);
  });

  it(`shows at most ${MAX_BUBBLES}, leaving out the least interesting`, () => {
    const shown = rankFacts([
      caption("Lantern Hill was released on 3 May as a single."),
      caption("The cowbell was borrowed from a farm next door."),
      caption("Quill sang it at age 16."),
      caption("The single peaked at number 12 on the Owl Chart."),
      caption("The drums were played in a stairwell."),
      caption("Lantern Hill is the album's second song."),
    ]);
    expect(shown).toHaveLength(MAX_BUBBLES);
    expect(shown.map((c) => c.text)).not.toContain("The single peaked at number 12 on the Owl Chart.");
    expect(shown.map((c) => c.text)).not.toContain("Lantern Hill was released on 3 May as a single.");
  });

  it("puts data facts and lead captions first among equals, then the writer's order", () => {
    const shown = rankFacts([
      caption("The band rehearsed it at night.", "Writing: The band rehearsed it at night, after shifts.", false),
      caption("The band named it after a hill."),
      data("Lantern Hill was produced by Ana Ferro."),
    ]);
    expect(shown.map((c) => c.text)).toEqual(["The band named it after a hill.", "Lantern Hill was produced by Ana Ferro.", "The band rehearsed it at night."]);
  });

  it("puts the song's data facts first on its artist's or game's article", () => {
    const shown = rankFacts([data("Lantern Hill came out in 2004."), caption("The cowbell was borrowed from a farm next door.")], { dataFirst: true });
    expect(shown[0].text).toBe("Lantern Hill came out in 2004.");
  });

  it("never shows the same kind of fact twice in a row when another kind is left", () => {
    const shown = rankFacts([
      caption("The cowbell was borrowed from a farm next door."),
      caption("The bass line was sampled from a music box."),
      caption("The band used forty musicians."),
    ]);
    expect(shown.map((c) => c.hook)).toEqual(["making", "picture", "making"]);
  });
});

describe("isLeadSentence", () => {
  const context = "Lantern Hill\nLantern Hill is a 2004 song by the Marmalade Owls. It was recorded in a barn.\n\nRecording: The strings were added in Lisbon.";
  it("reads the lead from the whole article when there is one", () => {
    const full = "Lantern Hill is a 2004 song by the Marmalade Owls. It was recorded in a barn.\n== Recording ==\nThe strings were added in Lisbon.";
    expect(isLeadSentence("It was recorded in a barn.", context, full)).toBe(true);
    expect(isLeadSentence("The strings were added in Lisbon.", context, full)).toBe(false);
  });

  it("otherwise takes a paragraph with no section name in front as the lead", () => {
    expect(isLeadSentence("It was recorded in a barn.", context)).toBe(true);
    expect(isLeadSentence("Recording: The strings were added in Lisbon.", context)).toBe(false);
    expect(isLeadSentence("", context)).toBe(false);
  });
});
