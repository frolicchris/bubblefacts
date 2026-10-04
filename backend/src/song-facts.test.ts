jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" } }));

import { findSongFacts, resetSongFacts, saveSongFacts, songFactLines, songFactsProblem } from "./song-facts";

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
      songFactLines({ title: "Evening Rain", artist: "Chris", songwriters: ["Jane Composer"], facts: [] })
    ).toEqual(['"Evening Rain" was written by Jane Composer.']);
  });

  it("keeps a fact typed with line breaks as one fact", () => {
    saveSongFacts({ title: "Water in the Moonlight", artist: "Chris", facts: ["Written at the lake\r\nin the summer of 2019.\n", "  "] });
    expect(findSongFacts({ title: "Water in the Moonlight", artist: "Chris" })?.facts).toEqual(["Written at the lake in the summer of 2019."]);
    saveSongFacts({ title: "Water in the Moonlight", artist: "Chris", facts: [] });
  });

  it("keeps the creator's link when the facts fill every slot (final QA #4)", () => {
    const entry = { title: "Evening Rain", artist: "Chris", songwriters: ["Jane Composer"], link: "twitch.tv/jane", facts: ["One.", "Two.", "Three.", "Four."] };
    const lines = songFactLines(entry, 5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('"Evening Rain" was written by Jane Composer.');
    expect(lines[4]).toBe("More from Jane Composer: twitch.tv/jane");
  });

  it("gives a link with no songwriter its own bubble, naming no one as the writer (musician review #4)", () => {
    expect(songFactLines({ title: "Evening Rain", artist: "Chris", link: "twitch.tv/jane", facts: ["Written in one night."] })).toEqual([
      "Written in one night.",
      "More from this song's creator: twitch.tv/jane",
    ]);
    expect(songFactLines({ title: "Evening Rain", artist: "Chris", link: "twitch.tv/jane", facts: ["One.", "Two."] }, 2)).toEqual([
      "One.",
      "More from this song's creator: twitch.tv/jane",
    ]);
  });

  it("saves a song that has only a link (musician review #4)", () => {
    saveSongFacts({ title: "Evening Rain", artist: "Chris", link: " twitch.tv/jane ", songwriters: [], facts: [] });
    resetSongFacts();
    const saved = findSongFacts({ title: "Evening Rain", artist: "Chris" });
    expect(saved?.link).toBe("twitch.tv/jane");
    expect(songFactLines(saved!)).toEqual(["More from this song's creator: twitch.tv/jane"]);
    saveSongFacts({ title: "Evening Rain", artist: "Chris", link: "", facts: [] });
    expect(findSongFacts({ title: "Evening Rain", artist: "Chris" })).toBeNull();
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
});
