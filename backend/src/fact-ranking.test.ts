import fs from "fs";
import path from "path";
import { Candidate, FLOOR, MAX_BUBBLES, MAX_OFF_MUSIC, aboutTheMusic, dryData, funSentences, interest, isLeadSentence, namesOtherSong, rankFacts, sentenceFun, sourceRisk } from "./fact-ranking";

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
      data("Lantern Hill was written by Mara Quill."),
      caption("Quill hired a quartet.", "Recording: Quill hired a quartet for two days to add strings in Lisbon, according to the liner notes.", false),
      caption("The song was recorded in a barn.", "The song was mostly recorded in a barn.", true),
      caption("The chorus was rewritten.", LONG_BODY, false),
    ]);
    // A reporting verb, a hedge lost and heavy compression (3 flags) stay out; one long body sentence (2) comes back.
    expect(shown.map((c) => c.text)).toEqual(["Lantern Hill was written by Mara Quill.", "The song was recorded in a barn.", "The chorus was rewritten."]);
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
    const shown = rankFacts([data("Lantern Hill was produced by Ana Ferro."), caption("The cowbell was borrowed from a farm next door.")], { dataFirst: true });
    expect(shown[0].text).toBe("Lantern Hill was produced by Ana Ferro.");
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

describe("another song named on the artist's article (namesOtherSong)", () => {
  const cap = (text: string): Candidate => ({ text, kind: "caption", sentence: text, lead: true });
  const own = cap("Velvet Harbor was written by Mira Vale in a single night.");
  const otherA = cap('Her breakthrough was "Paper Kites" in 2014, a number-one hit.');
  const otherB = cap('She followed it with "Glass Orchard" a year later.');
  const artistFact = cap("Mira Vale grew up in a small town and taught herself guitar.");

  it("spots a quoted title that is not the playing song, in double or single quotes", () => {
    expect(namesOtherSong(otherA.text, "Velvet Harbor")).toBe(true);
    expect(namesOtherSong("Her breakthrough was 'Paper Kites' in 2014.", "Velvet Harbor")).toBe(true);
  });

  it("leaves a caption that names the playing song, names none, or quotes speech", () => {
    expect(namesOtherSong('"Velvet Harbor" was written in a single night.', "Velvet Harbor")).toBe(false);
    expect(namesOtherSong('"Velvet Harbor" was written in a night.', "Velvet Harbor (Remix)")).toBe(false);
    expect(namesOtherSong(artistFact.text, "Velvet Harbor")).toBe(false);
    expect(namesOtherSong('She said "the night the whole street sang along".', "Velvet Harbor")).toBe(false);
    expect(namesOtherSong(otherA.text, "")).toBe(false);
  });

  it("ranks it below facts about the artist and keeps one at most, only on the artist's article", () => {
    const list = [otherA, otherB, own, artistFact];
    const shown = rankFacts(list, { artistArticle: true, title: "Velvet Harbor" }).map((c) => c.text);
    expect(shown).toEqual(expect.arrayContaining([own.text, artistFact.text, otherA.text]));
    expect(shown).not.toContain(otherB.text);
    expect(shown[shown.length - 1]).toBe(otherA.text);
    // Not the artist's article: untouched.
    expect(rankFacts(list, { title: "Velvet Harbor" })).toHaveLength(4);
    expect(rankFacts(list, { artistArticle: true, title: "Velvet Harbor" }).map((c) => c.text)[0]).not.toBe(otherA.text);
  });
});

describe("the Facts per song setting", () => {
  it("tells the streamer where found facts stop", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "renderer", "index.html"), "utf8");
    const hint = page.match(/<p class="hint" id="s-facts-hint">([^<]*)<\/p>/)?.[1] ?? "";
    expect(hint).toContain(`up to ${MAX_BUBBLES} facts`);
    expect(hint).toContain("your own");
    expect(page).toMatch(/name="factsPerSong"[^>]*aria-describedby="s-facts-hint"/);
  });
});

describe("captions about the music before the game around it (#189)", () => {
  it("tells the work's own business from its music", () => {
    // Made-up game "Starfall Saga" and its track "Ember Road".
    expect(aboutTheMusic("The English voice cast of Starfall Saga was chosen in 1998.")).toBe(false);
    expect(aboutTheMusic("Starfall Saga was later ported to two handheld consoles.")).toBe(false);
    expect(aboutTheMusic("The design document for Starfall Saga is dated March 1995.")).toBe(false);
    expect(aboutTheMusic("Ember Road was composed by Mara Quill for Starfall Saga.")).toBe(true);
    expect(aboutTheMusic("The soundtrack of Starfall Saga was recorded with a live string quartet.")).toBe(true);
    // Not about a work at all: nothing to hold back.
    expect(aboutTheMusic("Mara Quill grew up in a small fishing town.")).toBe(true);
  });

  it("ranks music captions first and shows at most two about the game, never filling with more", () => {
    const caption = (text: string): Candidate => ({ kind: "caption", text, sentence: text, lead: true });
    const trivia = [
      "The English voice cast of Starfall Saga was chosen in 1998.",
      "Starfall Saga was later ported to two handheld consoles.",
      "The design document for Starfall Saga is dated March 1995.",
      "Starfall Saga's sequel introduced three new playable characters.",
    ].map(caption);
    const music = caption("Ember Road was composed by Mara Quill for Starfall Saga.");
    const lines: string[] = [];
    const shown = rankFacts([...trivia, music], { log: (l) => lines.push(l) });
    expect(shown[0].text).toBe(music.text);
    expect(shown.filter((c) => c.offMusic)).toHaveLength(MAX_OFF_MUSIC);
    expect(shown).toHaveLength(1 + MAX_OFF_MUSIC);
    expect(lines.filter((l) => l.includes("not about the music"))).toHaveLength(trivia.length - MAX_OFF_MUSIC);
  });
});

