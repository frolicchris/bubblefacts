jest.mock("./config", () => ({
  config: {
    factsPerSong: 5,
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    groundingTimeoutMs: 5000,
    groundingExtractTimeoutMs: 15000,
    topic: "video-game,classical,film,pop,piano,general",
  },
}));

import {
  droppedFrame,
  droppedLimit,
  movedChartDetail,
  turnedRound,
  unnamedChart,
  companyHistory,
  unresolvedPronoun,
  screenClaims,
  leftBehindReferent,
  repairScope,
  workMatchConfidence,
  mergedClauses,
  otherRecordingSection,
  numberedReference,
  referenceSentences,
  parseCitation,
  citedMismatch,
  unsupportedDay,
  droppedYear,
  resolveGameAndTrack,
  unsupportedName,
  platformSupported,
  tooSimilar,
  alteredQuote,
  gameTrackText,
  creatorSentences,
  explainMusicTerms,
  receptionSentences,
  theorySentences,
  curatedFacts,
  orderExtract,
  readings,
  rememberArticle,
  withoutVideoSections,
  soundtrackPart,
  otherParts,
  unsupportedConnective,
  unsupportedRelation,
  unsupportedCredit,
  lostQualifier,
  swappedSubject,
  unattributedView,
  misattributedWords,
  otherDoer,
  unnamedReference,
  droppedHedge,
  misplacedYear,
  wrongOwner,
  suppliedException,
  reversedRole,
  supportingSentence,
  artistNames,
  restatesRequest,
} from "./fact-verifier";
import { hasNoArtist } from "./text";
import { topic } from "./topic";

describe("screenClaims", () => {
  const NO_CONTEXT = "";

  it("never puts a link, a chat command or an @mention on stream, even from the source", () => {
    const context = "Visit evil.example.com or www.example.org. Type !raid now. Follow @someone today.";
    const { kept, rejected } = screenClaims([
      "Fans can visit evil.example.com to hear the original recording today.",
      "The song's website is www.example.org and it has the full lyrics.",
      "Viewers should type !raid in chat to celebrate this classic song.",
      "Follow @someone for more trivia about this song and its composer.",
    ], context);
    expect(kept).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["a link", "a link", "a chat command", "an @mention"]);
  });

  it("keeps names that only look like links or commands", () => {
    const { kept } = screenClaims(["P!nk recorded a cover of the song in 2017 for a charity album."], "P!nk recorded a cover of the song in 2017.");
    expect(kept).toHaveLength(1);
  });

  it("drops fabricated award claims", () => {
    // A real failure: the model invented a Tokyo Game Award.
    const r = screenClaims(
      ["This piece won Best Original Soundtrack at the 2016 Tokyo Game Awards."],
      NO_CONTEXT
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/award/);
  });

  it("keeps an award claim the reference actually corroborates", () => {
    const r = screenClaims(
      ["The soundtrack won an award for its orchestration."],
      "The soundtrack won an award for its orchestration in 2017."
    );
    expect(r.kept).toHaveLength(1);
  });

  it("drops chart positions and sales figures", () => {
    const r = screenClaims(
      [
        "The single topped the Billboard chart for three weeks.",
        "The soundtrack sold 2 million copies worldwide.",
      ],
      NO_CONTEXT
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
  });

  it("drops meta-commentary about the source", () => {
    const r = screenClaims(
      [
        "Nobuo Uematsu is not credited as a composer in the provided reference material.",
        "I couldn't confirm whether he worked on this title.",
      ],
      NO_CONTEXT
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected.every((x) => x.reason === "meta-commentary")).toBe(true);
  });

  it("strips label prefixes rather than rejecting the fact", () => {
    const r = screenClaims(
      ["Fact: The score uses a live string section throughout the game."],
      NO_CONTEXT
    );
    expect(r.kept[0]).toBe("The score uses a live string section throughout the game.");
  });

  it("drops fragments left too short after prefix stripping", () => {
    const r = screenClaims(["Fact:", "3. ok"], NO_CONTEXT);
    expect(r.kept).toHaveLength(0);
  });

  it("keeps ordinary grounded facts", () => {
    const fact = "The soundtrack was performed by a live orchestra in Tokyo.";
    const r = screenClaims([fact], "Recording used a live orchestra in Tokyo.");
    expect(r.kept).toEqual([fact]);
  });

  describe("with a reference to check against", () => {
    const CTX = "The game's music was composed by Falcom Sound Team jdk and released in 2016.";

    it("drops a year the reference does not contain", () => {
      const r = screenClaims(["The soundtrack was recorded back in 1998 by the team."], CTX);
      expect(r.kept).toHaveLength(0);
      expect(r.rejected[0].reason).toMatch(/unsupported year 1998/);
    });

    it("keeps a year the reference does contain", () => {
      const fact = "Falcom Sound Team jdk wrote the score, which arrived in 2016.";
      expect(screenClaims([fact], CTX).kept).toEqual([fact]);
    });

    it("drops a platform the reference does not mention", () => {
      const r = screenClaims(["The score was squeezed onto the SNES sound chip."], CTX);
      expect(r.kept).toHaveLength(0);
      expect(r.rejected[0].reason).toMatch(/unsupported platform/);
    });

    it("keeps a platform the reference does mention", () => {
      const fact = "The PlayStation 4 version keeps the original arrangements intact.";
      const ctx = `${CTX} A PlayStation 4 port followed.`;
      expect(screenClaims([fact], ctx).kept).toEqual([fact]);
    });
  });

  it("does not screen years or platforms when there is no reference", () => {
    // Without a reference the prompt asks for general, well-known facts, which
    // legitimately contain years and console names. Screening them here would
    // reject everything and blank the overlay.
    const fact = "The NES sound chip had five channels, including a triangle wave.";
    expect(screenClaims([fact], NO_CONTEXT).kept).toEqual([fact]);
  });
});

describe("curatedFacts", () => {
  it("returns the requested number of distinct facts from the packs", () => {
    const facts = curatedFacts(5);
    expect(facts).toHaveLength(5);
    expect(new Set(facts).size).toBe(5);
    facts.forEach((f) => expect(topic.curatedFacts).toContain(f));
  });

  it("does not exceed the pool, and handles zero", () => {
    expect(curatedFacts(9999)).toHaveLength(topic.curatedFacts.length);
    expect(curatedFacts(0)).toEqual([]);
  });
});

describe("person-name screening", () => {
  // Composer attribution is the most visible error this overlay can make.
  const CTX =
    "the game's music was composed by falcom sound team jdk. a piano arrangement album followed.";

  it("drops a fabricated composer the reference never names", () => {
    const r = screenClaims(
      ["The Ys VIII score was written by Yuzo Koshiro and Nobuo Uematsu."],
      CTX
    );
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/unsupported name/);
  });

  it("drops a fabricated composer even in an otherwise clean sentence", () => {
    const r = screenClaims(
      ["Composer Koji Kondo wrote the battle themes in a single afternoon."],
      CTX
    );
    expect(r.kept).toHaveLength(0);
  });

  it("keeps a name the reference does contain", () => {
    const fact = "The score is credited to Falcom Sound Team jdk, the in-house staff.";
    expect(screenClaims([fact], CTX).kept).toEqual([fact]);
  });

  it("does not mistake a sentence-initial phrase for a name", () => {
    const fact = "The Piano Arrangement album collects the main themes for solo piano.";
    expect(screenClaims([fact], CTX).kept).toEqual([fact]);
  });

  it("does not screen names when there is no reference to check against", () => {
    // Ungrounded facts are hand-written curated ones; screening them here
    // would reject correct content and blank the overlay.
    const fact = "Nobuo Uematsu wrote the music for the first nine Final Fantasy games.";
    expect(screenClaims([fact], "").kept).toEqual([fact]);
  });

  it("doesn't take a place or people after \"by\" for a person (\"influenced by Western action movies\")", () => {
    expect(unsupportedName("The game was influenced by Western action movies and TV shows.", "the game drew on action films")).toBeNull();
    expect(unsupportedName("The theme was composed by Adele.", "the theme is well known")).toBe("Adele");
  });

  it("accepts a surname-only reference mention", () => {
    expect(unsupportedName("Music by Yuzo Koshiro.", "koshiro composed it; yuzo is credited")).toBeNull();
  });
});

describe("credits must match the source's roles (review)", () => {
  const CTX = "Starfall is a 2019 game. John Smith directed the game. The music was composed by Mia Chen.";

  it("drops a credit the source gives someone else", () => {
    expect(screenClaims(["John Smith wrote the soundtrack for Starfall."], CTX).kept).toEqual([]);
  });

  it("drops a one-word name the source never mentions", () => {
    expect(screenClaims(["The soundtrack was composed by Adele in 2019."], CTX).kept).toEqual([]);
  });

  it("needs the role stated for that person, active or passive (QA follow-up #4)", () => {
    const ctx = "John Smith directed the game and discussed its soundtrack. Mia Chen composed the music.";
    expect(screenClaims(["John Smith composed the soundtrack."], ctx).kept).toEqual([]);
    expect(screenClaims(["Adele composed the soundtrack."], ctx).kept).toEqual([]);
    expect(screenClaims(["The soundtrack was composed by John Smith."], ctx).kept).toEqual([]);
    expect(screenClaims(["Mia Chen composed the music."], ctx).kept).toHaveLength(1);
    expect(screenClaims(["The music was composed by Mia Chen."], ctx).kept).toHaveLength(1);
    expect(screenClaims(["John Smith directed the game."], ctx).kept).toHaveLength(1);
  });

  it("needs the sentence to tie the person to the role, not just put them near it (final QA #1)", () => {
    const kept = (fact: string, ctx: string) => screenClaims([fact], ctx).kept.length === 1;
    const mixed = "John Smith directed, while Mia Chen composed the music.";
    expect(kept("John Smith composed the music.", mixed)).toBe(false);
    expect(kept("Mia Chen composed the music.", mixed)).toBe(true);
    expect(kept("John Smith composed the music.", "John Smith directed and Mia Chen composed the music.")).toBe(false);
    expect(kept("John Smith composed the music.", "The game was directed by John Smith and composed by Mia Chen.")).toBe(false);
    expect(kept("Mia Chen directed the game.", "The game was directed by John Smith and composed by Mia Chen.")).toBe(false);
    expect(kept("John Smith composed the music.", "The music was composed by Mia Chen, and John Smith directed.")).toBe(false);
    expect(kept("John Smith composed the music.", "John Smith hired Mia Chen, who composed the music.")).toBe(false);
  });

  it("keeps the usual ways an article states a credit", () => {
    const kept = (fact: string, ctx: string) => screenClaims([fact], ctx).kept.length === 1;
    expect(kept("John Smith composed the music.", "John Smith directed the game and composed its music.")).toBe(true);
    expect(kept("Mia Chen composed the music.", "John Smith hired Mia Chen, who composed the music.")).toBe(true);
    expect(kept("Toby Fox composed the soundtrack.", "The soundtrack was written and composed by Mia Chen and Toby Fox.")).toBe(true);
    expect(kept("Will Champion wrote the song.", "It was written by Chris Martin, Jonny Buckland, Guy Berryman, and Will Champion, and produced by Ken Nelson.")).toBe(true);
    expect(kept("Ken Nelson wrote the song.", "It was written by Chris Martin, Jonny Buckland, Guy Berryman, and Will Champion, and produced by Ken Nelson.")).toBe(false);
    expect(kept("Ken Nelson produced the song.", "It was written by Chris Martin and produced by Ken Nelson.")).toBe(true);
    expect(kept("Nobuo Uematsu composed the score.", "The game features music by Nobuo Uematsu.")).toBe(true);
    expect(kept("Nobuo Uematsu composed the score.", "Series composer Nobuo Uematsu returned for the sequel.")).toBe(true);
    expect(kept("Mia Chen and Toby Fox composed the music.", "Mia Chen and Toby Fox composed the music.")).toBe(true);
  });

  it("keeps a credit the source does give", () => {
    expect(screenClaims(["Mia Chen composed the music for Starfall."], CTX).kept).toHaveLength(1);
    expect(screenClaims(["Starfall was directed by John Smith."], CTX).kept).toHaveLength(1);
  });
});

