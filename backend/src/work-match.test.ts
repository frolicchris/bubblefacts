jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" },
}));

import { workMatchConfidence } from "./fact-verifier";

/** A reference as fetchGrounding returns it: the page title, then the text. */
const ref = (page: string, ...text: string[]) => `${page}\n${text.join(" ")}`;
const level = (title: string, artist: string, grounding: string) => workMatchConfidence({ title, artist }, grounding);

describe("workMatchConfidence (issue #255)", () => {
  it("is none with no article", () => {
    expect(level("Paper Lanterns", "Dana Reyes", "")).toEqual({ level: "none", reason: "no article" });
  });

  it("is sure of a song's own article that names its artist up front", () => {
    const text = ref("Paper Lanterns", '"Paper Lanterns" is a song by English singer Dana Reyes, released in 1974.', "It reached number two in the UK.");
    expect(level("Paper Lanterns", "Dana Reyes", text).level).toBe("sure");
    // Typed with a letter too many: still her song.
    expect(level("Paper Lanterns", "Dana Reyess", text).level).toBe("sure");
  });

  it("is unsure of a song's article that never names the artist up front: someone else's song of that name", () => {
    const text = ref("Paper Lanterns", '"Paper Lanterns" is a song by the Welsh band Harbor Static.', "It was their first single.");
    expect(level("Paper Lanterns", "Dana Reyes", text)).toMatchObject({ level: "unsure", reason: expect.stringContaining("never names Dana Reyes") });
  });

  it("holds a short title to the article's first sentence: 'Cherry' by one singer isn't another's", () => {
    const theirs = ref("Cherry (Tom Orchard song)", '"Cherry" is a 2019 song by Tom Orchard.', "Mira Vale covered it in 2021.");
    expect(level("Cherry", "Mira Vale", theirs)).toMatchObject({ level: "unsure", reason: expect.stringContaining("a short title") });
    const hers = ref("Cherry (Mira Vale song)", '"Cherry" is a 2021 single.', "It was written in one night.");
    expect(level("Cherry", "Mira Vale", hers).level).toBe("sure");
  });

  it("is unsure of the original's article for a cover", () => {
    const text = ref("Glass Harbor", 'About this piece: "Glass Harbor" is originally by Dana Reyes. The version playing is a cover.', "", '"Glass Harbor" is a song by Dana Reyes.');
    expect(level("Glass Harbor", "Ollie Fenn", text)).toMatchObject({ level: "unsure", reason: "the article is about the original of a cover" });
  });

  it("is unsure of the artist's article that never names the song when a note had to be dropped to find it", () => {
    const text = ref("Ollie Fenn", "Ollie Fenn is an American singer-songwriter from Ohio.", "Fenn released three albums on a small label.");
    expect(level("Glass Harbor", "Ollie Fenn (Tribute)", text)).toMatchObject({ level: "unsure", reason: expect.stringContaining("dropping a note") });
    expect(level("Glass Harbor (Dana Reyes cover)", "Ollie Fenn", text).level).toBe("unsure");
    // As typed, with no note: the artist's article stays the fallback it has always been.
    expect(level("Glass Harbor", "Ollie Fenn", text).level).toBe("sure");
    // An article that names the song is about it, note or not.
    const naming = ref("Ollie Fenn", "Ollie Fenn is an American singer-songwriter from Ohio.", 'His 2019 single "Glass Harbor" was his first hit.');
    expect(level("Glass Harbor", "Ollie Fenn (Tribute)", naming).level).toBe("sure");
  });

  it("is unsure of an album's article for the song", () => {
    const text = ref("Silver Coast (album)", "Silver Coast is the third studio album by Ollie Fenn.", "Its title track opens it.");
    expect(level("Silver Coast", "Ollie Fenn", text)).toMatchObject({ level: "unsure", reason: expect.stringContaining("an album's article") });
  });

  it("is unsure of another song's article", () => {
    const text = ref("Morning Bus", '"Morning Bus" is a song by Ollie Fenn.', "It was his second single.");
    expect(level("Night Train", "Ollie Fenn", text)).toMatchObject({ level: "unsure", reason: '"Morning Bus" is another piece\'s article' });
  });

  it("is unsure of a film's article for a band's song, and of a concert film named after the band", () => {
    const film = ref("Velvet Lark (1961 film)", "Velvet Lark is a 1961 American romantic drama film directed by Ann Corrow.", "It was shot in Marseille.");
    expect(level("Country Road Home", "Velvet Lark", film)).toMatchObject({ level: "unsure", reason: "a film's article that never names the song" });
    const concert = ref("Velvet Lark: Live", "Velvet Lark: Live is a 2025 concert documentary film.", "It was filmed over two nights.");
    expect(level("Country Road Home", "Velvet Lark", concert).level).toBe("unsure");
  });

  it("is unsure of a series' article for one game's track it never names, sure once it names the track", () => {
    const series = ref("Rocket Drift", "Rocket Drift is a video game series developed by Pellmore.", "It began with a 1988 game; a 2017 reboot followed.");
    expect(level("Area 3", "Rocket Drift", series)).toMatchObject({ level: "unsure", reason: expect.stringContaining("a series' article") });
    const naming = ref("Rocket Drift", 'About this piece: "Area 3" is the series\' best-known track.', "", "Rocket Drift is a video game series developed by Pellmore.");
    expect(level("Area 3", "Rocket Drift", naming).level).toBe("sure");
    // A request for the series itself takes its article.
    expect(level("Area 3", "Rocket Drift Series", series).level).toBe("sure");
  });

  it("is unsure of a game's parent article for an edition or epilogue, unless its first sentence names it", () => {
    const parent = ref("Skyreach Chronicles (video game)", "Skyreach Chronicles is an action role-playing game developed by Hollow Pine.", "A remaster was released in 2020.");
    expect(level("Boss Battle", "Skyreach Chronicles: Far Shores", parent)).toMatchObject({ level: "unsure", reason: "the article is about Skyreach Chronicles, not Skyreach Chronicles: Far Shores" });
    const same = ref("Skyreach II", "Skyreach II, titled on-screen as Skyreach: The Last Voyage, is a 1988 role-playing game.", "It is a sequel.");
    expect(level("Harbor Town", "Skyreach II The Last Voyage", same).level).toBe("sure");
  });

  it("keeps a game's own article and its music article sure: the expected unit for a game's tracks", () => {
    const game = ref("Starfall Saga", "Starfall Saga is a 1996 role-playing video game developed by Hollow Pine.", "Kenji Arata composed its music.");
    expect(level("Lunar Tide", "Starfall Saga", game)).toEqual({ level: "sure", reason: "the work's own article" });
    const music = ref("Music of Starfall Saga", "The music of the video game Starfall Saga was composed by Kenji Arata.", "Its soundtrack album came out in 1997.");
    expect(level("Lunar Tide", "Starfall Saga", music)).toEqual({ level: "sure", reason: "the game's music article" });
    const album = ref("Starfall Saga Original Soundtrack", "Starfall Saga Original Soundtrack is the soundtrack album of the game.", "It has 60 tracks.");
    expect(level("Lunar Tide", "Starfall Saga", album).level).toBe("sure");
  });

  it("is unsure of a series-wide music article for a track it never names", () => {
    const music = ref("Music of the Starfall Saga series", "The music of the Starfall Saga series was composed by Kenji Arata.", "A sequel's score won an award.");
    expect(level("Lunar Tide", "Starfall Saga", music)).toMatchObject({ level: "unsure", reason: "a series' music article that never names the track" });
    const naming = ref("Music of the Starfall Saga series", 'About this piece: "Lunar Tide" opens the first game.', "", "The music of the Starfall Saga series was composed by Kenji Arata.");
    expect(level("Lunar Tide", "Starfall Saga", naming).level).toBe("sure");
  });
});
