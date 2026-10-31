import { factsTookLine, listeningLine } from "./listening";
import { SongListClient } from "./songlist-client";
import { StreamElementsClient } from "./streamelements-client";
import { NowPlayingFileSource } from "./now-playing-file";

jest.mock("./config", () => ({
  config: {
    sslPollIntervalMs: 15000,
    sePollIntervalMs: 15000,
    nowPlayingPreset: "none",
    nowPlayingFile: "",
    nowPlayingFolder: "",
    nowPlayingFormat: "artist-title",
    liveLearns: true,
    topic: "general",
  },
  NOW_PLAYING_PRESETS: {},
}));

const source = (name: string, live: boolean, ms: number) => ({ name, isEventStreamConnected: () => live, pollIntervalMs: () => ms });

describe("the dashboard's listening line", () => {
  it("says the queue is heard live while the live updates are connected", () => {
    expect(listeningLine(source("StreamerSongList", true, 15000))).toBe("Hearing your queue live");
  });

  it("says how often it checks when the live updates are not connected", () => {
    expect(listeningLine(source("StreamerSongList", false, 15000))).toBe("Checking your list every 15 seconds");
  });

  it("follows the interval the source really uses", () => {
    expect(listeningLine(source("StreamerSongList", false, 5000))).toBe("Checking your list every 5 seconds");
    expect(listeningLine(source("StreamerSongList", false, 1000))).toBe("Checking your list every second");
    // Rounded up: it never promises faster than it checks.
    expect(listeningLine(source("StreamerSongList", false, 2500))).toBe("Checking your list every 3 seconds");
  });

  it("speaks of song requests for StreamElements, live or by checking", () => {
    expect(listeningLine(source("StreamElements", true, 30000))).toBe("Hearing your song requests live");
    expect(listeningLine(source("StreamElements", false, 15000))).toBe("Checking your song requests every 15 seconds");
  });

  it("only ever checks a now playing file, every 2 seconds", () => {
    expect(listeningLine(source("Now playing file", false, 2000))).toBe("Checking your file every 2 seconds");
    expect(listeningLine(source("Streamling", false, 2000))).toBe("Checking your file every 2 seconds");
  });

  it("reads the real sources: not connected before the live updates are, and with their real intervals", () => {
    expect(listeningLine(new SongListClient())).toBe("Checking your list every 15 seconds");
    expect(listeningLine(new StreamElementsClient())).toBe("Checking your song requests every 15 seconds");
    expect(listeningLine(new NowPlayingFileSource())).toBe("Checking your file every 2 seconds");
  });

  it("reflects the live updates once the real client has them connected", () => {
    const client = new SongListClient();
    (client as unknown as { stream: { isConnected(): boolean } }).stream = { isConnected: () => true };
    expect(listeningLine(client)).toBe("Hearing your queue live");
    (client as unknown as { stream: { isConnected(): boolean } }).stream = { isConnected: () => false };
    expect(listeningLine(client)).toBe("Checking your list every 15 seconds");
  });
});

describe("factsTookLine", () => {
  it("says how long a song's AI facts took, in whole seconds", () => {
    expect(factsTookLine(45_400)).toBe("Facts took 45 s");
    expect(factsTookLine(800)).toBe("Facts took 1 s");
  });

  it("says nothing for a song the AI didn't write for", () => {
    expect(factsTookLine(null)).toBe("");
  });
});
