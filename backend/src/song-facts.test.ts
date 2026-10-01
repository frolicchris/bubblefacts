jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" } }));

import { findSongFacts, resetSongFacts, saveSongFacts, songFactLines } from "./song-facts";

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

  it("keeps the creator's link when the facts fill every slot (final QA #4)", () => {
    const entry = { title: "Evening Rain", artist: "Chris", songwriters: ["Jane Composer"], link: "twitch.tv/jane", facts: ["One.", "Two.", "Three.", "Four."] };
    const lines = songFactLines(entry, 5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('"Evening Rain" was written by Jane Composer.');
    expect(lines[4]).toBe("More from Jane Composer: twitch.tv/jane");
  });

  it("removes a song when its facts and writers are cleared, and survives a restart", () => {
    saveSongFacts({ title: "Evening Rain", artist: "Jane Composer", facts: ["A fact."] });
    resetSongFacts();
    expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })).not.toBeNull();
    saveSongFacts({ title: "Evening Rain", artist: "Jane Composer", facts: [] });
    expect(findSongFacts({ title: "Evening Rain", artist: "Jane Composer" })).toBeNull();
  });
});
