jest.mock("./config", () => ({
  config: { factsPerSong: 5, dataDir: process.env.BUBBLEFACTS_DATA_DIR, groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, topic: "general" },
}));

import { clearGroundingCache } from "./fact-verifier";
import { groundSongAlone } from "./grounding/readings";

const PAGE = "Harbor Lights (song)";
const ARTICLE =
  '"Harbor Lights" is a song recorded by the band The Tideline for their 1977 album Lantern Row. The song was written by Pat Wren and Dee Marsh, and tells of a ferry crossing at night. ' +
  "It was recorded over three days in a converted boathouse, with the lead vocal taken in a single pass. The single reached the top ten in several countries and has since been covered often. " +
  "Critics praised the guitar line, which was built from a sketch Wren had carried for years. The band played it live for most of the following decade, usually as the last song of the night.";

describe("groundSongAlone with credited names", () => {
  const mock = jest.fn(async (url: string) => {
    const p = new URL(url).searchParams;
    let body: unknown;
    if (p.get("srsearch") !== null) body = { query: { search: [{ title: PAGE }] } };
    else if (!p.get("prop")) body = { query: { pages: { 0: { title: PAGE } } } };
    else body = { query: { pages: { 1: { extract: ARTICLE, revisions: [{ timestamp: "2020-01-01T00:00:00Z" }] } } } };
    return { ok: true, status: 200, json: async () => body } as Response;
  });
  beforeAll(() => {
    global.fetch = mock as unknown as typeof fetch;
  });
  beforeEach(() => clearGroundingCache());
  const song = { title: "Pat Wren: Harbor Lights", artist: "The Tideline" };

  it("takes the song's own article when it names a credited person", async () => {
    const found = await groundSongAlone(song, "Harbor Lights", () => true, ["pat wren"]);
    expect(found.text.split("\n")[0]).toBe(PAGE);
  });

  it("takes it for the credited band even when the list's name is another", async () => {
    const found = await groundSongAlone(song, "Harbor Lights", () => true, ["the tideline"]);
    expect(found.text).not.toBe("");
  });

  it("passes over an article that names no credited person", async () => {
    const found = await groundSongAlone({ title: "Harbor Lights", artist: "Some Singer" }, "Harbor Lights", () => true, ["some singer"]);
    expect(found.text).toBe("");
  });
});
