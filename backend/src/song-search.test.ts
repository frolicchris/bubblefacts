import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import { ListSong, searchSongs, songSearchRoute } from "./song-search";

const LIST: ListSong[] = [
  { id: 1, title: "Evening Rain", artist: "Jane Composer" },
  { id: 2, title: "Rain on the Harbor", artist: "The Paper Lanterns" },
  { id: 3, title: "Aquarium Waltz", artist: "Rainmaker Trio" },
  { id: 4, title: "Café Sunrise", artist: "Jane Composer" },
  { id: 5, title: "Terra's Theme", artist: "Final Fantasy VI" },
  { id: 6, title: "Train to Nowhere", artist: "Moss & Mirrors" },
];

describe("searchSongs", () => {
  it("finds the title anywhere, ignoring case", () => {
    expect(searchSongs(LIST, "HARBOR").map((s) => s.id)).toEqual([2]);
  });

  it("finds the artist too", () => {
    expect(searchSongs(LIST, "jane composer").map((s) => s.id)).toEqual([1, 4]);
    expect(searchSongs(LIST, "final fantasy").map((s) => s.id)).toEqual([5]);
  });

  it("puts titles that start with what was typed first, then titles that contain it, then artists", () => {
    expect(searchSongs(LIST, "rain").map((s) => s.id)).toEqual([2, 1, 6, 3]);
  });

  it("matches words split across title and artist", () => {
    expect(searchSongs(LIST, "waltz rainmaker").map((s) => s.id)).toEqual([3]);
  });

  it("ignores accents", () => {
    expect(searchSongs(LIST, "cafe").map((s) => s.id)).toEqual([4]);
  });

  it("returns nothing for an empty search", () => {
    expect(searchSongs(LIST, "   ")).toEqual([]);
  });

  it("keeps to the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, title: `Night Song ${i + 1}`, artist: "Jane Composer" }));
    expect(searchSongs(many, "night")).toHaveLength(8);
    expect(searchSongs(many, "night", 3).map((s) => s.id)).toEqual([1, 2, 3]);
    expect(searchSongs(many, "night", 500)).toHaveLength(20);
  });
});

describe("POST /control/songs/search", () => {
  async function post(source: Parameters<typeof songSearchRoute>[0], body: unknown) {
    const app = express();
    app.use(express.json());
    app.post("/control/songs/search", songSearchRoute(source));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/control/songs/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it("answers with matching songs from the list", async () => {
    const source = { searchSongs: jest.fn((q: string, n: number) => searchSongs(LIST, q, n)) };
    const r = await post(source, { query: "harbor", limit: 5 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ available: true, songs: [{ id: 2, title: "Rain on the Harbor", artist: "The Paper Lanterns" }] });
    expect(source.searchSongs).toHaveBeenCalledWith("harbor", 5);
  });

  it("uses the default limit and treats a missing query as empty", async () => {
    const source = { searchSongs: jest.fn(() => []) };
    await post(source, {});
    expect(source.searchSongs).toHaveBeenCalledWith("", 8);
  });

  it("says so when the song source has no list (StreamElements)", async () => {
    expect((await post({}, { query: "rain" })).body).toEqual({ available: false, songs: [] });
  });
});
