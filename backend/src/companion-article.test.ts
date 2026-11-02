jest.mock("./config", () => ({
  config: {
    factsPerSong: 5,
    dataDir: process.env.BUBBLEFACTS_DATA_DIR,
    groundingTimeoutMs: 5000,
    groundingExtractTimeoutMs: 15000,
    topic: "video-game,classical,film,pop,piano,general",
  },
}));

import {
  COMPANION_LABEL,
  MAX_CONTEXT_CHARS,
  MIN_MAKING_SENTENCES,
  clearGroundingCache,
  companionOf,
  companionPages,
  companionSentences,
  creatorSentences,
  fetchGrounding,
  referenceSentences,
  supportingSentence,
  withoutBlockedCompanions,
} from "./fact-verifier";
import { blockArticle, resetWrongFacts } from "./wrong-facts";

// Made-up game, track, composers and albums, written the way Wikipedia's
// plain-text extracts read (headings as "== ... ==").

/** A track's own article with one sentence from its makers: under MIN_MAKING_SENTENCES. */
const TRACK_ARTICLE = [
  `"Ashen Choir" is a piece of music from the 2003 role-playing video game Lanternfall, composed by Mira Okafor. It plays during the final battle against the Hollow King and is the longest track on the game's soundtrack. A choral version opened the Lanternfall Symphonic Night concerts in 2011.`,
  "== Composition ==",
  `The track is written in E minor and runs for just over seven minutes. A full choir sings Latin text over a string section, a pipe organ and a rock rhythm section. Okafor recalled that she wanted the final battle to sound like a requiem played at the wrong speed.`,
  "== Release ==",
  `"Ashen Choir" was released on the Lanternfall Original Soundtrack in 2003. An orchestral arrangement appeared on the 2009 album Lanternfall Reprise, recorded by the Harbor City Philharmonic. The track was later included on a vinyl box set of the series' music in 2018, alongside a new piano arrangement by Teo Varga.`,
  "== Live performances ==",
  `The Harbor City Philharmonic has closed every Lanternfall Symphonic Night concert with the piece since 2011. A rock arrangement was performed by Okafor's band the Ember Keys at their 2015 tour of Europe and North America.`,
].join("\n");

/** The series' music article: four sentences about "Ashen Choir", the rest about the soundtracks in general. */
const MUSIC_ARTICLE = [
  `The music of the Lanternfall series was composed mainly by Mira Okafor, with later games scored by Teo Varga. The soundtracks have been released on numerous albums and performed in concert around the world.`,
  "== Lanternfall ==",
  `The soundtrack of the first game was recorded over four months in 2002 at a studio in Harbor City. Okafor said that she wrote "Ashen Choir" last, after the rest of the score was finished, because she could not decide how the game should end.`,
  `She explained that the Latin lyrics of "Ashen Choir" were adapted from a medieval poem she had found in a used bookshop. The choir for "Ashen Choir" was recorded in a single afternoon with forty singers from a local church.`,
  `Varga recalled that Okafor played him a piano sketch of "Ashen Choir" over the phone in 2001.`,
  `"Ashen Choir" is widely regarded as one of the greatest pieces of video game music ever written.`,
  `The soundtrack album was released on four discs in March 2003.`,
  "== Lanternfall II ==",
  `Varga composed most of the second game's score, which uses a smaller orchestra.`,
  "== Track listing ==",
  `"Ashen Choir" – 7:12`,
].join("\n");

const GAME = "Lanternfall";
const TRACK = "Ashen Choir";
const MUSIC_PAGE = "Music of the Lanternfall series";
const song = { title: TRACK, artist: GAME };

describe("companionSentences", () => {
  it("keeps only sentences that name the track, what its makers said first", () => {
    const kept = companionSentences(MUSIC_ARTICLE, TRACK);
    expect(kept).toHaveLength(3);
    expect(kept[0]).toMatch(/^Okafor said that she wrote "Ashen Choir" last/);
    expect(kept).toContain('The choir for "Ashen Choir" was recorded in a single afternoon with forty singers from a local church.');
    // The soundtrack in general, an opinion, a sentence leaning on the one before, and the track listing never come along.
    expect(kept.join(" ")).not.toMatch(/four discs|four months|greatest|She explained|7:12/);
  });

  it("leaves out what the reference's own article already says", () => {
    const own = `Okafor said that she wrote "Ashen Choir" last, after the rest of the score was finished, because she could not decide how the game should end.`;
    expect(companionSentences(MUSIC_ARTICLE, TRACK, own).join(" ")).not.toContain("could not decide");
  });

  it("takes a section headed with the track's name, but not its sentences about another title", () => {
    const album = [
      "Night Ferry is the second studio album by the Velvet Moths, released in 2014.",
      '== "Glass Harbor" ==',
      "The band wrote the song in one night at a rented cabin near the coast in 2013.",
      'Its demo shared a cassette with "Paper Saints", which the band finished a year later.',
      "== Other songs ==",
      "The album's closing track was recorded live in a church in a single take.",
    ].join("\n");
    expect(companionSentences(album, "Glass Harbor")).toEqual(["The band wrote the song in one night at a rented cabin near the coast in 2013."]);
  });

  it("finds nothing for a generic track name", () => {
    expect(companionSentences('The "Main Theme" was recorded with a full orchestra in London in 2004.', "Main Theme")).toEqual([]);
  });
});

