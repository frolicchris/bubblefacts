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
  screenClaims,
  numberedReference,
  referenceSentences,
  parseCitation,
  citedMismatch,
  unsupportedDay,
  splitGameAndTrack,
  resolveGameAndTrack,
  isRelevantArticle,
  unsupportedName,
  platformSupported,
  looksLikeArtistName,
  qualifierNamesAnotherArtist,
  dropVersionTags,
  normalizeTitle,
  tooSimilar,
  alteredQuote,
  gameTrackText,
  isMusicArticleFor,
  trackSentences,
  creatorSentences,
  explainMusicTerms,
  receptionSentences,
  theorySentences,
  curatedFacts,
  orderExtract,
  fetchGrounding,
  clearGroundingCache,
  readings,
  isRespelling,
  isSameWorkRedirect,
  editDistance,
  opensAboutMusicOrWork,
  isPlaceholderRequest,
  requestNames,
  articleMisfit,
  rememberArticle,
  withoutVideoSections,
  soundtrackPart,
  otherParts,
  unsupportedConnective,
  unsupportedRelation,
  unsupportedCredit,
  isAWork,
  isAPerformer,
  isAPiece,
  isInitials,
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
} from "./fact-verifier";
import { blockArticle, resetWrongFacts } from "./wrong-facts";
import { artistNames, mentionsName, restatesRequest } from "./fact-verifier";
import { topic } from "./topic";

describe("resolveGameAndTrack", () => {
  it("treats the artist field as the game, which is how the song list is keyed", () => {
    expect(
      resolveGameAndTrack({ title: "Sunshine Coastline", artist: "Ys VIII: Lacrimosa of Dana" })
    ).toEqual({ game: "Ys VIII: Lacrimosa of Dana", track: "Sunshine Coastline" });
  });

  it("falls back to parsing the title when there is no artist", () => {
    expect(resolveGameAndTrack({ title: "Chrono Trigger - Corridors of Time", artist: "" })).toEqual({
      game: "Chrono Trigger",
      track: "Corridors of Time",
    });
  });

  it("falls back to parsing the title when the artist is Unknown", () => {
    expect(
      resolveGameAndTrack({ title: "Celeste: Reach for the Summit", artist: "Unknown" }).game
    ).toBe("Celeste");
  });

  it("does not use the artist when it merely repeats the title", () => {
    expect(resolveGameAndTrack({ title: "Megalovania", artist: "Megalovania" })).toEqual({
      game: "Megalovania",
      track: "Megalovania",
    });
  });
});

describe("splitGameAndTrack", () => {
  it("splits 'Game: Track'", () => {
    expect(splitGameAndTrack("Ys VIII Lacrimosa of Dana: Sunshine Coastline")).toEqual({
      game: "Ys VIII Lacrimosa of Dana",
      track: "Sunshine Coastline",
    });
  });

  it("splits 'Game - Track'", () => {
    expect(splitGameAndTrack("Chrono Trigger - Corridors of Time")).toEqual({
      game: "Chrono Trigger",
      track: "Corridors of Time",
    });
  });

  it("treats a parenthetical as the game", () => {
    expect(splitGameAndTrack("One-Winged Angel (Final Fantasy VII)")).toEqual({
      game: "Final Fantasy VII",
      track: "One-Winged Angel",
    });
  });

  it("uses the whole title for both when there is no separator", () => {
    expect(splitGameAndTrack("Megalovania")).toEqual({
      game: "Megalovania",
      track: "Megalovania",
    });
  });

  it("does not split on a hyphenated word", () => {
    expect(splitGameAndTrack("Well-Worn Dirt Road").game).toBe("Well-Worn Dirt Road");
  });
});

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

describe("isRelevantArticle", () => {
  it("accepts an exact match", () => {
    expect(isRelevantArticle("Chrono Trigger", "Chrono Trigger")).toBe(true);
  });

  it("accepts a disambiguated title", () => {
    expect(isRelevantArticle("Celeste", "Celeste (video game)")).toBe(true);
  });

  it("accepts a subtitle the search term omitted", () => {
    expect(isRelevantArticle("Ys VIII", "Ys VIII: Lacrimosa of Dana")).toBe(true);
  });

  it("ignores punctuation differences", () => {
    expect(isRelevantArticle("Ys VIII Lacrimosa of Dana", "Ys VIII: Lacrimosa of Dana")).toBe(true);
  });

  it("rejects a longer title that only shares the subject's last word", () => {
    // A real failure: "The Midnight - Lost Boy" was grounded on a racing game.
    expect(isRelevantArticle("The Midnight", "Wangan Midnight")).toBe(false);
    expect(isRelevantArticle("The Midnight", "Wangan Midnight (2007 video game)")).toBe(false);
  });

  it("rejects a possessive title, which names another work", () => {
    // From a live stream: "Michael Jackson - Whatever Happens" got facts about the This Is It album.
    expect(isRelevantArticle("Michael Jackson", "Michael Jackson's This Is It (album)", true)).toBe(false);
  });

  it("accepts a band article when the subject is a performer", () => {
    expect(isRelevantArticle("The Midnight", "The Midnight (band)", true)).toBe(true);
    expect(isRelevantArticle("The Midnight", "The Midnight (band)")).toBe(false);
  });

  it("rejects the unrelated article Wikipedia returns for an original song", () => {
    // A real failure: faithful facts about entirely the wrong work.
    expect(isRelevantArticle("Jane Composer", "The Last of Us season 1")).toBe(false);
  });

  it("rejects a match sharing only one incidental word", () => {
    expect(isRelevantArticle("Final Fantasy VII", "Final Destination")).toBe(false);
  });
});

