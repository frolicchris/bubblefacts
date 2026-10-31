jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" },
}));
jest.mock("./wikidata", () => ({ ...jest.requireActual("./wikidata"), pageArtistIds: jest.fn() }));

import { anotherArtist } from "./musicbrainz";
import { pageArtistIds } from "./wikidata";

const ids = pageArtistIds as jest.Mock;
/** One recording of the song, credited to `id`. */
const serve = (id: string | null) => {
  const recordings = id ? [{ title: "Slow Tide", score: 100, "artist-credit": [{ name: "Northlight", artist: { id, name: "Northlight" } }] }] : [];
  return jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ recordings, count: recordings.length })));
};

describe("anotherArtist: a band that only shares the name (made-up acts)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is true when MusicBrainz credits a different act", async () => {
    ids.mockResolvedValue(["band-1970s"]);
    serve("dj-2020s");
    expect(await anotherArtist("Northlight (band)", "Slow Tide", "Northlight")).toBe(true);
  });

  it("is false when the ids agree", async () => {
    ids.mockResolvedValue(["same-act"]);
    serve("same-act");
    expect(await anotherArtist("Northlight (band)", "Slow Tide 2", "Northlight")).toBe(false);
  });

  it("is false when either side is unknown", async () => {
    ids.mockResolvedValue([]);
    const fetch = serve("dj-2020s");
    expect(await anotherArtist("Northlight (band)", "Slow Tide 3", "Northlight")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    ids.mockResolvedValue(["band-1970s"]);
    serve(null);
    expect(await anotherArtist("Northlight (band)", "Slow Tide 4", "Northlight")).toBe(false);
  });

  it("is false when the lookup fails", async () => {
    ids.mockResolvedValue(["band-1970s"]);
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    expect(await anotherArtist("Northlight (band)", "Slow Tide 5", "Northlight")).toBe(false);
  });
});
