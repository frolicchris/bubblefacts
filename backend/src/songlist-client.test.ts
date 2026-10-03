// Mock config before importing anything that uses it
jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    sslPlatform: "twitch",
    sslApiBase: "https://api.streamersonglist.com",
    sslAccessToken: "test-token",
    sslTokenKind: "streamer",
    liveLearns: true,
    sslEventsUrl: "wss://events.streamersonglist.com/connection/uni_websocket",
    sslPollIntervalMs: 15000,
    sslRequestTimeoutMs: 5000,
  },
}));

// The realtime stream opens a real socket; stub it out entirely.
const startMock = jest.fn();
const stopMock = jest.fn();
jest.mock("./centrifugo-client", () => ({
  CentrifugoStream: jest.fn().mockImplementation(() => ({
    start: startMock,
    stop: stopMock,
    isConnected: () => true,
  })),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { SongListClient, setAccessToken } from "./songlist-client";
import { config } from "./config";
import { CentrifugoStream } from "./centrifugo-client";

const STREAMER = { id: 123, requestsActive: true, promoteQueueToPlaying: true };

function entry(id: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    songId: id,
    song: { title, artist: "Test Artist" },
    nonlistSong: null,
    note: null,
    streamerId: 123,
    createdAt: "2026-08-15T00:00:00Z",
    requests: [{ id: 1, name: "viewer1" }],
    ...extra,
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe("SongListClient", () => {
  let client: SongListClient;

  beforeEach(() => {
    client = new SongListClient();
    mockFetch.mockReset();
    startMock.mockClear();
    stopMock.mockClear();
    (CentrifugoStream as unknown as jest.Mock).mockClear();
  });

  afterEach(() => client.disconnect());

  it("should initialize with no current song", () => {
    expect(client.getCurrentSong()).toBeNull();
  });

  it("marks an off-list (live learn) entry and carries the requester", () => {
    const live = entry(7, "", { songId: null, nonlistSong: "Never Gonna Learn This" });
    expect(SongListClient.isLiveLearn(live)).toBe(true);
    expect(SongListClient.toSong(live)).toEqual({
      title: "Never Gonna Learn This",
      artist: "Test Artist",
      liveLearn: true,
      requestedBy: "viewer1",
    });

    (config as unknown as { liveLearns: boolean }).liveLearns = false;
    try {
      expect(SongListClient.toSong(live).liveLearn).toBeUndefined();
    } finally {
      (config as unknown as { liveLearns: boolean }).liveLearns = true;
    }

    const listed = entry(8, "On The List");
    expect(SongListClient.isLiveLearn(listed)).toBe(false);
    expect(SongListClient.toSong(listed)).toEqual({
      title: "On The List",
      artist: "Test Artist",
      requestedBy: "viewer1",
      songId: 8,
    });
  });

  it("prefers the now-playing slot over the head of the queue", async () => {
    mockFetch.mockResolvedValueOnce(ok(STREAMER)).mockResolvedValueOnce(
      ok({
        items: [entry(2, "Up Next", { position: 1 })],
        playing: entry(1, "Now Playing", { nowPlayingStartedAt: "2026-08-15T00:01:00Z" }),
        total: 1,
      })
    );

    const songChangeSpy = jest.fn();
    client.onCurrentSongChange(songChangeSpy);

    await client.connect();

    expect(client.getCurrentSong()?.song.title).toBe("Now Playing");
    expect(songChangeSpy).toHaveBeenCalledTimes(1);

    client.disconnect();
  });

  it("falls back to the head of the queue when nothing is playing", async () => {
    mockFetch
      .mockResolvedValueOnce(ok(STREAMER))
      .mockResolvedValueOnce(ok({ items: [entry(2, "Up Next", { position: 1 })], playing: null, total: 1 }));

    await client.connect();

    expect(client.getCurrentSong()?.song.title).toBe("Up Next");

    client.disconnect();
  });

  it("handles an empty queue", async () => {
    mockFetch
      .mockResolvedValueOnce(ok(STREAMER))
      .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));

    await client.connect();
    expect(client.getCurrentSong()).toBeNull();

    client.disconnect();
  });

  it("identifies the streamer by query parameters and authorizes every request", async () => {
    mockFetch
      .mockResolvedValueOnce(ok(STREAMER))
      .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));

    await client.connect();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/streamers?");
    expect(url).toContain("streamer_name=teststreamer");
    expect(url).toContain("platform=twitch");
    expect(init.headers.Authorization).toBe("Streamer test-token");
    expect(init.headers["Client-Id"]).toBeUndefined();

    expect(mockFetch.mock.calls[1][0]).toContain("/queue?");

    client.disconnect();
  });

  it("signs in with an app's OAuth token, by channel ID, and takes refreshed tokens", async () => {
    const cfg = config as unknown as Record<string, unknown>;
    Object.assign(cfg, { sslTokenKind: "bearer", sslClientId: "app-id", sslStreamerId: 123 });
    setAccessToken("first");
    try {
      mockFetch
        .mockResolvedValueOnce(ok(STREAMER))
        .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));
      await client.connect();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain("streamer_id=123");
      expect(url).not.toContain("streamer_name");
      expect(init.headers).toMatchObject({ Authorization: "Bearer first", "Client-Id": "app-id" });

      setAccessToken("second");
      mockFetch.mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));
      await (client as unknown as { refresh(): Promise<void> }).refresh();
      expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe("Bearer second");
    } finally {
      client.disconnect();
      Object.assign(cfg, { sslTokenKind: "streamer", sslClientId: "", sslStreamerId: 0 });
      setAccessToken("test-token");
    }
  });

  it("subscribes to the streamer's public event channels", async () => {
    mockFetch
      .mockResolvedValueOnce(ok(STREAMER))
      .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));

    await client.connect();

    const [, channels] = (CentrifugoStream as unknown as jest.Mock).mock.calls[0];
    expect(channels).toContain("streamer:123");
    expect(channels).toContain("streamer:123-queue");
    expect(startMock).toHaveBeenCalled();

    client.disconnect();
    expect(stopMock).toHaveBeenCalled();
  });

  it("explains what to fix when the token is rejected", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });

    await expect(client.connect()).rejects.toThrow(/SSL_ACCESS_TOKEN/);
    expect(client.authRejected()).toBe(true);

    mockFetch
      .mockResolvedValueOnce(ok(STREAMER))
      .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));
    await client.connect();
    expect(client.authRejected()).toBe(false);
  });

  it("should throw on API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });

    await expect(client.connect()).rejects.toThrow("Failed to fetch streamer info");
  });

  it("fetches again when a change is announced while a fetch is running", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => (release = resolve));
    mockFetch
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(ok({ items: [], playing: entry(2, "Song B"), total: 0 }));

    const refresh = (client as unknown as { refresh(): Promise<void> }).refresh.bind(client);
    const first = refresh();
    const second = refresh();
    release(ok({ items: [], playing: entry(1, "Song A"), total: 0 }));
    await Promise.all([first, second]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(client.getCurrentSong()?.song.title).toBe("Song B");
  });

  it("waits as long as StreamerSongList asks when it's busy, and says why", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "retry-after": "30" }),
      json: async () => ({ title: "Too Many Requests", detail: "Slow down" }),
    });
    await expect(client.connect()).rejects.toThrow("(Slow down)");
    const calls = mockFetch.mock.calls.length;
    await (client as unknown as { refresh(): Promise<void> }).refresh();
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it("never sends the app's Client-Id with a pasted token", async () => {
    const cfg = config as unknown as Record<string, unknown>;
    cfg.sslClientId = "app-id";
    try {
      mockFetch
        .mockResolvedValueOnce(ok(STREAMER))
        .mockResolvedValueOnce(ok({ items: [], playing: null, total: 0 }));
      await client.connect();
      expect(mockFetch.mock.calls[0][1].headers["Client-Id"]).toBeUndefined();
    } finally {
      cfg.sslClientId = "";
    }
  });

  it("refetches on any event and on every reconnect", async () => {
    jest.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(ok(STREAMER))
        .mockResolvedValue(ok({ items: [], playing: null, total: 0 }));
      await client.connect();
      const [, , onPublication, onConnect] = (CentrifugoStream as unknown as jest.Mock).mock.calls.at(-1);
      const before = mockFetch.mock.calls.length;
      onPublication("streamer:123", { type: "some_new_event_type", data: null });
      await jest.advanceTimersByTimeAsync(300);
      expect(mockFetch.mock.calls.length).toBe(before + 1);
      onConnect();
      await jest.advanceTimersByTimeAsync(300);
      expect(mockFetch.mock.calls.length).toBe(before + 2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("uses the newer live-learn title and artist fields", () => {
    const live = entry(9, "", { songId: null, nonlistSong: "old field", nonlistTitle: "Aerith's Theme", nonlistArtist: "Nobuo Uematsu" });
    expect(SongListClient.toSong(live)).toMatchObject({ title: "Aerith's Theme", artist: "Nobuo Uematsu", liveLearn: true });
  });

  it("keeps a typed-in title to one short line", () => {
    const live = entry(10, "", { songId: null, nonlistTitle: "Aerith's Theme\n[Server] fake error\r\n", nonlistArtist: "x".repeat(500) });
    const song = SongListClient.toSong(live);
    expect(song.title).toBe("Aerith's Theme [Server] fake error");
    expect(song.artist).toHaveLength(200);
  });

  describe("song search", () => {
    const page = (items: unknown[], token?: string) => ok({ items, ...(token ? { token } : {}) });

    it("searches the song list it read, with title, artist and song ID", async () => {
      mockFetch
        .mockResolvedValueOnce(page([{ id: 11, title: "Evening Rain", artist: "Jane Composer" }, { id: 12, title: "Harbor Lights", artist: "The Paper Lanterns" }], "next"))
        .mockResolvedValueOnce(page([{ id: 13, title: "Rain Dance\n", artist: null }, { title: "No ID" }]));
      await client.learnListFormat();
      expect(mockFetch.mock.calls[1][0]).toContain("after=next");
      expect(client.searchSongs("rain", 8)).toEqual([
        { id: 13, title: "Rain Dance", artist: "" },
        { id: 11, title: "Evening Rain", artist: "Jane Composer" },
      ]);
      expect(client.searchSongs("lanterns", 8)).toEqual([{ id: 12, title: "Harbor Lights", artist: "The Paper Lanterns" }]);
    });

    it("finds nothing before the list is read, and reads it again on a search after a failure", async () => {
      jest.spyOn(console, "warn").mockImplementation(() => {});
      mockFetch.mockRejectedValueOnce(new Error("network down"));
      await client.learnListFormat();
      expect(client.searchSongs("rain", 8)).toEqual([]);
      // Too soon to try again.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now + 61_000);
      mockFetch.mockResolvedValueOnce(page([{ id: 21, title: "Evening Rain", artist: "Jane Composer" }]));
      client.searchSongs("rain", 8);
      await new Promise((r) => setImmediate(r));
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(client.searchSongs("evening", 8)).toEqual([{ id: 21, title: "Evening Rain", artist: "Jane Composer" }]);
      jest.restoreAllMocks();
    });
  });
});