describe("screening edge cases", () => {
  const CTX = "ys viii was released in 2016 for playstation vita by nihon falcom.";

  it("screens every year in a line, not just the first", () => {
    // "2016" corroborated the whole sentence and carried 2021 in with it.
    const r = screenClaims(["Ys VIII arrived in 2016 and was remastered in 2021."], CTX);
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/unsupported year 2021/);
  });
});

describe("platformSupported", () => {
  it("does not accept NES on the strength of an unrelated word", () => {
    expect(platformSupported("NES", "the game was praised for its kindness")).toBe(false);
    expect(platformSupported("NES", "released on the sega genesis")).toBe(false);
  });

  it("does not accept Switch inside ordinary prose", () => {
    expect(platformSupported("Switch", "you can switch between party members")).toBe(false);
  });

  it("accepts an alias for the same hardware", () => {
    expect(platformSupported("N64", "ported to the nintendo 64 in 1998")).toBe(true);
    expect(platformSupported("Mega Drive", "released for the sega genesis")).toBe(true);
    expect(platformSupported("SNES", "a super famicom exclusive")).toBe(true);
  });

  it("accepts a direct mention", () => {
    expect(platformSupported("PlayStation 4", "a playstation 4 port followed")).toBe(true);
  });
});

describe("duplicate and length screening", () => {
  const CTX =
    "the music was composed by falcom sound team jdk, the in-house sound staff at nihon falcom.";

  it("keeps only one of several restatements of the same source sentence", () => {
    const r = screenClaims(
      [
        "The music was composed by Falcom Sound Team jdk.",
        "Falcom Sound Team jdk composed the music for the game.",
        "The game's music comes from Falcom Sound Team jdk.",
      ],
      CTX
    );
    expect(r.kept).toHaveLength(1);
    expect(r.rejected.every((x) => x.reason === "near-duplicate of an earlier fact")).toBe(true);
  });

  it("rejects a fact too long for the bubble", () => {
    const long = "Falcom Sound Team jdk composed the music, " + "and it is very good ".repeat(12);
    const r = screenClaims([long], CTX);
    expect(r.kept).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/too long/);
  });

  it("does not treat two genuinely different facts as duplicates", () => {
    expect(
      tooSimilar(
        "Falcom Sound Team jdk composed the music.",
        "The game shipped for PlayStation Vita in Japan."
      )
    ).toBe(false);
  });
});


describe("screening holes found in review", () => {
  const CTX = "Chrono Trigger's wonderful score was composed by Yasunori Mitsuda and released in 1995 for the Super Famicom. The game played at arcade speed.";
  const dropped = (fact: string) => screenClaims([fact], CTX).kept.length === 0;

  it("does not corroborate a risky word from inside a longer word", () => {
    expect(dropped("Chrono Trigger's score won a prize for its composer.")).toBe(true);
  });

  it("catches a chart position written with a hash", () => {
    expect(dropped("The main theme reached #1 on the Oricon charts in Japan.")).toBe(true);
  });

  it("requires every part of a name as a whole word", () => {
    expect(dropped("Ed Mitsuda wrote several of the battle themes for the game.")).toBe(true);
  });

  it("checks accented and Mc- names", () => {
    expect(dropped("Antonín Dvořák influenced the score of Chrono Trigger heavily.")).toBe(true);
    expect(dropped("Paul McCartney performed on the original soundtrack album.")).toBe(true);
  });

  it("checks years before 1800", () => {
    expect(dropped("Chrono Trigger's score quotes a melody first published in 1722.")).toBe(true);
  });

  it("accepts a lowercase arcade mention the source supports", () => {
    expect(platformSupported("arcade", "a 1991 arcade game")).toBe(true);
  });
});

describe("screenClaims — opinions and the music video", () => {
  const context = "Rockstar is a song by Post Malone and 21 Savage. It was considered one of the best songs of 2017. " +
    "It was their first number one. The music video shows Post Malone fighting ninjas. The video game Nier Automata.";

  it("drops opinions even when the source quotes them (issue #21)", () => {
    const { kept, rejected } = screenClaims(["Rockstar was considered one of the best songs of 2017."], context);
    expect(kept).toEqual([]);
    expect(rejected[0].reason).toBe("opinion");
  });

  it("drops lines about the music video viewers are watching (issue #20)", () => {
    expect(screenClaims(["The music video shows Post Malone fighting ninjas."], context).kept).toEqual([]);
    expect(screenClaims(["In the video, Post Malone fights a crowd of ninjas."], context).kept).toEqual([]);
  });

  it("keeps a plain fact, and a line about a video game", () => {
    const { kept } = screenClaims(
      ["Rockstar was the first number one for Post Malone and 21 Savage.", "The video game Nier Automata has a famous score."],
      context
    );
    expect(kept).toHaveLength(2);
  });
});

describe("restatesRequest", () => {
  const clocks = { title: "Clocks", artist: "Coldplay" };

  it("drops lines that only repeat the title and artist", () => {
    for (const f of [
      '"Clocks" was written by Coldplay.',
      '"Clocks" is a song by English rock band Coldplay.',
      "Clocks is a single by Coldplay.",
      "Coldplay performed and recorded Clocks.",
    ]) expect(restatesRequest(f, clocks)).toBe(true);
  });

  it("keeps lines that add something", () => {
    for (const f of [
      '"Clocks" was written by Chris Martin, Jonny Buckland, Guy Berryman and Will Champion.',
      '"Clocks" came out in 2002.',
      '"Clocks" is on the album A Rush of Blood to the Head.',
      "Requested by kirbyfan.",
    ]) expect(restatesRequest(f, clocks)).toBe(false);
  });

  it("treats a game as part of the request", () => {
    const song = { title: "Megalovania", artist: "Undertale" };
    expect(restatesRequest('"Megalovania" is a song from the video game Undertale.', song)).toBe(true);
    expect(restatesRequest('"Megalovania" from Undertale was composed by Toby Fox.', song)).toBe(false);
  });

  it("drops an originals credit that names the artist the request showed", () => {
    const song = { title: "Water in the Moonlight", artist: "Robin" };
    expect(restatesRequest('"Water in the Moonlight" is an original composition by Robin.', song)).toBe(true);
    expect(restatesRequest("You're hearing this one straight from the person who wrote it.", song)).toBe(true);
    expect(restatesRequest("Robin has played \"Water in the Moonlight\" 3 times on stream.", song)).toBe(false);
  });
});

describe("what the makers said, how it's built, how it was received (issue #48)", () => {
  const article = [
    "Night Drive is a 1994 song by the band Example. It reached number three on the UK Singles Chart and was certified platinum.",
    "== Background ==",
    "According to singer Mia Chen, \"Night Drive\" was inspired by a bus ride through Osaka.",
    "He said the riff took a day.",
    "Chen recalled that the demo of the song was recorded in a kitchen: \"It was all we had.",
    "== Composition ==",
    "The song is written in the key of E minor with a tempo of 96 beats per minute.",
    "Its piano part is built on arpeggios over a four-chord progression.",
    "== Critical reception ==",
    "Jane Doe of The Daily Times said the song was the best single of the year.",
    "The song won the award for Best Single at the 1995 Example Awards.",
  ].join("\n");

  it("lifts creators' comments that stand on their own, and leaves critics out", () => {
    expect(creatorSentences(article, ["Night Drive", "Example"])).toEqual([
      'According to singer Mia Chen, "Night Drive" was inspired by a bus ride through Osaka.',
    ]);
  });

  it("in an article about the whole game or artist, takes only what names the track or is plainly about music", () => {
    const game = "Starfall is a 2019 game.\n== Development ==\nAccording to director John Smith, the title was inspired by a camping trip.\n== Music ==\nComposer Mia Chen said the soundtrack was inspired by lullabies.";
    expect(creatorSentences(game, ["Opening"], false)).toEqual(["Composer Mia Chen said the soundtrack was inspired by lullabies."]);
  });

  it("lifts how the music is built and how it was received, without opinions", () => {
    expect(theorySentences(article)).toEqual([
      "The song is written in the key of E minor with a tempo of 96 beats per minute.",
      "Its piano part is built on arpeggios over a four-chord progression.",
    ]);
    const received = receptionSentences(article);
    expect(received[0]).toContain("number three");
    expect(received.join(" ")).toContain("won the award");
    expect(received.join(" ")).not.toContain("best single of the year");
  });

  it("puts those sentences at the top of what the model reads", () => {
    const text = orderExtract(article, 3000, ["Night Drive", "Example"]);
    expect(text.startsWith("From the people who made it: According to singer Mia Chen")).toBe(true);
    expect(text).toContain("How the music is built: The song is written in the key of E minor");
    expect(text).toContain("How it was received:");
  });

  it("drops a quotation the source doesn't contain word for word, or one that runs long", () => {
    const ctx = 'May said the song "was all in Freddie\'s mind" before they started.';
    expect(alteredQuote('May said it "was all in Freddie\'s mind".', ctx)).toBeNull();
    expect(alteredQuote('May said it "was entirely in his head".', ctx)).toBe("was entirely in his head");
    expect(alteredQuote('"Night Drive" came out in 1994.', ctx)).toBeNull();
    expect(screenClaims(['May said the song "lived only in his imagination" before they started.'], ctx).kept).toEqual([]);
  });

  it("explains a music term in a few fixed plain words when it fits", () => {
    expect(explainMusicTerms("Its piano part is built on arpeggios.")).toBe("Its piano part is built on arpeggios (a chord's notes played one at a time).");
    expect(explainMusicTerms("It was recorded in a kitchen.")).toBe("It was recorded in a kitchen.");
    const long = "The verse rides a syncopated bass line " + "that keeps on going ".repeat(6) + "to the end.";
    expect(explainMusicTerms(long)).toBe(long);
  });

  it("keeps a quoted title whole at the start of a caption", () => {
    expect(screenClaims(['"Clocks" was released in the UK by Parlophone in March.'], "clocks was released in the uk by parlophone in march.").kept[0]).toMatch(/^"Clocks" was/);
  });
});

describe("who won the award (stream replay: Moon River)", () => {
  const ctx = "Moon River\nMoon River is a song composed by Henry Mancini with lyrics by Johnny Mercer. It was originally performed by Audrey Hepburn in the 1961 film Breakfast at Tiffany's, winning an Academy Award for Best Original Song. Henry Mancini won the Grammy Award for Record of the Year.";
  const kept = (fact: string) => screenClaims([fact], ctx).kept.length === 1;

  it("drops an award given to someone the source doesn't say won it", () => {
    expect(kept("Audrey Hepburn won an Academy Award for Best Original Song for her performance.")).toBe(false);
  });

  it("keeps the award for the song, and for a person the source says won", () => {
    expect(kept("The song won an Academy Award for Best Original Song.")).toBe(true);
    expect(kept("Henry Mancini won the Grammy Award for Record of the Year.")).toBe(true);
    expect(kept("Moon River won an Academy Award for Best Original Song.")).toBe(true);
  });
});

describe("screening slips found replaying real songs", () => {
  it("drops talk of music videos in the plural, and 'some of the best'", () => {
    const ctx = "Seal performed the song beside the Bat-Signal in one of its music videos. Tom's Guide wrote that the series has some of the best music in gaming.";
    expect(screenClaims(["Seal performed the song beside the Bat-Signal in one of its music videos."], ctx).kept).toEqual([]);
    expect(screenClaims(["Tom's Guide wrote that the series has some of the best music in gaming."], ctx).kept).toEqual([]);
    expect(screenClaims(['GameSpy called all of the music "incredible".'], 'GameSpy called all of the music "incredible".').kept).toEqual([]);
    expect(screenClaims(["It reached number one on the Billboard Hot 100 in 1983."], "It reached number one on the Billboard Hot 100 in 1983.").kept).toHaveLength(1);
  });
});