describe("a companion article's line in the reference", () => {
  const context = `${TRACK}\nFrom the article "${MUSIC_PAGE}": Varga recalled that Okafor played him a piano sketch of "Ashen Choir" over the phone in 2001.\n\nThe track is written in E minor and runs for just over seven minutes.`;

  it("names the companion article a sentence comes from, and none for the reference's own", () => {
    expect(companionPages(context)).toEqual([MUSIC_PAGE]);
    const sentence = supportingSentence("Okafor played Varga a piano sketch of Ashen Choir over the phone in 2001.", context);
    // The label isn't part of the sentence a caption rests on.
    expect(sentence).toBe('Varga recalled that Okafor played him a piano sketch of "Ashen Choir" over the phone in 2001.');
    expect(companionOf(sentence, context)).toBe(MUSIC_PAGE);
    expect(companionOf("The track is written in E minor and runs for just over seven minutes.", context)).toBe("");
    expect(referenceSentences(context)[0]).toMatch(/^Varga recalled/);
  });

  it("drops the line of a blocked companion, keeping the rest", () => {
    expect(withoutBlockedCompanions(context, (t) => t !== MUSIC_PAGE)).toBe(`${TRACK}\nThe track is written in E minor and runs for just over seven minutes.`);
    expect(withoutBlockedCompanions(context, () => true)).toBe(context);
  });
});

