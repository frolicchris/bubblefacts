import { buildStatFacts, isOriginal, cleanTitle } from "./stat-facts";
import { SSLQueueItem } from "./types";

function entry(partial: Partial<SSLQueueItem["song"]>, rest: Partial<SSLQueueItem> = {}): SSLQueueItem {
  return {
    id: 1,
    songId: 1,
    nonlistSong: null,
    note: null,
    streamerId: 1,
    createdAt: "",
    requests: [],
    song: { title: "A Song", artist: "An Artist", ...partial },
    ...rest,
  } as SSLQueueItem;
}

describe("isOriginal", () => {
  it("detects an original from the song attribute", () => {
    // Attribute-driven rather than a hardcoded title list, so adding a new
    // original to the song list needs no code change.
    expect(
      isOriginal(entry({ attributes: [{ name: "Jane's Originals" }] }), ["janestreams"])
    ).toBe(true);
  });

  it("falls back to the artist name for entries predating the tag", () => {
    expect(isOriginal(entry({ artist: "Jane Composer  @janestreams" }), ["janestreams"])).toBe(
      true
    );
  });

  it("does not treat an ordinary cover as an original", () => {
    expect(
      isOriginal(
        entry({ title: "Sunshine Coastline", artist: "Ys VIII", attributes: [{ name: "JRPG" }] }),
        ["janestreams"]
      )
    ).toBe(false);
  });

  it("matches the streamer's name exactly, not inside another artist's name", () => {
    expect(isOriginal(entry({ artist: "Joe Hisaishi" }), ["joe"])).toBe(false);
    expect(isOriginal(entry({ artist: "Johann Sebastian Bach" }), ["ann"])).toBe(false);
    expect(isOriginal(entry({ artist: "Jane Composer" }), ["janestreams", "Jane Composer"])).toBe(true);
  });

  it("does not treat an Original Soundtrack tag as the streamer's own work", () => {
    expect(isOriginal(entry({ attributes: [{ name: "Original Soundtrack" }] }), ["janestreams"])).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("strips a redundant artist prefix", () => {
    expect(cleanTitle("Jane Composer: Laura's Wedding", "Jane Composer")).toBe(
      "Laura's Wedding"
    );
  });

  it("leaves an ordinary title alone", () => {
    expect(cleanTitle("Sunshine Coastline", "Ys VIII")).toBe("Sunshine Coastline");
  });
});

describe("buildStatFacts", () => {
  const opts = { streamerName: "janestreams" };

  it("announces a debut when the song has never been played", () => {
    const f = buildStatFacts(entry({ timesPlayed: 0, title: "Laura's Wedding" }), opts);
    expect(f.some((x) => /First time on stream/.test(x))).toBe(true);
  });

  it("reports the play count when it has been played", () => {
    const f = buildStatFacts(entry({ timesPlayed: 3, title: "Water in the Moonlight" }), opts);
    expect(f.some((x) => /played .* 3 times/.test(x))).toBe(true);
  });

  it("uses singular wording for a single play", () => {
    const f = buildStatFacts(entry({ timesPlayed: 1 }), opts);
    expect(f.some((x) => /1 time on stream/.test(x))).toBe(true);
  });

  it("omits duration when the API returns null", () => {
    // The live API leaves durationSeconds null on many entries, and a bubble
    // reading "Runs about null" is worse than one fewer bubble.
    const f = buildStatFacts(entry({ durationSeconds: null }), opts);
    expect(f.some((x) => /Runs about/.test(x))).toBe(false);
  });

  it("formats a duration that is present", () => {
    const f = buildStatFacts(entry({ durationSeconds: 184 }), opts);
    expect(f.some((x) => x.includes("3:04"))).toBe(true);
  });

  it("drops an implausible duration rather than printing it", () => {
    expect(buildStatFacts(entry({ durationSeconds: 99999 }), opts).some((x) => /Runs/.test(x))).toBe(
      false
    );
  });

  it("credits the requester", () => {
    const f = buildStatFacts(entry({}, { requests: [{ id: 1, name: "kirbyfan" }] as any }), opts);
    expect(f).toContain("Requested by kirbyfan.");
  });

  it("pluralizes the other requesters correctly", () => {
    const two = buildStatFacts(entry({}, { requests: [{ id: 1, name: "a" }, { id: 2, name: "b" }] }), opts);
    const three = buildStatFacts(entry({}, { requests: [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }] }), opts);
    expect(two).toContain("Requested by a and 1 other.");
    expect(three).toContain("Requested by a and 2 others.");
  });

  it("skips a boilerplate note that the originals line already states", () => {
    const f = buildStatFacts(
      entry({ comment: "Original composition", attributes: [{ name: "Jane's Originals" }] }),
      { ...opts, isOriginalSong: true }
    );
    expect(f).not.toContain("Original composition");
    expect(f.some((x) => /is an original composition by/.test(x))).toBe(true);
  });

  it("keeps a note that says something specific", () => {
    const f = buildStatFacts(entry({ comment: "Jazz standard arrangement" }), opts);
    expect(f).toContain("Jazz standard arrangement");
  });

  it("credits the composer by name rather than the channel handle", () => {
    const f = buildStatFacts(
      entry({ title: "Jane Composer: Laura's Wedding", artist: "Jane Composer" }),
      { ...opts, isOriginalSong: true }
    );
    expect(f.some((x) => x.includes("by Jane Composer"))).toBe(true);
  });

  it("returns nothing for a null entry rather than throwing", () => {
    expect(buildStatFacts(null, opts)).toEqual([]);
  });
});

describe("the runtime fact", () => {
  it("names the song and comes after the others", () => {
    // saxdragon: "Runs for 4:29" first, out of nowhere, left viewers asking what does.
    const f = buildStatFacts(
      entry({ title: "Lost Boy", durationSeconds: 269, timesPlayed: 3 }, { requests: [{ id: 1, name: "viewer1" }] } as Partial<SSLQueueItem>),
      { streamerName: "SaxDragon" }
    );
    expect(f[f.length - 1]).toBe('"Lost Boy" runs about 4:29.');
    expect(f[0]).not.toMatch(/runs about/);
  });
});