describe("true facts dropped on a live stream (October 1 evening log)", () => {
  const kept = (fact: string, ctx: string) => screenClaims([fact], ctx).kept.length === 1;
  const chrono = "Chrono Trigger\nChrono Trigger was scored primarily by Yasunori Mitsuda. Mitsuda was unhappy with his pay and threatened to leave Square if he could not compose music. Hironobu Sakaguchi suggested he score Chrono Trigger. The game's director, Masato Kato, was Mitsuda's close friend. Nobuo Uematsu composed ten pieces.";

  it("keeps a fact that only mentions the game or a colleague", () => {
    expect(kept("Mitsuda was unhappy with his pay and threatened to leave Square if he could not compose music for Chrono Trigger.", chrono)).toBe(true);
    expect(kept("The game's director, Masato Kato, was Mitsuda's close friend and collaborator on the score.", chrono)).toBe(true);
    expect(kept("Hironobu Sakaguchi suggested Mitsuda compose the music after he threatened to leave.", chrono)).toBe(true);
  });

  it("still drops a credit given to the wrong person", () => {
    expect(kept("Masato Kato composed the music for Chrono Trigger.", chrono)).toBe(false);
    expect(kept("The music was composed by Hironobu Sakaguchi.", chrono)).toBe(false);
    expect(kept("Nobuo Uematsu composed ten pieces for the game.", chrono)).toBe(true);
  });
});

describe("music-video sections stay out of the reference", () => {
  const article = [
    '"Square Hammer" is a song by Swedish rock band Ghost.',
    "== Music video ==",
    "Papa Emeritus III takes a paper from a hawker.",
    "=== Production ===",
    "The video was shot in black and white.",
    "== Reception ==",
    "It made Ghost the first Swedish band to top the Billboard Mainstream Rock chart.",
  ].join("\n");

  it("drops the section and its subsections, and keeps the rest", () => {
    const text = withoutVideoSections(article);
    expect(text).not.toMatch(/hawker|black and white/);
    expect(text).toMatch(/first Swedish band/);
    expect(withoutVideoSections("Lead.\n== Video game ==\nIt was used in a video game.")).toMatch(/used in a video game/);
  });

  it("drops talk of the video or its shoot, but not a video game or a shoot 'em up", () => {
    const ctx = "I'll Never Break Your Heart\nKristin Willits was asked to be featured in the original video. The group would fall off after filming stopped. It gained notoriety due to its inclusion in the video game Guitar Hero III. The Touhou Project is a shoot 'em up series.";
    expect(screenClaims(["Kristin Willits was asked to be featured in the original video."], ctx).kept).toEqual([]);
    expect(screenClaims(["The group would constantly fall off after filming stopped."], ctx).kept).toEqual([]);
    expect(screenClaims(["The song gained notoriety due to its inclusion in the video game Guitar Hero III."], ctx).kept).toHaveLength(1);
    expect(screenClaims(["The Touhou Project is a shoot 'em up series."], ctx).kept).toHaveLength(1);
  });
});

describe("a big soundtrack article is cut to the track's part", () => {
  const music = [
    "The music of Genshin Impact was composed by Yu-Peng Chen.",
    "== Mondstadt ==",
    "The Mondstadt soundtrack was performed by the London Philharmonic Orchestra with Robert Ziegler.",
    "== Liyue ==",
    "The Liyue soundtrack draws on Chinese folk music and was recorded with the Shanghai Symphony Orchestra.",
    "== Fontaine ==",
    "The Fontaine soundtrack was recorded with the London Symphony Orchestra.",
    "== Musicology and instrumentation ==",
    '=== "Main Theme" ===',
    "The main theme opens with a solo violin.",
    "== Reception ==",
    "It won several awards.",
  ].join("\n");

  it("keeps the lead and the named part, and lists the others", () => {
    const part = soundtrackPart(music, "Liyue: Relaxation in Liyue");
    expect(part?.heading).toBe("Liyue");
    expect(part?.text).toMatch(/Shanghai Symphony/);
    expect(part?.text).not.toMatch(/London Philharmonic/);
    expect(part?.others).toEqual(["Mondstadt", "Fontaine"]);
    // An article that doesn't call itself a soundtrack, or has no parts, is left alone (a track naming no part: below).
    expect(soundtrackPart(music, "Raiden Shogun: Awake From A Nightmare")).toBeNull();
    expect(soundtrackPart("Lead.\n== Development ==\nText.\n== Reception ==\nText.", "Lumière")).toBeNull();
  });

  it("builds the track's reference from its part, and drops a caption naming another part", () => {
    const text = gameTrackText({ page: "Genshin Impact", full: "Genshin Impact is a 2020 action role-playing game.", music: { page: "Music of Genshin Impact", full: music } }, "Fontaine: Remuria - Glory and Decay");
    expect(text).toMatch(/London Symphony/);
    expect(text).not.toMatch(/Mondstadt|Philharmonic/);
    rememberArticle("Music of Genshin Impact", music);
    const others = otherParts(text, "Fontaine: Remuria - Glory and Decay");
    const { kept, rejected } = screenClaims(["Medieval European styles inspired the design of the Mondstadt region."], music, { otherParts: others });
    expect(kept).toEqual([]);
    expect(rejected[0].reason).toMatch(/another part/);
  });
});

describe("cause, order and count words must be in the sentence retold", () => {
  const fireEmblem = "Fire Emblem\nMarth and Roy's appearance in Super Smash Bros. Melee, alongside the international success of Advance Wars, is cited as what led to Nintendo localizing The Blazing Blade. Due to its success overseas, the series returned to home consoles.";

  it("drops a cause the source doesn't give", () => {
    expect(unsupportedConnective("Marth and Roy appeared in Super Smash Bros. Melee due to the international success of Advance Wars.", fireEmblem)).toBe("due to");
    const creed = "Assassin's Creed (soundtrack)\nBut he was ultimately replaced by Justin's brother, composer Jed Kurzel. Assassin's Creed is their third film together.";
    expect(unsupportedConnective("Justin's brother Jed Kurzel scored the film for the first time.", creed)).toBe("for the first time");
    expect(unsupportedConnective("The Assassin's Creed film marked Jed Kurzel and Justin Kurzel's third collaboration.", creed)).toBeNull();
  });

  it("drops an invented intention or order", () => {
    const ttfaf = "Through the Fire and Flames\nWhen the band first played the song live, they lacked any acoustic guitars, so it was decided to have keyboardist Vadim Pruzhanov play the acoustic guitar part.";
    expect(unsupportedConnective("The song was originally intended to be performed with only keyboardist Vadim Pruzhanov on acoustic guitar.", ttfaf)).toBe("originally intended");
    const smooth = "Smooth McGroove\nThe band fell apart, and a few years later, Gleason decided to do more music.";
    expect(unsupportedConnective("Gleason's band fell apart after he decided to focus on music full-time.", smooth)).toBe("after");
    const yiruma = "Yiruma\nAfter completing his military service, he made his comeback with a nationwide tour.";
    expect(unsupportedConnective("After completing his military service, Yiruma made his comeback with a nationwide tour.", yiruma)).toBeNull();
  });

  it("drops a count or number the source doesn't give", () => {
    const pressure = "Under Pressure\nIt reached number one on the UK Singles Chart, becoming Queen's second number-one hit in the UK and Bowie's third.";
    expect(unsupportedConnective('"Under Pressure" reached number one on the UK Singles Chart twice.', pressure)).toBe("twice");
    const violet = "Violet Evergarden\nThe album has 6 vocal tracks featuring performances by Aira Yuuki, Minori Chihara, and True.";
    expect(unsupportedConnective("Aira Yuuki performed in 5 of the 6 vocal tracks of the album.", violet)).toBe("5");
    const souvenirs = "Eugénie Rocherolle\nSouvenirs du château includes Une matinée au lavoir, La chapelle, Déjeuner dans la cour, Le donjon, and Le salon de musique.";
    expect(unsupportedConnective('"Souvenirs du château" includes three pieces.', souvenirs)).toBe("three");
    // A number in a name is no count: "Expedition 33", "21 Savage".
    expect(unsupportedConnective("Testard scored Clair Obscur: Expedition 33.", "Music of Clair Obscur: Expedition 33\nTestard scored the game.")).toBeNull();
  });
});

describe("a connective word inside a title is part of the name (#188)", () => {
  const glow = "After Glow (video game)\nThe game was released by Northwind in 1988. It is the fourth cabinet to use a hydraulic motion simulator.";

  it("keeps a fact whose only connective is the article's own title", () => {
    expect(unsupportedConnective("After Glow is the fourth cabinet to use a hydraulic motion simulator.", glow)).toBeNull();
    expect(unsupportedConnective('"After Glow" was released by Northwind in 1988.', glow)).toBeNull();
  });

  it("keeps a title that is quoted or sits mid-sentence", () => {
    expect(unsupportedConnective('Northwind\'s "After Glow" is the fourth cabinet to use a hydraulic motion simulator.', glow)).toBeNull();
    expect(unsupportedConnective("Northwind released After Glow in 1988.", glow)).toBeNull();
  });

  it("keeps a title named by the song request, or found verbatim in the source", () => {
    const artist = "Mira Okafor\nOkafor wrote the theme in 1990. Her album Because of Moonlight came out the same year.";
    expect(unsupportedConnective("Mira Okafor released the album Because of Moonlight in 1990.", artist)).toBeNull();
    expect(unsupportedConnective("The game Before the Storm has a theme written in 1990.", "Music of Northwind\nThe theme was written in 1990.", ["Before the Storm"])).toBeNull();
  });

  it("covers other connective words in titles", () => {
    expect(unsupportedConnective("While You Were Gone has a theme written in 1990.", "While You Were Gone\nThe theme was written in 1990.")).toBeNull();
    expect(unsupportedConnective("Because of You has a theme written in 1990.", "Because of You\nThe theme was written in 1990.")).toBeNull();
    expect(unsupportedConnective("Thanks to You was written in 1990.", "Thanks to You (song)\nIt was written in 1990.")).toBeNull();
  });

  it("still drops a real connective, with or without a title that has the same word", () => {
    expect(unsupportedConnective("The theme was composed after the director died.", glow)).toBe("after");
    expect(unsupportedConnective("After Glow was composed after the director died.", glow)).toBe("after");
    expect(unsupportedConnective("After Glow was released because of the arcade boom.", glow)).toBe("because");
    // A capital letter at the start of a sentence isn't a title.
    expect(unsupportedConnective("After Mira Okafor left Northwind, she wrote the theme.", glow)).toBe("After");
  });

  it("judges the joining word itself, with the title set aside (independent review)", () => {
    const theme = "After Glow (video game)\nThe theme of After Glow was composed by Mira Okafor after the director died.";
    expect(unsupportedConnective("The theme of After Glow was composed by Mira Okafor after the director died.", theme)).toBeNull();
    // A one-word title doesn't blank the word everywhere.
    const because = "Because (song)\nBecause is a 2001 song by Nightjar. The band was short of time and cut it to two minutes.";
    expect(unsupportedConnective("Because the band was short of time, they cut it to two minutes.", because, ["Because"])).not.toBeNull();
  });
});

describe("relationship and role words must be stated for those people", () => {
  it("drops an invented kinship, instrument or 'self-titled'", () => {
    const ware = "I Wanna Be Where You Are\nIt was written by Arthur 'T-Boy' Ross and Leon Ware. Ross, the younger brother of Diana Ross, later wrote for Marvin Gaye.";
    expect(unsupportedRelation("Leon Ware is T-Boy Ross's older brother.", ware)).toBe("brother");
    const aha = "Take On Me\nFuruholmen recalled thinking it was \"quite catchy\". Waaktaar played guitar.";
    expect(unsupportedRelation('The band\'s guitarist Furuholmen recalled thinking it was "quite catchy".', aha)).toBe("guitarist");
    const poison = "Poison (Bell Biv DeVoe song)\nIt was the first single from their debut album of the same name.";
    expect(unsupportedRelation("The group's debut single was released as part of their self-titled debut album.", poison)).toBe("self-titled");
  });

  it("keeps a relationship the source states", () => {
    const creed = "Assassin's Creed (soundtrack)\nBut he was ultimately replaced by Justin's brother, composer Jed Kurzel.";
    expect(unsupportedRelation("Jed Kurzel is Justin's brother.", creed)).toBeNull();
  });
});

