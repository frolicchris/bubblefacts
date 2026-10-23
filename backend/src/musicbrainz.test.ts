jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general", mbLink: true, factVerification: true },
}));

import { config } from "./config";
import { clearGroundingCache, fetchGrounding, workMatchConfidence } from "./fact-verifier";
import { artistByTitle, cachedArtistByTitle, clearLinkCache, clearOrderCache, clearTitleCache, composersOf, firstYear, gameCandidates, linkedGrounding, musicbrainzFacts, performerFacts, readableName, recordingOrder, settleTitleOrder, statedYear, statesAlbum, withoutYear } from "./musicbrainz";
import fs from "fs";
import path from "path";

let nextId = 0;
const rec = (title: string, artist: string, date: string, releases: Array<[string, string?, string[]?]>, score = 100) => ({
  id: `rec-${++nextId}`,
  score,
  title,
  "first-release-date": date,
  "artist-credit": [{ name: artist }],
  releases: releases.map(([t, status, types]) => ({
    title: t,
    status: status ?? "Official",
    "release-group": { "primary-type": "Album", "secondary-types": types ?? [] },
  })),
});

describe("performerFacts", () => {
  it("takes the earliest matching recording and the album it came out on", () => {
    const facts = performerFacts(
      [
        rec("Lost Boy", "The Midnight", "2023-04-22", [["Red, White and Bruised: The Midnight Live"]]),
        rec("Lost Boy", "The Midnight", "2018-07-13", [["A Synthwave Panorama, Vol. 3", "Bootleg"], ["Kids"]]),
        rec("Lost Boy", "Ruth B", "2015-01-01", [["Safe Haven"]]),
      ],
      "Lost Boy",
      "The Midnight"
    );
    expect(facts).toEqual(['"Lost Boy" came out in 2018 and is on the album Kids.']);
  });

  it("finds nothing when no recording credits the artist", () => {
    expect(performerFacts([rec("Lost Boy", "Ruth B", "2015", [["Safe Haven"]])], "Lost Boy", "The Midnight")).toEqual([]);
  });

  it("names only a studio album, never a compilation, and takes no year from one", () => {
    const facts = performerFacts(
      [rec("Song", "Band", "1980-01-01", [["Hits 2005", "Official", ["Compilation"]]])],
      "Song",
      "Band"
    );
    expect(facts).toEqual([]);
  });

  it("reads back its year and album, and drops the year alone (#256)", () => {
    const both = ['"Lost Boy" came out in 2018 and is on the album Kids.'];
    expect([statedYear(both), statesAlbum(both)]).toEqual(["2018", true]);
    expect(withoutYear(both)).toEqual(['"Lost Boy" is on the album Kids.']);
    const split = ['"Lost Boy" came out in 2018.', '"Lost Boy" is on the album Kids.'];
    expect(withoutYear(split)).toEqual(['"Lost Boy" is on the album Kids.']);
    expect([statedYear([]), statesAlbum(['"Lost Boy" came out in 2018.'])]).toEqual([null, false]);
  });
});

