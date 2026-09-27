// Mock config before importing anything that uses it
jest.mock("./config", () => ({
  config: {
    sslEnv: "production",
    sslStreamerName: "teststreamer",
    sslPlatform: "twitch",
    sslApiBase: "https://api.streamersonglist.com",
    sslAccessToken: "test-token",
    sslTokenKind: "streamer",
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
  })),
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { SongListClient } from "./songlist-client";
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

    const listed = entry(8, "On The List");
    expect(SongListClient.isLiveLearn(listed)).toBe(false);
    expect(SongListClient.toSong(listed)).toEqual({
      title: "On The List",
      artist: "Test Artist",
      requestedBy: "viewer1",
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

    expect(mockFetch.mock.calls[1][0]).toContain("/queue?");

    client.disconnect();
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
  });

  it("should throw on API error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });

    await expect(client.connect()).rejects.toThrow("Failed to fetch streamer info");
  });
});
