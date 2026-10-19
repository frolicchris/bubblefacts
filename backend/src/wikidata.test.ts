jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { factsFromEntity, pickSong, rankedClaims, searchLanguage, searchLanguages, wikidataFacts } from "./wikidata";

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
      '"Megalovania" came out in 2015.',
      '"Megalovania" appears on Undertale Soundtrack.',
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
