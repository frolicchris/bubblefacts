import fs from "fs";
import path from "path";
import { config, NOW_PLAYING_PRESETS } from "./config";
import { SongSource } from "./song-source";
import { displayTitle, toSong } from "./song-mapping";
import { SSLQueueItem, SSLSong } from "./types";
import { parseVideoTitle } from "./youtube-title";

/**
 * A text file a now-playing app keeps up to date with the song on now
 * (SONG_SOURCE=nowplaying): Streamling, Nightbot, or any app that writes one line.
 * Polled, because file watching is unreliable across folders that sync or
 * sit on other drives, and a 2-second look at one small file costs nothing.
 *
 * The file is the only word on what's playing, so the rules lean toward
 * showing nothing: an empty or missing file, a line with no words, or a file
 * nobody has rewritten for STALE_AFTER_MS (left over from an earlier stream,
 * or a player that stopped without clearing it) all mean no song.
 */

export type NowPlayingFormat = "artist-title" | "title" | "youtube-title";

const POLL_MS = 2000;
/** Longer than nearly any song: a line older than this is left over, not playing. */
export const STALE_AFTER_MS = 15 * 60_000;
/** One song's line is short; a larger file is read only this far. */
const MAX_BYTES = 4096;

export interface NowPlayingLine {
  title: string;
  artist: string;
}

/** The file's bytes as text: UTF-8, or UTF-16 with its byte order mark, as some Windows apps write. */
export function decodeNowPlaying(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8").replace(/^﻿/, "");
}

/**
 * A requester a now-playing app may add after a YouTube title ("... - Requested
 * by dana_k", "(added by dana_k)", "| requester: dana_k"). Only an explicit
 * "requested/added/queued/submitted/suggested by" or "requester:" at the end
 * counts: the format of the line is Nightbot's to customize, so nothing else
 * is guessed. The line has had its runs of spaces collapsed, so single spaces will do.
 */
const REQUESTER_TAIL = / ?(?:[-–—|•·~] |[(\[{] ?)?(?:\b(?:request(?:ed)?|added|queued|submitted|suggested) by\b|\brequester ?:)[^)\]}]*[)\]}]?$/i;

/**
 * The song in the file's first non-empty line, or null for none. "artist-title"
 * splits at the first spaced dash, so a dash later belongs to the title
 * ("Artist - Song - Part 2"); a line without one is all title. "youtube-title"
 * reads the line as a YouTube video's title ("Artist - Song (Official Video)")
 * the way StreamElements requests are read. A line with no letters or digits
 * (" - " from an app's template with nothing playing) is no song.
 */
export function parseNowPlaying(text: string, format: NowPlayingFormat): NowPlayingLine | null {
  const line = text
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (format === "youtube-title") {
    const video = line.replace(REQUESTER_TAIL, "").trim() || line;
    const parsed = parseVideoTitle(video);
    if (!/[\p{L}\p{N}]/u.test(parsed.title)) return null;
    return { title: parsed.title, artist: /[\p{L}\p{N}]/u.test(parsed.artist) ? parsed.artist : "Unknown" };
  }
  if (format === "artist-title") {
    const at = line.indexOf(" - ");
    const artist = at > 0 ? line.slice(0, at).trim() : "";
    const title = at > 0 ? line.slice(at + 3).trim() : "";
    if (/[\p{L}\p{N}]/u.test(artist) && /[\p{L}\p{N}]/u.test(title)) return { title, artist };
  }
  return { title: line, artist: "Unknown" };
}

/**
 * The most recently changed .txt file in a folder, or null for a missing or empty
 * folder. Looked up on every check, so a new file takes over as soon as the app
 * starts writing it; the folder holds a handful of files, so this stays cheap.
 */
export async function newestTextFile(folder: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await fs.promises.readdir(folder, { withFileTypes: true })).filter((e) => !e.isDirectory() && /\.txt$/i.test(e.name)).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names.sort()) {
    const file = path.join(folder, name);
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { file, mtime: stat.mtimeMs };
    } catch {
      // Removed between the listing and now: it isn't a candidate.
    }
  }
  return best?.file ?? null;
}

export interface NowPlayingOptions {
  file?: string;
  /** Follow the newest .txt in this folder instead of one file. */
  folder?: string;
  format?: NowPlayingFormat;
  /** Tests only: a shorter wait between checks. */
  pollMs?: number;
}

export class NowPlayingFileSource implements SongSource {
  readonly name: string;
  private readonly file: string;
  /** Set when the newest .txt in a folder is the song (the Nightbot preset); `file` is empty then. */
  private readonly folder: string;
  private readonly format: NowPlayingFormat;
  private readonly pollMs: number;
  private currentSong: SSLQueueItem | null = null;
  /** The line being followed (null: no song). */
  private currentKey: string | null = null;
  /** What the last check read, which the next one must agree with; undefined before the first. */
  private candidate: string | null | undefined = undefined;
  private onSongChange: ((current: SSLQueueItem | null) => void) | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastSuccessfulFetchAt: number | null = null;
  private stopped = false;
  /** The last state logged ("missing", "stale", an error), so a quiet file isn't logged every 2 seconds. */
  private lastNote = "";

