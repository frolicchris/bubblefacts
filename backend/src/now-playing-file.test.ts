jest.mock("./config", () => ({
  config: {
    songSource: "nowplaying",
    nowPlayingPreset: "none",
    nowPlayingFile: "",
    nowPlayingFormat: "artist-title",
    liveLearns: true,
    topic: "general",
  },
  NOW_PLAYING_PRESETS: { streamling: { name: "Streamling", folder: ["Documents", "streamling", "livetext"], file: "nowplaying-minimal.txt" } },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { NowPlayingFileSource, NowPlayingFormat, parseNowPlaying, STALE_AFTER_MS } from "./now-playing-file";
import { SSLQueueItem } from "./types";

/** Sample files as now-playing apps write them, with made-up songs. */
const SAMPLES = path.join(__dirname, "fixtures", "now-playing");
let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-nowplaying-"));
  file = path.join(dir, "nowplaying.txt");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The app writes a sample into the watched file, just now or `ageMs` ago. */
function write(sample: string, ageMs = 0): void {
  fs.copyFileSync(path.join(SAMPLES, sample), file);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}

/** A source plus every song change it reported. Two checks settle a reading (see apply()). */
function source(format: NowPlayingFormat = "artist-title") {
  const changes: Array<SSLQueueItem | null> = [];
  const src = new NowPlayingFileSource({ file, format });
  src.onCurrentSongChange((s) => changes.push(s));
  const settle = async () => {
    await src.checkNow();
    await src.checkNow();
  };
  return { src, changes, settle };
}

const shown = (src: NowPlayingFileSource) => {
  const current = src.getCurrentSong();
  return current && src.toSong(current);
};

describe("parseNowPlaying", () => {
  it("splits Artist - Title at the first spaced dash, so a later one stays in the title", () => {
    expect(parseNowPlaying("Marlow Finch - Harbor Lights - Part II", "artist-title")).toEqual({ artist: "Marlow Finch", title: "Harbor Lights - Part II" });
  });

  it("reads the whole line as the title with the title format, dashes and all", () => {
    expect(parseNowPlaying("Harbor Lights - Part II", "title")).toEqual({ artist: "Unknown", title: "Harbor Lights - Part II" });
  });

  it("treats a line without a spaced dash as all title", () => {
    expect(parseNowPlaying("Theme of the Glass Valley", "artist-title")).toEqual({ artist: "Unknown", title: "Theme of the Glass Valley" });
    // A hyphen inside a word isn't a separator.
    expect(parseNowPlaying("Hi-Fi Dreams", "artist-title")).toEqual({ artist: "Unknown", title: "Hi-Fi Dreams" });
  });

  it("reads no song from an empty file or a template with nothing filled in", () => {
    expect(parseNowPlaying("", "artist-title")).toBeNull();
    expect(parseNowPlaying("  \r\n\n", "artist-title")).toBeNull();
    expect(parseNowPlaying(" - \r\n", "artist-title")).toBeNull();
    expect(parseNowPlaying(" - ", "title")).toBeNull();
  });

  it("uses the first line that has something on it", () => {
    expect(parseNowPlaying("\n  Juniper Reyes  -  Copper Moon \nnext: something else", "artist-title")).toEqual({ artist: "Juniper Reyes", title: "Copper Moon" });
  });
});

describe("NowPlayingFileSource", () => {
  it("follows the song when the line changes", async () => {
    const { src, changes, settle } = source();
    write("artist-title.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights", artist: "Marlow Finch" });
    write("artist-title-next.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(changes.map((c) => c?.song.title ?? null)).toEqual(["Harbor Lights", "Copper Moon"]);
  });

  it("leaves the requester and length empty, like a StreamElements request without them", async () => {
    const { src, settle } = source();
    write("artist-title.txt");
    await settle();
    const current = src.getCurrentSong()!;
    expect(current).toMatchObject({ songId: null, requests: null, note: null, nonlistSong: null });
    expect(current.song.durationSeconds).toBeNull();
    const song = src.toSong(current);
    expect(song.requestedBy).toBeUndefined();
    expect(song.liveLearn).toBeUndefined();
    expect(song.songId).toBeUndefined();
  });

  it("keeps a dash inside the title", async () => {
    const { src, settle } = source();
    write("dash-in-title.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights - Part II", artist: "Marlow Finch" });
  });

  it("reads the whole line as the title with the title format", async () => {
    const { src, settle } = source("title");
    write("dash-in-title.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Marlow Finch - Harbor Lights - Part II", artist: "Unknown" });
    write("title-only.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Theme of the Glass Valley", artist: "Unknown" });
  });

  it("reads Windows line endings, a UTF-8 byte order mark and UTF-16", async () => {
    const { src, changes, settle } = source();
    write("windows-bom.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights", artist: "Marlow Finch" });
    write("utf16.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(changes).toHaveLength(2);
  });

  it("clears the song when the file goes empty", async () => {
    const { src, changes, settle } = source();
    write("artist-title.txt");
    await settle();
    write("empty.txt");
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    write("blank-template.txt");
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    expect(changes.map((c) => c?.song.title ?? null)).toEqual(["Harbor Lights", null]);
  });

  it("clears the song when the file is deleted, and counts a missing file as checked", async () => {
    const { src, changes, settle } = source();
    write("artist-title.txt");
    await settle();
    fs.rmSync(file);
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    expect(changes.at(-1)).toBeNull();
    // Missing isn't broken: the app may not have started yet.
    expect(src.lastSuccessfulFetchAgeMs()).toBeLessThan(1000);
  });

  it("shows nothing for a file that isn't there yet, then follows it once written", async () => {
    const { src, changes, settle } = source();
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    expect(changes).toEqual([]);
    write("artist-title.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights" });
  });

  it("ignores a stale file left over from an earlier stream", async () => {
    const { src, changes, settle } = source();
    write("artist-title.txt", STALE_AFTER_MS + 60_000);
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    expect(changes).toEqual([]);
  });

  it("clears a song whose file stops changing, so old facts never stay up", async () => {
    const { src, changes, settle } = source();
    write("artist-title.txt");
    await settle();
    expect(src.getCurrentSong()).not.toBeNull();
    // The player stopped and the file was never rewritten.
    const old = new Date(Date.now() - STALE_AFTER_MS - 1000);
    fs.utimesSync(file, old, old);
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    // Written again later, the same line is a new play.
    write("artist-title.txt");
    await settle();
    expect(changes.map((c) => c?.song.title ?? null)).toEqual(["Harbor Lights", null, "Harbor Lights"]);
  });

  it("keeps the song when the app rewrites the same line", async () => {
    const { changes, settle } = source();
    write("artist-title.txt");
    await settle();
    write("artist-title.txt");
    await settle();
    expect(changes).toHaveLength(1);
  });

  it("doesn't restart the bubbles when the file blinks empty during a rewrite", async () => {
    const { src, changes } = source();
    write("artist-title.txt");
    await src.checkNow();
    await src.checkNow();
    write("empty.txt");
    await src.checkNow();
    write("artist-title.txt");
    await src.checkNow();
    await src.checkNow();
    expect(changes).toHaveLength(1);
    expect(shown(src)).toMatchObject({ title: "Harbor Lights" });
  });

  it("reports a folder in place of the file and ends the song", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const { src, settle } = source();
    write("artist-title.txt");
    await settle();
    fs.rmSync(file);
    fs.mkdirSync(file);
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    // Logged once, not on every check.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(/is a folder, not a file/);
    error.mockRestore();
  });

  it("polls every 2 seconds and has no events or token", () => {
    const { src } = source();
    expect(src.pollIntervalMs()).toBe(2000);
    expect(src.isEventStreamConnected()).toBe(false);
    expect(src.authRejected()).toBe(false);
    expect(src.lastSuccessfulFetchAgeMs()).toBeNull();
    expect(src.name).toBe("Now playing file");
  });

  it("follows the file on its own once connected, and stops on disconnect", async () => {
    const changes: Array<SSLQueueItem | null> = [];
    const src = new NowPlayingFileSource({ file, pollMs: 20 });
    src.onCurrentSongChange((s) => changes.push(s));
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      write("artist-title.txt");
      await src.connect();
      await wait(200);
      expect(changes.map((c) => c?.song.title)).toEqual(["Harbor Lights"]);
    } finally {
      src.disconnect();
    }
    await wait(50);
    write("artist-title-next.txt");
    await wait(200);
    expect(changes).toHaveLength(1);
  });
});