describe("credits: partners, and what 'wrote' means", () => {
  it("needs the partners named 'with' a credit to share it in the source", () => {
    const ctx = "When Can I See You\nIt was written by Babyface and co-produced by him along with Antonio Reid and Daryl Simmons.";
    expect(unsupportedCredit('Babyface wrote "When Can I See You" with Antonio Reid and Daryl Simmons.', ctx)).toBe("Antonio Reid");
    expect(unsupportedCredit('Babyface wrote "When Can I See You".', ctx)).toBeNull();
  });

  it("doesn't take writing the story for composing (review)", () => {
    const ctx = "Starfall Tactics\nYasumi Matsuno wrote the story. Hitoshi Sakimoto composed the music.";
    expect(unsupportedCredit("Yasumi Matsuno composed the music for Starfall Tactics.", ctx)).toBe("Yasumi Matsuno");
    expect(unsupportedCredit("Yasumi Matsuno wrote the music for Starfall Tactics.", ctx)).toBe("Yasumi Matsuno");
    expect(unsupportedCredit("Hitoshi Sakimoto composed the music.", ctx)).toBeNull();
    expect(unsupportedCredit("Hitoshi Sakimoto composed the music.", "Starfall Tactics\nThe music was written by Hitoshi Sakimoto.")).toBeNull();
    expect(unsupportedCredit("Hitoshi Sakimoto composed the music.", "Starfall Tactics\nHitoshi Sakimoto wrote the score in a year.")).toBeNull();
  });
});

describe("true facts the screen used to drop", () => {
  const kept = (fact: string, ctx: string) => screenClaims([fact], ctx).kept.length === 1;

  it("reads U+2010 hyphens, middle initials and descriptors before names", () => {
    expect(kept("Satie's music shows Wagner-influenced Impressionism.", "Erik Satie\nHis music shows a Wagner‐influenced Impressionism.")).toBe(true);
    expect(kept("The song was produced by Barry J. Eastmond.", "Somebody Loves You Baby\nThe song was produced by Barry J. Eastmond. It reached number two.")).toBe(true);
    expect(kept("The song was written by Eugene Wilde and Albert Manno.", "Body and Soul\nThe song was written by singer-songwriters Eugene Wilde and Albert Manno.")).toBe(true);
  });

  it("keeps names written in one word with capitals inside", () => {
    expect(kept("Bell Biv DeVoe's song blends new jack swing and hip hop.", "Poison\nPoison is a song by Bell Biv DeVoe that blends new jack swing and hip hop.")).toBe(true);
    expect(kept("Luther Vandross ran a Patti LaBelle fan club as a teenager.", "Luther Vandross\nAs a teenager Vandross ran a Patti LaBelle fan club.")).toBe(true);
    expect(kept("Indila's YouTube clip passed 483 million views.", "Love Story (Indila song)\nIndila's YouTube clip passed 483 million views.")).toBe(true);
  });

  it("takes a maker's view for a fact, and keeps the closer of two near-duplicates", () => {
    expect(kept("Waaktaar considered the song too poppy at first.", "Take On Me\nWaaktaar considered the song too poppy at first.")).toBe(true);
    const ctx = 'Smells Like Teen Spirit\nThe riff resembles that of Boston\'s 1976 hit "More Than a Feeling", although it is not identical.';
    const { kept: both } = screenClaims(
      ['The guitar riff was inspired by Boston\'s 1976 hit "More Than a Feeling".', 'The guitar riff resembles Boston\'s 1976 hit "More Than a Feeling".'],
      ctx
    );
    expect(both).toEqual(['The guitar riff resembles Boston\'s 1976 hit "More Than a Feeling".']);
  });
});

describe("review: platform siblings and shared surnames", () => {
  it("doesn't take a sibling console's name for the console", () => {
    expect(screenClaims(["Starfall came out on the Wii in 2012."], "Starfall\nStarfall was released for the Wii U in 2012.").kept).toEqual([]);
    expect(screenClaims(["Starfall came out on the Wii in 2012."], "Starfall\nStarfall was released for the Wii in 2012 and the Wii U in 2013.").kept).toHaveLength(1);
    expect(platformSupported("PlayStation", "It came out on PlayStation 4.")).toBe(false);
    expect(platformSupported("Game Boy", "It came out on the Game Boy Advance.")).toBe(false);
    expect(platformSupported("Xbox", "It came out on the Xbox 360.")).toBe(false);
    expect(platformSupported("Wii U", "It came out on the Wii U.")).toBe(true);
  });

  it("needs the fact's given name in the role's sentence, unless the source gives the surname alone", () => {
    const ctx = "Starfall\nJohn Williams composed the score. Paul Williams wrote the lyrics.";
    expect(unsupportedCredit("Paul Williams composed the score.", ctx)).toBe("Paul Williams");
    expect(unsupportedCredit("John Williams composed the score.", ctx)).toBeNull();
    expect(unsupportedCredit("Yuzo Koshiro composed the score.", "Starfall\nKoshiro composed the score.")).toBeNull();
  });
});

// Second fact check: each case adapted from a real caption the checkers marked WRONG or MISLEADING,
// with the true captions from the same tables that must stay.
describe("second fact check: words that change what the source says", () => {
  const dropped = (fact: string, ctx: string) => screenClaims([fact], ctx).rejected[0]?.reason ?? null;

  it("drops 'inspired by' when the source says it resembles, and keeps a stated influence", () => {
    const riff = "Neon Static\nThe riff resembles that of Halvorsen's 1976 hit \"Long Way Down\", although it is not identical.";
    expect(unsupportedConnective("The riff was inspired by Halvorsen's 1976 hit \"Long Way Down\".", riff)).toBe("inspired");
    expect(unsupportedConnective("The theme of strength inspired the Giant mechanic.", "Starfall Saga\nThe theme of strength was expressed through the Giant mechanic and folklore.")).toBe("inspired");
    expect(unsupportedConnective("The opera The Lantern inspired the final scene of Winter Roads.", "Ivo Marek\nHis teacher's opera The Lantern became a model for the final scene of Winter Roads.")).toBeNull();
    expect(unsupportedConnective("Mia Chen drew inspiration from Orlov's symphonic suites when composing the desert music.", "Music of Starfall\nMia Chen also took reference from symphonic suites by Orlov for the desert music.")).toBeNull();
  });

  it("drops 'inspiring X to' when the source only says one piece resembles another", () => {
    const ctx = "Anton Weiss\nWeiss's piano music had a strong influence on Moreau; Moreau's Bright Island has clear similarities with Fountains, a piece he heard Weiss perform in 1884.";
    expect(unsupportedConnective("Weiss performed in 1884, inspiring Moreau to write Bright Island.", ctx)).toBe("inspiring Moreau to");
  });

  it("drops 'originally titled' and 'originally a cover' the source doesn't give, and keeps a working title", () => {
    const single = "Golden Hour Ball\nOriginally released two weeks prior on a holiday compilation, the single promoted the duo's forthcoming debut album, Sunsetboulevardmuzik.";
    expect(unsupportedConnective("The duo's debut album was originally titled \"Sunsetboulevardmuzik\".", single)).toBe("originally titled");
    expect(unsupportedConnective("Rain Theory was originally going to be titled by Kai Moreno in December 2016.", "Kai Moreno\nHe announced in December 2016 that it would be titled Rain Theory.")).toBe("going to be titled");
    expect(unsupportedConnective("The track was originally titled \"Luna noua\".", "Dance of May\nThe track was intended to be titled \"Luna noua\", which is the origin of its chorus.")).toBeNull();
    const cover = "Begging You\nNordic duo Skylark recorded a version in 2007. Italian rock band Vespa performed a cover of the song in 2017.";
    expect(unsupportedConnective("Skylark's version was originally a cover of a song by an Italian rock band.", cover)).toBe("originally");
    // "originally from" only says where someone comes from.
    expect(unsupportedConnective("Coral Bloom was originally formed in Motobu, Okinawa.", "Coral Bloom\nCoral Bloom was a Japanese band from Motobu, Okinawa.")).toBeNull();
  });

  it("drops a birth date the source gives as a baptism", () => {
    const ctx = "Ludo Fennimore\nLudo Fennimore (baptised 17 December 1770 – 26 March 1827) was a German composer.";
    expect(unsupportedConnective("Fennimore was born on December 17, 1770, and died on March 26, 1827.", ctx)).toBe("born");
  });

  it("drops 'first' the sentence doesn't have, and finds it in a closely related sentence", () => {
    const ctx = "Ludo Fennimore\nThe 1805 premiere of the symphony received a mixed reception. In 1807, after a performance in Leipzig, the public demanded it to be played again a week later.";
    expect(unsupportedConnective("The public demanded to hear the symphony again just one week after its first performance.", ctx)).toBe("first");
    const pair = "Where You Are\nIt is a song written by Rafe Lyle and Owen Grant. It was the first collaboration between Grant and Lyle.";
    expect(unsupportedConnective("Owen Grant and Rafe Lyle collaborated on their first song together.", pair)).toBeNull();
  });

  it("drops 'A after B' when the source says 'after A, B'", () => {
    const ctx = "Dreamland\nAfter Marisol began writing songs for her new album Daylight, she decided to include the hook from the Ring Ring Club song \"Spark of Love\" in an up-tempo song.";
    expect(unsupportedConnective("Marisol began writing songs for her new album Daylight after deciding to include a hook from \"Spark of Love\".", ctx)).toBe("after (the other way round)");
    expect(dropped("Marisol decided to use the hook from \"Spark of Love\" after she began writing songs for Daylight.", ctx)).toBeNull();
    const studio = "Starship Show\nAfter the original series was canceled, the studio licensed the syndication rights. Studio head Lena Ward was instrumental in approving production of the series.";
    expect(unsupportedConnective("Lena Ward approved production of the original series after presenting a brief treatment.", studio)).toMatch(/^after/);
  });

  it("drops an illustration credit the source gives someone else", () => {
    const ctx = "Letters of Ivy\nLetters of Ivy is a light novel series written by Kana Mizuki and illustrated by Aki Tanabe.";
    expect(unsupportedCredit("Kana Mizuki illustrated the light novel series.", ctx)).toBe("Kana Mizuki");
    expect(unsupportedCredit("Aki Tanabe illustrated the light novel series.", ctx)).toBeNull();
  });

  it("drops a caption about someone's video, but not their video game", () => {
    const ctx = "Somebody Waits\nLike her previous single, the video was shot at the Starlight Theater. Rosa Lind's video game cameo came in 2001.";
    expect(dropped("The Starlight Theater is where Rosa Lind's video was shot.", ctx)).toBe("about the music video");
    expect(dropped("Rosa Lind's video game cameo came in 2001.", ctx)).toBeNull();
  });
});

describe("second fact check: a detail kept without what it belongs to", () => {
  it("drops one chart with the two peaks of two charts", () => {
    const ctx = "Silent Promises\nIt peaked at numbers 15 and 16 on the US Billboard Hot 100 and Cash Box Top 100, and number three on the R&B chart.";
    expect(lostQualifier("\"Silent Promises\" peaked at numbers 15 and 16 on the US Billboard Hot 100.", ctx)).toMatch(/15 and 16/);
    expect(lostQualifier("\"Silent Promises\" peaked at numbers 15 and 16 on the Billboard Hot 100 and Cash Box Top 100.", ctx)).toBeNull();
  });

  it("drops 'her second single' when it's the second single from an album", () => {
    const ctx = "All I Need\nSinger Nadia Rowe released it as the official second single from her third album, Midnight Hours, on December 4, 1990.";
    expect(lostQualifier("Nadia Rowe released \"All I Need\" as her second single.", ctx)).toMatch(/second single/);
    expect(lostQualifier("Nadia Rowe released \"All I Need\" as the second single from her third album.", ctx)).toBeNull();
  });

  it("drops a single's release date given to the album it came from", () => {
    const ctx = "Never Let Go\nIt was released in the United Kingdom on December 4, 1995, as the second single from their self-titled debut album. The album came out in 1996 in the US.";
    expect(lostQualifier("The Harbor Boys' debut album was released in the United Kingdom on December 4, 1995.", ctx)).toMatch(/another release/);
    expect(lostQualifier("\"Never Let Go\" was released in the United Kingdom on December 4, 1995.", ctx)).toBeNull();
    // A year alone is no date to move: many releases share one.
    expect(lostQualifier("Their debut album, Quiet Rooms, was released in 2004.", "Ohio Nights\nIt was the lead single from their debut album, Quiet Rooms, in 2004.")).toBeNull();
  });
});

