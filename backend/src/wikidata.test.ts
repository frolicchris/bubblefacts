jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { MAX_FACT_CHARS } from "./fact-verifier";
import { artistFactsFromEntity, factsFromEntity, pickSong, plainDate, rankedClaims, searchLanguage, searchLanguages, wikidataFacts } from "./wikidata";

describe("pickSong", () => {
  const lostBoy = [
    { id: "Q1", label: "Lost Boy", description: "single by Ruth B" },
    { id: "Q2", label: "Lost Boy", description: "2015 film directed by Tara Miele" },
  ];

  it("matches the song by title and the artist named in its description", () => {
    const hits = [{ id: "Q107619633", label: "Industry Baby", description: "2021 single by Lil Nas X and Jack Harlow" }];
    expect(pickSong(hits, "INDUSTRY BABY", "Lil Nas X, Jack Harlow")).toBe("Q107619633");
  });

  it("matches a game track through the game named in its description", () => {
    const hits = [{ id: "Q138753162", label: "MEGALOVANIA", description: "track #100 in the Undertale Soundtrack" }];
    expect(pickSong(hits, "Megalovania", "Undertale")).toBe("Q138753162");
  });

  it("never takes a same-named song by someone else, or a film", () => {
    // "The Midnight - Lost Boy": Wikidata only has Ruth B's song.
    expect(pickSong(lostBoy, "Lost Boy", "The Midnight")).toBeNull();
  });
});

describe("factsFromEntity", () => {
  const item = (claims: Record<string, unknown[]>) => ({
    id: "Q1",
    claims: Object.fromEntries(
      Object.entries(claims).map(([p, vals]) => [p, vals.map((value) => ({ mainsnak: { datavalue: { value } } }))])
    ),
  });
  const labels = {
    Q10: { id: "Q10", labels: { en: { value: "Toby Fox" } } },
    Q11: { id: "Q11", labels: { en: { value: "Undertale Soundtrack" } } },
    Q12: { id: "Q12", labels: { en: { value: "Billboard Hot 100" } } },
  };

  it("writes one plain sentence per statement, naming the song", () => {
    const facts = factsFromEntity(
      item({
        P86: [{ id: "Q10" }],
        P676: [{ id: "Q10" }],
        P577: [{ time: "+2015-09-15T00:00:00Z" }],
        P361: [{ id: "Q11" }],
        P2291: [{ id: "Q12" }],
      }),
      labels,
      "Megalovania"
    );
    expect(facts).toEqual([
      '"Megalovania" was written by Toby Fox.',
      '"Megalovania" came out in 2015 and appears on Undertale Soundtrack.',
      '"Megalovania" made the Billboard Hot 100.',
    ]);
  });

  it("uses the earliest release year and skips statements without a label", () => {
    const facts = factsFromEntity(
      item({ P577: [{ time: "+2019-01-01T00:00:00Z" }, { time: "+2017-05-05T00:00:00Z" }], P162: [{ id: "Q99" }] }),
      labels,
      "Song"
    );
    expect(facts).toEqual(['"Song" came out in 2017.']);
  });
});

describe("titles in other scripts (review)", () => {
  it("searches in the title's language", () => {
    expect(searchLanguage("紅蓮華")).toBe("ja");
    expect(searchLanguage("アイドル")).toBe("ja");
    expect(searchLanguage("강남스타일")).toBe("ko");
    expect(searchLanguage("Gurenge")).toBe("en");
  });

  it("matches a Japanese description naming the artist in Latin letters", () => {
    expect(pickSong([{ id: "Q65278185", label: "紅蓮華", description: "LiSAの楽曲" }], "紅蓮華", "LiSA")).toBe("Q65278185");
    expect(pickSong([{ id: "Q1", label: "紅蓮華", description: "日本のアダルトゲーム" }], "紅蓮華", "LiSA")).toBeNull();
  });
});

describe("statement ranks (review)", () => {
  it("drops deprecated statements and prefers preferred ones", () => {
    const e = {
      id: "Q1",
      claims: {
        P577: [
          { rank: "deprecated", mainsnak: { datavalue: { value: { time: "+1900-01-01T00:00:00Z" } } } },
          { rank: "normal", mainsnak: { datavalue: { value: { time: "+1999-01-01T00:00:00Z" } } } },
          { rank: "preferred", mainsnak: { datavalue: { value: { time: "+2000-01-01T00:00:00Z" } } } },
        ],
      },
    };
    expect(rankedClaims(e, "P577")).toHaveLength(1);
    expect(factsFromEntity(e, {}, "Song")).toEqual(['"Song" came out in 2000.']);
  });
});

