jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general", mbLink: true },
}));

import { config } from "./config";
import { clearGroundingCache, fetchGrounding } from "./fact-verifier";
import { clearLinkCache, composersOf, firstYear, gameCandidates, linkedGrounding, performerFacts, readableName } from "./musicbrainz";
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
    expect(facts).toEqual(['"Lost Boy" came out in 2018.', '"Lost Boy" is on the album Kids.']);
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
    expect(performerFacts(satie, "Gnossienne No. 1", "Erik Satie")[0]).toBe('"Gnossienne No. 1" came out in 1995.');
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
    if (hit?.extract !== undefined) body = { query: { pages: { 1: { title: hit.page, extract: hit.extract } } } };
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