describe("second fact check: the statement told with another subject", () => {
  it("drops 'the band' for what the source says 'the company' did", () => {
    const ctx = "Until We Fall\nThe label was using Chartwave. The company had a top 20 downloads section, based on data from peer-to-peer networks, which featured \"Until We Fall\".";
    expect(swappedSubject("The band had a top 20 downloads section based on data from peer-to-peer networks.", ctx)).toBe("the band");
    expect(swappedSubject("The company had a top 20 downloads section based on data from peer-to-peer networks.", ctx)).toBeNull();
  });

  it("drops the wrong speaker, and keeps a speaker named before a clause", () => {
    const ctx = "Candy Dance\nAccording to an interview with Ruvo, Spinwheel said the speed-up came from a mixing mistake.";
    expect(swappedSubject("Ruvo said Spinwheel made a mixing mistake that sped up the song.", ctx)).toBe("Ruvo");
    expect(swappedSubject("Spinwheel said the speed-up came from a mixing mistake.", ctx)).toBeNull();
    const clause = "Under Glass\nDrummer Ray Tolland, in an interview for the documentary Days of Our Band, stated that Dean had been playing the riff over and over again.";
    expect(swappedSubject("Ray Tolland stated that Dean played the riff over and over again during sessions.", clause)).toBeNull();
  });

  it("drops a critic's reading told as the composer's intent", () => {
    const ctx = "Star Voyage III\nAmong the new cues Hartley wrote was a percussive and atonal theme for the raiders. Music author Dana Reyes described the cue as a compromise between music from Hartley's earlier film Nightfall and the raiders' old music.";
    expect(unattributedView("A percussive and atonal theme was written for the raiders as a compromise between Hartley's earlier film Nightfall and others.", ctx)).toBe("Reyes");
    expect(unattributedView("Dana Reyes described the raiders' cue as a compromise between Nightfall's music and older themes.", ctx)).toBeNull();
    expect(unattributedView("Hartley wrote a percussive and atonal theme for the raiders.", ctx)).toBeNull();
  });

  it("on another work's article, drops 'The song' or 'The musical' unless the sentence names this track", () => {
    const ctx = "Dana Reyes\nOpening to strong reviews, the show won four stage awards, including Best New Musical. Reyes said Glass Harbor took a week to write. Her song Paper Lanterns reached number two.";
    const opts = { track: "Glass Harbor" };
    expect(screenClaims(["The musical won four stage awards, including Best New Musical."], ctx, opts).rejected[0]?.reason).toBe("doesn't say which musical");
    expect(screenClaims(["The song took a week to write, according to Glass Harbor's writer."], ctx, opts).kept).toHaveLength(1);
    expect(screenClaims(['The song "Paper Lanterns" reached number two.'], ctx, opts).kept).toHaveLength(1);
    // On the track's own article "the song" is this one, small words aside.
    expect(screenClaims(["The song peaked at number two."], "Through the Fire and Flames\nThe song peaked at number two.", { track: "Through the Fire and the Flames" }).kept).toHaveLength(1);
  });

  it("cuts a soundtrack in parts to its general sections for a track named after something it never mentions", () => {
    const music = [
      "Since 2020, the studio has been releasing music soundtracks for Starfall, primarily composed by Mia Chen.",
      "== Windvale ==",
      "The Windvale soundtrack was performed by the Northshore Philharmonic Orchestra with Tom Ziegel as the conductor.",
      "== Stonehold ==",
      "The Stonehold soundtrack draws on folk music.",
      "== Tidemark ==",
      "The Tidemark soundtrack was recorded with the Harbor Symphony Orchestra.",
      "== Musicology and instrumentation ==",
      "The main theme opens with a solo violin.",
      "== Reception ==",
      "It won several awards.",
    ].join("\n");
    const part = soundtrackPart(music, "Kaela: Radiant Dreams");
    expect(part?.heading).toBe("");
    expect(part?.text).toMatch(/solo violin/);
    expect(part?.text).not.toMatch(/Philharmonic|folk|Harbor Symphony/);
    expect(part?.others).toEqual(["Windvale", "Stonehold", "Tidemark"]);
    const text = gameTrackText({ page: "Starfall", full: "Starfall is a 2020 game.", music: { page: "Music of Starfall", full: music } }, "Kaela: Radiant Dreams");
    expect(text).not.toMatch(/Windvale soundtrack|Ziegel/);
    // A track the article does mention, or a composer's article with sections, is left alone.
    expect(soundtrackPart(`${music}\nKaela's theme is in the Stonehold section.`, "Kaela: Radiant Dreams")).toBeNull();
    expect(soundtrackPart("Ivo Marek was a composer.\n== Early life ==\nText.\n== Vienna ==\nText.\n== Later years ==\nText.", "Sonata in A, K. 331: i. Andante")).toBeNull();
  });
});