describe("fetchGrounding with a companion article (issue #48, step 2)", () => {
  let extracts: Record<string, string>;
  let wikitexts: Record<string, string>;
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    let body: unknown;
    if (p.get("srsearch") !== null) {
      body = { query: { search: p.get("srsearch") === `${TRACK} ${GAME}` ? [{ title: TRACK }] : [] } };
    } else if (p.get("rvprop") === "content") {
      body = { query: { pages: [{ revisions: [{ slots: { main: { content: wikitexts[p.get("titles") ?? ""] ?? "" } } }] }] } };
    } else if (!p.get("prop")) {
      const names = (p.get("titles") ?? "").split("|");
      body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), extracts[n] !== undefined ? { title: n } : { title: n, missing: "" }])) } };
    } else {
      body = { query: { pages: { 1: { extract: extracts[p.get("titles") ?? ""] ?? "", revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  const requests = (what: (p: URLSearchParams) => boolean) => mock.mock.calls.filter(([u]) => what(new URL(u).searchParams)).length;

  beforeAll(() => {
    global.fetch = mock as unknown as typeof fetch;
  });
  beforeEach(() => {
    clearGroundingCache();
    resetWrongFacts();
    mock.mockClear();
    extracts = { [TRACK]: TRACK_ARTICLE, [MUSIC_PAGE]: MUSIC_ARTICLE };
    wikitexts = { [TRACK]: `{{Infobox song\n| name = Ashen Choir\n| album = ''[[Lanternfall Original Soundtrack]]''\n}}\nPart of the [[Music of the Lanternfall series|music of the series]].` };
  });

  it("the fixture's own article has fewer sentences from its makers than the threshold", () => {
    expect(creatorSentences(TRACK_ARTICLE, [TRACK, GAME]).length).toBeLessThan(MIN_MAKING_SENTENCES);
  });

  it("adds the companion's sentences about the track, labelled with its title, within the budget", async () => {
    const text = await fetchGrounding(song);
    expect(text.split("\n")[0]).toBe(TRACK);
    const line = text.split("\n").find((l) => COMPANION_LABEL.test(l));
    expect(line).toBeDefined();
    expect(COMPANION_LABEL.exec(line!)?.[1]).toBe(MUSIC_PAGE);
    expect(line).toContain("forty singers from a local church");
    expect(line).not.toMatch(/four discs|greatest|second game/);
    // The track's own article is still the reference.
    expect(text).toContain("written in E minor");
    expect(text.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS + TRACK.length + 1);
    // Two requests more than the track's own article needs: the title lookup and the companion's text.
    expect(requests((p) => !p.get("prop") && !p.get("srsearch") && !p.get("list"))).toBe(1);
    expect(requests((p) => (p.get("prop") ?? "").startsWith("extracts") && p.get("titles") === MUSIC_PAGE)).toBe(1);
  });

  it("is remembered with the reference: the track again costs nothing", async () => {
    const first = await fetchGrounding(song);
    const calls = mock.mock.calls.length;
    expect(await fetchGrounding(song)).toBe(first);
    expect(mock.mock.calls.length).toBe(calls);
  });

  it("never reads a companion the streamer marked wrong for the song, even from the cache", async () => {
    expect(await fetchGrounding(song)).toContain(`From the article "${MUSIC_PAGE}"`);
    blockArticle(song, MUSIC_PAGE);
    const cached = await fetchGrounding(song);
    expect(cached.split("\n")[0]).toBe(TRACK);
    expect(cached).not.toContain(MUSIC_PAGE);
    clearGroundingCache();
    mock.mockClear();
    const fresh = await fetchGrounding(song);
    expect(fresh.split("\n")[0]).toBe(TRACK);
    expect(fresh).not.toContain(MUSIC_PAGE);
    expect(requests((p) => p.get("titles") === MUSIC_PAGE)).toBe(0);
  });

  it("reads no companion when the article already has enough from its makers", async () => {
    extracts[TRACK] = `${TRACK_ARTICLE}\n== Development ==\nOkafor said that the piece was the hardest of the game's music to write. Producer Dana Whitlow recalled that the choir was added to the track late in development. Okafor explained that the organ part was inspired by a church she visited as a child.`;
    const text = await fetchGrounding(song);
    expect(text.split("\n")[0]).toBe(TRACK);
    expect(companionPages(text)).toEqual([]);
    expect(requests((p) => p.get("titles") === MUSIC_PAGE)).toBe(0);
  });

  it("adds nothing when the companion never names the track", async () => {
    extracts[MUSIC_PAGE] = MUSIC_ARTICLE.replace(/"Ashen Choir"/g, "the final battle theme");
    const text = await fetchGrounding(song);
    expect(text.split("\n")[0]).toBe(TRACK);
    expect(companionPages(text)).toEqual([]);
  });
});

describe("fetchGrounding: a song's own article and its album (issue #48, step 2)", () => {
  const SONG_ARTICLE = [
    `"Harbor Lights Fading" is a song by the English indie rock band the Velvet Moths, released in 2014 as the second single from their album Night Ferry. It was written by singer Ada Pell and guitarist Rui Moreno and produced by Lena Voss.`,
    "== Composition ==",
    `The song is written in D major with a tempo of 128 beats per minute. It is built on a three-chord guitar riff and a drum machine pattern, with a string section added in the final chorus.`,
    "== Release ==",
    `"Harbor Lights Fading" was released as a single on 3 March 2014, with a B-side titled "Paper Saints". It reached number 14 on the UK Singles Chart and number 3 on the UK Indie Chart, and was certified silver in 2016.`,
    "== Live performances ==",
    `The band performed the song on several television shows in 2014, and it has closed most of their concerts since. An acoustic version was recorded for a radio session in Manchester in 2015.`,
  ].join("\n");
  const ALBUM_ARTICLE = [
    `Night Ferry is the second studio album by the English indie rock band the Velvet Moths, released on 14 April 2014.`,
    "== Recording ==",
    `The album was recorded over six weeks at a converted chapel in Cornwall. Pell said that "Harbor Lights Fading" began as a voice memo she recorded on a night ferry to Ireland.`,
    `Moreno recalled that the band played "Harbor Lights Fading" more than forty times before Voss chose the take on the album.`,
    `The album's artwork was painted by Pell's sister.`,
  ].join("\n");
  const SONG = { title: "Harbor Lights Fading", artist: "The Velvet Moths" };
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    const pages: Record<string, string> = { "Harbor Lights Fading": SONG_ARTICLE, "Night Ferry (album)": ALBUM_ARTICLE };
    let body: unknown;
    if (p.get("srsearch") !== null) {
      body = { query: { search: /Harbor Lights Fading/.test(p.get("srsearch") ?? "") ? [{ title: "Harbor Lights Fading" }] : [] } };
    } else if (p.get("rvprop") === "content") {
      const content = p.get("titles") === "Harbor Lights Fading" ? "{{Infobox song\n| name = Harbor Lights Fading\n| album = ''[[Night Ferry (album)|Night Ferry]]''\n}}" : "";
      body = { query: { pages: [{ revisions: [{ slots: { main: { content } } }] }] } };
    } else if (!p.get("prop")) {
      const names = (p.get("titles") ?? "").split("|");
      body = { query: { pages: Object.fromEntries(names.map((n, i) => [String(i), pages[n] !== undefined ? { title: n } : { title: n, missing: "" }])) } };
    } else {
      body = { query: { pages: { 1: { extract: pages[p.get("titles") ?? ""] ?? "", revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
    }
    return { ok: true, status: 200, json: async () => body } as Response;
  });

  beforeAll(() => {
    global.fetch = mock as unknown as typeof fetch;
  });
  beforeEach(() => {
    clearGroundingCache();
    resetWrongFacts();
  });

  it("adds the album's sentences about the song, never the album's own facts", async () => {
    const text = await fetchGrounding(SONG);
    expect(text.split("\n")[0]).toBe("Harbor Lights Fading");
    expect(companionPages(text)).toEqual(["Night Ferry (album)"]);
    const line = text.split("\n").find((l) => COMPANION_LABEL.test(l)) ?? "";
    expect(line).toContain("voice memo she recorded on a night ferry");
    expect(line).toContain("more than forty times");
    expect(line).not.toMatch(/six weeks|artwork|14 April/);
  });
});
