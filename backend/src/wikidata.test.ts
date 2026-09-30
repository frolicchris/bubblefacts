jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { factsFromEntity, pickSong } from "./wikidata";

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
