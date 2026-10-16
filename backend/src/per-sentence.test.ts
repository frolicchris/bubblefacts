jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "video-game,classical,film,pop,piano,general" },
}));

import { attributeCaption, captionGrammar, cleanCaption, hedgeOf, holderOf, pickSentences, sentencePrompt } from "./per-sentence";

describe("holderOf: the precise holder rules", () => {
  it("takes the holder a sentence names with According to", () => {
    expect(holderOf("According to Mira Holt, the riff came from a broken organ.")).toBe("Mira Holt");
    expect(holderOf("The riff, according to Mira Holt, came from a broken organ.")).toBeUndefined(); // lower-case "according" is not the rule
  });

  it("takes the speaker a quote is introduced by", () => {
    expect(holderOf('In 1998, Tomas Vell said, "The bridge was written on a train."')).toBe("Tomas Vell");
    expect(holderOf("Tomas Vell later recalled that “the bridge was written on a train”.")).toBe("Tomas Vell");
  });

  it("finds no holder from a pronoun, a common word or a name far from the quote", () => {
    expect(holderOf('He explained, "The bridge was written on a train."')).toBeUndefined();
    expect(holderOf('The band said, "The bridge was written on a train."')).toBeUndefined();
    expect(holderOf('Tomas Vell said that the band, after touring for most of a long and tiring year, "wrote the bridge on a train".')).toBeUndefined();
    expect(holderOf("Tomas Vell said the bridge was written on a train.")).toBeUndefined(); // no quote, no According to
  });
});

describe("hedgeOf", () => {
  it("finds the sure hedge cues", () => {
    expect(hedgeOf("The demo was reportedly lost in a flood.")).toBe("reportedly");
    expect(hedgeOf("The tune was said to be the composer's favorite.")).toBe("was said to");
    expect(hedgeOf("Rumored sessions with Kip Arlo never happened.")).toBe("rumored");
    expect(hedgeOf("It has been described as a lullaby.")).toBe("has been described as");
    expect(hedgeOf("The demo was lost in a flood.")).toBeUndefined();
  });
});

describe("captionGrammar", () => {
  it("is free text on one line, held to the bubble length, when nothing is forced", () => {
    expect(captionGrammar({ limit: 160 })).toBe("root ::= body\nbody ::= [^\\r\\n]{1,160}");
  });

  it("opens with According to and keeps the room left for the rest", () => {
    const g = captionGrammar({ holder: "Mira Holt", limit: 100 });
    expect(g).toContain('root ::= "According to Mira Holt, " body');
    expect(g).toContain(`{1,${100 - "According to Mira Holt, ".length}}`);
  });

  it("requires the hedge cue, in either case at its first letter", () => {
    const g = captionGrammar({ cue: "reportedly", limit: 60 });
    expect(g).toContain("body ::= [^\\r\\n]{0,50} cue [^\\r\\n]{0,50}");
    expect(g).toContain('cue ::= ("R" | "r") "eportedly"');
  });

  it("escapes quotes and backslashes in a holder's name", () => {
    expect(captionGrammar({ holder: 'Sly "Ace" Dunn' })).toContain('"According to Sly \\"Ace\\" Dunn, "');
  });
});

describe("pickSentences", () => {
  const context = [
    "Night Harbor (song)",
    "From the people who made it: Dana Reyes wrote the song on a ferry crossing in 2001. He said it took an afternoon to finish the whole thing.",
    "",
    "Recording: The band recorded it in a converted lighthouse over two weeks. Short one.",
    "The strings were added later in a studio in Lisbon by Lee Park.",
    "",
    "Night Harbor is a song by the made-up band Tide Lamps, released as a single in 2002.",
  ].join("\n");

  it("lets the blocks take turns, keeps each sentence's heading, and leaves leaning sentences for last", () => {
    expect(pickSentences(context, 10)).toEqual([
      { sentence: "Dana Reyes wrote the song on a ferry crossing in 2001.", heading: "From the people who made it" },
      { sentence: "The band recorded it in a converted lighthouse over two weeks.", heading: "Recording" },
      { sentence: "Night Harbor is a song by the made-up band Tide Lamps, released as a single in 2002.", heading: "Introduction" },
      { sentence: "The strings were added later in a studio in Lisbon by Lee Park.", heading: "Recording" },
      { sentence: "He said it took an afternoon to finish the whole thing.", heading: "From the people who made it" },
    ]);
    expect(pickSentences(context, 2)).toHaveLength(2);
  });

  it("puts the fixed instructions before the sentence", () => {
    const prompt = sentencePrompt("Night Harbor (song)", { sentence: "Dana Reyes wrote the song on a ferry.", heading: "Recording" });
    expect(prompt.endsWith("Article: Night Harbor (song)\nSection: Recording\nSentence: Dana Reyes wrote the song on a ferry.")).toBe(true);
  });
});

describe("cleanCaption and the attribution fallback", () => {
  it("keeps the first line, without a label or wrapping quotes", () => {
    expect(cleanCaption('Caption: "Tide Lamps recorded it in a lighthouse."\nMore')).toBe("Tide Lamps recorded it in a lighthouse.");
  });

  it("attributes a quote the sentence introduces with a speaker", () => {
    const sentence = 'Asked about it in 2005, Mira Holt said, "We only had one microphone for the whole band."';
    expect(attributeCaption('The band had "only had one microphone for the whole band."', sentence)).toBe(
      'According to Mira Holt, the band had "only had one microphone for the whole band."'
    );
  });

  it("leaves alone a caption with no quote, one that names the holder, or one already attributed", () => {
    const sentence = 'Mira Holt said, "We only had one microphone for the whole band."';
    expect(attributeCaption("The band had one microphone.", sentence)).toBe("The band had one microphone.");
    expect(attributeCaption('Holt said they "only had one microphone for the whole band."', sentence)).toBe('Holt said they "only had one microphone for the whole band."');
    expect(attributeCaption("According to Mira Holt, the band had one microphone.", sentence)).toBe("According to Mira Holt, the band had one microphone.");
  });
});
