jest.mock("./config", () => ({ config: { groundingTimeoutMs: 5000, topic: "general" } }));

import { gameFacts, performerFacts, readableName } from "./musicbrainz";

const rec = (title: string, artist: string, date: string, releases: Array<[string, string?, string[]?]>, score = 100) => ({
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

describe("gameFacts", () => {
  it("names the composer credited on several releases", () => {
    const facts = gameFacts(
      [
        rec("MEGALOVANIA", "Toby Fox", "2015-09-15", [["UNDERTALE Soundtrack"], ["UNDERTALE"]]),
        rec("Megalovania", "Holder", "2016-03-04", [["Undertale Remixed", "Official", ["Remix"]], ["Undertale Remixed", "Official", ["Remix"]]]),
        rec("MEGALOVANIA", "Toby Fox", "2015-11-30", [["Undertale: Looped", "Bootleg"]]),
        rec("MEGALOVANIA", "Kara Comparetto", "2025", [["Undertale"]]),
      ],
      "Megalovania",
      "Undertale"
    );
    expect(facts).toEqual(['"Megalovania" from Undertale was composed by Toby Fox.']);
  });

  it("states nothing when only covers agree, or no name leads", () => {
    // From a real search: every exact "Terra's Theme" on a Final Fantasy VI release was a cover, each on one release.
    const covers = [
      rec("Terra's Theme", "Eiko Nichols", "2015-03-20", [["Final Fantasy VI: Acoustic Rendition"]]),
      rec("Terra's Theme", "Kara Comparetto", "2021", [["Final Fantasy VI — Complete Soundtrack"]]),
      rec("Terra's Theme", "Nobuo Uematsu", "2022-02-22", [["Final Fantasy VI Pixel Remaster Soundtrack", "Bootleg"]]),
    ];
    expect(gameFacts(covers, "Terra's Theme", "Final Fantasy VI")).toEqual([]);
  });
});

describe("readableName", () => {
  it("uses the sort name for a name in another script", () => {
    expect(readableName({ name: "近藤浩治", artist: { name: "近藤浩治", "sort-name": "Kondo, Koji" } })).toBe("Koji Kondo");
    expect(readableName({ name: "Toby Fox" })).toBe("Toby Fox");
    expect(readableName({ name: "近藤浩治", artist: { "sort-name": "近藤浩治" } })).toBe("");
  });
});