describe("game composers (review: never from recording credits)", () => {
  it("considers recordings on releases naming the game, earliest first, skipping remix albums", () => {
    const ids = gameCandidates(
      [
        rec("MEGALOVANIA", "Kara Comparetto", "2025", [["Undertale"]]),
        rec("Megalovania", "Holder", "2016-03-04", [["Undertale Remixed", "Official", ["Remix"]]]),
        rec("MEGALOVANIA", "Toby Fox", "2015-09-15", [["UNDERTALE Soundtrack"]]),
        rec("Other Song", "Toby Fox", "2015-09-15", [["UNDERTALE Soundtrack"]]),
      ],
      "Megalovania",
      "Undertale"
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("reads composers and writers from a work's relationships only", () => {
    const work = {
      relations: [
        { type: "composer", "target-type": "artist", artist: { name: "近藤浩治", "sort-name": "Kondo, Koji" } },
        { type: "performer", "target-type": "artist", artist: { name: "Cover Artist" } },
        { type: "writer", "target-type": "artist", artist: { name: "Toby Fox" } },
      ],
    };
    expect(composersOf(work)).toEqual(["Koji Kondo", "Toby Fox"]);
    expect(composersOf({ relations: [] })).toEqual([]);
  });
});

describe("readableName", () => {
  it("uses the sort name for a name in another script", () => {
    expect(readableName({ name: "近藤浩治", artist: { name: "近藤浩治", "sort-name": "Kondo, Koji" } })).toBe("Koji Kondo");
    expect(readableName({ name: "Toby Fox" })).toBe("Toby Fox");
    expect(readableName({ name: "近藤浩治", artist: { "sort-name": "近藤浩治" } })).toBe("");
  });
});

describe("release years (October 2026 fact checks)", () => {
  const dated = (title: string, artist: string, releases: Array<[string, string, string[]]>) => ({
    id: `rec-${++nextId}`,
    score: 100,
    title,
    "first-release-date": releases.map((r) => r[1]).sort()[0],
    "artist-credit": [{ name: artist }],
    releases: releases.map(([t, date, types]) => ({ title: t, status: "Official", date, "release-group": { "primary-type": "Album", "secondary-types": types } })),
  });

  it("takes no year from a compilation or a live album", () => {
    expect(performerFacts([dated("It's Only a Paper Moon", "Harold Arlen", [["I Love Jazz", "1988", ["Compilation"]]])], "It's Only a Paper Moon", "Harold Arlen")).toEqual([]);
    expect(firstYear([dated("Through the Fire and the Flames", "DragonForce", [["Live at Wacken 2009", "2010", ["Live"]]])])).toBeUndefined();
    expect(firstYear([dated("Song", "Band", [["Best Of", "2001", ["Compilation"]], ["Debut", "1998", []]])])).toBe("1998");
  });

  it("takes no year after the credited artist died", () => {
    const satie = [dated("Gnossienne No. 1", "Erik Satie", [["Satie Piano Music", "1995", []]])];
    expect(performerFacts(satie, "Gnossienne No. 1", "Erik Satie", 1925)).toEqual(['"Gnossienne No. 1" is on the album Satie Piano Music.']);
    expect(performerFacts(satie, "Gnossienne No. 1", "Erik Satie")[0]).toBe('"Gnossienne No. 1" came out in 1995 and is on the album Satie Piano Music.');
  });

  it("leaves out an additional composer", () => {
    const work = {
      relations: [
        { type: "composer", "target-type": "artist", artist: { name: "James Horner" } },
        { type: "composer", "target-type": "artist", attributes: ["additional"], artist: { name: "Alexander Courage" } },
      ],
    };
    expect(composersOf(work)).toEqual(["James Horner"]);
  });
});

describe("MusicBrainz's own link to the article (issue #245)", () => {
  // Responses recorded from MusicBrainz, Wikidata and Wikipedia, trimmed, with made-up names.
  type Entry = { match: string; body?: unknown; page?: string; extract?: string };
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/musicbrainz-link.json"), "utf8")) as Record<string, Entry[]>;
  let scenario: Entry[] = [];
  const asked: string[] = [];
  const host = (url: string) => new URL(url).hostname;
  const toMusicBrainz = (url: string) => host(url) === "musicbrainz.org";
  const fetchMock = jest.fn(async (input: string | URL) => {
    const url = decodeURIComponent(String(input)).replace(/\+/g, " ");
    asked.push(url);
    const hit = scenario.find((e) => url.includes(e.match));
    let body: unknown = hit?.body;
    // Last edited long ago: read as it is (issue #242).
    if (hit?.extract !== undefined) body = { query: { pages: { 1: { title: hit.page, extract: hit.extract, revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
    // Wikipedia knows none of these names: every ordinary lookup misses.
    body ??= host(url).endsWith(".wikipedia.org") ? { query: { search: [], pages: {} } } : toMusicBrainz(url) && new URL(url).pathname === "/ws/2/artist" ? { artists: [] } : {};
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  const run = (name: string, title: string, artist: string) => {
    scenario = fixtures[name];
    return linkedGrounding({ title, artist });
  };

  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  beforeEach(() => {
    clearLinkCache();
    clearGroundingCache();
    asked.length = 0;
    (config as { mbLink: boolean }).mbLink = true;
  });

  it("takes the song's own page that the work's Wikidata link names, for a misspelled title", async () => {
    const text = await run("song", "Glass Harbour", "The Velvet Lanterns");
    expect(text.split("\n")[0]).toBe("Glass Harbor (song)");
    expect(text).toContain("Ada Penhallow");
    expect(text).not.toContain("originally by");
  });

  it("takes the artist's page from the artist's Wikidata link when the recording has no work", async () => {
    const text = await run("artist", "Low Orbit", "Kestrel Moon");
    expect(text.split("\n")[0]).toBe("Kestrel Moon (band)");
  });

  it("never takes an album's or a TV series' page, even from MusicBrainz's link", async () => {
    expect(await run("notAnAct", "Low Orbit", "Kestrel Moon")).toBe("");
    // Both linked pages were read, and the gate turned them down.
    expect(asked.some((u) => u.includes("titles=Low Orbit (album)"))).toBe(true);
    expect(asked.some((u) => u.includes("titles=Kestrel Moon (TV series)"))).toBe(true);
  });

  it("doesn't follow a respelled artist that MusicBrainz knows under the typed spelling", async () => {
    expect(await run("respelling", "Halcyon Drift", "Brisa Vale")).toBe("");
    expect(asked.some((u) => u.includes('ws/2/artist?query=artist:"Brisa Vale"'))).toBe(true);
    expect(asked.some((u) => u.includes("ws/2/recording/rec-hd-1"))).toBe(false);
  });

  it("marks a cover's page as the original's and never names the artist on the list", async () => {
    const text = await run("cover", "Paper Comets", "The Night Ferns");
    expect(text.split("\n")[0]).toBe("Paper Comets");
    expect(text.split("\n")[1]).toBe('About this piece: "Paper Comets" is originally by Juniper Hale. The version playing is a cover.');
    expect(text).not.toContain("Night Ferns");
  });

  it("is unsure of the artist's page MusicBrainz's link led to, and of a cover's original (issue #255)", async () => {
    scenario = fixtures.artist;
    const song = { title: "Low Orbit", artist: "Kestrel Moon" };
    const artist = await fetchGrounding(song);
    expect(artist.split("\n")[0]).toBe("Kestrel Moon (band)");
    expect(workMatchConfidence(song, artist)).toEqual({ level: "unsure", reason: "MusicBrainz's link led to the artist's article, not the song's" });
    const cover = await run("cover", "Paper Comets", "The Night Ferns");
    expect(workMatchConfidence({ title: "Paper Comets", artist: "The Night Ferns" }, cover)).toMatchObject({ level: "unsure", reason: "the article is about the original of a cover" });
  });

  it("runs from fetchGrounding only after every reading misses, and not with MB_LINK=off", async () => {
    scenario = fixtures.song;
    const text = await fetchGrounding({ title: "Glass Harbour", artist: "The Velvet Lanterns" });
    expect(text.split("\n")[0]).toBe("Glass Harbor (song)");
    const firstMb = asked.findIndex((u) => toMusicBrainz(u));
    expect(asked.slice(0, firstMb).some((u) => u.includes("list=search"))).toBe(true);

    clearLinkCache();
    clearGroundingCache();
    asked.length = 0;
    (config as { mbLink: boolean }).mbLink = false;
    expect(await fetchGrounding({ title: "Glass Harbour", artist: "The Velvet Lanterns" })).toBe("");
    expect(asked.some((u) => toMusicBrainz(u))).toBe(false);
  });

  it("doesn't ask MusicBrainz for an artist called Traditional or Anon. (#261)", async () => {
    scenario = fixtures.song;
    (config as { mbLink: boolean }).mbLink = true;
    clearLinkCache();
    clearGroundingCache();
    asked.length = 0;
    await fetchGrounding({ title: "Glass Harbour", artist: "Traditional" });
    expect(asked.some((u) => toMusicBrainz(u))).toBe(false);
  });
});

describe("musicbrainzFacts: no year it can't vouch for", () => {
  // Made-up names. Heart's "Alone" once got 2010 (a later EP: the 1987 single wasn't among the results),
  // and "Vampire Killer" 2015 (an album called "Castlevania" credited to "Castlevania").
  let byArtist: { count: number; recordings: unknown[] };
  const fetchMock = jest.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query") ?? "";
    const body = url.pathname === "/ws/2/recording" && query.includes(" AND artist:") ? byArtist : { recordings: [], count: 0 };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  beforeAll(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("states a year only when every recording came back", async () => {
    const later = rec("Paper Moonlight", "Lantern", "2010", [["Later Sessions"]]);
    byArtist = { count: 40, recordings: Array.from({ length: 25 }, () => later) };
    expect(await musicbrainzFacts({ title: "Paper Moonlight", artist: "Lantern" })).not.toContainEqual(expect.stringMatching(/came out in/));
    byArtist = { count: 1, recordings: [rec("Paper Lanterns", "Lantern", "1987", [["First Light"]])] };
    expect(await musicbrainzFacts({ title: "Paper Lanterns", artist: "Lantern" })).toContain('"Paper Lanterns" came out in 1987 and is on the album First Light.');
  });

  it("takes a recording credited to the game's own name for the game's soundtrack: no year, no album", async () => {
    byArtist = { count: 1, recordings: [rec("Night Lancer", "Gloomhold", "2015", [["Gloomhold"]])] };
    expect(await musicbrainzFacts({ title: "Night Lancer", artist: "Gloomhold" })).toEqual([]);
  });
});

describe("year and album in one bubble (#256)", () => {
  const lantern = (title: string, album?: string, date = "2021-03-05") => [rec(title, "Glass Orchard", date, album ? [[album]] : [])];
  const bubble = 160;

  it("tells the year and the album together when both are known", () => {
    expect(performerFacts(lantern("Harbor Lights", "Paper Boats"), "Harbor Lights", "Glass Orchard")).toEqual([
      '"Harbor Lights" came out in 2021 and is on the album Paper Boats.',
    ]);
  });

  it("keeps a single fact when only one value is known", () => {
    // A release named like the song gives the year but is not an album to name.
    expect(performerFacts(lantern("Harbor Lights", "Harbor Lights"), "Harbor Lights", "Glass Orchard")).toEqual(['"Harbor Lights" came out in 2021.']);
    // The year is held back for an artist who had died by then; the album stays on its own.
    expect(performerFacts(lantern("Harbor Lights", "Paper Boats"), "Harbor Lights", "Glass Orchard", 1950)).toEqual(['"Harbor Lights" is on the album Paper Boats.']);
  });

  it("falls back to separate facts when the combined sentence would not fit a bubble", () => {
    const title = "The Long Slow Walk Home Along the Quiet Harbor Wall at Dusk Again";
    const album = "Songs for the Lamplighters of the Eastern Pier and Beyond";
    const facts = performerFacts(lantern(title, album), title, "Glass Orchard");
    expect(facts).toEqual([`"${title}" came out in 2021.`, `"${title}" is on the album ${album}.`]);
    expect(`"${title}" came out in 2021 and is on the album ${album}.`.length).toBeGreaterThan(bubble);
    for (const f of facts) expect(f.length).toBeLessThanOrEqual(bubble);
  });

  it("keeps the values exactly as MusicBrainz gives them", () => {
    const [fact] = performerFacts(lantern("¿Dónde Estás?", "Déjà Vu (Deluxe)"), "¿Dónde Estás?", "Glass Orchard");
    expect(fact).toBe('"¿Dónde Estás?" came out in 2021 and is on the album Déjà Vu (Deluxe).');
  });
});

describe("musicbrainzFacts: the year is checked against the artist's death (#256)", () => {
  // Each run has its own title: lookups are cached by song.
  const run = async (title: string, ended: string | undefined) => {
    const search = [{ ...rec(title, "Glass Orchard", "1995-03-05", [["Paper Boats"]]), "artist-credit": [{ name: "Glass Orchard", artist: { id: "artist-1" } }] }];
    const real = global.fetch;
    global.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).includes("/artist/") ? { "life-span": { end: ended } } : { recordings: search }),
    })) as unknown as typeof fetch;
    try {
      return await musicbrainzFacts({ title, artist: "Glass Orchard" });
    } finally {
      global.fetch = real;
    }
  };

  it("tells the year and album together for an artist who was alive", async () => {
    expect(await run("Harbor Lights", undefined)).toEqual(['"Harbor Lights" came out in 1995 and is on the album Paper Boats.']);
  });

  it("leaves the year out, and the album alone, when the artist had died before it", async () => {
    expect(await run("Quiet Pier", "1950-01-01")).toEqual(['"Quiet Pier" is on the album Paper Boats.']);
  });
});


describe("artistByTitle: the artist of a now playing title with no artist", () => {
  const recording = (title: string, artist: string) => ({ title, score: 100, "artist-credit": [{ name: artist, artist: { id: `id-${artist}`, name: artist } }] });
  let reply: { count?: number; recordings?: unknown[] } = {};
  const asked: string[] = [];
  const fetchMock = jest.fn(async (input: string | URL) => {
    asked.push(decodeURIComponent(String(input)).replace(/\+/g, " "));
    return { ok: true, status: 200, json: async () => reply } as Response;
  });
  const found = (recordings: unknown[], count = recordings.length) => {
    reply = { count, recordings };
    clearTitleCache();
  };

  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    asked.length = 0;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("takes the artist when every recording of the exact title is theirs", async () => {
    found([recording("Ember Lanterns", "Wren Halvard"), recording("Ember Lanterns (Live)", "Wren Halvard"), recording("Ember Lanterns Reprise", "Someone Else")]);
    expect(await artistByTitle("Ember Lanterns")).toBe("Wren Halvard");
    expect(asked[0]).toContain('recording:"Ember Lanterns"');
    expect(cachedArtistByTitle("ember lanterns")).toBe("Wren Halvard");
  });

  it("takes none when two or more artists have the title", async () => {
    found([recording("Ember Lanterns", "Wren Halvard"), recording("Ember Lanterns", "The Paper Coves")]);
    expect(await artistByTitle("Ember Lanterns")).toBe("");
    expect(cachedArtistByTitle("Ember Lanterns")).toBe("");
  });

  it("takes none when no recording has the title, or only a placeholder credit does", async () => {
    found([]);
    expect(await artistByTitle("Ember Lanterns")).toBe("");
    found([recording("Quiet Orchard", "Ember Lanterns")]);
    expect(await artistByTitle("Ember Lanterns")).toBe("");
    found([recording("Ember Lanterns", "[unknown]"), recording("Ember Lanterns", "[unknown]")]);
    expect(await artistByTitle("Ember Lanterns")).toBe("");
  });

  it("folds case and accents: the typed title matches the accented one", async () => {
    found([recording("Då som nu för vintern", "Ola Strandvik")]);
    expect(await artistByTitle("Da Som Nu For Vintern")).toBe("Ola Strandvik");
  });

  it("takes none for a common title with more recordings than one search reads, even if those read agree", async () => {
    found([recording("Alone", "Wren Halvard")], 5000);
    expect(await artistByTitle("Alone")).toBe("");
  });

  it("asks MusicBrainz once per title", async () => {
    found([recording("Ember Lanterns", "Wren Halvard")]);
    await artistByTitle("Ember Lanterns");
    await artistByTitle("EMBER LANTERNS");
    expect(asked).toHaveLength(1);
  });

  it("finds none from a failed lookup, and doesn't throw", async () => {
    found([]);
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await artistByTitle("Ember Lanterns")).toBe("");
  });
});

describe("musicbrainzFacts: a game track's composers, all or none (#256)", () => {
  const composer = (name: string) => ({ type: "composer", "target-type": "artist", artist: { name } });
  let composers: string[] = [];
  beforeAll(() => {
    global.fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      const body = url.pathname === "/ws/2/recording"
        ? (url.searchParams.get("query") ?? "").includes(" AND release:")
          ? { count: 1, recordings: [{ id: "r1", score: 100, title: /recording:"([^"]+)"/.exec(url.searchParams.get("query") ?? "")?.[1], releases: [{ title: "Lantern Quest III Sound Collection" }] }] }
          : { count: 0, recordings: [] }
        : url.pathname === "/ws/2/recording/r1"
          ? { relations: [{ "target-type": "work", work: { id: "w1" } }] }
          : { relations: composers.map(composer) };
      return { ok: true, status: 200, json: async () => body } as Response;
    }) as unknown as typeof fetch;
  });

  it("names every composer the work lists, not the first three", async () => {
    composers = ["Ann Vale", "Bo Lund", "Kit Marsh", "Lee Park"];
    expect(await musicbrainzFacts({ title: "Lantern Waltz", artist: "Lantern Quest III" })).toEqual([
      '"Lantern Waltz" from Lantern Quest III was composed by Ann Vale, Bo Lund, Kit Marsh and Lee Park.',
    ]);
  });

  it("names none when they don't fit a bubble", async () => {
    composers = Array.from({ length: 12 }, (_, i) => `Composer Number ${i}`);
    expect(await musicbrainzFacts({ title: "Lantern Polka", artist: "Lantern Quest III" })).toEqual([]);
  });
});

describe("settleTitleOrder: which side of a fan's \"X - Y\" is the artist", () => {
  const recording = (title: string, artist: string) => ({ title, score: 100, "artist-credit": [{ name: artist, artist: { name: artist } }] });
  let reply: { recordings?: unknown[] } = {};
  const asked: string[] = [];
  const fetchMock = jest.fn(async (input: string | URL) => {
    asked.push(decodeURIComponent(String(input)).replace(/\+/g, " "));
    return { ok: true, status: 200, json: async () => reply } as Response;
  });
  // As parseVideoTitle reads "Copper Moon - Juniper Reyes" from a fan's channel.
  const unsure = { title: "Juniper Reyes", artist: "Copper Moon", confident: true, performer: false, orderUnsure: true };

  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
    asked.length = 0;
    fetchMock.mockClear();
    reply = {};
    clearOrderCache();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("turns the reading round when only the other order is a recording", async () => {
    reply = { recordings: [recording("Copper Moon", "Juniper Reyes"), recording("Copper Moon (Remix)", "Juniper Reyes")] };
    expect(await settleTitleOrder(unsure)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('(recording:"Juniper Reyes" AND artist:"Copper Moon") OR (recording:"Copper Moon" AND artist:"Juniper Reyes")');
  });

  it("keeps the reading when it is the recording, both are, or neither is", async () => {
    reply = { recordings: [recording("Juniper Reyes", "Copper Moon")] };
    expect(await settleTitleOrder(unsure)).toBe(unsure);
    clearOrderCache();
    reply = { recordings: [recording("Juniper Reyes", "Copper Moon"), recording("Copper Moon", "Juniper Reyes")] };
    expect(await settleTitleOrder(unsure)).toBe(unsure);
    clearOrderCache();
    reply = { recordings: [recording("Copper Moon", "Someone Else")] };
    expect(await settleTitleOrder(unsure)).toBe(unsure);
  });

  it("asks only for an unsure order, and once per title", async () => {
    const sure = { ...unsure, orderUnsure: undefined };
    expect(await settleTitleOrder(sure)).toBe(sure);
    expect(asked).toHaveLength(0);
    reply = { recordings: [recording("Copper Moon", "Juniper Reyes")] };
    await settleTitleOrder(unsure);
    expect(await settleTitleOrder({ ...unsure, title: "JUNIPER REYES" })).toMatchObject({ title: "Copper Moon", artist: "JUNIPER REYES" });
    expect(asked).toHaveLength(1);
  });

  it("keeps the reading when MusicBrainz fails, and asks again next time", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
    expect(await settleTitleOrder(unsure)).toBe(unsure);
    reply = { recordings: [recording("Copper Moon", "Juniper Reyes")] };
    expect(await settleTitleOrder(unsure)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't hold the song for a slow answer, and uses it the next time", async () => {
    const answer = { recordings: [recording("Copper Moon", "Juniper Reyes")] };
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => answer } as Response), 400))
    );
    expect(await settleTitleOrder(unsure)).toBe(unsure);
    await new Promise((r) => setTimeout(r, 300));
    expect(await settleTitleOrder(unsure)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("matches title and credit without case or accents", () => {
    expect(recordingOrder([recording("A Novidade", "Gíl Berto")] as never, "a novidade", "Gil Berto")).toBe("swap");
    expect(recordingOrder([] as never, "Copper Moon", "Juniper Reyes")).toBeNull();
  });
});