describe("artistFactsFromEntity (issue #255)", () => {
  const ids = (...list: string[]) => list.map((id) => ({ mainsnak: { datavalue: { value: { id } } } }));
  const time = (t: string) => [{ mainsnak: { datavalue: { value: { time: t } } } }];
  const labels = Object.fromEntries(
    [["Q10", "Harborview"], ["Q11", "dream pop"], ["Q12", "shoegaze"], ["Q13", "Kenji Arata"], ["Q14", "Hollow Pine Inc."], ["Q15", "Some Records"]].map(([id, value]) => [id, { id, labels: { mul: { value } } }])
  );

  it("tells when and where a band formed, its genres and labels in one bubble", () => {
    const band = { id: "Q1", labels: { en: { value: "Velvet Lark" } }, descriptions: { en: { value: "American dream pop band" } }, claims: { P31: ids("Q215380"), P571: time("+1994-00-00T00:00:00Z"), P740: ids("Q10"), P136: ids("Q11", "Q12"), P264: ids("Q15") } };
    expect(artistFactsFromEntity(band, labels)).toEqual(["Velvet Lark formed in Harborview in 1994. Genres include dream pop and shoegaze. Record labels include Some Records."]);
  });

  it("tells when a singer was born, and reads labels given for every language", () => {
    const singer = { id: "Q2", labels: { mul: { value: "Dana Reyes" } }, descriptions: { en: { value: "English singer" } }, claims: { P31: ids("Q5"), P569: time("+1950-03-01T00:00:00Z"), P264: ids("Q15") } };
    expect(artistFactsFromEntity(singer, labels)).toEqual(["Dana Reyes was born in 1950. Record labels include Some Records."]);
  });

  it("tells who scored and made a game, without doubling a name's final period", () => {
    const game = { id: "Q3", labels: { en: { value: "Starfall Saga" } }, descriptions: { en: { value: "1996 video game" } }, claims: { P86: ids("Q13"), P178: ids("Q14"), P577: time("+1996-05-01T00:00:00Z") } };
    expect(artistFactsFromEntity(game, labels)).toEqual(["The music of Starfall Saga is by Kenji Arata.", "Starfall Saga was developed by Hollow Pine Inc."]);
  });
});

describe("Han-only titles (#183)", () => {
  it("tries Japanese, then Chinese, then English for Han characters alone", () => {
    expect(searchLanguages("星空旋律")).toEqual(["ja", "zh", "en"]);
    expect(searchLanguage("星空旋律")).toBe("ja");
  });

  it("keeps one language for titles with kana, Hangul or Cyrillic, and Latin titles", () => {
    expect(searchLanguages("星空のワルツ")).toEqual(["ja"]); // kanji with kana is Japanese
    expect(searchLanguages("별빛 노래")).toEqual(["ko"]);
    expect(searchLanguages("Звёздная песня")).toEqual(["ru"]);
    expect(searchLanguages("Starlight Waltz")).toEqual(["en"]);
  });

  it("matches a Chinese description that names the artist in Han characters", () => {
    const hits = [{ id: "Q1", label: "星空旋律", description: "林小雨演唱的歌曲" }];
    expect(pickSong(hits, "星空旋律", "林小雨")).toBe("Q1");
    expect(pickSong(hits, "星空旋律", "陈大文")).toBeNull();
    expect(pickSong([{ id: "Q2", label: "星空旋律", description: "1994年電影" }], "星空旋律", "林小雨")).toBeNull();
    expect(pickSong([{ id: "Q3", label: "星空旋律", description: "林小雨的單曲" }], "星空旋律", "林小雨")).toBe("Q3");
  });
});

