/** Which settings are required depends on where song requests come from. */
import os from "os";
import path from "path";

const SAVED = { ...process.env };
const KEYS = [
  "SONG_SOURCE", "SSL_STREAMER_NAME", "SSL_ACCESS_TOKEN", "SE_CHANNEL", "SE_JWT", "STREAMER_DISPLAY_NAME", "AI_PROVIDER",
  "NOW_PLAYING_FILE", "NOW_PLAYING_FORMAT", "NOW_PLAYING_PRESET", "OneDrive", "OneDriveConsumer", "OneDriveCommercial", "CREDIT_BUBBLE",
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

  it("uses Streamling's own file with the Streamling preset, and finds another name in its folder", () => {
    const folder = path.join(os.homedir(), "Documents", "streamling", "livetext");
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling" }).nowPlayingFile).toBe(path.join(folder, "nowplaying-minimal.txt"));
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FILE: "song.txt" }).nowPlayingFile).toBe(path.join(folder, "song.txt"));
    // A full path, or one from the home folder, is used as written.
    const elsewhere = path.join(os.tmpdir(), "song.txt");
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling", NOW_PLAYING_FILE: elsewhere }).nowPlayingFile).toBe(elsewhere);
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: "~/Music/song.txt" }).nowPlayingFile).toBe(path.join(os.homedir(), "Music", "song.txt"));
    expect(() => load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "lanternplayer", NOW_PLAYING_FILE: "x" })).toThrow(/NOW_PLAYING_PRESET must be one of/);
  });

  it("follows Nightbot's whole folder with the Nightbot preset, reading YouTube titles", () => {
    const folder = path.join(os.homedir(), "Documents", "Nightbot");
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "nightbot" })).toMatchObject({
      nowPlayingPreset: "nightbot",
      nowPlayingFolder: folder,
      nowPlayingFile: "",
      nowPlayingFormat: "youtube-title",
    });
    // A file named in the settings is followed instead, found in that folder; the format can still be set.
    const named = load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "nightbot", NOW_PLAYING_FILE: "song.txt", NOW_PLAYING_FORMAT: "artist-title" });
    expect(named).toMatchObject({ nowPlayingFolder: "", nowPlayingFile: path.join(folder, "song.txt"), nowPlayingFormat: "artist-title" });
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: path.join(os.tmpdir(), "song.txt") })).toMatchObject({ nowPlayingFolder: "", nowPlayingFormat: "artist-title" });
    expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_FILE: path.join(os.tmpdir(), "song.txt"), NOW_PLAYING_FORMAT: "youtube-title" }).nowPlayingFormat).toBe("youtube-title");
  });

  it("looks for a preset's folder where now-playing-folder says (OneDrive's Documents, say)", () => {
    const moved = path.join(os.tmpdir(), "OneDrive", "Documents");
    jest.doMock("./now-playing-folder", () => ({ presetFolder: (folder: string[]) => path.join(moved, ...folder) }));
    try {
      expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "nightbot" })).toMatchObject({ nowPlayingFolder: path.join(moved, "Nightbot"), nowPlayingFile: "" });
      expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "nightbot", NOW_PLAYING_FILE: "song.txt" }).nowPlayingFile).toBe(path.join(moved, "Nightbot", "song.txt"));
      expect(load({ SONG_SOURCE: "nowplaying", NOW_PLAYING_PRESET: "streamling" }).nowPlayingFile).toBe(path.join(moved, "streamling", "livetext", "nowplaying-minimal.txt"));
    } finally {
      jest.dontMock("./now-playing-folder");
    }
  });

  it("ignores the now playing settings with the other sources", () => {
    expect(load({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", NOW_PLAYING_PRESET: "nightbot" })).toMatchObject({ nowPlayingFile: "", nowPlayingFolder: "" });
    expect(load({ SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t", NOW_PLAYING_PRESET: "streamling" })).toMatchObject({ nowPlayingFile: "" });
  });

  it("refuses an unknown source", () => {
    expect(() => load({ SONG_SOURCE: "spotify" })).toThrow(/SONG_SOURCE must be one of/);
  });
});

describe("config credit bubble", () => {
  const base = { SSL_STREAMER_NAME: "jane", SSL_ACCESS_TOKEN: "t" };

  it("is on unless CREDIT_BUBBLE=off", () => {
    expect(load(base).creditBubble).toBe(true);
    expect(load({ ...base, CREDIT_BUBBLE: "on" }).creditBubble).toBe(true);
    expect(load({ ...base, CREDIT_BUBBLE: "off" }).creditBubble).toBe(false);
    expect(() => load({ ...base, CREDIT_BUBBLE: "sometimes" })).toThrow(/CREDIT_BUBBLE must be one of/);
  });
});
