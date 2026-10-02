import { buildStatFacts, isOriginal, isOwnOriginal, cleanTitle } from "./stat-facts";
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
      isOriginal(entry({ attributes: [{ name: "Jane's Originals" }] }), ["janestreams", "Jane"])
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

  it("never shows the song's length, which isn't a fact about the song", () => {
    // A tester: "Runs about 4:29" read as noise on stream.
    expect(buildStatFacts(entry({ durationSeconds: 184 }), opts).some((x) => /3:04|runs/i.test(x))).toBe(false);
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
      entry({ comment: "Original composition", artist: "Jane Composer", attributes: [{ name: "Jane's Originals" }] }),
      { ...opts, isOriginalSong: true, names: ["janestreams", "Jane Composer"] }
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
      { ...opts, isOriginalSong: true, names: ["janestreams", "Jane Composer"] }
    );
    expect(f.some((x) => x.includes("by Jane Composer"))).toBe(true);
  });

  it("names no writer when the credit is missing, and doesn't match names by prefix (QA follow-up #3)", () => {
    const unknown = entry({ title: "Untitled Jam", artist: "Unknown", attributes: [{ name: "Originals" }] });
    expect(isOriginal(unknown, ["frolicchris", "Chris"])).toBe(true);
    const f = buildStatFacts(unknown, { streamerName: "frolicchris", isOriginalSong: true, names: ["frolicchris", "Chris"] });
    expect(f.join(" ")).not.toMatch(/composition by|person who wrote it|credited to/);
    expect(isOriginal(entry({ artist: "Christina Lee", attributes: [{ name: "Christina's Originals" }] }), ["frolicchris", "Chris"])).toBe(false);
  });

  it("never claims another streamer's original was written by the one playing it", () => {
    // From review: Chris plays "Evening Rain", credited to Jane Composer and tagged "Jane's Originals".
    const song = entry({ title: "Evening Rain", artist: "Jane Composer", attributes: [{ name: "Jane's Originals" }] });
    expect(isOriginal(song, ["frolicchris", "Chris"])).toBe(false);
    const f = buildStatFacts(song, { streamerName: "frolicchris", isOriginalSong: true, names: ["frolicchris", "Chris"] });
    expect(f.join(" ")).not.toMatch(/person who wrote it|composition by frolicchris/);
    expect(f).toContain('"Evening Rain" is an original, credited to Jane Composer.');
  });

  it("returns nothing for a null entry rather than throwing", () => {
    expect(buildStatFacts(null, opts)).toEqual([]);
  });
});

describe("isOwnOriginal (issue #45)", () => {
  const item = (artist: string, tag?: string) =>
    ({ song: { title: "Water in the Moonlight", artist, attributes: tag ? [{ name: tag }] : [] } }) as unknown as Parameters<typeof isOwnOriginal>[0];
  const names = ["frolicchris", "Chris"];

  it("counts a piece credited to one of the streamer's names", () => {
    expect(isOwnOriginal(item("frolicchris"), names)).toBe(true);
    expect(isOwnOriginal(item("Christopher Feyrer", "Originals"), [...names, "Christopher Feyrer"])).toBe(true);
  });

  it("never counts a tag alone: a friend's piece tagged Originals isn't the streamer's (review)", () => {
    expect(isOwnOriginal(item("Jane Composer", "Originals"), names)).toBe(false);
    expect(isOwnOriginal(item("Christopher Feyrer", "Originals"), names)).toBe(false);
    expect(isOwnOriginal(item("Unknown", "Originals"), names)).toBe(false);
    expect(isOwnOriginal(item("", "Originals"), names)).toBe(false);
    expect(isOwnOriginal(item("Jane Composer", "Jane's Originals"), names)).toBe(false);
    expect(isOwnOriginal(item("Jane Composer"), names)).toBe(false);
  });
});
