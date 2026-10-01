jest.mock("./config", () => ({
  config: {
    songSource: "streamelements",
    seChannel: "janeplays",
    seJwt: "test-jwt",
    seApiBase: "https://api.streamelements.com/kappa/v2",
    seEventsUrl: "wss://astro.streamelements.com",
    sePollIntervalMs: 15000,
    seRequestTimeoutMs: 5000,
    liveLearns: true,
    topic: "general",
  },
}));

// The realtime stream opens a real socket; stub it out entirely.
const startMock = jest.fn();
const stopMock = jest.fn();
let streamConnected = true;
jest.mock("./astro-client", () => ({
  AstroStream: jest.fn().mockImplementation(() => ({
    start: startMock,
    stop: stopMock,
    isConnected: () => streamConnected,
  })),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { StreamElementsClient, SESong } from "./streamelements-client";
import { config } from "./config";
import { AstroStream } from "./astro-client";

const CHANNEL = { _id: "5b2e2007760aeb7729487dab", username: "janeplays", provider: "twitch" };
const CIARA: SESong = {
  _id: "req-1",
  videoId: "iBHNgV6_znU",
  title: "Ciara - 1, 2 Step (Official Video) ft. Missy Elliott",
  channel: "CiaraVEVO",
  duration: 205,
  user: { username: "viewer1", providerId: "1" },
};
const STORMS: SESong = {
  _id: "req-2",
  videoId: "abc",
  title: "Song of Storms - The Legend of Zelda: Ocarina of Time",
  channel: "Some Uploader",
  duration: 90,
  user: { username: "viewer2" },
};

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body), json: async () => body };
}
function status(code: number, statusText: string, headers: Record<string, string> = {}) {
  return { ok: false, status: code, statusText, headers: new Headers(headers), text: async () => "", json: async () => ({}) };
}
/** One refresh: the player's state, then the song at the head of the player. */
function player(state: string, song: SESong | null) {
  mockFetch.mockResolvedValueOnce(ok({ state })).mockResolvedValueOnce(song ? ok(song) : status(404, "Not Found"));
}

type Internals = { refresh(): Promise<void> };
const refresh = (c: StreamElementsClient) => (c as unknown as Internals).refresh();

