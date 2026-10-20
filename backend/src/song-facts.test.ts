jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" } }));

import fs from "fs";
import path from "path";
import { BEFORE_SWITCHES, factsOff, findSongFacts, hasOwnFacts, resetSongFacts, saveSongFacts, setFactsOff, songFactLines, songFactsProblem } from "./song-facts";

describe("song facts", () => {
  beforeEach(() => {
    resetSongFacts();
    saveSongFacts({ title: "x", artist: "x", facts: [] }); // start empty
  });

  it("matches by song ID, video ID, title and artist, or an alias", () => {
    saveSongFacts({ title: "Evening Rain", artist: "Jane Composer", songId: 42, facts: ["Written in one night."] });
    saveSongFacts({ title: "Night Drive", artist: "Some Band", videoId: "abcdefghijk", aliases: ["SB - Night Drive (Live)"], facts: ["A fact."] });
    expect(findSongFacts({ title: "Renamed", artist: "Whoever", songId: 42 })?.title).toBe("Evening Rain");
    expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })?.title).toBe("Evening Rain");
    expect(findSongFacts({ title: "Anything", artist: "Anyone", videoId: "abcdefghijk" })?.title).toBe("Night Drive");
    expect(findSongFacts({ title: "Night Drive (Live)", artist: "SB" })?.title).toBe("Night Drive");
    expect(findSongFacts({ title: "Evening Rain", artist: "Someone Else", songId: 7 })).toBeNull();
  });

  it("keeps versions apart unless an alias joins them (QA follow-up #5)", () => {
    saveSongFacts({ title: "Night Drive (Acoustic)", artist: "Jane", facts: ["Recorded live in one take."] });
    expect(findSongFacts({ title: "Night Drive (Acoustic)", artist: "Jane" })).not.toBeNull();
    expect(findSongFacts({ title: "Night Drive (Remix)", artist: "Jane" })).toBeNull();
    expect(findSongFacts({ title: "Night Drive", artist: "Jane" })).toBeNull();
  });

  it("credits a writer only when the streamer typed one in", () => {
    expect(songFactLines({ title: "Evening Rain", artist: "Jane Composer", facts: ["Written in one night."] })).toEqual([
      "Written in one night.",
    ]);
    expect(
      songFactLines({ title: "Evening Rain", artist: "Jane Composer", songwriters: ["Jane Composer"], link: "twitch.tv/jane", facts: ["Written in one night."] })
    ).toEqual(['"Evening Rain" was written by Jane Composer.', "Written in one night.", "More from Jane Composer: twitch.tv/jane"]);
    expect(
      songFactLines({ title: "Evening Rain", artist: "Robin", songwriters: ["Jane Composer"], facts: [] })
    ).toEqual(['"Evening Rain" was written by Jane Composer.']);
  });

  it("keeps a fact typed with line breaks as one fact", () => {
    saveSongFacts({ title: "Water in the Moonlight", artist: "Robin", facts: ["Written at the lake\r\nin the summer of 2019.\n", "  "] });
    expect(findSongFacts({ title: "Water in the Moonlight", artist: "Robin" })?.facts).toEqual(["Written at the lake in the summer of 2019."]);
    saveSongFacts({ title: "Water in the Moonlight", artist: "Robin", facts: [] });
  });

  it("keeps the creator's link when the facts fill every slot (final QA #4)", () => {
    const entry = { title: "Evening Rain", artist: "Robin", songwriters: ["Jane Composer"], link: "twitch.tv/jane", facts: ["One.", "Two.", "Three.", "Four."] };
    const lines = songFactLines(entry, 5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('"Evening Rain" was written by Jane Composer.');
    expect(lines[4]).toBe("More from Jane Composer: twitch.tv/jane");
  });

  it("gives a link with no songwriter its own bubble, naming no one as the writer (musician review #4)", () => {
    expect(songFactLines({ title: "Evening Rain", artist: "Robin", link: "twitch.tv/jane", facts: ["Written in one night."] })).toEqual([
      "Written in one night.",
      "More from this song's creator: twitch.tv/jane",
    ]);
    expect(songFactLines({ title: "Evening Rain", artist: "Robin", link: "twitch.tv/jane", facts: ["One.", "Two."] }, 2)).toEqual([
      "One.",
      "More from this song's creator: twitch.tv/jane",
    ]);
  });

  it("saves a song that has only a link (musician review #4)", () => {
    saveSongFacts({ title: "Evening Rain", artist: "Robin", link: " twitch.tv/jane ", songwriters: [], facts: [] });
    resetSongFacts();
    const saved = findSongFacts({ title: "Evening Rain", artist: "Robin" });
    expect(saved?.link).toBe("twitch.tv/jane");
    expect(songFactLines(saved!)).toEqual(["More from this song's creator: twitch.tv/jane"]);
    saveSongFacts({ title: "Evening Rain", artist: "Robin", link: "", facts: [] });
    expect(findSongFacts({ title: "Evening Rain", artist: "Robin" })).toBeNull();
  });

  it("refuses too many or too long facts with the reason, instead of cutting them (musician review #2)", () => {
    expect(songFactsProblem({ facts: Array(20).fill("A fact."), songwriters: ["Jane"], link: "twitch.tv/jane" })).toBeNull();
    expect(songFactsProblem({ facts: ["x".repeat(300)] })).toBeNull();
    expect(songFactsProblem({ facts: Array(22).fill("A fact.") })).toBe("A song can have up to 20 facts. Remove 2 to save.");
    expect(songFactsProblem({ facts: ["Short.", "x".repeat(301)] })).toBe("Fact 2 is 301 characters. Shorten it to 300 or fewer to save.");
    // Counted as it's saved: line breaks and spaces at the ends don't count against it; blank boxes are skipped.
    expect(songFactsProblem({ facts: ["", "  " + "x".repeat(150) + "\n\n" + "x".repeat(149) + "  "] })).toBeNull();
    expect(songFactsProblem({ songwriters: ["A", "B", "C", "D", "E", "F"] })).toBe("Up to 5 songwriters can be credited.");
    expect(songFactsProblem({ link: "twitch.tv/" + "x".repeat(200) })).toBe("Their link can be up to 200 characters.");
    expect(songFactsProblem({ facts: "not a list" })).toBe("Couldn't read that. Try again in a moment.");
    expect(songFactsProblem({ facts: ["ok", 5] })).toBe("Couldn't read that. Try again in a moment.");
  });

  it("removes a song when its facts, writers and link are cleared, and survives a restart", () => {
    saveSongFacts({ title: "Evening Rain", artist: "Jane Composer", facts: ["A fact."] });
    resetSongFacts();
    expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })).not.toBeNull();
    saveSongFacts({ title: "Evening Rain", artist: "Jane Composer", facts: [] });
    expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })).toBeNull();
  });

  describe("the switches: no facts for this song, or for this artist (issue #262)", () => {
    const dir = () => process.env.BUBBLEFACTS_DATA_DIR as string;
    const file = () => path.join(dir(), "song-facts.json");
    const copy = () => path.join(dir(), BEFORE_SWITCHES);
    const clear = () => {
      fs.writeFileSync(file(), "[]\n");
      fs.rmSync(copy(), { force: true });
      resetSongFacts();
    };
    beforeEach(clear);

    it("saves a switch with no facts, and reads it back after a restart", () => {
      saveSongFacts({ title: "Glass Orchard", artist: "Wren Halloway", facts: [], noFacts: true });
      saveSongFacts({ title: "Night Ferry", artist: "Tobin Varr", songwriters: [], link: "", facts: ["Recorded on a boat."], noArtistFacts: true });
      resetSongFacts();
      const glass = findSongFacts({ title: "Glass Orchard", artist: "Wren Halloway" });
      expect(glass).toMatchObject({ noFacts: true, facts: [] });
      expect(hasOwnFacts(glass)).toBe(false);
      expect(factsOff({ title: "Glass Orchard", artist: "Wren Halloway" })).toEqual({ song: true, artist: false });
      expect(factsOff({ title: "Any Song", artist: "Wren Halloway" })).toEqual({ song: false, artist: false });
      // Every song by the artist: with a note after the name, a featured guest, or another case.
      for (const artist of ["Tobin Varr", "tobin varr (note words)", "Tobin Varr feat. Ada Penn"]) {
        expect(factsOff({ title: "Another Song", artist }).artist).toBe(true);
      }
      expect(factsOff({ title: "Another Song", artist: "Tobin Varrick" }).artist).toBe(false);
      expect(findSongFacts({ title: "Night Ferry", artist: "Tobin Varr" })?.facts).toEqual(["Recorded on a boat."]);
    });

    it("turns the artist's switch off from any of their songs, and drops an entry left with nothing", () => {
      saveSongFacts({ title: "Night Ferry", artist: "Tobin Varr", facts: [], noArtistFacts: true });
      expect(factsOff({ title: "Harbor Lights", artist: "Tobin Varr" }).artist).toBe(true);
      setFactsOff({ title: "Harbor Lights", artist: "Tobin Varr" }, "artist", false);
      expect(factsOff({ title: "Night Ferry", artist: "Tobin Varr" }).artist).toBe(false);
      expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual([]);
    });

    it("turns one switch on or off and leaves the song's facts as they are", () => {
      saveSongFacts({ title: "Glass Orchard", artist: "Wren Halloway", facts: ["Wren wrote it on a porch."] });
      setFactsOff({ title: "Glass Orchard", artist: "Wren Halloway" }, "song", true);
      expect(findSongFacts({ title: "Glass Orchard", artist: "Wren Halloway" })).toMatchObject({ facts: ["Wren wrote it on a porch."], noFacts: true });
      setFactsOff({ title: "Glass Orchard", artist: "Wren Halloway" }, "song", false);
      const after = findSongFacts({ title: "Glass Orchard", artist: "Wren Halloway" });
      expect(after?.facts).toEqual(["Wren wrote it on a porch."]);
      expect(after?.noFacts).toBeUndefined();
    });

    it("reads a file from before the switches, and copies it once before the first switch is saved", () => {
      const old = JSON.stringify([{ title: "Evening Rain", artist: "Jane Composer", songwriters: [], link: "", facts: ["Written in one night."] }], null, 2) + "\n";
      fs.writeFileSync(file(), old);
      resetSongFacts();
      expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })?.facts).toEqual(["Written in one night."]);
      saveSongFacts({ title: "Other Song", artist: "Jane Composer", facts: ["Another fact."] });
      expect(fs.existsSync(copy())).toBe(false);
      const unswitched = fs.readFileSync(file(), "utf8");
      setFactsOff({ title: "Evening Rain", artist: "Jane Composer" }, "song", true);
      expect(fs.readFileSync(copy(), "utf8")).toBe(unswitched);
      // Never copied again: the copy is the file as it was before any switch.
      setFactsOff({ title: "Other Song", artist: "Jane Composer" }, "artist", true);
      setFactsOff({ title: "Evening Rain", artist: "Jane Composer" }, "song", false);
      setFactsOff({ title: "Evening Rain", artist: "Jane Composer" }, "song", true);
      expect(fs.readFileSync(copy(), "utf8")).toBe(unswitched);
      // Still the list an older version reads: every entry has a title, an artist and facts.
      const now = JSON.parse(fs.readFileSync(file(), "utf8")) as Array<Record<string, unknown>>;
      expect(now.every((e) => typeof e.title === "string" && typeof e.artist === "string" && Array.isArray(e.facts))).toBe(true);
    });

    it("refuses a switch that isn't true or false", () => {
      expect(songFactsProblem({ facts: [], noFacts: true, noArtistFacts: false })).toBeNull();
      expect(songFactsProblem({ facts: [], noFacts: "yes" })).toBe("Couldn't read that. Try again in a moment.");
    });
  });
});