describe("isRelevantArticle — franchise siblings and false friends", () => {
  // Screening cannot catch these: the facts would match the article, and the
  // article is the wrong one. So relevance has to reject them.
  const MUST_REJECT: Array<[string, string]> = [
    ["Final Fantasy VI", "Final Fantasy VII"],
    ["Dragon Quest II", "Dragon Quest III"],
    ["Kingdom Hearts II", "Kingdom Hearts III"],
    ["Persona 5", "Persona 4"],
    ["Mega Man 2", "Mega Man 11"],
    ["Sonic the Hedgehog 2", "Sonic the Hedgehog 3"],
    ["Chrono Trigger", "Chrono Cross"],
    ["Ys", "System Shock"],
    // Wikipedia's own parenthetical is the disambiguator; stripping it was
    // what let these through.
    ["Journey", "Journey (band)"],
    ["Braid", "Braid (hairstyle)"],
    ["Celeste", "Celeste (band)"],
  ];

  it.each(MUST_REJECT)("rejects %s -> %s", (subject, page) => {
    expect(isRelevantArticle(subject, page)).toBe(false);
  });

  const MUST_ACCEPT: Array<[string, string]> = [
    ["Chrono Trigger", "Chrono Trigger"],
    ["Celeste", "Celeste (video game)"],
    ["Journey", "Journey (2012 video game)"],
    ["Ys VIII", "Ys VIII: Lacrimosa of Dana"],
    ["Ys VIII Lacrimosa of Dana", "Ys VIII: Lacrimosa of Dana"],
    ["Undertale", "Undertale"],
    // Roman and arabic numerals must compare equal, or a legitimate match
    // is rejected for a cosmetic difference.
    ["Final Fantasy VI", "Final Fantasy 6"],
  ];

  it.each(MUST_ACCEPT)("accepts %s -> %s", (subject, page) => {
    expect(isRelevantArticle(subject, page)).toBe(true);
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

describe("non-video-game repertoire", () => {
  // The setlist is not only game music: pop, film and musical soundtracks,
  // classical, and the streamer's own compositions all appear. A relevance guard
  // tuned only for games rejects their articles outright.
  it("accepts a classical work's own article", () => {
    expect(isRelevantArticle("Clair de Lune", "Clair de Lune (Debussy)")).toBe(true);
    expect(isRelevantArticle("Suite bergamasque", "Suite bergamasque")).toBe(true);
  });

  it("accepts a pop song's article", () => {
    expect(isRelevantArticle("Bohemian Rhapsody", "Bohemian Rhapsody")).toBe(true);
    expect(isRelevantArticle("Yesterday", "Yesterday (Beatles song)")).toBe(true);
  });

  it("accepts a film score article", () => {
    expect(isRelevantArticle("Schindler's List", "Schindler's List (soundtrack)")).toBe(true);
  });

  it("still rejects a same-name article about something unmusical", () => {
    expect(isRelevantArticle("Yesterday", "Yesterday (2019 film)")).toBe(true); // film is musical-adjacent
    expect(isRelevantArticle("Braid", "Braid (hairstyle)")).toBe(false);
  });

  it("admits a performer article only when the subject is a performer", () => {
    // "Journey" the game must not ground on "Journey (band)"...
    expect(isRelevantArticle("Journey", "Journey (band)", false)).toBe(false);
    // ...but a song list entry whose subject IS the band legitimately does.
    expect(isRelevantArticle("Journey", "Journey (band)", true)).toBe(true);
  });
});

describe("looksLikeArtistName", () => {
  it("recognizes well-known composers and artists", () => {
    expect(looksLikeArtistName("Chopin")).toBe(true);
    expect(looksLikeArtistName("Joe Hisaishi")).toBe(true);
    expect(looksLikeArtistName("The Beatles")).toBe(true);
  });

  it("recognizes an ordinary personal name", () => {
    expect(looksLikeArtistName("Jane Composer")).toBe(true);
  });

  it("does not treat a game title as a person", () => {
    expect(looksLikeArtistName("Ys VIII: Lacrimosa of Dana")).toBe(false);
    expect(looksLikeArtistName("The Legend of Zelda")).toBe(false);
  });
});

describe("qualifierNamesAnotherArtist", () => {
  it("rejects a same-titled work by a different artist", () => {
    // Live regression: "Clair de Lune" matched "Clair de Lune (Flight
    // Facilities song)" — a 2012 electronic track, not Debussy — because the
    // track name matched exactly. Titles collide across genres constantly.
    expect(
      qualifierNamesAnotherArtist("Clair de Lune (Flight Facilities song)", "Claude Debussy")
    ).toBe(true);
  });

  it("accepts a work attributed to the subject", () => {
    expect(qualifierNamesAnotherArtist("Clair de Lune (Debussy)", "Claude Debussy")).toBe(false);
    expect(qualifierNamesAnotherArtist("Yesterday (Beatles song)", "The Beatles")).toBe(false);
  });

  it("ignores a bare category qualifier that names nobody", () => {
    expect(qualifierNamesAnotherArtist("Bohemian Rhapsody (song)", "Queen")).toBe(false);
    expect(qualifierNamesAnotherArtist("Celeste (video game)", "Celeste")).toBe(false);
  });

  it("treats a bracket the requested title shares as part of the name", () => {
    // Live: "Separate Ways (Worlds Apart)" by Journey fell through to the 2012 video game Journey.
    expect(qualifierNamesAnotherArtist("Separate Ways (Worlds Apart)", "Journey", "Separate Ways (Worlds Apart)")).toBe(false);
    // A bare subtitle is allowed only where the caller checks the article names the artist.
    expect(qualifierNamesAnotherArtist("Separate Ways (Worlds Apart)", "Journey", "Separate Ways", true)).toBe(false);
    expect(qualifierNamesAnotherArtist("Clair de Lune (Flight Facilities song)", "Claude Debussy", "Clair de Lune", true)).toBe(true);
  });

  it("is a no-op when there is no qualifier at all", () => {
    expect(qualifierNamesAnotherArtist("Bohemian Rhapsody", "Queen")).toBe(false);
  });
});

describe("isRelevantArticle — title collisions seen in real song lists", () => {
  // Each case comes from real song-list entries.
  it("does not ground a numbered installment on the un-numbered original", () => {
    // "To Zanarkand" by Final Fantasy X grounded on "Final Fantasy (video
    // game)" — i.e. FF1. "Final Fantasy" is a prefix of "Final Fantasy X",
    // so prefix matching alone accepted a truncation that dropped the
    // installment. Same shape as the franchise-sibling bug, parent/child.
    expect(isRelevantArticle("Final Fantasy X", "Final Fantasy (video game)")).toBe(false);
    expect(isRelevantArticle("Marvel vs Capcom 2", "Marvel vs. Capcom")).toBe(false);
  });

  it("still allows a series subject to match one of its installments", () => {
    // The reverse direction is legitimate: the song list often names the
    // series, and any installment's article is a fair reference.
    expect(isRelevantArticle("Animal Crossing", "Animal Crossing: New Leaf")).toBe(true);
    expect(isRelevantArticle("Ys", "Ys I")).toBe(true);
  });

  it("does not follow a name into a different medium", () => {
    // "Super Mario 64: Dire Dire Docks" grounded on "The Super Mario Galaxy
    // Movie (soundtrack)" — the film, not the game.
    expect(
      isRelevantArticle("Super Mario", "The Super Mario Galaxy Movie (soundtrack)")
    ).toBe(false);
  });

  it("matches two-letter titles, which were being filtered out entirely", () => {
    // significantTokens dropped tokens under three characters, so "Ys" — a
    // whole series and core repertoire — reduced to an empty token list and
    // could never match anything. Every Ys track in the set missed grounding.
    expect(isRelevantArticle("Ys", "Ys (series)")).toBe(true);
    expect(isRelevantArticle("Ys", "Ys II: The Final Chapter")).toBe(true);
    // ...without becoming a substring free-for-all.
    expect(isRelevantArticle("Ys", "System Shock")).toBe(false);
  });
});

describe("resolveGameAndTrack — series in artist, game in title", () => {
  it("prefers the more specific game named in the title", () => {
    // Live: artist "Super Mario" grounded a Super Mario 64 track on the
    // Super Mario Galaxy soundtrack; artist "Animal Crossing" put a New
    // Horizons track on New Leaf.
    expect(
      resolveGameAndTrack({ title: "Super Mario 64: Dire Dire Docks", artist: "Super Mario" })
    ).toEqual({ game: "Super Mario 64", track: "Dire Dire Docks" });
    expect(
      resolveGameAndTrack({ title: "Animal Crossing New Horizons: 5 PM", artist: "Animal Crossing" })
        .game
    ).toBe("Animal Crossing New Horizons");
  });

  it("strips a title prefix that just repeats the artist", () => {
    expect(resolveGameAndTrack({ title: "Billy Joel: Piano Man", artist: "Billy Joel" })).toEqual({
      game: "Billy Joel",
      track: "Piano Man",
    });
  });

  it("keeps the artist when the title names something unrelated", () => {
    expect(
      resolveGameAndTrack({ title: "Sunshine Coastline", artist: "Ys VIII: Lacrimosa of Dana" }).game
    ).toBe("Ys VIII: Lacrimosa of Dana");
  });

  it("accepts a truncated article when the installment number survives", () => {
    expect(isRelevantArticle("Ys II The Final Chapter", "Ys II")).toBe(true);
    expect(isRelevantArticle("Final Fantasy X", "Final Fantasy (video game)")).toBe(false);
  });

  it("rejects a truncated title that isn't at a subtitle break", () => {
    // A real failure: a drum cover of "Everybody Dance Now" got facts about a PlayStation game.
    expect(isRelevantArticle("Everybody Dance Now", "Everybody Dance (video game)")).toBe(false);
    expect(isRelevantArticle("Ys VIII: Lacrimosa of Dana", "Ys VIII")).toBe(true);
  });
});

describe("grounding — stubs, arrangements and remakes", () => {
  it("does not read an arrangement marker as the game name", () => {
    // "(Arr Arcana Shift)" was parsed as the game, so every Ys VIII
    // arrangement grounded on the bare "Ys (series)" article instead.
    expect(
      splitGameAndTrack("Ys VIII Lacrimosa of Dana: Iclucian Dance (Arr Arcana Shift)").game
    ).toBe("Ys VIII Lacrimosa of Dana");
    expect(splitGameAndTrack("Sonic Mania: Studiopolis Zone (Act 1)").game).toBe("Sonic Mania");
    expect(splitGameAndTrack("Floaroma Town (Day)").game).toBe("Floaroma Town (Day)");
  });

  it("still reads a real game name in parentheses", () => {
    expect(splitGameAndTrack("One-Winged Angel (Final Fantasy VII)").game).toBe(
      "Final Fantasy VII"
    );
  });

  it("rejects an article for a work that has not been released yet", () => {
    // "Song of Storms" grounded on the 2026 Ocarina REMAKE and the overlay
    // announced an "upcoming" game under a 1998 track.
    const future = new Date().getFullYear() + 1;
    expect(
      isRelevantArticle(
        "The Legend of Zelda: Ocarina of Time",
        `The Legend of Zelda: Ocarina of Time (${future} video game)`
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

describe("title parsing and matching found in review", () => {
  it("reads arrangement parentheticals as variants, not game names", () => {
    for (const title of ["Terra (Piano Collections)", "Tifa's Theme (Acoustic Cover)", "Aerith (Live at Budokan)", "Main Theme (Night)"]) {
      expect(splitGameAndTrack(title).game).toBe(title);
    }
  });

  it("still reads a game name that merely starts with Day or Night", () => {
    expect(splitGameAndTrack("Theme (Night in the Woods)").game).toBe("Night in the Woods");
  });

  it("matches titles regardless of accents", () => {
    expect(isRelevantArticle("Pokemon Red", "Pokémon Red and Blue")).toBe(true);
    expect(isRelevantArticle("Okami", "Ōkami")).toBe(true);
  });

  it("does not accept a hyphen-numbered sequel", () => {
    expect(isRelevantArticle("Final Fantasy X", "Final Fantasy X-2")).toBe(false);
  });
});

describe("orderExtract", () => {
  const article = [
    "Lead paragraph. Released 1998 for N64.",
    "== Gameplay ==\nYou jump.",
    "== Music ==",
    "=== Composition ===\nComposed by Koji Kondo.",
    "=== Release ===\nA soundtrack album followed.",
    "== Reception ==\nIt was liked.",
  ].join("\n");

  it("keeps a music section's subsections and drops unrelated sections", () => {
    const text = orderExtract(article, 2400);
    expect(text).toContain("Koji Kondo");
    expect(text).toContain("soundtrack album");
    expect(text).not.toContain("You jump");
    expect(text).not.toContain("It was liked");
  });

  it("keeps the lead within a tight budget", () => {
    const text = orderExtract(article, 120);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toContain("Released 1998");
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

describe("fetchGrounding", () => {
  const LONG = "x".repeat(700);
  let pages: Record<string, string[]>;
  let mentions: Record<string, string>;
  const fetchMock = jest.fn(async (url: string) => {
    const params = new URL(url).searchParams;
    const term = params.get("srsearch");
    const body = term !== null
      ? { query: { search: (pages[term] ?? []).map((title) => ({ title })) } }
      : { query: { pages: { 1: { extract: `Lead about ${params.get("titles")}, ${mentions[params.get("titles") ?? ""] ?? ""}. ${LONG}\n== Music ==\nScore.` } } } };
    return { ok: true, status: 200, json: async () => body } as Response;
  });

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  beforeEach(() => {
    clearGroundingCache();
    fetchMock.mockClear();
    pages = {};
    mentions = { "Bohemian Rhapsody": "a song by Queen", "Don't Stop Me Now": "a song by Queen" };
  });

  it("does not reuse one song's article for another song by the same artist", async () => {
    pages = { "Bohemian Rhapsody Queen": ["Bohemian Rhapsody"], "Don't Stop Me Now Queen": ["Don't Stop Me Now"] };
    expect(await fetchGrounding({ title: "Bohemian Rhapsody", artist: "Queen" })).toMatch(/^Bohemian Rhapsody/);
    expect(await fetchGrounding({ title: "Don't Stop Me Now", artist: "Queen" })).toMatch(/^Don't Stop Me Now/);
  });

  it("shares an article found through the game across its tracks", async () => {
    pages = { "Celeste video game": ["Celeste (video game)"] };
    await fetchGrounding({ title: "First Steps", artist: "Celeste" });
    const calls = fetchMock.mock.calls.length;
    expect(await fetchGrounding({ title: "Resurrections", artist: "Celeste" })).toMatch(/^Celeste/);
    // One search for the track's own article, and nothing more: the game's is reused.
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    await fetchGrounding({ title: "Resurrections", artist: "Celeste" });
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
  });

  it("prefers the song's article to the album of the same name", async () => {
    pages = { "Let It Be The Beatles": ["Let It Be (album)", "Let It Be (song)"] };
    mentions = { "Let It Be (album)": "by the Beatles", "Let It Be (song)": "by the Beatles" };
    expect(await fetchGrounding({ title: "Let It Be", artist: "The Beatles" })).toMatch(/^Let It Be \(song\)\n/);
  });

  it("prefers a game track's own article when it has one (issue #48)", async () => {
    pages = { "Megalovania Undertale": ["Megalovania", "Undertale"], "Undertale video game": ["Undertale"] };
    mentions = { Megalovania: "a song from Undertale" };
    expect(await fetchGrounding({ title: "Megalovania", artist: "Undertale" })).toMatch(/^Megalovania\n/);
    expect(await fetchGrounding({ title: "Hopes and Dreams", artist: "Undertale" })).toMatch(/^Undertale\n/);
    // An article with the track's name that isn't about music: Skyrim's "Dragonborn" expansion.
    pages = { "Dragonborn Skyrim": ["Dragonborn"], "Skyrim video game": ["Skyrim"] };
    mentions = { Dragonborn: "an add-on for Skyrim" };
    expect(await fetchGrounding({ title: "Dragonborn", artist: "Skyrim" })).toMatch(/^Skyrim\n/);
  });

  it("does not let one song's miss block the artist's other songs", async () => {
    expect(await fetchGrounding({ title: "Obscure B-Side", artist: "Queen" })).toBe("");
    pages = { "Bohemian Rhapsody Queen": ["Bohemian Rhapsody"] };
    expect(await fetchGrounding({ title: "Bohemian Rhapsody", artist: "Queen" })).toMatch(/^Bohemian Rhapsody/);
  });

  it("remembers a game's miss for all its tracks", async () => {
    expect(await fetchGrounding({ title: "Track One", artist: "The Tiny Game 2" })).toBe("");
    const calls = fetchMock.mock.calls.length;
    expect(await fetchGrounding({ title: "Track Two", artist: "The Tiny Game 2" })).toBe("");
    // Only the search for Track Two's own article; the game isn't looked up again.
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
  });

  it("never grounds a game track on a generic article named like the track", async () => {
    pages = { Overture: ["Overture"], "Overture Obscure Game": ["Overture"] };
    expect(await fetchGrounding({ title: "Overture", artist: "Obscure Game" })).toBe("");
  });

  it("takes an installment only when it names the track (review: Final Fantasy -> Final Fantasy VII)", async () => {
    pages = { "Final Fantasy video game": ["Final Fantasy VII"], "Final Fantasy soundtrack": ["Final Fantasy VII"], "Final Fantasy": ["Final Fantasy VII"] };
    mentions = { "Final Fantasy VII": "with music including One-Winged Angel" };
    expect(await fetchGrounding({ title: "Terra's Theme", artist: "Final Fantasy" })).toBe("");
    expect(await fetchGrounding({ title: "One-Winged Angel", artist: "Final Fantasy" })).toMatch(/^Final Fantasy VII/);
  });

  it("never looks up an uploader that's only a guess (review: Apollo)", async () => {
    pages = { "Megalovania": ["Apollo"], "Apollo video game": ["Apollo"], "Apollo": ["Apollo"] };
    expect(await fetchGrounding({ title: "Megalovania", artist: "Apollo", artistUncertain: true })).toBe("");
  });

  it("never uses an article the streamer marked wrong for that song", async () => {
    pages = { "Celeste video game": ["Celeste (video game)"] };
    expect(await fetchGrounding({ title: "First Steps", artist: "Celeste" })).toMatch(/^Celeste/);
    blockArticle({ title: "First Steps", artist: "Celeste" }, "Celeste (video game)");
    // Blocked even though it's cached, and only for that song.
    expect(await fetchGrounding({ title: "First Steps", artist: "Celeste" })).toBe("");
    expect(await fetchGrounding({ title: "Resurrections", artist: "Celeste" })).toMatch(/^Celeste/);
    // Remembered after a restart.
    resetWrongFacts();
    clearGroundingCache();
    expect(await fetchGrounding({ title: "First Steps", artist: "Celeste" })).toBe("");
  });

  it("keeps the whole reference within the context budget", async () => {
    pages = { "Celeste video game": ["Celeste (video game)"] };
    expect((await fetchGrounding({ title: "First Steps", artist: "Celeste" })).length).toBeLessThanOrEqual(2400);
  });
});

describe("artist names (peer review)", () => {
  it("keeps a whole credit and tries the lead artist", () => {
    expect(artistNames("Earth, Wind & Fire")).toEqual(["earth wind fire", "earth"]);
    expect(artistNames("Lil Nas X, Jack Harlow")).toEqual(["lil nas x jack harlow", "lil nas x"]);
    // Written either way in articles: "Simon & Garfunkel".
    expect(artistNames("Simon and Garfunkel")).toEqual(["simon and garfunkel", "simon garfunkel"]);
  });

  it("matches whole words only", () => {
    expect(mentionsName("2014 single by asia", ["sia"])).toBe(false);
    expect(mentionsName("2014 single by sia", ["sia"])).toBe(true);
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
    const song = { title: "Water in the Moonlight", artist: "Chris" };
    expect(restatesRequest('"Water in the Moonlight" is an original composition by Chris.', song)).toBe(true);
    expect(restatesRequest("You're hearing this one straight from the person who wrote it.", song)).toBe(true);
    expect(restatesRequest("Chris has played \"Water in the Moonlight\" 3 times on stream.", song)).toBe(false);
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

describe("names and editions from a real stream's log (issue #45)", () => {
  it("looks for each of two full names joined by and", () => {
    expect(artistNames("Johnny Mercer and Henry Mancini")).toEqual(expect.arrayContaining(["johnny mercer", "henry mancini"]));
    expect(artistNames("Simon and Garfunkel")).not.toContain("simon");
    expect(artistNames("Earth, Wind & Fire")).not.toContain("fire");
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

describe("a game's music article, and what it says about one track (issue #48)", () => {
  it("recognizes the music article for a game or its series", () => {
    expect(isMusicArticleFor("Music of Final Fantasy VIII", "Final Fantasy VIII")).toBe(true);
    expect(isMusicArticleFor("Music of the Final Fantasy VII series", "Final Fantasy VII")).toBe(true);
    expect(isMusicArticleFor("Music of Sonic the Hedgehog", "Sonic the Hedgehog 3")).toBe(true);
    expect(isMusicArticleFor("Undertale Soundtrack", "Undertale")).toBe(true);
    expect(isMusicArticleFor("Super Mario Galaxy Original Soundtrack", "Super Mario Galaxy")).toBe(true);
  });

  it("rejects another game's, and unrelated music articles", () => {
    expect(isMusicArticleFor("Music of Final Fantasy IV", "Final Fantasy VI")).toBe(false);
    expect(isMusicArticleFor("Music of Chrono Cross", "Chrono Trigger")).toBe(false);
    expect(isMusicArticleFor("Music of Japan", "Sonic the Hedgehog 3")).toBe(false);
    expect(isMusicArticleFor("Music of Deltarune", "Undertale")).toBe(false);
    expect(isMusicArticleFor("Final Fantasy concerts", "Final Fantasy VIII")).toBe(false);
  });

  const music = [
    "The music of Starfall was composed by Mia Chen.",
    "== Soundtrack ==",
    "The album has 40 tracks. \"Harbor at Dawn\" was the first piece Chen wrote for the game.",
    "Chen said \"Harbor at Dawn\" was inspired by a ferry ride. The title screen uses a solo piano.",
  ].join("\n");

  it("lifts the sentences that name the track, and none for a generic track name", () => {
    expect(trackSentences(music, "Harbor at Dawn")).toEqual([
      '"Harbor at Dawn" was the first piece Chen wrote for the game.',
      'Chen said "Harbor at Dawn" was inspired by a ferry ride.',
    ]);
    expect(trackSentences(music, "Title Screen")).toEqual([]);
    expect(trackSentences(music, "Boss")).toEqual([]);
  });

  it("builds a track's reference from the music article, with the track's own sentences first", () => {
    const articles = { page: "Starfall", full: "Starfall is a 2019 game about ferries.", music: { page: "Music of Starfall", full: music } };
    const text = gameTrackText(articles, "Harbor at Dawn");
    expect(text.startsWith('Music of Starfall\nAbout this piece: "Harbor at Dawn" was the first piece')).toBe(true);
    // The streamer marked the music article wrong for this song: the game's article serves.
    expect(gameTrackText(articles, "Harbor at Dawn", (t) => t !== "Music of Starfall").startsWith("Starfall\n")).toBe(true);
    expect(gameTrackText({ ...articles, music: null }, "Harbor at Dawn").startsWith("Starfall\n")).toBe(true);
    // A series-wide music article is only for the tracks it names.
    const series = { ...articles, music: { ...articles.music, series: true } };
    expect(gameTrackText(series, "Harbor at Dawn").startsWith("Music of Starfall\n")).toBe(true);
    expect(gameTrackText(series, "Night Market").startsWith("Starfall\n")).toBe(true);
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

describe("a set named in the plural (October 1 evening log)", () => {
  it("matches Hungarian Dance to Hungarian Dances (Brahms)", () => {
    expect(isRelevantArticle("Hungarian Dance", "Hungarian Dances (Brahms)")).toBe(true);
    expect(isRelevantArticle("Queen", "Queens (band)")).toBe(false);
  });
});

describe("dropVersionTags", () => {
  it("drops tags that say how a song is played, keeping the song's own name", () => {
    expect(dropVersionTags("Separate Ways (Worlds Apart) [Instrumental]")).toBe("Separate Ways (Worlds Apart)");
    expect(dropVersionTags("Take On Me [Instrumental]")).toBe("Take On Me");
    expect(dropVersionTags("Gerudo Valley (Piano Cover)")).toBe("Gerudo Valley");
    expect(dropVersionTags("Song Title (Live) (Remastered)")).toBe("Song Title");
    expect(dropVersionTags("Song of Storms (Ocarina of Time)")).toBe("Song of Storms (Ocarina of Time)");
  });

  it("compares titles without trailing tags in either kind of bracket", () => {
    expect(normalizeTitle("Separate Ways (Worlds Apart) [Instrumental]")).toBe(normalizeTitle("Separate Ways (Worlds Apart)"));
  });
});

describe("other readings of a request (a song list's misses)", () => {
  it("reads the work from the title when the artist is a category", () => {
    expect(readings({ title: "Star Trek: Picard Season 1 Theme", artist: "Star Trek TV" })[0]).toEqual({
      game: "Star Trek: Picard",
      track: "Theme",
      notGame: true,
    });
    const khan = readings({ title: "Star Trek II. The Wrath of Khan: Battle At The Mutara Nebula", artist: "Star Trek Movies" });
    expect(khan.map((r) => [r.game, r.track])).toEqual([
      ["Star Trek II: The Wrath of Khan: Battle At The Mutara Nebula", "Theme"],
      ["Star Trek II: The Wrath of Khan", "Battle At The Mutara Nebula"],
      ["Star Trek series", "Star Trek II. The Wrath of Khan: Battle At The Mutara Nebula"],
    ]);
    // A tag in brackets names the arrangement, never the work or a piece of it.
    expect(readings({ title: "Star Trek: The Next Generation Theme [Legacy]", artist: "Star Trek TV" })[0]).toMatchObject({
      game: "Star Trek: The Next Generation",
      track: "Theme",
    });
    expect(readings({ title: "Mass Effect Main Theme", artist: "Mass Effect Series" })[0]).toMatchObject({ game: "Mass Effect", track: "Main Theme" });
  });

  it("puts a subtitle in the title under the franchise, then falls back to the franchise's own article", () => {
    expect(readings({ title: "Wild World - The Roost", artist: "Animal Crossing Series" })).toEqual([
      { game: "Animal Crossing: Wild World", track: "The Roost", notGame: false },
      { game: "Animal Crossing series", track: "Wild World - The Roost", notGame: false },
    ]);
    expect(readings({ title: "Gourmet Race", artist: "Kirby Series" })).toEqual([{ game: "Kirby series", track: "Gourmet Race", notGame: false }]);
  });

  it("doesn't fall back to the franchise when the title names something else in brackets", () => {
    // "Aquatic Ambiance" is from Donkey Kong Country, not Super Mario.
    expect(readings({ title: "Aquatic Ambiance (Donkey Kong Country)", artist: "Super Mario Franchise" })).toEqual([]);
  });

  it("looks up each name of a credit with an arranger or a second name", () => {
    expect(readings({ title: "Rocket Man [Jazzy]", artist: "Elton John arr. Brent Edstrom" })).toEqual([
      { game: "Elton John arr. Brent Edstrom", track: "Rocket Man" },
      { game: "Elton John", track: "Rocket Man", trackOnly: false },
    ]);
    expect(readings({ title: "Passacaglia", artist: "Arr. Handel Halvorsen" })[1]).toMatchObject({ game: "Handel Halvorsen", trackOnly: false });
    const slash = readings({ title: "Sound of Silence", artist: "Simon and Garfunkel/Disturbed" });
    // A name that isn't plainly a person's may be anything: only the song's own article is taken for it.
    expect(slash.slice(1)).toEqual([
      { game: "Simon and Garfunkel", track: "Sound of Silence", trackOnly: true },
      { game: "Disturbed", track: "Sound of Silence", trackOnly: true },
    ]);
    // A person's name: the song's own article under every name first, then the person's, which must be a performer's.
    expect(readings({ title: "Nocturne Op. 9 No. 2", artist: "Frederic Chopin/Some Arranger" }).slice(1)).toEqual([
      { game: "Frederic Chopin", track: "Nocturne Op. 9 No. 2", trackOnly: true },
      { game: "Some Arranger", track: "Nocturne Op. 9 No. 2", trackOnly: true },
      { game: "Frederic Chopin", track: "Nocturne Op. 9 No. 2", trackOnly: false, aPerformer: true },
      { game: "Some Arranger", track: "Nocturne Op. 9 No. 2", trackOnly: false, aPerformer: true },
    ]);
  });

  it("looks up a song by no one by its title alone", () => {
    expect(readings({ title: "Greensleeves", artist: "Traditional" })).toEqual([{ game: "", track: "Greensleeves", songAlone: true }]);
    expect(readings({ title: "Santa Lucia", artist: "Italian Folk Song" })).toEqual([{ game: "", track: "Santa Lucia", songAlone: true }]);
    expect(readings({ title: "Celeste: Reach for the Summit", artist: "Unknown" }).map((r) => r.songAlone ?? false)).toEqual([false, true]);
  });

  it("keeps a music video or a guessed artist to the one usual reading", () => {
    expect(readings({ title: "Sound of Silence", artist: "Simon and Garfunkel/Disturbed", performer: true })).toHaveLength(1);
    expect(readings({ title: "Greensleeves", artist: "Traditional", artistUncertain: true })).toHaveLength(1);
  });

  it("drops a 'jazzy' tag like any other way of playing", () => {
    expect(dropVersionTags("Goodbye Yellow Brick Road [Jazzy]")).toBe("Goodbye Yellow Brick Road");
  });
});

describe("a series' own article", () => {
  it("matches the series' page, never one installment", () => {
    expect(isRelevantArticle("Kirby series", "Kirby (series)")).toBe(true);
    expect(isRelevantArticle("Star Trek series", "Star Trek")).toBe(true);
    expect(isRelevantArticle("Nier series", "Nier (video game)")).toBe(false);
    expect(isRelevantArticle("Star Trek series", "Star Trek: The Original Series")).toBe(false);
    expect(isRelevantArticle("Mass Effect series", "Mass Effect 2")).toBe(false);
  });
});

describe("Wikipedia's own spelling and names", () => {
  it("counts a letter or two in one word, or the spacing, as a respelling", () => {
    expect(isRespelling("Eric Satie", "Erik Satie")).toBe(true);
    expect(isRespelling("Pirates of the Carribean", "Pirates of the Caribbean")).toBe(true);
    expect(isRespelling("Stein's Gate", "Steins;Gate")).toBe(true);
    expect(isRespelling("Pyotr Illyich Tchaikovsky", "Pyotr Ilyich Tchaikovsky")).toBe(true);
    // Two words changed is another person.
    expect(isRespelling("Windy Harper", "Wendy Harmer")).toBe(false);
    expect(isRespelling("Johann Strauss", "Johann Strauss II")).toBe(false);
    expect(isRespelling("Final Fantasy X", "Final Fantasy XI")).toBe(false);
    expect(isRespelling("Erik Satie", "Erik Satie")).toBe(false);
  });

  it("follows a redirect only to the same work under its proper name", () => {
    expect(isSameWorkRedirect("Star Wars: The Phantom Menace", "Star Wars: Episode I – The Phantom Menace")).toBe(true);
    expect(isSameWorkRedirect("Red Alert 3", "Command & Conquer: Red Alert 3")).toBe(true);
    expect(isSameWorkRedirect("Star Trek VII: Generations", "Star Trek Generations")).toBe(true);
    expect(isSameWorkRedirect("The Inkspots", "The Ink Spots")).toBe(true);
    // One of several, a later installment, a list, an album, or something else altogether.
    expect(isSameWorkRedirect("Johann Strauss", "Johann Strauss II")).toBe(false);
    expect(isSameWorkRedirect("Honkai Impact", "Honkai Impact 3rd")).toBe(false);
    expect(isSameWorkRedirect("Star Trek Movies", "List of Star Trek films")).toBe(false);
    expect(isSameWorkRedirect("Some Song", "Some Song (album)")).toBe(false);
    expect(isSameWorkRedirect("Kimi no Na wa", "Your Name")).toBe(false);
    // A surname given a first name is one person of that name.
    expect(isSameWorkRedirect("Poirot", "Hercule Poirot")).toBe(false);
    expect(isSameWorkRedirect("Ponce de León", "Juan Ponce de León")).toBe(false);
  });

  it("measures edit distance", () => {
    expect(editDistance("carribean", "caribbean")).toBe(2);
    expect(editDistance("satie", "satie")).toBe(0);
  });
});

describe("fetchGrounding — other readings and Wikipedia's names", () => {
  let hits: Record<string, string[]>;
  let suggestions: Record<string, string>;
  let redirects: Record<string, string>;
  let extracts: Record<string, string>;
  const LONG = " It was recorded with a full orchestra.".repeat(20);
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    const term = p.get("srsearch");
    let body: unknown;
    if (term !== null) {
      body = { query: { search: (hits[term] ?? []).map((title) => ({ title })), searchinfo: suggestions[term] ? { suggestion: suggestions[term] } : {} } };
    } else if (p.get("redirects")) {
      const names = (p.get("titles") ?? "").split("|");
      const reds = names.filter((n) => redirects[n]).map((n) => ({ from: n, to: redirects[n] }));
      const pages = names.map((n, i) => {
        const title = redirects[n] ?? n;
        return extracts[title] !== undefined ? { title } : { title, missing: "", ns: i };
      });
      body = { query: { redirects: reds, pages: Object.fromEntries(pages.map((pg, i) => [String(i), pg])) } };
    } else {
      const t = p.get("titles") ?? "";
      body = { query: { pages: { 1: { extract: extracts[t] ?? "" } } } };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });

  beforeAll(() => {
    global.fetch = mock as unknown as typeof fetch;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  beforeEach(() => {
    clearGroundingCache();
    mock.mockClear();
    hits = {};
    suggestions = {};
    redirects = {};
    extracts = {};
  });

  it("follows a redirect to the work's proper name (Duel of the Fates)", async () => {
    hits = { "Duel of the Fates Star Wars: Episode I – The Phantom Menace": ["Duel of the Fates"], "Duel of the Fates Star Wars: The Phantom Menace": ["Duel of the Fates"] };
    redirects = { "Star Wars: The Phantom Menace": "Star Wars: Episode I – The Phantom Menace" };
    extracts = {
      "Duel of the Fates": `"Duel of the Fates" is a musical theme from Star Wars: Episode I – The Phantom Menace.${LONG}`,
      "Star Wars: Episode I – The Phantom Menace": `A film.${LONG}`,
    };
    expect(await fetchGrounding({ title: "Duel of the Fates", artist: "Star Wars: The Phantom Menace" })).toMatch(/^Duel of the Fates\n/);
  });

  it("takes Wikipedia's spelling suggestion when it names one of the search's hits", async () => {
    hits = { "Pirates of the Carribean": ["Pirates of the Caribbean: The Curse of the Black Pearl", "Pirates of the Caribbean"], "Pirates of the Caribbean": ["Pirates of the Caribbean (video game)", "Pirates of the Caribbean"] };
    suggestions = { "Pirates of the Carribean": "pirates of the caribbean" };
    extracts = { "Pirates of the Caribbean": `Pirates of the Caribbean is a Disney media franchise.${LONG}`, "Pirates of the Caribbean (video game)": `A video game.${LONG}` };
    // The page the suggestion names, not the video game a search for it finds first.
    expect(await fetchGrounding({ title: "Davy Jones", artist: "Pirates of the Carribean" })).toMatch(/^Pirates of the Caribbean\n/);
  });

  it("never respells a name into someone the search didn't find", async () => {
    hits = { "Windy Harper": ["Cavalcade of the West", "Jorjet Harper"], "Wendy Harmer": ["Wendy Harmer"] };
    suggestions = { "Windy Harper": "windy harmer" };
    extracts = { "Windy Harmer": `A comedian.${LONG}`, "Wendy Harmer": `A comedian.${LONG}` };
    expect(await fetchGrounding({ title: "Let's Make Toast", artist: "Windy Harper" })).toBe("");
    // A suggestion for a name Wikipedia already has as written is ignored too.
    hits = { Reverie: ["Reverie"] };
    suggestions = { Reverie: "reverse" };
    extracts = { Reverse: `Reverse.${LONG}` };
    expect(await fetchGrounding({ title: "Main Theme", artist: "Reverie" })).toBe("");
  });

  it("finds a traditional song by its title alone, and only an article about a song", async () => {
    hits = { "Greensleeves song": ["Greensleeves"], "Santa Lucia song": ["Santa Lucia"], "Santa Lucia": ["Santa Lucia"] };
    extracts = {
      // Sections the usual ordering doesn't read: every section but the lists is used instead.
      Greensleeves: `"Greensleeves" is a traditional English folk song.\n\n== Origin ==\n${LONG}\n\n== Form ==\n${LONG}\n\n== References ==\nA list.`,
      "Santa Lucia": `Santa Lucia is a town in Sicily.${LONG}`,
    };
    const text = await fetchGrounding({ title: "Greensleeves", artist: "Traditional" });
    expect(text).toMatch(/^Greensleeves\n/);
    expect(text.length).toBeGreaterThan(600);
    expect(text).not.toMatch(/A list/);
    expect(await fetchGrounding({ title: "Santa Lucia", artist: "Italian Folk Song" })).toBe("");
  });

  it("uses a series' own article as Wikipedia files it", async () => {
    hits = { "NieR series video game": ["Nier: Automata", "Drakengard and Nier", "Nier (video game)"] };
    redirects = { "Nier (series)": "Drakengard and Nier" };
    extracts = { "Drakengard and Nier": `Drakengard and Nier is a video game series.${LONG}`, "Nier (video game)": `A game.${LONG}`, "Nier: Automata": `A game.${LONG}` };
    expect(await fetchGrounding({ title: "Grandma", artist: "NieR Series" })).toMatch(/^Drakengard and Nier\n/);
  });

  it("finds a film named in the title of a category artist, never a video game of that name", async () => {
    hits = {
      "Star Trek II: The Wrath of Khan soundtrack": ["Star Trek II: The Wrath of Khan (video game)", "Star Trek II: The Wrath of Khan"],
    };
    extracts = { "Star Trek II: The Wrath of Khan": `A 1982 film.${LONG}`, "Star Trek II: The Wrath of Khan (video game)": `A game.${LONG}` };
    expect(await fetchGrounding({ title: "Star Trek II. The Wrath of Khan", artist: "Star Trek Movies" })).toMatch(/^Star Trek II: The Wrath of Khan\n/);
  });

  it("never takes an installment for a generic track name that every installment mentions", async () => {
    hits = { "Some Saga video game": ["Some Saga II"], "Some Saga soundtrack": ["Some Saga II"], "Some Saga": ["Some Saga II"] };
    extracts = { "Some Saga II": `Some Saga II is a video game. Its main theme was well liked.${LONG}` };
    expect(await fetchGrounding({ title: "Main Theme", artist: "Some Saga" })).toBe("");
  });

  it("never takes another work's article for a generic track name (Star Trek: Discovery)", async () => {
    hits = { "Theme Star Trek: Discovery": ["Theme from Star Trek"], "Star Trek: Discovery soundtrack": ["Theme from Star Trek"], "Star Trek: Discovery": ["Theme from Star Trek"] };
    extracts = { "Theme from Star Trek": `The theme of Star Trek, also heard in Star Trek: Discovery, is a piece of music.${LONG}` };
    expect(await fetchGrounding({ title: "Star Trek: Discovery Theme", artist: "Star Trek TV" })).not.toMatch(/^Theme from Star Trek/);
  });

  it("counts composers named in a page's brackets as named by the article", async () => {
    hits = { "Passacaglia Handel Halvorsen": ["Passacaglia (Handel/Halvorsen)"] };
    extracts = { "Passacaglia (Handel/Halvorsen)": `A piece for violin and viola.${LONG}` };
    expect(await fetchGrounding({ title: "Passacaglia", artist: "Arr. Handel Halvorsen" })).toMatch(/^Passacaglia \(Handel\/Halvorsen\)\n/);
  });

  it("never takes the name's article for a credit of several names when it isn't a performer's", async () => {
    hits = { "Some Song Black Caviar": ["Black Caviar"], "Black Caviar": ["Black Caviar"] };
    extracts = { "Black Caviar": `Black Caviar is an Australian Thoroughbred racehorse.${LONG}` };
    expect(await fetchGrounding({ title: "Some Song", artist: "Some Remixer - Black Caviar" })).toBe("");
  });

  it("takes a game's own article under one of several names", async () => {
    hits = { "Dearly Beloved Kingdom Hearts": ["Kingdom Hearts"], "Kingdom Hearts": ["Kingdom Hearts"] };
    extracts = { "Kingdom Hearts": `Kingdom Hearts is a fantasy action role-playing game franchise. Dearly Beloved is its theme.${LONG}` };
    expect(await fetchGrounding({ title: "Dearly Beloved", artist: "Kingdom Hearts / Some Remixer" })).toMatch(/^Kingdom Hearts\n/);
  });

  it("never takes a disambiguation page that opens with its main meaning", async () => {
    hits = { "Regret 2 A.M.": ["2 A.M."], "2 A.M.": ["2 A.M."] };
    redirects = { "2am": "2 A.M." };
    extracts = { "2 A.M.": "2 A.M. is a time on the 12-hour clock.\n2 A.M. may also refer to:\nA film\nA song" + LONG };
    expect(await fetchGrounding({ title: "Regret", artist: "2am" })).toBe("");
  });

  it("takes only a piece of music for a piece read from the title", async () => {
    hits = { "Victory Overwatch": ["Overwatch and fan art"], "Overwatch Victory": ["Overwatch and fan art"] };
    extracts = { "Overwatch and fan art": `The Overwatch franchise inspired fan art. Players celebrate a victory.${LONG}` };
    expect(await fetchGrounding({ title: "Victory - Overwatch", artist: "Some Remixer" })).toBe("");
    expect(isAPiece("Friend Like Me", '"Friend Like Me" is a song from Disney\'s 1992 animated film Aladdin.')).toBe(true);
    expect(isAPiece("Overwatch", "Overwatch is a 2016 team-based shooter game.")).toBe(false);
  });

  it("reads a work after a dash in the title when the artist is a remixer", async () => {
    hits = { "Dad Battle Friday Night Funkin'": ["Friday Night Funkin'"], "Friday Night Funkin' soundtrack": ["Friday Night Funkin'"] };
    extracts = { "Friday Night Funkin'": `Friday Night Funkin' is a 2020 rhythm game developed by a small team.${LONG}` };
    expect(await fetchGrounding({ title: "Dad Battle - Friday Night Funkin'", artist: "Chiptune Kid" })).toMatch(/^Friday Night Funkin'\n/);
  });

  it("never takes a person, a song or a folk tale for a work read from the title", async () => {
    hits = { "Aladdin soundtrack": ["Aladdin"], Aladdin: ["Aladdin"] };
    extracts = { Aladdin: `Aladdin is a Middle Eastern folk tale, later made into films.${LONG}` };
    expect(await fetchGrounding({ title: "Prince Ali - Aladdin", artist: "Some Remixer" })).toBe("");
  });

  it("follows a redirect from a game's initials (FFVII)", async () => {
    hits = { "Final Fantasy VII soundtrack": ["Final Fantasy VII"] };
    redirects = { FFVII: "Final Fantasy VII" };
    extracts = { "Final Fantasy VII": `Final Fantasy VII is a 1997 role-playing video game. Let the Battles Begin plays in fights.${LONG}` };
    expect(await fetchGrounding({ title: "Let the Battles Begin - FFVII Remix", artist: "Chiptune Kid" })).toMatch(/^Final Fantasy VII\n/);
  });

  it("finds the original's own article for a cover that names it in brackets, and only that", async () => {
    hits = { "Baby Justin Bieber": ["Baby (Justin Bieber song)", "Justin Bieber"] };
    extracts = { "Baby (Justin Bieber song)": `"Baby" is a song by Justin Bieber.${LONG}`, "Justin Bieber": `Justin Bieber is a Canadian singer.${LONG}` };
    expect(await fetchGrounding({ title: "Baby(Justin Bieber)", artist: "Some Cover Band" })).toMatch(/^Baby \(Justin Bieber song\)\n/);
    // No song article: never the original artist's own.
    clearGroundingCache();
    hits = { "Baby Justin Bieber": ["Justin Bieber"], "Justin Bieber": ["Justin Bieber"] };
    expect(await fetchGrounding({ title: "Baby(Justin Bieber)", artist: "Some Cover Band" })).toBe("");
  });

  it("looks up a credit of several names joined by dashes under each name (Under Pressure)", async () => {
    hits = { "Under Pressure Queen": ["Under Pressure"] };
    extracts = { "Under Pressure": `"Under Pressure" is a song by the British rock band Queen and David Bowie.${LONG}` };
    expect(await fetchGrounding({ title: "Under Pressure", artist: "Queen - David Bowie" })).toMatch(/^Under Pressure\n/);
  });
});

describe("glued and dashed version tags, credits of several names (a second song list's misses)", () => {
  it("drops a version tag glued to the title, or ending in what kind of version it is", () => {
    expect(dropVersionTags("Beat It(Arrangement)")).toBe("Beat It");
    expect(dropVersionTags("Dear Mama(Original)")).toBe("Dear Mama");
    expect(dropVersionTags("End of the Road(Acapella)")).toBe("End of the Road");
    expect(dropVersionTags("What a Fool Believes(A Capella Cover)")).toBe("What a Fool Believes");
    expect(dropVersionTags("Guile's Theme(Chill Version)")).toBe("Guile's Theme");
    expect(dropVersionTags("Something Just Like This (Children's Choir Remix)")).toBe("Something Just Like This");
    expect(dropVersionTags("What's the Use(NPR Tiny Desk)")).toBe("What's the Use");
    expect(dropVersionTags("The Real Folk Blues(2020 Performance)")).toBe("The Real Folk Blues");
    expect(dropVersionTags("Can You Feel the Love Tonight(Elton John Version 2)")).toBe("Can You Feel the Love Tonight");
    // A name in brackets is kept: it may be the game, or part of the song's name.
    expect(dropVersionTags("Song of Storms (Ocarina of Time)")).toBe("Song of Storms (Ocarina of Time)");
    expect(dropVersionTags("Forever(Part II.)")).toBe("Forever(Part II.)");
  });

  it("drops a version tag before or after a dash, keeping a work named with it", () => {
    expect(dropVersionTags("Song of Storms(Lofi) - Ocarina of Time")).toBe("Song of Storms - Ocarina of Time");
    expect(dropVersionTags("Numb - 80's Remix")).toBe("Numb");
    expect(dropVersionTags("Coffin Dance - Downtempo Remix")).toBe("Coffin Dance");
    expect(dropVersionTags("Bohemian Rhapsody - Remastered 2011")).toBe("Bohemian Rhapsody");
    expect(dropVersionTags("Let the Battles Begin - FFVII Remix")).toBe("Let the Battles Begin - FFVII");
    expect(dropVersionTags("Mystic Cave Zone - Sonic 2 Trap Remix 1")).toBe("Mystic Cave Zone - Sonic 2");
    // "Act 2" and "Part 2" name a piece.
    expect(dropVersionTags("Undertale - Act 2")).toBe("Undertale - Act 2");
  });

  it("drops a short tag after the artist", () => {
    expect(readings({ title: "Billie Jean", artist: "Michael Jackson - AB" })).toEqual([{ game: "Michael Jackson", track: "Billie Jean", trackOnly: false }]);
    expect(readings({ title: "Rivers in the Desert", artist: "Persona 5 - AB" })[0]).toMatchObject({ game: "Persona 5", track: "Rivers in the Desert" });
    // Three capitals can be a name.
    expect(readings({ title: "Black Swan", artist: "BTS" })).toEqual([{ game: "BTS", track: "Black Swan" }]);
  });

  it("looks up each of several names joined by a dash, an x or ft.", () => {
    expect(readings({ title: "Under Pressure", artist: "Queen - David Bowie" }).slice(1).map((r) => r.game)).toEqual(["Queen", "David Bowie", "Queen", "David Bowie"]);
    expect(readings({ title: "My Heart Will Go On", artist: "Titanic - Celine Dion" }).slice(1)).toEqual([
      { game: "Titanic", track: "My Heart Will Go On", trackOnly: true },
      { game: "Celine Dion", track: "My Heart Will Go On", trackOnly: true },
      { game: "Celine Dion", track: "My Heart Will Go On", trackOnly: false, aPerformer: true },
    ]);
    expect(readings({ title: "Mia", artist: "Bad Bunny x Drake" }).slice(1, 3).map((r) => r.game)).toEqual(["Bad Bunny", "Drake"]);
    expect(readings({ title: "Before I Let Go", artist: "Maze ft. Frankie Beverly" })[1]).toEqual({ game: "Maze", track: "Before I Let Go", trackOnly: true });
    // A capital X is part of a name.
    expect(readings({ title: "Industry Baby", artist: "Lil Nas X" })).toHaveLength(1);
  });

  it("reads the original or the work named in the title when the artist is someone else", () => {
    expect(readings({ title: "Baby(Justin Bieber)", artist: "Some Cover Band" })[1]).toEqual({ game: "Justin Bieber", track: "Baby", trackOnly: true });
    expect(readings({ title: "Gerudo Valley - Ocarina of Time", artist: "Some Remixer" }).slice(1)).toEqual([
      { game: "Ocarina of Time", track: "Gerudo Valley", fromTitle: true },
      { game: "Gerudo Valley", track: "Ocarina of Time", fromTitle: true },
    ]);
    // The usual reading already took the game from the title.
    expect(readings({ title: "Super Mario 64: Dire Dire Docks", artist: "Super Mario" })).toHaveLength(1);
  });

  it("tells a game, a film or a show from a person, a song or a tale", () => {
    expect(isAWork("Final Fantasy VII", "Final Fantasy VII is a 1997 role-playing video game developed by Square.")).toBe(true);
    expect(isAWork("The Mask (1994 film)", "")).toBe(true);
    expect(isAWork("Adventure Time", "Adventure Time is an American animated television series created by Pendleton Ward.")).toBe(true);
    expect(isAWork("Some Composer", "Some Composer is a German film score composer and record producer.")).toBe(false);
    expect(isAWork("Wind", "\"Wind\" is a song by a Japanese singer, used in an anime series.")).toBe(false);
    expect(isAWork("Aladdin", "Aladdin is a Middle Eastern folk tale, later made into films.")).toBe(false);
    expect(isAWork("Queen (band)", "")).toBe(false);
  });

  it("tells a performer from a racehorse or a show's season", () => {
    expect(isAPerformer("Boyce Avenue", "Boyce Avenue is an American rock band formed in 2004.")).toBe(true);
    expect(isAPerformer("Lil Wayne", "Dwayne Michael Carter Jr. (born September 27, 1982), known professionally as Lil Wayne, is an American rapper, singer.")).toBe(true);
    expect(isAPerformer("Some Name (singer)", "")).toBe(true);
    expect(isAPerformer("Black Caviar", "Black Caviar is an Australian Thoroughbred racehorse.")).toBe(false);
    expect(isAPerformer("One Piece season 7", "The seventh season of the One Piece anime series has a theme song.")).toBe(false);
  });

  it("never takes a company or a plural for a name", () => {
    expect(isRelevantArticle("Qumu", "Qumu Corporation")).toBe(false);
    expect(isRelevantArticle("Overwatch", "Overwatch and pornography")).toBe(false);
    expect(isSameWorkRedirect("Qumu", "Qumu Corporation")).toBe(false);
    expect(isRespelling("Memes", "Meme")).toBe(false);
    expect(isRelevantArticle("Celeste", "Celeste (video game)")).toBe(true);
  });

  it("counts a game's initials as its name only with the installment number", () => {
    expect(isInitials("FFVII", "Final Fantasy VII")).toBe(true);
    expect(isInitials("FF7", "Final Fantasy VII")).toBe(true);
    expect(isInitials("TLoZ", "The Legend of Zelda")).toBe(true);
    expect(isInitials("FFX", "Final Fantasy VII")).toBe(false);
    expect(isInitials("Final Fantasy", "Final Fantasy VII")).toBe(false);
    expect(isSameWorkRedirect("FFVII", "Final Fantasy VII")).toBe(true);
  });
});

// Examples below are from the two 50-song fact checks of October 2026 (public works only).
describe("the article must fit the request", () => {
  it("needs an opening about a song, a performer or a work", () => {
    expect(opensAboutMusicOrWork("Jezebel () was the daughter of Ithobaal I of Tyre and the wife of Ahab, King of Israel, according to the Book of Kings of the Hebrew Bible (1 Kings 16). In the biblical narrative, Jezebel replaced Yahwism with Baal and Asherah worship.")).toBe(false);
    expect(opensAboutMusicOrWork("YouTube is an American online video-sharing platform owned by Google. YouTube was founded on February 14, 2005, by Chad Hurley, Jawed Karim and Steve Chen.")).toBe(false);
    expect(opensAboutMusicOrWork('"Square Hammer" is a song by Swedish rock band Ghost.')).toBe(true);
    expect(opensAboutMusicOrWork("The Touhou Project is a bullet hell shoot 'em up video game series created by ZUN.")).toBe(true);
    expect(opensAboutMusicOrWork("Star Trek: Voyager is an American science fiction television series created by Rick Berman, Michael Piller and Jeri Taylor.")).toBe(true);
    expect(opensAboutMusicOrWork("Erik Satie was a French composer and pianist.")).toBe(true);
  });

  it("knows a request placeholder from a song", () => {
    expect(isPlaceholderRequest({ title: "Off-List YouTube Request < 5 Min(Free). 4", artist: "YouTube" })).toBe(true);
    expect(isPlaceholderRequest({ title: "Any song request", artist: "Viewer" })).toBe(true);
    expect(isPlaceholderRequest({ title: "Love Story", artist: "Indila" })).toBe(false);
    expect(isPlaceholderRequest({ title: "Special Request", artist: "The Midnight Owls" })).toBe(false);
  });

  it("asks the article to name the character whose theme it is, and the work in the artist's subtitle", () => {
    expect(requestNames({ title: "Killer (Yoshikage Kira's Theme)", artist: "JoJo's Bizarre Adventure" })).toEqual(["yoshikage kira"]);
    expect(requestNames({ title: "Main Theme", artist: "Star Wars: Rogue One" })).toEqual(["rogue one"]);
    // A stage name in brackets: the game's article may never name it, and its facts were right.
    expect(requestNames({ title: "Kick The Rock! (Wild Canyon)", artist: "Sonic Adventure 2" })).toEqual([]);
    expect(requestNames({ title: "Don't Let The Sun Go Down On Me [Instrumental]", artist: "Elton John" })).toEqual([]);
  });

  it("rejects an article that doesn't name them, or isn't about music or a work", () => {
    rememberArticle("Star Wars (1983 video game)", "Star Wars is a 1983 space combat game developed and published by Atari, Inc. The controller was designed for a Bradley Fighting Vehicle simulator.");
    expect(articleMisfit({ title: "Main Theme", artist: "Star Wars: Rogue One" }, "Star Wars (1983 video game)\nreference")).toBe('never mentions "rogue one"');
    rememberArticle("Jezebel", "Jezebel () was the daughter of Ithobaal I of Tyre and the wife of Ahab, King of Israel.");
    expect(articleMisfit({ title: "Jezebel", artist: "Sade" }, "Jezebel\nreference")).toMatch(/doesn't open like/);
    // For a person's piece a bracket is often a translation: "Under The Stars" is fine.
    rememberArticle("Eugénie Rocherolle", "Eugénie Ricau Rocherolle was an American composer and pianist.");
    expect(articleMisfit({ title: "Debajo Las Estrellas (Under The Stars)", artist: "Eugénie Rocherolle" }, "Eugénie Rocherolle\nreference")).toBe("");
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

  it("drops a caption that barely shares a word with the sentence it cites", () => {
    expect(screen(["1 | Paper Lanterns was recorded in October 1933 as a hit version."]).rejected[0].reason).toBe("doesn't retell the sentence it cites");
  });

  it("checks the caption against the cited sentence only, not the closest one", () => {
    expect(citedMismatch("Ivo Brandt recorded a hit version in October 1933.", sentences, 5, "Paper Lanterns")).toBeNull();
    expect(citedMismatch("Ivo Brandt recorded a hit version in October 1933.", sentences, 4, "Paper Lanterns")).not.toBeNull();
  });
});