describe("wikidataFacts for a Han-only title (#183)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** A fake Wikidata: searches answer by language, entity lookups answer with a small song item. */
  function fakeWikidata(byLanguage: Record<string, unknown[]>) {
    const languages: string[] = [];
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const u = new URL(String(url));
      let body: unknown = {};
      if (u.searchParams.get("action") === "wbsearchentities") {
        languages.push(u.searchParams.get("language") ?? "");
        body = { search: byLanguage[u.searchParams.get("language") ?? ""] ?? [] };
      } else {
        const ids = (u.searchParams.get("ids") ?? "").split("|");
        body = {
          entities: Object.fromEntries(
            ids.map((id) => [
              id,
              id === "Q5001"
                ? { id, claims: { P577: [{ mainsnak: { datavalue: { value: { time: "+1990-01-01T00:00:00Z" } } } }] } }
                : { id },
            ])
          ),
        };
      }
      return { ok: true, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    return languages;
  }
  const song = (title: string, artist: string) => ({ title, artist });
  const hit = (label: string) => ({ id: "Q5001", label, description: "1990 single by Lin Xiaoyu" });

  it("stops at Japanese when it finds the song", async () => {
    const languages = fakeWikidata({ ja: [hit("星空旋律")] });
    expect(await wikidataFacts(song("星空旋律", "Lin Xiaoyu"))).toEqual(['"星空旋律" came out in 1990.']);
    expect(languages).toEqual(["ja"]);
  });

  it("goes on to Chinese when Japanese finds no song", async () => {
    const languages = fakeWikidata({ ja: [{ id: "Q9", label: "月光小夜曲", description: "2001 film" }], zh: [hit("月光小夜曲")] });
    expect(await wikidataFacts(song("月光小夜曲", "Lin Xiaoyu"))).toEqual(['"月光小夜曲" came out in 1990.']);
    expect(languages).toEqual(["ja", "zh"]);
  });

  it("ends with English, and gives nothing when no search finds the song", async () => {
    const languages = fakeWikidata({});
    expect(await wikidataFacts(song("夜空之歌", "Lin Xiaoyu"))).toEqual([]);
    expect(languages).toEqual(["ja", "zh", "en"]);
  });
});

