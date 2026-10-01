jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { composersOf, gameCandidates, performerFacts, readableName } from "./musicbrainz";

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

  it("names only a studio album, never a compilation", () => {
    const facts = performerFacts(
      [rec("Song", "Band", "1980-01-01", [["Hits 2005", "Official", ["Compilation"]]])],
      "Song",
      "Band"
    );
    expect(facts).toEqual(['"Song" came out in 1980.']);
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
