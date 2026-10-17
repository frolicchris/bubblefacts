jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "video-game,classical,film,pop,piano,general" },
}));

import { assembleCaption, choiceGrammar, clauseOptions, namesIn, needsHolder, pickCaptions, referents } from "./picker";

describe("clauseOptions: clauses verbatim from the sentence", () => {
  it("keeps a sentence with one main clause whole, lead-in and modifiers attached", () => {
    expect(clauseOptions("In 2004, Dana Reyes recorded the demo in Oslo, using a borrowed organ.")).toEqual(["In 2004, Dana Reyes recorded the demo in Oslo, using a borrowed organ."]);
  });

  it("splits at a semicolon and before and, dropping the conjunction", () => {
    expect(clauseOptions("Lee Park wrote the verses for Night Harbor; the chorus came from a ferry horn, and he later called it luck.")).toEqual([
      "Lee Park wrote the verses for Night Harbor",
      "the chorus came from a ferry horn",
      "he later called it luck.",
    ]);
  });

  it("keeps names joined by and together", () => {
    expect(clauseOptions("Dana Reyes and Lee Park wrote the song in a single night.")).toEqual(["Dana Reyes and Lee Park wrote the song in a single night."]);
  });

  it("never splits inside a quote, brackets or a dash aside", () => {
    expect(clauseOptions('Reyes said the riff was "loud, fast, and cheap" when asked.')).toEqual(['Reyes said the riff was "loud, fast, and cheap" when asked.']);
    expect(clauseOptions("The tune (written in 1999, then lost) was found by Park in a closet.")).toHaveLength(1);
  });

  it("ends an overlong clause early only before a participle, and, or which", () => {
    const long = "Dana Reyes recorded the whole of the Night Harbor album in a converted lighthouse on the coast of Tide Island, working through the nights of a long and very cold winter.";
    expect(clauseOptions(long, 160)).toEqual(["Dana Reyes recorded the whole of the Night Harbor album in a converted lighthouse on the coast of Tide Island"]);
    // A qualifier ("although...") is never cut off: the clause is left out instead.
    const qualified = "Dana Reyes recorded the whole of the Night Harbor album in a converted lighthouse on the coast of Tide Island, although only the vocals survive from those long sessions.";
    expect(clauseOptions(qualified, 160)).toEqual([]);
  });

  it("doesn't split a list of places joined by and, or end a clause before its main verb", () => {
    expect(clauseOptions("It came out in both Tide Island and North Harbor in March 2017 followed by Oslo in June.")).toHaveLength(1);
    const lead = "According to producer Dana Reyes, keeping the album on schedule was hard due to the band's close attention to detail, so she had to balance quality with time.";
    expect(clauseOptions(lead, 120)).toEqual([]);
  });

  it("leaves out clauses under five words", () => {
    expect(clauseOptions("Park sang it; the band was gone.")).toEqual([]);
  });
});

describe("referents", () => {
  it("finds the phrases that name nothing themselves", () => {
    expect(referents("He later attributed this track to a dream about the game").map((r) => r.text)).toEqual(["He", "this track", "the game"]);
    expect(referents("Its chorus was recorded twice")[0]).toMatchObject({ text: "Its", possessive: true });
  });

  it("skips an it that refers to nothing, a time phrase, and that after a verb", () => {
    expect(referents("it took two years to finish the demo")).toEqual([]);
    expect(referents("At that time Park toured in vans")).toEqual([]);
    expect(referents("Park said that the song was finished")).toEqual([]);
    expect(referents("It came out on the album Tide Songs")).toEqual([expect.objectContaining({ text: "It" })]);
    expect(referents("This allows players to keep their saves").map((r) => r.text)).toEqual(["This"]);
    expect(referents("This is the band's longest song").map((r) => r.text)).toEqual(["This", "the band"]);
  });
});

describe("namesIn", () => {
  it("takes capitalized names and publications, not the words that open them", () => {
    expect(namesIn("In 2004, Dana Reyes told Harbor Weekly that The Open Door was finished in March.")).toEqual(["Dana Reyes", "Harbor Weekly", "The Open Door"]);
    expect(namesIn("Frame rate was doubled. Japanese fans noticed it first.")).toEqual([]);
    expect(namesIn("Following the Tide Records release, Lee Park's demo leaked.")).toEqual(["Tide Records", "Lee Park"]);
  });
});

describe("needsHolder", () => {
  it("fires on an opinion cue or a verb of saying", () => {
    expect(needsHolder("the album is a landmark of harbor rock")).toBe(true);
    expect(needsHolder("Park recalled the session as a mess")).toBe(true);
    expect(needsHolder("The album was recorded in 2004")).toBe(false);
  });
});

