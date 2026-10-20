jest.mock("./config", () => ({
  config: {
    songSource: "nowplaying",
    nowPlayingPreset: "none",
    nowPlayingFile: "",
    nowPlayingFolder: "",
    nowPlayingFormat: "artist-title",
    liveLearns: true,
    topic: "general",
  },
  NOW_PLAYING_PRESETS: { streamling: { name: "Streamling", folder: ["Documents", "streamling", "livetext"], file: "nowplaying-minimal.txt" },
    nightbot: { name: "Nightbot", folder: ["Documents", "Nightbot"], file: "" },
  },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { newestTextFile, NowPlayingFileSource, NowPlayingFormat, parseNowPlaying, STALE_AFTER_MS } from "./now-playing-file";
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

describe("parseNowPlaying with a YouTube title", () => {
  const read = (line: string) => parseNowPlaying(line, "youtube-title");

  it("reads the artist and song out of a video title", () => {
    expect(read("Marlow Finch - Harbor Lights (Official Video)")).toEqual({ artist: "Marlow Finch", title: "Harbor Lights" });
    expect(read("Juniper Reyes - Copper Moon [Official Audio] ft. Tobias Vale")).toEqual({ artist: "Juniper Reyes", title: "Copper Moon" });
    expect(read("Marlow Finch - Harbor Lights - Live (4K)")).toEqual({ artist: "Marlow Finch", title: "Harbor Lights" });
  });

  it("keeps the whole title with an unknown artist when the title has no artist", () => {
    expect(read("Theme of the Glass Valley")).toEqual({ artist: "Unknown", title: "Theme of the Glass Valley" });
  });

  it.each([
    "Marlow Finch - Harbor Lights (Official Video) - Requested by dana_k",
    "Marlow Finch - Harbor Lights (Official Video) | requested by dana_k",
    "Marlow Finch - Harbor Lights (Official Video) (requested by dana_k)",
    "Marlow Finch - Harbor Lights (Official Video) [Requested by: dana_k]",
    "Marlow Finch - Harbor Lights (Official Video) requested by @dana_k",
    "Marlow Finch - Harbor Lights (Official Video) • Added by dana_k",
    "Marlow Finch - Harbor Lights (Official Video) | Requester: dana_k",
  ])("ignores a requester added at the end: %s", (line) => {
    expect(read(line)).toEqual({ artist: "Marlow Finch", title: "Harbor Lights" });
  });

  it("does not guess at other text, and does not strip a title that only looks like one", () => {
    // No explicit marker, so a bare name stays with the title: the line's format is Nightbot's to customize.
    expect(read("Marlow Finch - Harbor Lights (Official Video) - dana_k")?.artist).toBe("Marlow Finch");
    // A line that is only a requester note still shows something, not nothing.
    expect(read("Requested by dana_k")).toEqual({ artist: "Unknown", title: "Requested by dana_k" });
  });

  it("has no song for an empty line or one with no words", () => {
    expect(read("")).toBeNull();
    expect(read(" - ")).toBeNull();
    expect(read("(Official Video)")?.title).toBeTruthy();
  });
});

describe("newestTextFile", () => {
  it("is null for a missing folder and an empty one", async () => {
    expect(await newestTextFile(path.join(dir, "no-such-folder"))).toBeNull();
    expect(await newestTextFile(dir)).toBeNull();
  });

  it("picks the .txt changed last and ignores other files and folders", async () => {
    const put = (name: string, ageMs: number) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, "x");
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(f, when, when);
    };
    put("old.txt", 60_000);
    put("new.TXT", 1000);
    put("newest.log", 0);
    fs.mkdirSync(path.join(dir, "newest.txt"));
    expect(await newestTextFile(dir)).toBe(path.join(dir, "new.TXT"));
  });
});

describe("NowPlayingFileSource following a folder (Nightbot)", () => {
  /** Nightbot's files, each written just now or `ageMs` ago. */
  const put = (name: string, sample: string, ageMs = 0) => {
    const f = path.join(dir, name);
    fs.copyFileSync(path.join(SAMPLES, sample), f);
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(f, when, when);
  };
  const folderSource = (folder = dir) => {
    const changes: Array<SSLQueueItem | null> = [];
    const src = new NowPlayingFileSource({ folder, format: "youtube-title" });
    src.onCurrentSongChange((s) => changes.push(s));
    const settle = async () => {
      await src.checkNow();
      await src.checkNow();
    };
    return { src, changes, settle };
  };

  it("reads the newest .txt, and follows it when another file becomes the newest", async () => {
    const { src, changes, settle } = folderSource();
    put("songlist.txt", "youtube-title-next.txt", 5000);
    put("currentsong.txt", "youtube-title.txt", 1000);
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights", artist: "Marlow Finch" });
    put("songlist.txt", "youtube-title-next.txt", 0);
    await settle();
    expect(shown(src)).toMatchObject({ title: "Copper Moon", artist: "Juniper Reyes" });
    expect(changes).toHaveLength(2);
  });

  it("shows no song for an empty folder, a missing folder, or a newest file that has gone stale", async () => {
    const empty = folderSource();
    await empty.settle();
    expect(empty.src.getCurrentSong()).toBeNull();
    expect(empty.changes).toEqual([]);

    const missing = folderSource(path.join(dir, "Nightbot"));
    await missing.settle();
    expect(missing.src.getCurrentSong()).toBeNull();
    expect(missing.src.lastSuccessfulFetchAgeMs()).not.toBeNull();

    const stale = folderSource();
    put("currentsong.txt", "youtube-title.txt", STALE_AFTER_MS + 1000);
    await stale.settle();
    expect(stale.src.getCurrentSong()).toBeNull();
  });

  it("reads a song once the folder appears, and drops it when the files go", async () => {
    const folder = path.join(dir, "Nightbot");
    const { src, changes, settle } = folderSource(folder);
    await settle();
    fs.mkdirSync(folder);
    fs.copyFileSync(path.join(SAMPLES, "youtube-title-requester.txt"), path.join(folder, "currentsong.txt"));
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights", artist: "Marlow Finch" });
    fs.rmSync(path.join(folder, "currentsong.txt"));
    await settle();
    expect(src.getCurrentSong()).toBeNull();
    expect(changes.map((c) => c?.song.title ?? null)).toEqual(["Harbor Lights", null]);
  });

  it("reads a YouTube-style line from a single file, with the requester left off", async () => {
    const { src, settle } = source("youtube-title");
    write("youtube-title-requester.txt");
    await settle();
    expect(shown(src)).toMatchObject({ title: "Harbor Lights", artist: "Marlow Finch" });
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
