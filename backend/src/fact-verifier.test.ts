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
  splitGameAndTrack,
  resolveGameAndTrack,
  isRelevantArticle,
  unsupportedName,
  platformSupported,
  looksLikeArtistName,
  qualifierNamesAnotherArtist,
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
    expect(artistNames("Simon and Garfunkel")).toEqual(["simon and garfunkel"]);
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
    expect(artistNames("Simon and Garfunkel")).toEqual(["simon and garfunkel"]);
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