describe("assembleCaption", () => {
  const clause = "he later attributed this track to a dream";
  const [he, track] = referents(clause);

  it("names the referents and adds a final period", () => {
    expect(assembleCaption(clause, { resolved: [{ ref: he, name: "Dana Reyes" }, { ref: track, name: '"Night Harbor"' }] })).toBe('Dana Reyes later attributed "Night Harbor" to a dream.');
  });

  it("gives the possessive for its", () => {
    const c = "its chorus was recorded twice";
    expect(assembleCaption(c, { resolved: [{ ref: referents(c)[0], name: "Night Harbor" }] })).toBe("Night Harbor's chorus was recorded twice.");
  });

  it("leaves a referent alone when its name already comes earlier in the clause", () => {
    const c = "Dana Reyes said he wrote it on a ferry";
    const [ref] = referents(c);
    expect(assembleCaption(c, { resolved: [{ ref, name: "Dana Reyes" }] })).toBe("Dana Reyes said he wrote it on a ferry.");
  });

  it("attributes once, never twice", () => {
    expect(assembleCaption("The album is a landmark of harbor rock", { holder: "Harbor Weekly" })).toBe("According to Harbor Weekly, the album is a landmark of harbor rock.");
    expect(assembleCaption("Dana Reyes called the album a landmark", { holder: "Dana Reyes" })).toBe("Dana Reyes called the album a landmark.");
  });

  it("lowercases the first word after According to unless it starts a name", () => {
    expect(assembleCaption("Contained in the song is a sample of a ferry horn", { holder: "Dana Reyes", names: ["Night Harbor"] })).toBe(
      "According to Dana Reyes, contained in the song is a sample of a ferry horn."
    );
    expect(assembleCaption("Night Harbor is a landmark", { holder: "Harbor Weekly", names: ["Night Harbor"] })).toBe("According to Harbor Weekly, Night Harbor is a landmark.");
  });

  it("returns nothing rather than cutting a long caption", () => {
    expect(assembleCaption("Dana Reyes recorded the demo in Oslo", { limit: 20 })).toBeUndefined();
  });

  it("turns a comma before a closing quote into a period", () => {
    expect(assembleCaption('Park called the demo "rough around the edges,"', {})).toBe('Park called the demo "rough around the edges."');
  });
});

describe("choiceGrammar", () => {
  it("allows exactly the listed answers", () => {
    expect(choiceGrammar(["yes", "no"])).toBe('root ::= "yes" | "no"');
    expect(choiceGrammar(['Sly "Ace" Dunn', "NONE"])).toBe('root ::= "Sly \\"Ace\\" Dunn" | "NONE"');
  });
});

describe("pickCaptions", () => {
  const context = [
    "Night Harbor (song)",
    "Recording: Dana Reyes produced the session in Oslo. He later attributed the song to a dream; Harbor Weekly called it a landmark of harbor rock.",
    "",
    "Release: The single was pressed in a run of 500 copies by Tide Records.",
  ].join("\n");
  const song = { title: "Night Harbor", artist: "Tide Lamps" };

  it("asks the questions in order and assembles the captions from the answers", async () => {
    const asked: string[] = [];
    const ask = async (prompt: string, grammar: string) => {
      const question = prompt.split("Question: ")[1];
      asked.push(question.split("\n")[0].slice(0, 40));
      if (grammar.includes('"yes"')) return "yes";
      if (question.startsWith("Which part")) return "2";
      if (question.includes('what does "it" refer to')) return "Night Harbor";
      if (question.startsWith("Whose view")) return "Harbor Weekly";
      return "NONE";
    };
    const { captions } = await pickCaptions(context, song, 5, ask);
    expect(captions).toEqual([
      "Dana Reyes produced the session in Oslo.",
      "The single was pressed in a run of 500 copies by Tide Records.",
      // Q2 picked the second clause, Q3 named "it", and Q4's holder is already in the clause.
      "Harbor Weekly called Night Harbor a landmark of harbor rock.",
    ]);
    expect(asked.filter((q) => q.startsWith("The request is"))).toHaveLength(3);
  });

  it("skips a sentence that is not about the song, or whose referent is NONE", async () => {
    const ask = async (prompt: string, grammar: string) => (grammar.includes('"yes"') ? (prompt.includes("500 copies") ? "no" : "yes") : grammar.includes('"1"') ? "1" : "NONE");
    const { captions, log } = await pickCaptions(context, song, 5, ask);
    expect(captions).toEqual(["Dana Reyes produced the session in Oslo."]);
    expect(log.map((l) => l.outcome)).toEqual(expect.arrayContaining(["skip: not about the song", 'skip: "He" refers to nothing listed']));
  });
});