describe("more data facts (#256)", () => {
  const claim = (value: unknown, rank?: string) => ({ rank, mainsnak: { datavalue: { value } } });
  const song = (claims: Record<string, unknown[]>, description = "1990 single by Lin Xiaoyu") => ({
    id: "Q1",
    descriptions: { en: { value: description } },
    claims: Object.fromEntries(Object.entries(claims).map(([p, vals]) => [p, vals.map((v) => claim(v))])),
  });
  const named = (...pairs: Array<[string, string, string?]>) =>
    Object.fromEntries(pairs.map(([id, value, description]) => [id, { id, labels: { en: { value } }, ...(description ? { descriptions: { en: { value: description } } } : {}) }]));
  const L = named(["Q20", "Old Harbor Song"], ["Q21", "Harbor Remix"], ["Q22", "Harbor Sample"], ["Q23", "Harbor Third"], ["Q24", "Opening Night", "1989 single by Lin Xiaoyu"],
    ["Q25", "Closing Night", "1991 single by Lin Xiaoyu"], ["Q26", "Japanese"], ["Q27", "English"], ["Q28", "no linguistic content"], ["Q29", "Korean"],
    ["Q30", "Q12345"], ["Q31", "Harbor Lights", "1990 single by Lin Xiaoyu"], ["Q32", "Quiet Pier", "1956 song performed by Chen Dawen"],
    ["Q33", "Old Harbor Song (Chen Dawen song)"]);
  const t = "Harbor Lights";

  it("says what a song is based on, naming the other work and no artist", () => {
    expect(factsFromEntity(song({ P144: [{ id: "Q20" }] }), L, t)).toEqual(['"Harbor Lights" is based on "Old Harbor Song".']);
  });

  it("skips a based-on work with the song's own name, a missing label and a bare item number", () => {
    expect(factsFromEntity(song({ P144: [{ id: "Q31" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P144: [{ id: "Q999" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P144: [{ id: "Q30" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P144: [{ id: "Q31" }, { id: "Q20" }] }), L, t)).toEqual(['"Harbor Lights" is based on "Old Harbor Song".']);
  });

  it("names at most two derivative works, without crediting them to anyone", () => {
    const facts = factsFromEntity(song({ P4969: [{ id: "Q21" }, { id: "Q22" }, { id: "Q23" }] }), L, t);
    expect(facts).toEqual(['Derivative works of "Harbor Lights" include "Harbor Remix" and "Harbor Sample".']);
    expect(factsFromEntity(song({ P4969: [{ id: "Q31" }, { id: "Q21" }] }), L, t)).toEqual(['Derivative works of "Harbor Lights" include "Harbor Remix".']);
    expect(factsFromEntity(song({ P4969: [{ id: "Q31" }] }), L, t)).toEqual([]);
  });

  it("names the single before and after only for a single", () => {
    const claims = { P155: [{ id: "Q24" }], P156: [{ id: "Q25" }] };
    expect(factsFromEntity(song(claims), L, t)).toEqual([
      '"Harbor Lights" came after the single "Opening Night".',
      '"Harbor Lights" was followed by the single "Closing Night".',
    ]);
    expect(factsFromEntity(song({ P156: [{ id: "Q25" }] }), L, t)).toEqual(['"Harbor Lights" was followed by the single "Closing Night".']);
    expect(factsFromEntity(song(claims, "track #4 in the Harbor Soundtrack"), L, t)).toEqual([]);
  });

  it("skips a neighbor that isn't described as a single, a missing one and one with the song's own name", () => {
    // An earlier song a single covers is not "the single before".
    expect(factsFromEntity(song({ P155: [{ id: "Q32" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P155: [{ id: "Q999" }], P156: [{ id: "Q31" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P155: [{ id: "Q32" }, { id: "Q24" }] }), L, t)).toEqual([]); // two, so unclear which
  });

  it("skips two neighbors on one side, and a neighbor released on the wrong side of the song", () => {
    // Two "follows" means two series (a duet): which one is meant is unknown.
    expect(factsFromEntity(song({ P155: [{ id: "Q24" }, { id: "Q25" }] }), L, t)).toEqual([]);
    // "Followed by" a single from 1981 when the song is from 1990, and the reverse.
    expect(factsFromEntity(song({ P156: [{ id: "Q24" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P155: [{ id: "Q25" }] }), L, t)).toEqual([]);
  });

  it("drops a disambiguation in brackets from a label", () => {
    expect(factsFromEntity(song({ P144: [{ id: "Q33" }] }), L, t)).toEqual(['"Harbor Lights" is based on "Old Harbor Song".']);
  });

  it("names the language of the lyrics only when it isn't English", () => {
    expect(factsFromEntity(song({ P407: [{ id: "Q26" }] }), L, t)).toEqual(['The lyrics of "Harbor Lights" are in Japanese.']);
    expect(factsFromEntity(song({ P407: [{ id: "Q29" }, { id: "Q27" }] }), L, t)).toEqual(['The lyrics of "Harbor Lights" are in Korean and English.']);
    expect(factsFromEntity(song({ P407: [{ id: "Q27" }] }), L, t)).toEqual([]);
    expect(factsFromEntity(song({ P407: [{ id: "Q28" }] }), L, t)).toEqual([]); // an instrumental has no lyrics
    expect(factsFromEntity(song({ P407: [{ id: "Q999" }] }), L, t)).toEqual([]);
  });

  it("gives the first performance to the precision Wikidata has", () => {
    const at = (time: string, precision: number) => ({ time, precision });
    expect(factsFromEntity(song({ P1191: [at("+1987-03-03T00:00:00Z", 11)] }), L, t)).toEqual(['"Harbor Lights" was first performed on March 3, 1987.']);
    expect(factsFromEntity(song({ P1191: [at("+1987-03-01T00:00:00Z", 10)] }), L, t)).toEqual(['"Harbor Lights" was first performed in March 1987.']);
    expect(factsFromEntity(song({ P1191: [at("+1987-01-01T00:00:00Z", 9), at("+1986-06-06T00:00:00Z", 11)] }), L, t)).toEqual([
      '"Harbor Lights" was first performed on June 6, 1986.',
    ]);
  });

  it("skips a first performance that is only a decade, unreadable, before the year 1000 or has no precision", () => {
    expect(plainDate({ time: "+1980-01-01T00:00:00Z", precision: 8 })).toBeNull();
    expect(plainDate({ time: "+0900-01-01T00:00:00Z", precision: 9 })).toBeNull();
    expect(plainDate({ time: "-0100-01-01T00:00:00Z", precision: 9 })).toBeNull();
    expect(plainDate({ time: "+1987-00-00T00:00:00Z", precision: 10 })).toBeNull();
    expect(plainDate({ time: "+1987-02-30T00:00:00Z" })).toBeNull();
    expect(plainDate("1987")).toBeNull();
    expect(plainDate(undefined)).toBeNull();
    expect(factsFromEntity(song({ P1191: [{ time: "soon", precision: 9 }] }), L, t)).toEqual([]);
  });

  it("ignores deprecated statements and reads preferred ones first", () => {
    const e = {
      id: "Q1",
      claims: { P144: [{ rank: "deprecated", mainsnak: { datavalue: { value: { id: "Q20" } } } }, { rank: "normal", mainsnak: { datavalue: { value: { id: "Q21" } } } }] },
    };
    expect(factsFromEntity(e, L, t)).toEqual(['"Harbor Lights" is based on "Harbor Remix".']);
  });

  it("keeps the older facts first", () => {
    const facts = factsFromEntity(song({ P577: [{ time: "+1990-05-05T00:00:00Z" }], P144: [{ id: "Q20" }] }), L, t);
    expect(facts).toEqual(['"Harbor Lights" came out in 1990.', '"Harbor Lights" is based on "Old Harbor Song".']);
  });
});

describe("wikidataFacts with no artist (issue #261)", () => {
  it("does not look up a song whose artist field means no artist", async () => {
    const fetchMock = jest.fn(async () => { throw new Error("offline"); });
    const real = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      for (const artist of ["Traditional", "Trad.", "Anon.", "Anonymous", "Unknown", "Folk"]) {
        expect(await wikidataFacts({ title: "Marigold Lane", artist })).toEqual([]);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = real;
    }
  });
});

describe("basic facts in one bubble (#256)", () => {
  const claim = (value: unknown) => ({ mainsnak: { datavalue: { value } } });
  const item = (claims: Record<string, unknown[]>) => ({ id: "Q1", claims: Object.fromEntries(Object.entries(claims).map(([p, vals]) => [p, vals.map(claim)])) });
  const named = (...pairs: Array<[string, string]>) => Object.fromEntries(pairs.map(([id, value]) => [id, { id, labels: { en: { value } } }]));
  const year = { P577: [{ time: "+2004-06-01T00:00:00Z" }] };

  it("tells a song's year and where it appears together", () => {
    const L = named(["Q2", "Paper Boats"]);
    expect(factsFromEntity(item({ ...year, P361: [{ id: "Q2" }] }), L, "Harbor Lights")).toEqual(['"Harbor Lights" came out in 2004 and appears on Paper Boats.']);
  });

  it("keeps a single fact when only one value is known", () => {
    expect(factsFromEntity(item(year), {}, "Harbor Lights")).toEqual(['"Harbor Lights" came out in 2004.']);
    expect(factsFromEntity(item({ P361: [{ id: "Q2" }] }), named(["Q2", "Paper Boats"]), "Harbor Lights")).toEqual(['"Harbor Lights" appears on Paper Boats.']);
  });

  it("falls back to separate facts when the combination would not fit a bubble", () => {
    const title = "The Long Slow Walk Home Along the Quiet Harbor Wall at Dusk Again";
    const album = "Songs for the Lamplighters of the Eastern Pier and Beyond Again";
    const facts = factsFromEntity(item({ ...year, P361: [{ id: "Q2" }] }), named(["Q2", album]), title);
    expect(facts).toEqual([`"${title}" came out in 2004.`, `"${title}" appears on ${album}.`]);
    expect(`"${title}" came out in 2004 and appears on ${album}.`.length).toBeGreaterThan(MAX_FACT_CHARS);
  });

  describe("about the artist", () => {
    const ids = (...list: string[]) => list.map((id) => ({ id }));
    const labels = named(["Q10", "Harborview"], ["Q11", "dream pop"], ["Q12", "shoegaze"], ["Q15", "Some Records"]);
    const band = (claims: Record<string, unknown[]>) => ({ id: "Q9", labels: { en: { value: "Velvet Lark" } }, descriptions: { en: { value: "American dream pop band" } }, claims: Object.fromEntries(Object.entries(claims).map(([p, v]) => [p, v.map(claim)])) });

    it("joins where and when a band formed with its genres", () => {
      const e = band({ P31: ids("Q215380"), P571: [{ time: "+1994-00-00T00:00:00Z" }], P740: ids("Q10"), P136: ids("Q11", "Q12") });
      expect(artistFactsFromEntity(e, labels)).toEqual(["Velvet Lark formed in Harborview in 1994. Genres include dream pop and shoegaze."]);
    });

    it("keeps a single fact when only the genres are known", () => {
      expect(artistFactsFromEntity(band({ P136: ids("Q11") }), labels)).toEqual(["Velvet Lark's genres include dream pop."]);
    });

    it("starts another bubble when the next sentence would not fit", () => {
      const long = named(["Q10", "A Small Harbor Town Far Up the Windswept Northern Coast Beyond the Lighthouse Road"], ["Q11", "atmospheric chamber folk"], ["Q12", "experimental ambient drone"]);
      const e = band({ P571: [{ time: "+1994-00-00T00:00:00Z" }], P740: ids("Q10"), P136: ids("Q11", "Q12") });
      expect(artistFactsFromEntity(e, long)).toEqual([
        "Velvet Lark formed in A Small Harbor Town Far Up the Windswept Northern Coast Beyond the Lighthouse Road in 1994.",
        "Velvet Lark's genres include atmospheric chamber folk and experimental ambient drone.",
      ]);
    });
  });
});
