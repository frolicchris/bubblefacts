import fs from "fs";
import path from "path";
import { config, NOW_PLAYING_PRESETS } from "./config";
import { SongSource } from "./song-source";
import { displayTitle, toSong } from "./song-mapping";
import { SSLQueueItem, SSLSong } from "./types";
import { parseVideoTitle } from "./youtube-title";
import { settleTitleOrder } from "./musicbrainz";

// The song on now from a text file an app keeps up to date (SONG_SOURCE=nowplaying): Streamling, Nightbot, any one-line writer
// Polled, not watched; the file is the only word, so doubt means no song (ARCHITECTURE.md: Song sources and YouTube titles)

export type NowPlayingFormat = "artist-title" | "title" | "youtube-title";

const POLL_MS = 2000; // ms between checks
export const STALE_AFTER_MS = 15 * 60_000; // ms unchanged before the line counts as left over; longer than nearly any song
const MAX_BYTES = 4096; // bytes read from the start of the file; one line is short

export interface NowPlayingLine {
  title: string;
  artist: string;
}

/** The file's bytes as text: UTF-8, or UTF-16 with a byte order mark (some Windows apps) */
export function decodeNowPlaying(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  return bytes.toString("utf8").replace(/^﻿/, "");
}

// A requester after a YouTube title ("... - Requested by dana_k", "| requester: dana_k"): only these explicit
// words at the end, as the line is Nightbot's to customize. Spaces are already collapsed, so single ones do
const REQUESTER_TAIL = / ?(?:[-–—|•·~] |[(\[{] ?)?(?:\b(?:request(?:ed)?|added|queued|submitted|suggested) by\b|\brequester ?:)[^)\]}]*[)\]}]?$/i;

/** The song in the first non-empty line, or null; "artist-title" splits at the first spaced dash */
export function parseNowPlaying(text: string, format: NowPlayingFormat): NowPlayingLine | null {
  const read = readNowPlaying(text, format);
  return read && { title: read.title, artist: read.artist };
}

/** `parseNowPlaying`, also saying when a YouTube title's order is unsure (see `settleTitleOrder`) */
function readNowPlaying(text: string, format: NowPlayingFormat): (NowPlayingLine & { orderUnsure?: boolean }) | null {
  const line = text
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (format === "youtube-title") {
    const video = line.replace(REQUESTER_TAIL, "").trim() || line;
    const parsed = parseVideoTitle(video);
    if (!/[\p{L}\p{N}]/u.test(parsed.title)) return null;
    return { title: parsed.title, artist: /[\p{L}\p{N}]/u.test(parsed.artist) ? parsed.artist : "Unknown", ...(parsed.orderUnsure ? { orderUnsure: true } : {}) };
  }
  if (format === "artist-title") {
    const at = line.indexOf(" - ");
    const artist = at > 0 ? line.slice(0, at).trim() : "";
    const title = at > 0 ? line.slice(at + 3).trim() : "";
    if (/[\p{L}\p{N}]/u.test(artist) && /[\p{L}\p{N}]/u.test(title)) return { title, artist };
  }
  return { title: line, artist: "Unknown" };
}

/** The most recently changed .txt in a folder, or null; looked up every check, so a new file takes over at once */
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
      // Removed since the listing: not a candidate
    }
  }
  return best?.file ?? null;
}

export interface NowPlayingOptions {
  file?: string;
  /** Follow the newest .txt in this folder instead of one file */
  folder?: string;
  format?: NowPlayingFormat;
  /** Tests only: ms between checks */
  pollMs?: number;
}

export class NowPlayingFileSource implements SongSource {
  readonly name: string;
  private readonly file: string;
  /** Set when the newest .txt in a folder is the song (Nightbot preset); `file` is empty then */
  private readonly folder: string;
  private readonly format: NowPlayingFormat;
  private readonly pollMs: number;
  private currentSong: SSLQueueItem | null = null;
  /** The line being followed (null: no song) */
  private currentKey: string | null = null;
  /** What the last check read, for the next to agree with; undefined before the first */
  private candidate: string | null | undefined = undefined;
  private onSongChange: ((current: SSLQueueItem | null) => void) | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private lastSuccessfulFetchAt: number | null = null;
  private lastPollAttemptAt: number | null = null;
  private stopped = false;
  /** Last state logged ("missing", "stale", an error), so a quiet file isn't logged every check */
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

  lastPollAttemptAgeMs(): number | null {
    return this.lastPollAttemptAt === null ? null : Date.now() - this.lastPollAttemptAt;
  }

  lastSuccessfulFetchAgeMs(): number | null {
    return this.lastSuccessfulFetchAt === null ? null : Date.now() - this.lastSuccessfulFetchAt;
  }

  pollIntervalMs(): number {
    return this.pollMs;
  }

  /** Polling only */
  isEventStreamConnected(): boolean {
    return false;
  }

  /** No token to turn down */
  authRejected(): boolean {
    return false;
  }

  /** A line with no artist is marked, so its artist may be looked up by title alone */
  toSong(item: SSLQueueItem): SSLSong {
    const song = toSong(item);
    return /^unknown$/i.test(song.artist) ? { ...song, titleOnly: true } : song;
  }

  displayTitle(item: SSLQueueItem): string {
    return displayTitle(item);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    // File name only: the path holds the computer's user name, and logs can end up on stream
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

  /** The song as a queue entry; no requester or length, so no facts use them */
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

  /** One look at the file; public so tests can step without the timer */
  checkNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let key: string | null;
      try {
        key = await this.readLine();
        this.lastSuccessfulFetchAt = Date.now();
      } catch (err) {
        // An unreadable file can't say a song is still on, so it ends the song too
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

  /** The cleaned first line, or null when nothing is playing */
  private async readLine(): Promise<string | null> {
    let file = this.file;
    if (this.folder) {
      const newest = await newestTextFile(this.folder);
      if (!newest) {
        // No folder yet (app not installed or run), or nothing in it: checked fine, just no song
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
      // Not written yet (app not started): checked fine, just no song
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
    // "X - Y" with no channel: MusicBrainz may say which side is the artist (cached, so the next check agrees)
    const read = readNowPlaying(decodeNowPlaying(bytes), this.format);
    const line = read && (await settleTitleOrder(read));
    return line && `${line.artist}\0${line.title}`;
  }

  /** A reading counts once two checks agree (a mid-rewrite blink mustn't restart bubbles); the same line is the same song */
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

  /** Logs a change of state once, not every check */
  private note(state: string, log: () => void): void {
    if (state === this.lastNote) return;
    this.lastNote = state;
    if (state) log();
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.lastPollAttemptAt ??= Date.now();
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      if (this.stopped) return;
      this.lastPollAttemptAt = Date.now();
      await this.checkNow();
      if (!this.stopped) this.schedulePoll();
    }, this.pollMs);
  }
}
