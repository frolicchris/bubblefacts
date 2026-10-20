jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { clearGroundingCache, fetchGrounding, gameTrackText, namesPiece, oneOfSeveral, resolveGameAndTrack, workMatchConfidence } from "./fact-verifier";

// Made-up bands, songs and games. Each case is a wrong work the lookup once took: an artist's name
// read as a game's, a name the article only uses for something else, one of several same-name games.
describe("the requested work, or none", () => {
  let hits: Record<string, string[]>;
  let descriptions: Record<string, string>;
  let extracts: Record<string, string>;
  const LONG = " It was made by a small team over three years.".repeat(20);
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    const term = p.get("srsearch");
    const names = (p.get("titles") ?? "").split("|");
    let body: unknown;
    if (term !== null) body = { query: { search: (hits[term] ?? []).map((title) => ({ title })) } };
    else if (p.get("prop") === "description")
      body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), descriptions[n] !== undefined ? { title: n, description: descriptions[n] } : { title: n, missing: "" }])) } };
    else if (p.get("redirects")) body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), { title: n, missing: "" }])) } };
    else body = { query: { pages: { 1: { extract: extracts[names[0]] ?? "", revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
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
    descriptions = {};
    extracts = {};
  });

  it("takes a band's song article over a game that only uses the title as a word", async () => {
    // Heart's "Alone" once read from "Heart of Darkness (video game)", which says "working alone".
    hits = { "Lantern video game": ["Lantern of Dusk (video game)"] };
    extracts = {
      "Lantern of Dusk (video game)": `Lantern of Dusk is a 1998 platform video game. Its director said he preferred working alone.${LONG}`,
      "Paper Moonlight (song)": `"Paper Moonlight" is a 1987 single by the American rock band Lantern. It reached number one in Canada.${LONG}`,
    };
    descriptions = { "Lantern (band)": "American rock band", "Paper Moonlight (song)": "1987 single by Lantern" };
    expect(await fetchGrounding({ title: "Paper Moonlight", artist: "Lantern" })).toMatch(/^Paper Moonlight \(song\)\n/);
  });

  it("takes a band's article over someone else's album that never names the song", async () => {
    // Muse's "Space Dementia" once read from Elton John's "The Muse (soundtrack)".
    hits = { "Quasar soundtrack": ["The Quasar (soundtrack)"] };
    extracts = {
      "The Quasar (soundtrack)": `The Quasar is a soundtrack album by Dana Reyes for the 1999 film of the same name.${LONG}`,
      "Quasar (band)": `Quasar are an English rock band formed in 1994.${LONG}`,
    };
    descriptions = { "Quasar (band)": "English rock band" };
    expect(await fetchGrounding({ title: "Orbit Fever", artist: "Quasar" })).toMatch(/^Quasar \(band\)\n/);
  });

  it("keeps the band's article when the song's own is too short to write from", async () => {
    hits = { "Velvet Harbor": ["Velvet Harbor"] };
    extracts = {
      "Velvet Harbor": `Velvet Harbor are an American glam metal band formed in 1985.${LONG}`,
      "Rust Parade (Velvet Harbor song)": `"Rust Parade" is a 1989 single by Velvet Harbor.`,
    };
    descriptions = { "Velvet Harbor": "American glam metal band", "Rust Parade (Velvet Harbor song)": "1989 single by Velvet Harbor" };
    expect(await fetchGrounding({ title: "Rust Parade", artist: "Velvet Harbor" })).toMatch(/^Velvet Harbor\n/);
  });

  it("keeps a person's own article that never names the song", async () => {
    // Not a record by someone else: the performer's lookup finds this very page.
    hits = { "Mara Quinn": ["Mara Quinn"] };
    extracts = { "Mara Quinn": `Mara Quinn is an American internet personality and actress.${LONG}` };
    descriptions = { "Mara Quinn": "American internet personality and entertainer" };
    expect(await fetchGrounding({ title: "Lanterns in the Rain", artist: "Mara Quinn" })).toMatch(/^Mara Quinn\n/);
  });

  it("keeps a game's article when a band shares the game's name but has no such song", async () => {
    hits = { "Starfall video game": ["Starfall (video game)"] };
    extracts = { "Starfall (video game)": `Starfall is a 2003 platform video game.${LONG}` };
    descriptions = { "Starfall (band)": "Swedish pop band" };
    expect(await fetchGrounding({ title: "Comet Ridge", artist: "Starfall" })).toMatch(/^Starfall \(video game\)/);
  });

  it("never takes a later game that names the track only as something else", async () => {
    // "Vampire Killer" once read from "Castlevania: Belmont's Curse", whose whip has that name.
    hits = { "Gloomhold video game": ["Gloomhold: Ashen Crown", "Gloomhold"], Gloomhold: ["Gloomhold"] };
    extracts = {
      "Gloomhold: Ashen Crown": `Gloomhold: Ashen Crown is a 2025 action video game. The hero wields the "Night Lancer", a spear passed down in his family.${LONG}`,
      Gloomhold: `Gloomhold is a video game series created by an imaginary studio. Its heroes carry the Night Lancer.${LONG}`,
    };
    const text = await fetchGrounding({ title: "Night Lancer", artist: "Gloomhold" });
    expect(text).not.toMatch(/^Gloomhold: Ashen Crown\n/);
    // The series' article may serve, but never as sure about this one track, nor with the spear as "About this piece".
    if (text) {
      expect(text).not.toMatch(/^About this piece:/m);
      expect(workMatchConfidence({ title: "Night Lancer", artist: "Gloomhold" }, text).level).toBe("unsure");
    }
  });

  it("takes the one of several same-name games that names the track", async () => {
    hits = { "Brawlers!! video game": ["Brawlers!! (1984 video game)", "Brawlers!! (1987 video game)", "Brawlers!!"] };
    extracts = {
      "Brawlers!! (1984 video game)": `Brawlers!! is a 1984 arcade boxing video game.${LONG}`,
      "Brawlers!! (1987 video game)": `Brawlers!! is a 1987 boxing video game for home consoles.${LONG}\n== Music ==\nIts music includes "Locker Room", played between bouts.`,
      "Brawlers!!": `Brawlers!! is a boxing video game series.${LONG}`,
    };
    expect(await fetchGrounding({ title: "Locker Room", artist: "Brawlers!!" })).toMatch(/^Brawlers!! \(1987 video game\)\n/);
  });

  it("never guesses among same-name games when none names the track", async () => {
    // NES Punch-Out!!'s "Training" once read from the 1984 arcade game's article.
    hits = { "Brawlers!! video game": ["Brawlers!! (1984 video game)", "Brawlers!! (1987 video game)", "Brawlers!!"] };
    extracts = {
      "Brawlers!! (1984 video game)": `Brawlers!! is a 1984 arcade boxing video game.${LONG}`,
      "Brawlers!! (1987 video game)": `Brawlers!! is a 1987 boxing video game for home consoles.${LONG}`,
      "Brawlers!!": `Brawlers!! is a boxing video game series. The hero goes to training camp.${LONG}`,
    };
    const text = await fetchGrounding({ title: "Locker Room", artist: "Brawlers!!" });
    expect(text).not.toMatch(/^Brawlers!! \(19\d\d video game\)/);
    if (text) expect(workMatchConfidence({ title: "Locker Room", artist: "Brawlers!!" }, text).level).toBe("unsure");
  });
});

