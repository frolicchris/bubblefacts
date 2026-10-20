jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" },
}));

import { PageSummary, USER_AGENT, clearGroundingCache, describedKind, pageSummary, summaryGate, summaryMismatch } from "./fact-verifier";

// Made-up songs, bands and pages throughout.
const ref = (page: string, ...text: string[]) => `${page}\n${text.join(" ")}`;
const summary = (description: string, type = "standard", extract = "", title = ""): PageSummary => ({ title, type, description, extract });

/** Wikipedia's summary endpoint, answering from a table of titles; every other title is a 404. */
function serveSummaries(pages: Record<string, { type?: string; description: string; extract?: string }>) {
  return jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const title = decodeURIComponent(url.split("/page/summary/")[1] ?? "").replace(/_/g, " ");
    const page = pages[title];
    if (!page) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ title, type: page.type ?? "standard", description: page.description, extract: page.extract ?? "" }), { status: 200 });
  });
}

beforeEach(() => clearGroundingCache());
afterEach(() => jest.restoreAllMocks());

describe("describedKind: what a short description calls its subject", () => {
  it.each([
    ["1975 song by the Marmalade Owls", "song"],
    ["2004 single by Dana Reyes", "song"],
    ["studio album by British rock band the Marmalade Owls", "album"],
    ["2016 video game soundtrack", "album"],
    ["2018 film directed by Ana Ferro", "film"],
    ["American animated television series", "tv"],
    ["2009 novel by Mara Quill", "book"],
    ["2015 video game", "game"],
    ["video game series", "series"],
    ["Japanese video game composer (born 1970)", "person"],
    ["American rock band", "person"],
    ["Topics referred to by the same term", "other"],
    ["", "other"],
  ])("%s: %s", (description, kind) => {
    expect(describedKind(description)).toBe(kind);
  });
});

describe("summaryMismatch: what Wikipedia's summary says about the found article", () => {
  const song = { title: "Lantern Hill", artist: "The Marmalade Owls" };

  it("is unsure of a disambiguation page and of any page that isn't a standard article", () => {
    const text = ref("Lantern Hill", "Lantern Hill may mean a hill or a song.");
    expect(summaryMismatch(summary("Topics referred to by the same term", "disambiguation"), song, text)).toMatch(/disambiguation/);
    expect(summaryMismatch(summary("", "no-extract"), song, text)).toMatch(/"no-extract" page/);
  });

  it("is unsure of a page named like the song that Wikipedia describes as a film", () => {
    const text = ref("Lantern Hill", "Lantern Hill is a 2018 film by Ana Ferro about the Marmalade Owls.");
    expect(summaryMismatch(summary("2018 film directed by Ana Ferro"), song, text)).toMatch(/as "2018 film directed by Ana Ferro", not the song/);
    expect(summaryMismatch(summary("1975 song by the Marmalade Owls"), song, text)).toBe("");
  });

  it("is unsure of a game's article for a band's song it never names", () => {
    const text = ref("Owl Quest", "Owl Quest is a 2015 video game. Its music was composed by Mara Quill.");
    expect(summaryMismatch(summary("2015 video game"), song, text)).toMatch(/another work that never names the song/);
    // Naming the song, the game may well be where it is from.
    const naming = ref("Owl Quest", "Owl Quest is a 2015 video game. Its theme is Lantern Hill by the Marmalade Owls.");
    expect(summaryMismatch(summary("2015 video game"), song, naming)).toBe("");
  });

  it("keeps a game's article for its own track, under another spelling", () => {
    const track = { title: "Moth Waltz", artist: "Pokemon Moth" };
    const text = ref("Pokémon Moth and Lantern", "Pokémon Moth and Lantern is a 1998 video game.");
    expect(summaryMismatch(summary("1998 video game"), track, text)).toBe("");
  });

  it("changes nothing when there is no summary", () => {
    expect(summaryMismatch(null, song, ref("Lantern Hill", "Some text."))).toBe("");
  });
});

describe("summaryGate", () => {
  it("asks Wikipedia's summary endpoint with the project's User-Agent, and caches the answer", async () => {
    const fetch = serveSummaries({ "Lantern Hill": { description: "1975 song by the Marmalade Owls" } });
    expect(await pageSummary("Lantern Hill")).toMatchObject({ type: "standard", description: "1975 song by the Marmalade Owls" });
    await pageSummary("Lantern Hill");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe("https://en.wikipedia.org/api/rest_v1/page/summary/Lantern_Hill");
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("is unsure of the band's article when the song has an article of its own", async () => {
    serveSummaries({
      "The Marmalade Owls": { description: "English folk band" },
      "Lantern Hill (The Marmalade Owls song)": { description: "1975 song by the Marmalade Owls", extract: "Lantern Hill is a song by the Marmalade Owls." },
    });
    const text = ref("The Marmalade Owls", "The Marmalade Owls are an English folk band. Their songs include Lantern Hill.");
    expect(await summaryGate({ title: "Lantern Hill", artist: "The Marmalade Owls" }, text)).toMatch(/has an article of its own \("Lantern Hill \(The Marmalade Owls song\)"\)/);
  });

  it("keeps the band's article when no song article names the band", async () => {
    serveSummaries({
      "The Marmalade Owls": { description: "English folk band" },
      "Lantern Hill (song)": { description: "1961 song by Dana Reyes", extract: "Lantern Hill is a song by Dana Reyes." },
    });
    const text = ref("The Marmalade Owls", "The Marmalade Owls are an English folk band.");
    expect(await summaryGate({ title: "Lantern Hill", artist: "The Marmalade Owls" }, text)).toBe("");
  });

  it("changes nothing when the summary can't be read", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("", { status: 429 }));
    expect(await summaryGate({ title: "Lantern Hill", artist: "The Marmalade Owls" }, ref("Lantern Hill", "Some text."))).toBe("");
  });
});