  constructor(options: NowPlayingOptions = {}) {
    this.file = options.file ?? config.nowPlayingFile;
    this.folder = options.folder ?? (options.file === undefined ? config.nowPlayingFolder ?? "" : "");
    this.format = options.format ?? config.nowPlayingFormat;
    this.pollMs = options.pollMs ?? POLL_MS;
    this.name = config.nowPlayingPreset === "none" ? "Now playing file" : NOW_PLAYING_PRESETS[config.nowPlayingPreset].name;
  }

  onCurrentSongChange(callback: (current: SSLQueueItem | null) => void): void {
    this.onSongChange = callback;
  }

  getCurrentSong(): SSLQueueItem | null {
    return this.currentSong;
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  pollIntervalMs(): number {
    return this.pollMs;
  }

  /** Polling only. */
  isEventStreamConnected(): boolean {
    return false;
  }

  /** There's no token to turn down. */
  authRejected(): boolean {
    return false;
  }

  /** A line with no artist is marked, so its artist may be looked up by the title alone. */
  toSong(item: SSLQueueItem): SSLSong {
    const song = toSong(item);
    return /^unknown$/i.test(song.artist) ? { ...song, titleOnly: true } : song;
  }

  displayTitle(item: SSLQueueItem): string {
    return displayTitle(item);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    // The file name only: the full path holds the computer's user name, and logs can end up on stream.
    const what = this.folder ? `the newest .txt in "${path.basename(this.folder)}"` : `"${path.basename(this.file)}"`;
    const how = { title: "title only", "artist-title": "Artist - Title", "youtube-title": "YouTube title" }[this.format];
    console.log(`[NowPlaying] Reading ${what} every ${this.pollMs / 1000} s (${how})`);
    this.schedulePoll();
    await this.checkNow();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /**
   * The song as the queue entry the fact pipeline reads. A file says nothing
   * about who asked or how long the song is, so, as with a StreamElements
   * request without them, those fields stay empty and no facts use them.
   */
  static toEntry(line: NowPlayingLine): SSLQueueItem {
    return {
      id: 0,
      songId: null,
      song: { title: line.title, artist: line.artist, durationSeconds: null },
      nonlistSong: null,
      note: null,
      streamerId: 0,
      createdAt: "",
      requests: null,
    };
  }

  /** One look at the file. Public so tests can step through without waiting on the timer. */
  checkNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let key: string | null;
      try {
        key = await this.readLine();
        this.lastSuccessfulFetchAt = Date.now();
      } catch (err) {
        // An unreadable file can't say a song is still on, so it ends the song too.
        const message = err instanceof Error ? err.message : String(err);
        this.note(`error: ${message}`, () => console.error(`[NowPlaying] Can't read the file: ${message}`));
        key = null;
      }
      this.apply(key);
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The cleaned first line, or null when the file says nothing is playing. */
  private async readLine(): Promise<string | null> {
    let file = this.file;
    if (this.folder) {
      const newest = await newestTextFile(this.folder);
      if (!newest) {
        // No folder yet (the app may not be installed or run), or nothing written in it. Checked fine, just no song.
        this.note("missing", () => console.warn(`[NowPlaying] No .txt file in "${path.basename(this.folder)}" yet; no song until there is`));
        return null;
      }
      file = newest;
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // Not written yet: the app may not have started. Checked fine, just no song.
      this.note("missing", () => console.warn(`[NowPlaying] "${path.basename(file)}" isn't there yet; no song until it is`));
      return null;
    }
    if (!stat.isFile()) throw new Error(`"${path.basename(file)}" is a folder, not a file. NOW_PLAYING_FILE names the file itself.`);
    if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
      this.note("stale", () => console.log(`[NowPlaying] "${path.basename(file)}" hasn't changed in ${STALE_AFTER_MS / 60_000} minutes; no song until it does`));
      return null;
    }
    const handle = await fs.promises.open(file, "r");
    let bytes: Buffer;
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    this.note("", () => undefined);
    const line = parseNowPlaying(decodeNowPlaying(bytes), this.format);
    return line && `${line.artist}\0${line.title}`;
  }

  /**
   * A new reading counts once two checks in a row agree: an app rewriting the
   * file can leave it empty or half-written for a moment, and that blink
   * mustn't restart the bubbles. The same line again is the same song, even if
   * the app rewrote the file, so a song played twice in a row shows once.
   */
  private apply(key: string | null): void {
    if (key !== this.candidate) {
      this.candidate = key;
      return;
    }
    if (key === this.currentKey) return;
    const [artist, title] = key === null ? [] : key.split("\0");
    const entry = key === null ? null : NowPlayingFileSource.toEntry({ artist, title });
    console.log(
      `[NowPlaying] Song changed: "${this.currentSong ? this.displayTitle(this.currentSong) : "none"}" -> ` +
        `"${entry ? this.displayTitle(entry) : "none"}"`
    );
    this.currentKey = key;
    this.currentSong = entry;
    this.onSongChange?.(entry);
  }

  /** Logs a change of state once, not on every check. */
  private note(state: string, log: () => void): void {
    if (state === this.lastNote) return;
    this.lastNote = state;
    if (state) log();
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      if (this.stopped) return;
      await this.checkNow();
      if (!this.stopped) this.schedulePoll();
    }, this.pollMs);
  }
}
