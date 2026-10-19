/** Which settings are required depends on where song requests come from. */
import os from "os";
import path from "path";

const SAVED = { ...process.env };
const KEYS = [
  "SONG_SOURCE", "SSL_STREAMER_NAME", "SSL_ACCESS_TOKEN", "SE_CHANNEL", "SE_JWT", "STREAMER_DISPLAY_NAME", "AI_PROVIDER",
  "NOW_PLAYING_FILE", "NOW_PLAYING_FORMAT", "NOW_PLAYING_PRESET",
];

function load(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { AI_PROVIDER: "none" }, env);
  let config: typeof import("./config").config | undefined;
  jest.isolateModules(() => {
    // dotenv never overrides what's already set, and the tests set everything they read.
    jest.doMock("dotenv", () => ({ config: () => ({}) }));
    config = require("./config").config;
  });
  return config!;
}

afterAll(() => {
  process.env = SAVED;
});

describe("config song source", () => {
  it("defaults to StreamerSongList and requires its settings", () => {
    expect(() => load({})).toThrow(/SSL_STREAMER_NAME/);
    const c = load({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t" });
    expect(c).toMatchObject({ songSource: "streamersonglist", sslStreamerName: "jane", streamerDisplayName: "jane", seJwt: "" });
  });

  it("needs only the StreamElements token with SONG_SOURCE=streamelements", () => {
    expect(() => load({ SONG_SOURCE: "streamelements" })).toThrow(/SE_JWT/);
    const c = load({ SONG_SOURCE: "streamelements", SE_JWT: "jwt", SE_CHANNEL: "janeplays" });
    expect(c).toMatchObject({
      songSource: "streamelements",
      seJwt: "jwt",
      seChannel: "janeplays",
      sslAccessToken: "",
      // The channel name stands in for the streamer's name, for originals.
      sslStreamerName: "janeplays",
      streamerDisplayName: "janeplays",
    });
    expect(load({ SONG_SOURCE: "streamelements", SE_JWT: "jwt", STREAMER_DISPLAY_NAME: "Jane" }).streamerDisplayName).toBe("Jane");
  });

  it("needs only the file with SONG_SOURCE=nowplaying, read as Artist - Title by default", () => {
    expect(() => load({ SONG_SOURCE: "nowplaying" })).toThrow(/NOW_PLAYING_FILE.*full path/);
    const file = path.join(os.tmpdir(), "nowplaying.txt");
    const c = load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: file, STREAMER_DISPLAY_NAME: "Jane" });
    expect(c).toMatchObject({
      songSource: "nowplaying",
      nowPlayingFile: file,
      nowPlayingFormat: "artist-title",
      nowPlayingPreset: "none",
      sslAccessToken: "",
      seJwt: "",
      streamerDisplayName: "Jane",
    });
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: file, NOW_PLAYING_FORMAT: "Title" }).nowPlayingFormat).toBe("title");
    expect(() => load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: file, NOW_PLAYING_FORMAT: "title-artist" })).toThrow(/NOW_PLAYING_FORMAT must be one of/);
  });

  it("finds a file name in Streamling's folder with the Streamling preset, and asks for the name", () => {
    const folder = path.join(os.homedir(), "Documents", "streamling", "livetext");
    expect(() => load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling" })).toThrow(/NOW_PLAYING_FILE.*Streamling.*livetext/);
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FILE: "song.txt" }).nowPlayingFile).toBe(path.join(folder, "song.txt"));
    // A full path, or one from the home folder, is used as written.
    const elsewhere = path.join(os.tmpdir(), "song.txt");
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FILE: elsewhere }).nowPlayingFile).toBe(elsewhere);
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: "~/Music/song.txt" }).nowPlayingFile).toBe(path.join(os.homedir(), "Music", "song.txt"));
    expect(() => load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "lanternplayer", NOW_PLAYING_FILE: "x" })).toThrow(/NOW_PLAYING_PRESET must be one of/);
  });

  it("ignores the now playing settings with the other sources", () => {
    expect(load({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", NOW_PLAYING_PRESET: "streamling" })).toMatchObject({ nowPlayingFile: "" });
  });

  it("refuses an unknown source", () => {
    expect(() => load({ SONG_SOURCE: "spotify" })).toThrow(/SONG_SOURCE must be one of/);
  });
});