describe("StreamElementsClient", () => {
  let client: StreamElementsClient;

  beforeEach(() => {
    client = new StreamElementsClient();
    mockFetch.mockReset();
    startMock.mockClear();
    stopMock.mockClear();
    streamConnected = true;
    (AstroStream as unknown as jest.Mock).mockClear();
  });

  afterEach(() => client.disconnect());
  // Failed fetches are logged as errors; the tests check the outcome instead.
  const quiet = jest.spyOn(console, "error").mockImplementation(() => undefined);
  afterAll(() => quiet.mockRestore());

  it("finds the channel by name, sends the JWT, and follows the playing song", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL));
    player("playing", CIARA);
    const changes = jest.fn();
    client.onCurrentSongChange(changes);

    await client.connect();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.streamelements.com/kappa/v2/channels/janeplays");
    expect(init.headers.Authorization).toBe("Bearer test-jwt");
    expect(mockFetch.mock.calls[1][0]).toBe(`https://api.streamelements.com/kappa/v2/songrequest/${CHANNEL._id}/player`);
    expect(mockFetch.mock.calls[2][0]).toBe(`https://api.streamelements.com/kappa/v2/songrequest/${CHANNEL._id}/playing`);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(client.toSong(client.getCurrentSong()!)).toEqual({ title: "1, 2 Step", artist: "Ciara", requestedBy: "viewer1", performer: true });
  });

  it("uses a channel ID as is, and the token's own channel when none is given", async () => {
    const cfg = config as unknown as Record<string, unknown>;
    try {
      cfg.seChannel = CHANNEL._id;
      player("playing", CIARA);
      await client.connect();
      expect(mockFetch.mock.calls[0][0]).toContain(`/songrequest/${CHANNEL._id}/player`);
      client.disconnect();

      mockFetch.mockReset();
      cfg.seChannel = "";
      client = new StreamElementsClient();
      mockFetch.mockResolvedValueOnce(ok(CHANNEL));
      player("playing", CIARA);
      await client.connect();
      expect(mockFetch.mock.calls[0][0]).toMatch(/\/channels\/me$/);
    } finally {
      cfg.seChannel = "janeplays";
    }
  });

  it("maps a request into the entry the fact pipeline reads", () => {
    const entry = StreamElementsClient.toEntry(STORMS);
    expect(entry.song).toEqual({ title: "Song of Storms", artist: "The Legend of Zelda: Ocarina of Time", durationSeconds: 90 });
    expect(entry.requests).toEqual([{ id: 0, name: "viewer2" }]);
    expect(entry.nonlistSong).toBeNull();
    expect(StreamElementsClient.toEntry({ title: "Hello", channel: "" }).song.artist).toBe("Unknown");
  });

  it("never marks a request as a live learn", () => {
    expect(client.toSong(StreamElementsClient.toEntry(CIARA)).liveLearn).toBeUndefined();
  });

  it("ignores the next song up while nothing is playing", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL));
    player("paused", CIARA);
    const changes = jest.fn();
    client.onCurrentSongChange(changes);
    await client.connect();
    expect(client.getCurrentSong()).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it("keeps the song through a pause, and clears it when the player moves on without playing", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL));
    player("playing", CIARA);
    const changes = jest.fn();
    client.onCurrentSongChange(changes);
    await client.connect();
    expect(changes).toHaveBeenCalledTimes(1);

    player("paused", CIARA);
    await refresh(client);
    expect(client.getCurrentSong()?.song.title).toBe("1, 2 Step");
    expect(changes).toHaveBeenCalledTimes(1);

    player("paused", STORMS);
    await refresh(client);
    expect(client.getCurrentSong()).toBeNull();
    expect(changes).toHaveBeenLastCalledWith(null);
  });

  it("notices a song change, and an empty player", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL));
    player("playing", CIARA);
    const changes = jest.fn();
    client.onCurrentSongChange(changes);
    await client.connect();

    player("playing", CIARA);
    await refresh(client);
    expect(changes).toHaveBeenCalledTimes(1);

    player("playing", STORMS);
    await refresh(client);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(client.getCurrentSong()?.song.artist).toBe("The Legend of Zelda: Ocarina of Time");

    // The same video requested again is a new request, so a new song.
    player("playing", { ...STORMS, _id: "req-3" });
    await refresh(client);
    expect(changes).toHaveBeenCalledTimes(3);

    player("playing", null);
    await refresh(client);
    expect(client.getCurrentSong()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(4);
  });

  it("follows /playing when the player doesn't report a state", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL)).mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(CIARA));
    await client.connect();
    expect(client.getCurrentSong()?.song.title).toBe("1, 2 Step");
  });

  it("reports a refused token, and recovers when it works again", async () => {
    mockFetch.mockResolvedValueOnce(status(401, "Unauthorized"));
    await expect(client.connect()).rejects.toThrow(/SE_JWT/);
    expect(client.authRejected()).toBe(true);

    client.disconnect();
    client = new StreamElementsClient();
    mockFetch.mockResolvedValueOnce(ok(CHANNEL)).mockResolvedValueOnce(status(403, "Forbidden"));
    await client.connect();
    expect(client.authRejected()).toBe(true);
    expect(client.getCurrentSong()).toBeNull();

    player("playing", CIARA);
    await refresh(client);
    expect(client.authRejected()).toBe(false);
    expect(client.lastSuccessfulFetchAgeMs()).not.toBeNull();
  });

  it("waits as long as StreamElements asks when it's busy", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL)).mockResolvedValueOnce(status(429, "Too Many Requests", { "retry-after": "30" }));
    await client.connect();
    const calls = mockFetch.mock.calls.length;
    await refresh(client);
    expect(mockFetch.mock.calls.length).toBe(calls);
    expect(client.lastSuccessfulFetchAgeMs()).toBeNull();
  });

  it("fetches again when a change is announced while a fetch is running", async () => {
    mockFetch.mockResolvedValueOnce(ok(CHANNEL));
    player("playing", CIARA);
    await client.connect();

    let release: (v: unknown) => void = () => undefined;
    mockFetch.mockReturnValueOnce(new Promise((resolve) => (release = resolve))).mockResolvedValueOnce(ok(CIARA));
    player("playing", STORMS);
    const first = refresh(client);
    const second = refresh(client);
    release(ok({ state: "playing" }));
    await Promise.all([first, second]);
    expect(client.getCurrentSong()?.song.title).toBe("Song of Storms");
  });

  it("subscribes to the channel's song requests and refetches on any event and every reconnect", async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce(ok(CHANNEL));
      player("playing", CIARA);
      await client.connect();
      const [url, topic, room, token, onMessage, onConnect] = (AstroStream as unknown as jest.Mock).mock.calls.at(-1);
      expect(url).toBe("wss://astro.streamelements.com");
      expect(topic).toBe("channel.songrequest");
      expect(room).toBe(CHANNEL._id);
      expect(token()).toBe("test-jwt");
      expect(startMock).toHaveBeenCalled();

      mockFetch.mockResolvedValue(ok({ state: "playing" }));
      const before = mockFetch.mock.calls.length;
      onMessage({ topic, event: "some.new.event" });
      onMessage({ topic, event: "song.next" });
      await jest.advanceTimersByTimeAsync(300);
      expect(mockFetch.mock.calls.length).toBe(before + 2); // one refetch: player and playing

      onConnect();
      await jest.advanceTimersByTimeAsync(300);
      expect(mockFetch.mock.calls.length).toBe(before + 4);
    } finally {
      jest.useRealTimers();
    }
    client.disconnect();
    expect(stopMock).toHaveBeenCalled();
  });

  it("keeps following songs after a pause even if the player still reports paused", async () => {
    // A real failure (issue #16): after a pause, the REST player state stayed
    // "paused", so no later song was followed until the player was restarted.
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce(ok(CHANNEL));
      player("playing", CIARA);
      const changes = jest.fn();
      client.onCurrentSongChange(changes);
      await client.connect();
      const [, topic, , , onMessage] = (AstroStream as unknown as jest.Mock).mock.calls.at(-1);
      expect(client.getCurrentSong()?.song.title).toBe("1, 2 Step");

      // Paused, and /playing briefly answers nothing: keep the song and its facts.
      player("paused", null);
      onMessage({ topic, event: "pause" });
      await jest.advanceTimersByTimeAsync(300);
      expect(client.getCurrentSong()?.song.title).toBe("1, 2 Step");

      // Resumed, then the next song starts, but REST still says "paused".
      player("paused", STORMS);
      onMessage({ topic, event: "play" });
      onMessage({ topic, event: "song.next" });
      await jest.advanceTimersByTimeAsync(300);
      expect(client.getCurrentSong()?.song.artist).toBe("The Legend of Zelda: Ocarina of Time");
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("doesn't call an empty queue at the end of the stream a problem", async () => {
    // From review: the last "play" event stayed in force after the queue ran out,
    // so health turned degraded and the app restarted every few minutes.
    jest.useFakeTimers();
    streamConnected = true;
    try {
      mockFetch.mockResolvedValueOnce(ok(CHANNEL));
      player("playing", CIARA);
      await client.connect();
      const [, topic, , , onMessage] = (AstroStream as unknown as jest.Mock).mock.calls.at(-1);
      player("playing", null);
      onMessage({ topic, event: "play" });
      await jest.advanceTimersByTimeAsync(31_000);
      expect(client.getCurrentSong()).toBeNull();
      expect(client.followingProblem()).toBeNull();
    } finally {
      streamConnected = false;
      jest.useRealTimers();
    }
  });

  it("ignores a live event once its socket is gone", async () => {
    jest.useFakeTimers();
    streamConnected = true;
    try {
      mockFetch.mockResolvedValueOnce(ok(CHANNEL));
      player("playing", CIARA);
      await client.connect();
      const [, topic, , , onMessage] = (AstroStream as unknown as jest.Mock).mock.calls.at(-1);
      onMessage({ topic, event: "play" });
      await jest.advanceTimersByTimeAsync(300);
      // The socket drops, and the streamer stops: REST is now the only word.
      streamConnected = false;
      player("stopped", STORMS);
      await refresh(client);
      expect(client.getCurrentSong()).toBeNull();
    } finally {
      streamConnected = false;
      jest.useRealTimers();
    }
  });

  it("polls less often while live events arrive", () => {
    streamConnected = false;
    expect(client.pollIntervalMs()).toBe(15000);
    (client as unknown as { stream: unknown }).stream = { isConnected: () => true, stop: () => undefined };
    expect(client.pollIntervalMs()).toBe(30000);
    expect(client.isEventStreamConnected()).toBe(true);
  });
});
