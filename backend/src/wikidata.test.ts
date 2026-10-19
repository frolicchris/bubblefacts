jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { artistFactsFromEntity, factsFromEntity, pickSong, rankedClaims, searchLanguage } from "./wikidata";

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

describe("artistFactsFromEntity (issue #255)", () => {
  const ids = (...list: string[]) => list.map((id) => ({ mainsnak: { datavalue: { value: { id } } } }));
  const time = (t: string) => [{ mainsnak: { datavalue: { value: { time: t } } } }];
  const labels = Object.fromEntries(
    [["Q10", "Harborview"], ["Q11", "dream pop"], ["Q12", "shoegaze"], ["Q13", "Kenji Arata"], ["Q14", "Hollow Pine Inc."], ["Q15", "Some Records"]].map(([id, value]) => [id, { id, labels: { mul: { value } } }])
  );

  it("tells when and where a band formed, then its genres: two facts at most", () => {
    const band = { id: "Q1", labels: { en: { value: "Velvet Lark" } }, descriptions: { en: { value: "American dream pop band" } }, claims: { P31: ids("Q215380"), P571: time("+1994-00-00T00:00:00Z"), P740: ids("Q10"), P136: ids("Q11", "Q12"), P264: ids("Q15") } };
    expect(artistFactsFromEntity(band, labels)).toEqual(["Velvet Lark formed in Harborview in 1994.", "Velvet Lark's genres include dream pop and shoegaze."]);
  });

  it("tells when a singer was born, and reads labels given for every language", () => {
    const singer = { id: "Q2", labels: { mul: { value: "Dana Reyes" } }, descriptions: { en: { value: "English singer" } }, claims: { P31: ids("Q5"), P569: time("+1950-03-01T00:00:00Z"), P264: ids("Q15") } };
    expect(artistFactsFromEntity(singer, labels)).toEqual(["Dana Reyes was born in 1950.", "Dana Reyes's record labels include Some Records."]);
  });

  it("tells who scored and made a game, without doubling a name's final period", () => {
    const game = { id: "Q3", labels: { en: { value: "Starfall Saga" } }, descriptions: { en: { value: "1996 video game" } }, claims: { P86: ids("Q13"), P178: ids("Q14"), P577: time("+1996-05-01T00:00:00Z") } };
    expect(artistFactsFromEntity(game, labels)).toEqual(["The music of Starfall Saga is by Kenji Arata.", "Starfall Saga was developed by Hollow Pine Inc."]);
  });
});