describe("third fact check: words put in someone's mouth", () => {
  const reason = (fact: string, ctx: string) => screenClaims([fact], ctx).rejected[0]?.reason ?? null;

  it("drops a quote from someone the source only credits", () => {
    const ctx = "Never Let You Go\n\"Never Let You Go\" is a ballad written by singer-songwriters Dana Vale and Ike Morrow. It reached number one on the Adult Contemporary chart.";
    expect(misattributedWords("Dana Vale described the song as a \"very tender\" ballad.", ctx)).toBe("Vale");
    expect(misattributedWords("Dana Vale described the song as a classic.", ctx)).toBe("Vale");
    expect(reason("Dana Vale described the song as a \"very tender\" ballad.", ctx)).toMatch(/doesn't give to Vale/);
    expect(misattributedWords("Dana Vale and Ike Morrow wrote the ballad.", ctx)).toBeNull();
  });

  it("drops a view the source gives no one, or someone else", () => {
    const ctx = "Hold My Breath\nIt was written by Tia Rowe, Kim Bell and Lena Moss. Rowe said the song came together in a day. The members' vocals in \"Hold My Breath\" were described as \"airy\". Critic Sam Hale felt that the vocals were \"too airy\".";
    expect(misattributedWords("Tia Rowe described Lena Moss's vocals in \"Hold My Breath\" as \"airy\".", ctx)).toBe("Rowe");
    expect(misattributedWords("Sam Hale described the vocals as \"too airy\".", ctx)).toBeNull();
    expect(misattributedWords("Tia Rowe said the song came together in a day.", ctx)).toBeNull();
    const narrated = "Raftwork\nThe team was programmer Ole Dahl and artist Ana Berg. To fix it, they introduced the shark as a constant threat. According to Berg, the shark solved other problems too. When they later added islands, they found the shark also helped on reefs.";
    expect(misattributedWords("Ole Dahl described the shark as a constant threat to players.", narrated)).toBe("Dahl");
    // A quote or finding running on from "According to Berg" is still Berg's.
    expect(misattributedWords("Berg said the shark helped on reefs.", narrated)).toBeNull();
  });

  it("keeps a speaker the source gives as a pronoun, a passive or a part of the name", () => {
    expect(misattributedWords("Lio Tessard acknowledged inspiration from French singers.", "Music of Lumen\nLio Tessard scored the game. Since then, he has acknowledged inspiration from French singers.")).toBeNull();
    expect(misattributedWords("Kenji Arata described the series as a student project.", "Ember Crest\nThe series was defined by creator Kenji Arata as a student project.")).toBeNull();
    expect(misattributedWords("Chen Yuwei described the project as a difficult challenge.", "Music of Starfall\nThe studio hired Yu Chen, also known as Chen Yuwei. It was Chen's first major work, and he described the project as a difficult challenge.")).toBeNull();
    expect(misattributedWords("Rui Nobre described his work \"Arcade\" as a Brazilian tango.", "Arcade (Nobre)\n\"Arcade\" is a Brazilian tango written for piano by Rui Nobre. The form of \"Arcade\" is marked by the composer as a \"Brazilian tango\".")).toBeNull();
  });

  it("drops a speaker who only gave the interview", () => {
    const ctx = "Candy Dance\nAccording to an interview with Ruvo, Spinwheel said the speed-up came from a mixing mistake.";
    expect(reason("Ruvo described a mixing mistake as the reason for the speed-up.", ctx)).toMatch(/isn't about "Ruvo"/);
  });
});

describe("third fact check: someone else's doing", () => {
  it("drops a caption opening on a person the retold sentence gives to another", () => {
    const ctx = "Paper Sky\nThe song was first performed on December 2, 1932. Ada Pell recorded a hit version later that year, featuring Bo Hart on trumpet. Nate Cole recorded it in 1943.";
    expect(otherDoer("Nate Cole recorded a hit version of the song featuring Bo Hart on trumpet.", ctx)).toBe("Ada Pell");
    expect(otherDoer("Ada Pell recorded a hit version featuring Bo Hart on trumpet.", ctx)).toBeNull();
    const lead = "Shadow Ops\nIn 2003, during the filming in Sydney, Mara Quill, the effects supervisor, pitched an episode for the unmade series Underground.";
    expect(otherDoer("Dale Ortiz had pitched an episode of Underground in 2003.", lead)).toBe("Mara Quill");
  });

  it("keeps a caption whose retold sentence opens on the work it names", () => {
    const ctx = "Music of Starfall\nForest of Ash, the fourth album, came out in 2022. Other musicians included Gu Lan on the bansuri.";
    expect(otherDoer("Gu Lan played the bansuri on Forest of Ash.", ctx)).toBeNull();
  });

  it("drops a role turned round", () => {
    const ctx = "Music of Starfall\nThe vocals of Juno's voice actor Kai Moreno were recorded at the Harbor Opera House.";
    expect(reversedRole("The vocals of Kai Moreno's voice actor were recorded at the Harbor Opera House.", ctx)).toBe("voice actor");
    expect(reversedRole("The vocals of Juno's voice actor were recorded at the Harbor Opera House.", ctx)).toBeNull();
  });
});

describe("third fact check: unnamed references", () => {
  it("drops 'the duo' or 'the quartet' the source's subject isn't", () => {
    const ctx = "Ari Song\nAri Song is a South Korean pianist. From 2010 he presented a radio show alongside singer Bo Kim. The duo initially raised eyebrows.";
    expect(unnamedReference("The duo initially raised eyebrows due to their different backgrounds.", ctx)).toBe("the duo");
    expect(unnamedReference("Ari Song and Bo Kim initially raised eyebrows as hosts.", ctx)).toBeNull();
  });

  it("keeps 'the band' or 'the group' when the source's subject is one", () => {
    expect(unnamedReference("The group is signed to Kioto Records.", "Home Grown\nHome Grown is a Japanese hip hop trio from Nagoya. They are signed to Kioto Records.")).toBeNull();
    expect(unnamedReference("The band chose a studio in London.", "Take It\n\"Take It\" is a song by the Norwegian band Northline.")).toBeNull();
  });

  it("drops 'this chart'", () => {
    const ctx = "Violet Rain\nOn the US World chart the song peaked at number 8, becoming their second top 10 hit.";
    expect(unnamedReference("This was their second top-ten hit on this chart.", ctx)).toBe("this chart");
    expect(unnamedReference("It was their second top-ten hit on the US World chart.", ctx)).toBeNull();
  });
});

describe("third fact check: hedges, years and owners", () => {
  it("drops a hedge the caption leaves out, but not one inside someone's quote", () => {
    const ctx = "Ivo Marek\nThe idea of a symphony on the general's career may have been suggested to Marek by Count Ardent in 1798. His Concerto No. 9 is sometimes described as a breakthrough; Lee Rosen called it \"perhaps the first masterpiece\".";
    expect(droppedHedge("Count Ardent suggested Marek write a symphony on the general's career in 1798.", ctx)).toBe("may have");
    expect(droppedHedge("Count Ardent may have suggested the symphony to Marek in 1798.", ctx)).toBeNull();
    expect(droppedHedge("Lee Rosen described Marek's Concerto No. 9 as a breakthrough.", ctx)).toBeNull();
  });

  it("drops a year the retold sentence doesn't place there", () => {
    const ctx = "Ivo Marek\nWhen the symphony premiered in early 1805 it got a mixed reception. Some listeners disliked its length. In 1807, after a concert in Leipzig, the public demanded it again a week later.";
    expect(misplacedYear("The public demanded the symphony again a week after its premiere in 1805.", ctx)).toBe("1805");
    expect(misplacedYear("In 1807 the public in Leipzig demanded the symphony again a week later.", ctx)).toBeNull();
    const after = "Arcade (Nobre)\n\"Arcade\" is a tango written by Rui Nobre. Written in 1909, it is his most popular work.";
    expect(misplacedYear("Rui Nobre wrote \"Arcade\" in 1909.", after)).toBeNull();
    const clauses = "Rolling Hills\nIn 2011, it was reportedly the biggest crossover hit since 1985; \"Rolling Hills\" gained airplay from many radio formats.";
    expect(misplacedYear("The song gained airplay from many radio formats since 1985.", clauses)).toBe("1985");
  });

  it("drops a detail the source gives the video, the single or the release", () => {
    expect(wrongOwner("The song was inspired by the 1998 film Fangs.", "Wall Run\nThe music video for \"Wall Run\" was inspired by the 1998 film Fangs.")).toBe("the music video");
    expect(wrongOwner("The song topped the Hot 100.", "Take It\nIn October 1985, the single topped the Hot 100, helped by the wide exposure of its music video.")).toBeNull();
    const sales = "Big Ball\nIt was the lead single from their debut album, Southern Nights. The single was certified gold in 1994, selling over 500,000 copies.";
    expect(wrongOwner("Their debut album Southern Nights sold over 500,000 copies.", sales)).toBe("the single");
    expect(wrongOwner("The single sold over 500,000 copies.", sales)).toBeNull();
    const radio = "Last Day\n\"Last Day\" was released to radio on August 12, 2003 and charted at number 12 on the Alternative Songs chart.";
    expect(wrongOwner("The song charted at number 12 on the Alternative Songs chart in August 2003.", radio)).toMatch(/release/);
    expect(wrongOwner("The song was released to radio in August 2003.", radio)).toBeNull();
  });

  it("drops an EP's date that is the single's", () => {
    const ctx = "Jungle Dance\n\"Jungle Dance\" is a song by Kira Vale, released on 10 May 2019 as the second single from Kira Vale's debut EP, The Young Ones.";
    expect(lostQualifier("Kira Vale released her debut EP \"The Young Ones\" on 10 May 2019.", ctx)).toMatch(/not the EP/);
    expect(lostQualifier("\"Jungle Dance\" was released on 10 May 2019.", ctx)).toBeNull();
  });

  it("drops an exception the caption explains on its own", () => {
    const ctx = "Max Groove\nHe sided against modern game music, saying it serves a more atmospheric role. He noted that the Ember Saga series was an exception.";
    expect(suppliedException("The Ember Saga series is an exception to his preference for atmospheric soundtracks.", ctx)).toBe(true);
    expect(suppliedException("He noted that the Ember Saga series was an exception.", ctx)).toBe(false);
  });

  it("drops a cause turned round from a 'when' clause, and a co-producer made a co-writer", () => {
    const ctx = "Venom\nThe song was meant for Eli Straite, but plans changed when the members of the trio heard his demo version.";
    expect(screenClaims(["The members of the trio heard Straite's demo version after plans changed."], ctx).rejected[0]?.reason).toMatch(/turns round/);
    expect(screenClaims(["Plans changed after the members of the trio heard Straite's demo version."], ctx).kept).toHaveLength(1);
    const credit = "See You\nIt was written by Kenny Lane and co-produced by him along with Tony Reid and Daryl Sim.";
    expect(screenClaims(["Kenny Lane wrote the song along with co-producer Tony Reid."], credit).rejected[0]?.reason).toMatch(/Tony Reid/);
  });
});

describe("supportingSentence", () => {
  it("finds the sentence a caption retells, ignoring our own bracketed explanations", () => {
    const context = "Night Drive\nThe song was recorded in one take at a small studio in Leeds. It reached number four.";
    expect(supportingSentence("The song was recorded in one take (a single continuous performance) in Leeds.", context)).toBe(
      "The song was recorded in one take at a small studio in Leeds."
    );
  });

  it("stays fast on text built to slow a pattern down (code scanning alert)", () => {
    const context = "Night Drive\nThe song was recorded in one take at a small studio in Leeds.";
    const start = Date.now();
    supportingSentence(`${" ".repeat(50_000)}(${"(".repeat(50_000)}`, context);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("unattributed speakers and dates (fourth fact check)", () => {
  const ref = 'Glass Harbor\n"Glass Harbor" is a song by Dana Reyes, released on 3 May 1994. Reyes said: "Somewhere between an hour and two, I had the whole thing written."';

  it("drops a caption that opens in someone's own words with no one named", () => {
    const { kept, rejected } = screenClaims(["I had the whole thing written somewhere between an hour and two."], ref);
    expect(kept).toEqual([]);
    expect(rejected[0].reason).toBe("doesn't say who is speaking");
    // A title that starts with "I" is no speaker.
    expect(screenClaims(["I Wanna Stay was the B-side of Glass Harbor in 1994."], "Glass Harbor\nI Wanna Stay was the B-side of Glass Harbor in 1994.").kept).toHaveLength(1);
  });

  it("drops a day or month the source doesn't give, though the year is there", () => {
    expect(unsupportedDay("Glass Harbor came out on November 22, 1994.", ref)).toBe("November 22");
    expect(unsupportedDay("Glass Harbor came out in November 1994.", ref)).toBe("November");
    expect(unsupportedDay("Glass Harbor came out on May 3, 1994.", ref)).toBeNull();
    expect(unsupportedDay("Glass Harbor came out on the 3rd of May 1994.", ref)).toBeNull();
    expect(unsupportedDay("Reyes may have written it in an hour.", ref)).toBeNull();
    expect(screenClaims(["Glass Harbor was released on November 22, 1994."], ref).rejected[0].reason).toBe('unsupported date "November 22"');
  });
});

describe("a month told without its year", () => {
  const ref = "Pine Lantern\nIn January 2010, Ada and Bo regrouped as Pine Lantern. The duo played their first show on June 22, 2011. Their tour began in March and ended in May.";

  it("drops a caption with the month but not the year the source gives it with", () => {
    expect(droppedYear("Ada and Bo regrouped as Pine Lantern in January.", ref)).toBe("January 2010");
    expect(droppedYear("The duo played their first show on June 22.", ref)).toBe("June 2011");
    expect(droppedYear("The duo played their first show on 22 June.", "Pine Lantern\nThe duo played their first show on 22 June 2011.")).toBe("June 2011");
    expect(screenClaims(["Ada and Bo regrouped as Pine Lantern in January."], ref).rejected[0].reason).toMatch(/month but not the year.*January 2010/);
  });

  it("keeps a caption that gives the year, or a month the source gives alone", () => {
    expect(droppedYear("Ada and Bo regrouped as Pine Lantern in January 2010.", ref)).toBeNull();
    expect(droppedYear("In 2010, Ada and Bo regrouped as Pine Lantern in January.", ref)).toBeNull();
    expect(droppedYear("The duo played their first show on June 22, 2011.", ref)).toBeNull();
    expect(droppedYear("The Pine Lantern tour began in March and ended in May.", ref)).toBeNull();
    expect(screenClaims(["The Pine Lantern tour began in March and ended in May."], ref).kept).toHaveLength(1);
  });
});

describe("cite the sentence (fourth fact check)", () => {
  const context = [
    "Paper Lanterns",
    "From the people who made it: Ada Pell considered the song too slow, but Rui Moreno recalled thinking it was \"quite catchy\".",
    "",
    "Recording: The band signed with Tom Hale, who introduced them to manager Lena Voss. With this encouragement, the band completed some songs. Kit Arden, who was paid $3,000 for his work, said that he arranged the strings based on Moreno's demos.",
    "\"Paper Lanterns\" is a song by the trio Northlight, composed by series composer Ada Pell. Ivo Brandt recorded a hit version in October 1933.",
  ].join("\n");
  const sentences = referenceSentences(context);
  const screen = (lines: string[]) => screenClaims(lines, context, { cited: true, artists: ["northlight"] });

  it("numbers every sentence for the model, labels on lines of their own", () => {
    const numbered = numberedReference(context).split("\n");
    expect(numbered[0]).toBe("Paper Lanterns");
    expect(numbered[1]).toBe("From the people who made it:");
    expect(numbered[2]).toMatch(/^\[1\] Ada Pell considered/);
    expect(numbered).toContain("[2] Recording: The band signed with Tom Hale, who introduced them to manager Lena Voss.");
    expect(numbered.filter((l) => /^\[\d+\]/.test(l))).toHaveLength(sentences.length);
    expect(sentences[4]).toBe('"Paper Lanterns" is a song by the trio Northlight, composed by series composer Ada Pell.');
  });

  it("reads the sentence number in the forms a small model writes", () => {
    expect(parseCitation("4 | The caption.")).toEqual({ at: 4, text: "The caption." });
    expect(parseCitation("[4] The caption.")).toEqual({ at: 4, text: "The caption." });
    expect(parseCitation("1. 4 | The caption.")).toEqual({ at: 4, text: "The caption." });
    expect(parseCitation("The caption.")).toEqual({ at: 0, text: "The caption." });
    expect(parseCitation("1985 was the year.").at).toBe(0);
  });

  it("keeps true captions, including a name from the sentence before and a second clause's subject", () => {
    const { kept, rejected, sources } = screen([
      "1 | Rui Moreno recalled thinking Paper Lanterns was quite catchy.",
      "3 | With Tom Hale's encouragement, Northlight completed some songs.",
      "5 | Paper Lanterns was composed by series composer Ada Pell.",
    ]);
    expect(rejected).toEqual([]);
    expect(kept).toHaveLength(3);
    expect(sources?.get(kept[2])).toBe(sentences[4]);
  });

  it("drops a caption with no sentence number, or one the reference doesn't have", () => {
    expect(screen(["Paper Lanterns was composed by series composer Ada Pell."]).rejected[0].reason).toBe("doesn't say which sentence it retells");
    expect(screen(["40 | Paper Lanterns was composed by series composer Ada Pell."]).rejected[0].reason).toMatch(/^cites sentence 40/);
  });

  it("drops a name, number or year from another sentence", () => {
    // Merged across sentences: the hit version was Brandt's, and Hale isn't in its sentence.
    expect(screen(["6 | Tom Hale recorded a hit version of Paper Lanterns in October 1933."]).rejected[0].reason).toBe('"Tom" isn\'t in the sentence it cites');
    expect(screen(["3 | The band completed three songs with this encouragement."]).rejected[0].reason).toBe('"three" isn\'t in the sentence it cites');
  });

  it("drops a first, or words, the sentence doesn't give", () => {
    expect(screen(["5 | Paper Lanterns was the first song composed by series composer Ada Pell."]).rejected[0].reason).toBe('"first" isn\'t in the sentence it cites');
    expect(screen(["5 | Ada Pell said Paper Lanterns was a song for the trio Northlight."]).rejected[0].reason).toBe("the sentence it cites doesn't give Pell's words");
  });

  it("drops a caption that gives the sentence's doing to someone it only mentions", () => {
    // The fee was Arden's; Moreno only made the demos.
    expect(screen(["4 | Moreno was paid $3,000 for his work on the strings."]).rejected[0].reason).toBe("the sentence it cites is about Kit Arden");
    // The introduction was Hale's.
    expect(screen(["2 | Lena Voss introduced the band to manager Tom Hale."]).rejected[0].reason).toBe("the sentence it cites is about Tom Hale");
  });

  it("reads a number one off from the line it clearly retells as that line", () => {
    // Sentence 5 cited for sentence 6: the model joined two sentences earlier and counts one short.
    const { kept, sources } = screen(["5 | Ivo Brandt recorded a hit version of Paper Lanterns in October 1933."]);
    expect(kept).toHaveLength(1);
    expect(sources?.get(kept[0])).toBe(sentences[5]);
  });

  it("never takes a heading or a word that only starts the sentence for its first-named person", () => {
    const ref = "Night Song\nRecording and production: Dana Reyes recorded the song in Leeds. Written in 1909, it was taken up by Ivo Brandt in his concerts.";
    const cited = (line: string) => screenClaims([line], ref, { cited: true });
    expect(cited("1 | Dana Reyes recorded the song in Leeds.").kept).toHaveLength(1);
    expect(cited("2 | Ivo Brandt took the song up in his concerts in 1909.").kept).toHaveLength(1);
    // A surname in the sentence and the full name elsewhere in the reference.
    expect(screenClaims(["2 | Dana Reyes took it up in her concerts."], "Night Song\nDana Reyes wrote it. Reyes took it up in her concerts.", { cited: true }).kept).toHaveLength(1);
  });

  it("drops a caption that barely shares a word with the sentence it cites", () => {
    expect(screen(["1 | Paper Lanterns was recorded in October 1933 as a hit version."]).rejected[0].reason).toBe("doesn't retell the sentence it cites");
  });

  it("checks the caption against the cited sentence only, not the closest one", () => {
    expect(citedMismatch("Ivo Brandt recorded a hit version in October 1933.", sentences, 5, "Paper Lanterns")).toBeNull();
    expect(citedMismatch("Ivo Brandt recorded a hit version in October 1933.", sentences, 4, "Paper Lanterns")).not.toBeNull();
  });
});

describe("true captions the screen dropped (#206, #207)", () => {
  it("reads every day in a list like 3 and 5 June", () => {
    const ref = "Nightjar\nThe EP was released on 3 and 5 June 2001, and again on July 8, 9 and 10.";
    expect(unsupportedDay("The EP came out on June 3, 2001.", ref)).toBeNull();
    expect(unsupportedDay("The EP came out again on July 9.", ref)).toBeNull();
    expect(unsupportedDay("The EP came out on June 4, 2001.", ref)).toBe("June 4");
    expect(unsupportedDay("The EP came out on June 5.", "Nightjar\nShows ran on June 3, 4, and 5.")).toBeNull();
    // A comma alone isn't a list of days.
    expect(unsupportedDay("On July 4, 10,000 fans came.", "Nightjar\nOn July 4, 10,000 fans came to the show.")).toBeNull();
    expect(unsupportedDay("The band played on June 20.", "Nightjar\nOn June 3, 20 people heard the band.")).toBe("June 20");
  });

  it("keeps a caption that opens with the song's title, and still drops unnamed first-person words", () => {
    const ref = "My Glass Harbor\nMy Glass Harbor is a 2019 song by Dana Reyes. It was released as a single in 2019.";
    const reasons = (fact: string) => screenClaims([fact], ref, { track: "My Glass Harbor" }).rejected.map((r) => r.reason);
    expect(reasons("My glass harbor was released as a single in 2019.")).not.toContain("doesn't say who is speaking");
    expect(reasons("My heart was in it from the first take.")).toContain("doesn't say who is speaking");
    // The whole title, not just its first words.
    const longer = "My Glass Harbor Lights\nMy Glass Harbor Lights is a 2019 song by Dana Reyes.";
    expect(screenClaims(["My glass was broken when we finished it."], longer).rejected.map((r) => r.reason)).toContain("doesn't say who is speaking");
  });
});

describe("artist fields that mean no artist (issue #261)", () => {
  const NO_ARTIST = ["Traditional", "Trad.", "Trad", "Anon.", "Anon", "Anonymous", "Unknown", "Folk", "TRADITIONAL", " anonymous. "];
  const REAL_ARTISTS = ["Folk Lanterns", "The Unknown Harbor", "Anonymous Choir", "Traditional Revival Band", "Unknown Mortal Orchestra"];

  it("recognizes each value, whole field only", () => {
    for (const a of NO_ARTIST) expect(hasNoArtist(a)).toBe(true);
    for (const a of REAL_ARTISTS) expect(hasNoArtist(a)).toBe(false);
    expect(hasNoArtist("")).toBe(false);
    expect(hasNoArtist(undefined)).toBe(false);
  });

  it("gives no names to look for or require in an article", () => {
    for (const a of NO_ARTIST) expect(artistNames(a)).toEqual([]);
    expect(artistNames("Folk Lanterns")).toEqual(["folk lanterns"]);
    expect(artistNames("The Unknown Harbor")).toEqual(["the unknown harbor"]);
  });

  it("reads the title alone, never the value as the game", () => {
    for (const a of NO_ARTIST) expect(resolveGameAndTrack({ title: "Marigold Lane", artist: a })).toEqual({ game: "Marigold Lane", track: "Marigold Lane" });
    expect(resolveGameAndTrack({ title: "Marigold Lane", artist: "Folk Lanterns" })).toEqual({ game: "Folk Lanterns", track: "Marigold Lane" });
    expect(resolveGameAndTrack({ title: "Marigold Lane", artist: "The Unknown Harbor" })).toEqual({ game: "The Unknown Harbor", track: "Marigold Lane" });
  });

  it("looks the song up by its title alone, and a real artist stays an artist", () => {
    for (const a of NO_ARTIST.filter((x) => !/^unknown$/i.test(x.trim()))) {
      expect(readings({ title: "Marigold Lane", artist: a })).toEqual([{ game: "", track: "Marigold Lane", songAlone: true }]);
    }
    expect(readings({ title: "Marigold Lane", artist: "Folk Lanterns" })).toEqual([{ game: "Folk Lanterns", track: "Marigold Lane" }]);
    expect(readings({ title: "Marigold Lane", artist: "The Unknown Harbor" })).toEqual([{ game: "The Unknown Harbor", track: "Marigold Lane" }]);
  });

  it("does not count the value as a name a caption repeats", () => {
    expect(restatesRequest("Marigold Lane is a traditional song.", { title: "Marigold Lane", artist: "Traditional" })).toBe(false);
    expect(restatesRequest("Folk Lanterns wrote Marigold Lane.", { title: "Marigold Lane", artist: "Folk Lanterns" })).toBe(true);
  });
});

describe("a bubble names what it's about", () => {
  const artistCtx =
    "Ada Penn\nAda Penn is a composer from Lisbon. She wrote twelve symphonies and four operas. The symphonies are spread evenly through her career. " +
    "This was loosely based on the harbor at night. This theme draws on old harbor songs. Her song Glass Harbor was written in 1984.";
  const reasons = (fact: string, ctx = artistCtx, track: string | undefined = "Glass Harbor") => screenClaims([fact], ctx, { track }).rejected.map((r) => r.reason);

  it("drops works with no one named, a bare 'this', and 'this theme' on another work's article", () => {
    expect(reasons("The symphonies are spread evenly through her career.")).toEqual(["doesn't say whose symphonies"]);
    expect(reasons("This was loosely based on the harbor at night.")).toEqual([`doesn't say what "this" is`]);
    expect(reasons("This theme draws on old harbor songs.")).toEqual(["doesn't say which theme"]);
  });

  it("drops a 'his' or 'her' with nobody named for it", () => {
    expect(unresolvedPronoun("The song was written while he was on tour.")).toBe("he");
    expect(unresolvedPronoun("The symphonies are spread evenly through her career.")).toBe("her");
    expect(reasons("The song was written in 1984 for her brother.", "Glass Harbor\nGlass Harbor is a song written in 1984 by Ada Penn for her brother.", undefined)).toEqual([`doesn't say who "her" is`]);
  });

  it("keeps captions that name their subject, or are about the requested song", () => {
    const own = "Glass Harbor\nGlass Harbor is a song written in 1984 by Ada Penn. Its composer, Ada Penn, wrote it for her brother. This theme draws on old harbor songs.";
    expect(screenClaims(["The song was written in 1984."], own).kept).toHaveLength(1);
    expect(screenClaims(["Its composer, Ada Penn, wrote it for her brother."], own).kept).toHaveLength(1);
    // On the song's own article, "this theme" is the requested one.
    expect(screenClaims(["This theme draws on old harbor songs."], own).kept).toHaveLength(1);
    expect(reasons("Ada Penn's symphonies are spread evenly through her career.")).toEqual([]);
    expect(unresolvedPronoun("Ada Penn wrote it for her brother.")).toBeNull();
    expect(unresolvedPronoun("The song's narrator loses his way home.")).toBeNull();
    expect(unresolvedPronoun("“Her Glass Harbor” was written in 1984.")).toBeNull();
  });
});

describe("companyHistory", () => {
  it("finds a company's deals, buyouts, renamings and console news", () => {
    expect(companyHistory("Northwind Media signed a five-year deal with Halcyon Pictures to make games based on the Skyreach licence.")).toBe(true);
    expect(companyHistory("Lumen Works purchased Brightwater Studios and was soon renamed Lumen North.")).toBe(true);
    expect(companyHistory("Brightwater Studios was renamed Lumen North in 2003.")).toBe(true);
    expect(companyHistory("The next-generation console was announced to be the Orbis.")).toBe(true);
    expect(companyHistory("Skyreach was announced alongside the next-generation console.")).toBe(true);
  });

  it("leaves the music and the requested work alone", () => {
    expect(companyHistory("The band signed a record deal with Harbor Records in 1984.")).toBe(false);
    expect(companyHistory("Ada Penn reached an agreement with Leo Marsh to record the album.")).toBe(false);
    expect(companyHistory("The game was announced for the Orbis console in 2001.")).toBe(false);
    expect(companyHistory("The song was renamed Glass Harbor before its release.")).toBe(false);
    expect(companyHistory("Skyreach was announced alongside the next-generation console.", ["Skyreach"])).toBe(false);
  });

  it("is a reason screenClaims drops a caption", () => {
    const ctx =
      "Skyreach (video game)\nSkyreach is a 2001 platform game developed by Lumen North. Northwind Media signed a five-year deal with Halcyon Pictures to make games based on the Skyreach licence. " +
      "The game's music was composed by Ada Penn.";
    const { kept, rejected } = screenClaims(
      ["Northwind Media signed a five-year deal with Halcyon Pictures to make games based on the Skyreach licence.", "The game's music was composed by Ada Penn."],
      ctx,
      { track: "Glass Harbor" }
    );
    expect(rejected.map((r) => r.reason)).toEqual(["a company's business, not the music"]);
    expect(kept).toEqual(["The game's music was composed by Ada Penn."]);
  });
});

describe("captions that lean on the sentence around them", () => {
  const titles = ["Paper Lanterns", "Moth Hour"];
  it("drops a count that points at a sentence not on screen", () => {
    expect(leftBehindReferent("Jo Vance's \"Hello\" held it off the top for the first of these three weeks.", titles)).toBe("these three weeks");
    expect(leftBehindReferent("A rival single held it off the top for the next two weeks.", titles)).toBe("the next two weeks");
  });
  it("keeps a period the caption itself sets up", () => {
    expect(leftBehindReferent("Paper Lanterns spent three weeks at number one.", titles)).toBeNull();
    expect(leftBehindReferent("It was recorded over the last two days of March.", titles)).toBeNull();
  });
  it("drops a dated recording nobody performs", () => {
    expect(leftBehindReferent("The 1937 recording lasted 8 minutes.", titles)).toBe("The 1937 recording");
    expect(leftBehindReferent("The 1937 recording by Jo Vance lasted 8 minutes.", titles)).toBeNull();
  });
  it("drops a sales total with no product", () => {
    expect(leftBehindReferent("By March 2017, total sales reached 1.3 million copies.", titles)).toBe("total sales");
    expect(leftBehindReferent("By March 2017, total sales of Paper Lanterns reached 1.3 million.", titles)).toBeNull();
  });
  it("drops a film nobody names, unless the request is that film", () => {
    expect(leftBehindReferent("Bo Lind shot the film in ten days.", titles)).toBe("the film");
    expect(leftBehindReferent("The film was shot in ten days.", ["Paper Lanterns"], ["Paper Lanterns"])).toBeNull();
    expect(leftBehindReferent("Bo Lind shot the film \"Moth Hour\" in ten days.", titles)).toBeNull();
  });
});

describe("two statements told as one", () => {
  const context = "Lamp Street\nLamp Street is a band. It was formed in 1976 by Ann Roe and Bo Lind, who formed a production and songwriting team known as Roe & Lind. Roe began her career in 1963, after forming the group Sparrows with Cy Hale.";
  it("drops a year from the other clause", () => {
    expect(mergedClauses("Ann Roe and Bo Lind formed a production and songwriting team in 1976.", context)).toBe("1976");
    expect(mergedClauses("Roe formed the group Sparrows with Cy Hale in 1963.", context)).toBe("1963");
  });
  it("keeps a caption that stays in one clause", () => {
    expect(mergedClauses("Ann Roe and Bo Lind formed a production and songwriting team.", context)).toBeNull();
    expect(mergedClauses("Roe began her career in 1963.", context)).toBeNull();
  });
});

describe("a section about another recording", () => {
  const context = "Moth Hour\n\"Moth Hour\" is a song by Lamp Street.\n\nBo Lind version: It was the second of two singles from his LP.\n\nB-sides: \"Tin Cup\" was played live a few times during 2004.\n\nLamp Street version: It was their first hit single in Norway.";
  it("drops what the heading makes another recording's", () => {
    expect(otherRecordingSection("\"Moth Hour\" was the second of two singles from his LP.", context, ["lamp street"])).toBe("Bo Lind version");
    expect(otherRecordingSection("\"Tin Cup\" was played live a few times during 2004.", context, ["lamp street"])).toBe("B-sides");
  });
  it("keeps the requested artist's own section and a caption naming the performer", () => {
    expect(otherRecordingSection("\"Moth Hour\" was their first hit single in Norway.", context, ["lamp street"])).toBeNull();
    expect(otherRecordingSection("Bo Lind's version was the second of two singles from his LP.", context, ["lamp street"])).toBeNull();
  });
});

describe("what a retelling must keep", () => {
  it("keeps partial credit and being credited", () => {
    const context = "Moth Hour\nDrums were provided in part by Cy Hale on the recording. The band is credited with advancing the sound of folk rock.";
    expect(droppedHedge("Drums were provided by Cy Hale on the recording.", context)).toBe("in part");
    expect(droppedHedge("The band advanced the sound of folk rock.", context)).toBe("is credited with");
  });
  it("keeps both halves of a pair", () => {
    const context = "Moth Hour\nMore than a thousand recordings were released by jazz and pop musicians around the world.";
    expect(lostQualifier("More than a thousand recordings were released by jazz musicians.", context)).toContain("pop");
    expect(lostQualifier("More than a thousand recordings were released by jazz and pop musicians.", context)).toBeNull();
  });
  it("keeps a comparison", () => {
    const context = "Moth Hour\nThe album stayed at number one for longer than any record for 13 years.";
    expect(lostQualifier("The album stayed at number one for 13 years.", context)).toBe("drops what it's compared with");
  });
  it("does not lift the tail of a quote with no speaker", () => {
    const context = "Moth Hour\nAnn Roe said \"It is a letter home. In essence, a reminder of what the road can do to a person.\"\n\nThe band toured Norway that spring.";
    expect(lostQualifier("In essence, a reminder of what the road can do to a person.", context)).toBe("someone's words, without who said them");
  });
  it("does not swap in another edition", () => {
    const context = "Moth Hour\nExe:Dawn[st] came out in 2017. Halo Works later published this version on Steam in 2018. Exe:Dawn[cl] was nominated at the Game Awards.";
    expect(lostQualifier("Halo Works published Exe:Dawn on Steam in 2018.", context)).toBe("doesn't say which version");
    expect(lostQualifier("Exe:Dawn was nominated at the Game Awards.", context)).toContain("cuts another edition");
  });
  it("puts back a region that opens the sentence", () => {
    const context = "Moth Hour\nSales: In the United States, Moth Hour sold 620,000 copies by August 2006.";
    expect(repairScope("Moth Hour sold 620,000 copies by August 2006.", context)).toBe("In the United States, Moth Hour sold 620,000 copies by August 2006.");
  });
});

describe("a remake's article for the original's track", () => {
  it("is unsure, so no AI captions", () => {
    const grounding = "Orbit: Reforged\nOrbit: Reforged is a 2026 action game. It is a remake of Orbit: First Light, released in 2001, with new visuals.";
    expect(workMatchConfidence({ title: "Starfall", artist: "Orbit: First Light" } as never, grounding).level).toBe("unsure");
  });
});

describe("captions that lose their context", () => {
  it("keeps whose account it is", () => {
    const context = "Paper Moons\n\"Paper Moons\" is a song by Tin Sail. According to Dale Hart, the song was written as a result of a quarrel with his brother.";
    expect(droppedFrame("Dale Hart wrote the song as a result of a quarrel with his brother.", context)).toBe("according to Dale Hart");
    expect(droppedFrame("Dale Hart said the song came from a quarrel with his brother.", context)).toBeNull();
  });

  it("keeps the work a sentence opens on", () => {
    const context = "Lena Moss\nLena Moss appears across the series. In Night Harbor Returns, Lena's ghost is seen as a face in the window, an effect made with a mirror.";
    expect(droppedFrame("Lena's ghost is seen as a face in the window.", context)).toBe("Night Harbor Returns");
    expect(droppedFrame("In Night Harbor Returns, Lena's ghost is seen as a face in the window.", context)).toBeNull();
    expect(droppedFrame("Lena's ghost is seen as a face in the window.", context, ["Night Harbor Returns"])).toBeNull();
  });

  it("leaves a place that opens a sentence to the scope repair", () => {
    const context = "Moth Hour\nIn Nashville, Moth Hour was recorded over three days in a converted barn.";
    expect(droppedFrame("Moth Hour was recorded over three days in a converted barn.", context)).toBeNull();
  });

  it("keeps a moment the sentence before set", () => {
    const context = "Moth Hour\nLater shows: By this era the touring band was using four backing singers.";
    expect(droppedFrame("The touring band used four backing singers.", context)).toBe("By this era");
    expect(droppedFrame("By 1998 the touring band used four backing singers.", context)).toBeNull();
  });

  it("keeps a limit that points back", () => {
    const context = "Moth Hour\nIt set a record on the Alt Songs chart. It was the second-most played song of the 2010s decade on the format.";
    expect(droppedLimit("\"Moth Hour\" was the second-most played song of the 2010s decade.", context)).toBe("on the format");
    expect(droppedLimit("\"Moth Hour\" was the second-most played song of the 2010s decade on the format.", context)).toBeNull();
  });

  it("keeps a remake or an adaptation", () => {
    const context = "Moth Hour\nThe song was featured in the 2019 film adaptation, performed by Ana Bell and Rui Costa.";
    expect(droppedLimit("The song was performed by Ana Bell and Rui Costa in 2019.", context)).toBe("film adaptation");
    expect(droppedLimit("In the 2019 film adaptation, the song was performed by Ana Bell and Rui Costa.", context)).toBeNull();
  });

  it("keeps who a ranking is from", () => {
    const context = "Snow Bells\nIt was among the top 25 most-performed holiday songs written by ASCAP members.";
    expect(droppedLimit("\"Snow Bells\" is one of the top 25 most-performed holiday songs.", context)).toBe("by ASCAP");
  });

  it("keeps \"respectively\" with a pair of records", () => {
    const context = "Tin Sail\nThe band found success, with Lanterns and Blue Door certified platinum six times and gold in the United States, respectively.";
    expect(droppedLimit("Lanterns and Blue Door were certified platinum six times in the United States.", context)).toBe("respectively");
    expect(droppedLimit("Blue Door was certified gold in the United States.", context)).toBeNull();
  });

  it("keeps a pairing, and someone else's version", () => {
    const pair = "Moth Hour\nThe song was the theme for the Night Slam match between Ana Bell and Rui Costa.";
    expect(droppedLimit("The song was the theme for the Night Slam match.", pair)).toBe("between Ana Bell and Rui Costa");
    const cover = "Moth Hour\nThe song has been covered often, with a 2001 version recorded by Ana Bell that reached number one in the UK for three weeks.";
    expect(droppedLimit("\"Moth Hour\" reached number one in the UK for three weeks.", cover)).toBe("version recorded by Ana Bell");
    expect(droppedLimit("\"Moth Hour\" reached number one in the UK for three weeks.", cover, ["Ana Bell"])).toBeNull();
  });

  it("keeps \"this\" from turning into \"the\"", () => {
    const context = "Moth Hour\nRui Costa kept the chords but wrote a new bridge. This arrangement is documented on a 1950 broadcast recording in Chicago.";
    expect(droppedFrame("The arrangement is documented on a 1950 broadcast recording in Chicago.", context)).toBe("This arrangement");
  });

  it("catches an event swapped for the sentence's own", () => {
    const context = "Moth Hour\nHer performance at the Mercury Prize in 2007 was included on the soundtrack. She later won at the Brit Awards.";
    expect(turnedRound("Her performance at the Brit Awards was included on the soundtrack.", context)).toBe("Brit Awards");
  });

  it("drops a span moved to another chart of the run", () => {
    const context = "Moth Hour\n\"Moth Hour\" reached number one on the Billboard Hot 100, topped the Billboard Hot Soul Singles chart within three weeks, and became her fastest-rising hit.";
    expect(movedChartDetail("\"Moth Hour\" reached number one on the Billboard Hot 100 chart within three weeks.", context)).toBe("within three weeks");
    expect(movedChartDetail("\"Moth Hour\" reached number one on the Billboard Hot 100.", context)).toBeNull();
  });

  it("wants a chart for a chart claim", () => {
    expect(unnamedChart("\"Moth Hour\" was the top new entry for the week of 1-7 October.")).toBe("top new entry");
    expect(unnamedChart("\"Moth Hour\" reached number 4 on the UK Singles Chart.")).toBeNull();
  });

  it("catches a statement turned round", () => {
    const context = "Moth Hour\nCritic Sam Ortiz praised the song. He compared Vale's vocals to those of Rui Costa.";
    expect(turnedRound("Ana Vale compared her vocals to those of Rui Costa.", context)).toBe("Vale");
    const speaking = "Moth Hour\nIn June 2025, Rob Lane confirmed to Sound Weekly that a script for a sequel is still being worked on.";
    expect(turnedRound("A script for a sequel is still being worked on by Rob Lane.", speaking)).toBe("Lane");
  });

  it("leaves a passive told as active alone", () => {
    const context = "Orbit\nOrbit is a game developed by Lumen Works in 2004.";
    expect(turnedRound("Lumen Works developed Orbit.", context)).toBeNull();
  });

  it("wants what the bubble points at named", () => {
    expect(leftBehindReferent("Tin Sail got wide support after the incident.", ["Tin Sail"])).toBe("the incident");
    expect(leftBehindReferent("All three faces were on the earlier singles.", ["Moth Hour"])).toBe("All three faces");
    expect(leftBehindReferent("All songs were written by Ana Bell.", ["Moth Hour"])).toBe("All songs");
    expect(leftBehindReferent("All songs on \"Blue Door\" were written by Ana Bell.", ["Moth Hour"])).toBeNull();
    expect(leftBehindReferent("Rui Costa recorded the same arrangement in 1951.", ["Moth Hour"])).toBe("the same arrangement");
  });

  it("doesn't take a bandleader's name for a film", () => {
    const context = "Big Lou (musician)\nBig Lou is a trombonist and bandleader from Mobile.";
    expect(leftBehindReferent("Big Lou performed with a guest in the film.", ["Big Lou"], [], context)).toBe("the film");
    expect(leftBehindReferent("Big Lou was shot in the film.", ["Big Lou"], [], "Big Lou\nBig Lou is a 1990 film.")).toBeNull();
  });
});