describe("namesPiece", () => {
  it("counts a name only in a sentence about music", () => {
    expect(namesPiece('The hero wields the "Night Lancer", a spear.', "Night Lancer")).toBe(false);
    expect(namesPiece("He said he preferred working alone.", "Alone")).toBe(false);
    expect(namesPiece('Its main theme, "Night Lancer", was composed by Mara Quinn.', "Night Lancer")).toBe(true);
    expect(namesPiece('"Alone" reached number one on the singles chart.', "Alone")).toBe(true);
  });
});

describe("oneOfSeveral", () => {
  const titles = ["Brawlers!! (1984 video game)", "Brawlers!! (1987 video game)", "Brawlers!!"];
  it("marks a dated article when the name has others and the request gives no year", () => {
    expect(oneOfSeveral("Brawlers!! (1984 video game)", titles, "Brawlers!!")).toBe(true);
    expect(oneOfSeveral("Brawlers!! (1984 video game)", titles, "Brawlers!! 1984")).toBe(false);
    expect(oneOfSeveral("Brawlers!!", titles, "Brawlers!!")).toBe(false);
    expect(oneOfSeveral("Brawlers!! (1984 video game)", ["Brawlers!! (1984 video game)"], "Brawlers!!")).toBe(false);
  });
});

describe("a game named in the title", () => {
  it("reads the possessive form as the longer name", () => {
    expect(resolveGameAndTrack({ title: "Nibbo's Voyage: Coral Cove", artist: "Nibbo" })).toEqual({ game: "Nibbo's Voyage", track: "Coral Cove" });
    expect(resolveGameAndTrack({ title: "Nibbo’s Voyage - Coral Cove", artist: "Nibbo" })).toEqual({ game: "Nibbo’s Voyage", track: "Coral Cove" });
    expect(resolveGameAndTrack({ title: "Nibbonian: Coral Cove", artist: "Nibbo" })).toEqual({ game: "Nibbo", track: "Nibbonian: Coral Cove" });
  });
});

describe("About this piece", () => {
  it("holds only sentences about the music", () => {
    const full = `Gloomhold is a video game series.${" Filler sentence for the article body goes here.".repeat(10)} The hero carries the Night Lancer into every battle. The series' main theme "Night Lancer" was composed by Mara Quinn.`;
    const text = gameTrackText({ page: "Gloomhold", full, music: null }, "Night Lancer");
    expect(text).toMatch(/^About this piece: The series' main theme "Night Lancer" was composed by Mara Quinn\.$/m);
    expect(text).not.toMatch(/^About this piece:.*carries the Night Lancer/m);
  });
});