describe("the fun screen: fewer, better bubbles", () => {
  it("names why a data fact is dry", () => {
    expect(dryData("Lantern Hill came out in 2004.")).toBe("release date");
    expect(dryData('"Lantern Hill" is on the album Paper Boats.')).toBe("album");
    expect(dryData("Lantern Hill appears on Paper Boats.")).toBe("album");
    expect(dryData("The genres of Lantern Hill include dream pop.")).toBe("genres");
    expect(dryData("Mara Quill was born in Port Vell in 1980.")).toBe("birth");
    expect(dryData("The Owl Lanterns formed in Port Vell in 1999.")).toBe("birth");
    expect(dryData('Lantern Hill came after the single "Paper Kites".')).toBe("came after");
    expect(dryData('Lantern Hill was followed by the single "Paper Kites".')).toBe("came after");
    expect(dryData("Lantern Hill was released on Owl Records.")).toBe("record label");
    expect(dryData("Lantern Hill was written by Mara Quill.")).toBeNull();
    expect(dryData("Lantern Hill was produced by Ana Ferro.")).toBeNull();
  });

  it("drops dry data facts and captions scoring -1 or less, and logs only why", () => {
    const log = jest.fn();
    const shown = rankFacts(
      [
        data("Lantern Hill came out in 2004."),
        data("The genres of Lantern Hill include dream pop."),
        data("Lantern Hill was written by Mara Quill."),
        caption("The single peaked at number 12 on the Owl Chart."),
        caption("The cowbell was borrowed from a farm next door."),
      ],
      { dataFirst: true, log }
    );
    expect(shown.map((c) => c.text)).toEqual(["Lantern Hill was written by Mara Quill.", "The cowbell was borrowed from a farm next door."]);
    expect(log).toHaveBeenCalledWith("[Fun] DROP (dry: release date)");
    expect(log).toHaveBeenCalledWith("[Fun] DROP (dry: genres)");
    expect(log).toHaveBeenCalledWith("[Fun] DROP (dry: interest -1)");
    // The reason only, never the fact's words (issue #262).
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Lantern|Owl Chart|2004/);
  });

  it("keeps one fallback, the best of the dropped, when nothing else is left", () => {
    const log = jest.fn();
    const shown = rankFacts([data("Lantern Hill came out in 2004."), data("Lantern Hill appears on Paper Boats."), data('Lantern Hill came after the single "Paper Kites".')], { log });
    expect(shown).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[Fun\] KEEP one dry fact/));
    expect(JSON.stringify(log.mock.calls)).not.toContain("Lantern");
  });

  it("never brings a risky caption back in a dry fact's place: the dry fact still counts toward the floor", () => {
    const shown = rankFacts([
      data("Lantern Hill came out in 2004."),
      data("Lantern Hill appears on Paper Boats."),
      caption("The song was recorded in a barn."),
      caption("The chorus was rewritten.", LONG_BODY, false),
    ]);
    // Before the fun screen: two data facts and the safe caption made three, so the long body sentence stayed out.
    expect(shown.map((c) => c.text)).toEqual(["The song was recorded in a barn."]);
  });

  it("can be turned off", () => {
    const shown = rankFacts([data("Lantern Hill came out in 2004."), caption("The cowbell was borrowed from a farm next door.")], { fun: false });
    expect(shown.map((c) => c.text)).toContain("Lantern Hill came out in 2004.");
  });
});

describe("sentenceFun and funSentences: the article's most fun sentences", () => {
  it("scores a link to other music, a twist or a made-of detail above a definition, a credit list or music theory", () => {
    const fun = sentenceFun("Mara Quill wrote the melody after hearing a music box her grandmother borrowed from a church.");
    expect(fun).toBeGreaterThan(sentenceFun('"Lantern Hill" is a 2004 song by the Owl Lanterns.'));
    expect(fun).toBeGreaterThan(sentenceFun('"Lantern Hill" was written and produced by Mara Quill.'));
    expect(fun).toBeGreaterThan(sentenceFun("The song is written in the key of B major with a tempo of 88 beats per minute."));
    expect(sentenceFun("The soundtrack contained 2 discs and a total of 48 tracks.")).toBeLessThan(2);
  });

  it("picks the best few that are safe to retell whole, best first", () => {
    const picks = funSentences([
      '"Lantern Hill" is a 2004 song by the Owl Lanterns.',
      "The drums were recorded in a stairwell because the studio was flooded that week.",
      "Quill said the song was inspired by a lighthouse she saw as a child.",
      "The melody was originally written for a film that was cancelled.",
      "It peaked at number 12 on the Owl Chart.",
    ]);
    expect(picks).toContain("The drums were recorded in a stairwell because the studio was flooded that week.");
    expect(picks).toContain("The melody was originally written for a film that was cancelled.");
    // A reporting verb: the safety screen would hold its caption back.
    expect(picks).not.toContain("Quill said the song was inspired by a lighthouse she saw as a child.");
    expect(picks).not.toContain("It peaked at number 12 on the Owl Chart.");
    expect(funSentences(['"Lantern Hill" is a 2004 song by the Owl Lanterns.'])).toEqual([]);
  });
});
