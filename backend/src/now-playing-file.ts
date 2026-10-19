import fs from "fs";
import path from "path";
import { config, NOW_PLAYING_PRESETS } from "./config";
import { SongSource } from "./song-source";
import { SongListClient } from "./songlist-client";
import { SSLQueueItem, SSLSong } from "./types";

/**
 * A text file a now-playing app keeps up to date with the song on now
 * (SONG_SOURCE=nowplaying): Streamling, or any app that writes one line.
 * Polled, because file watching is unreliable across folders that sync or
 * sit on other drives, and a 2-second look at one small file costs nothing.
 *
 * The file is the only word on what's playing, so the rules lean toward
 * showing nothing: an empty or missing file, a line with no words, or a file
 * nobody has rewritten for STALE_AFTER_MS (left over from an earlier stream,
 * or a player that stopped without clearing it) all mean no song.
 */

export type NowPlayingFormat = "artist-title" | "title";

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
 * The song in the file's first non-empty line, or null for none. "artist-title"
 * splits at the first spaced dash, so a dash later belongs to the title
 * ("Artist - Song - Part 2"); a line without one is all title. A line with no
 * letters or digits (" - " from an app's template with nothing playing) is no song.
 */
export function parseNowPlaying(text: string, format: NowPlayingFormat): NowPlayingLine | null {
  const line = text
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line || !/[\p{L}\p{N}]/u.test(line)) return null;
  if (format === "artist-title") {
    const at = line.indexOf(" - ");
    const artist = at > 0 ? line.slice(0, at).trim() : "";
    const title = at > 0 ? line.slice(at + 3).trim() : "";
    if (/[\p{L}\p{N}]/u.test(artist) && /[\p{L}\p{N}]/u.test(title)) return { title, artist };
  }
  return { title: line, artist: "Unknown" };
}

export interface NowPlayingOptions {
  file?: string;
  format?: NowPlayingFormat;
  /** Tests only: a shorter wait between checks. */
  pollMs?: number;
}

export class NowPlayingFileSource implements SongSource {
  readonly name: string;
  private readonly file: string;
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

  toSong(item: SSLQueueItem): SSLSong {
    return SongListClient.toSong(item);
  }

  displayTitle(item: SSLQueueItem): string {
    return SongListClient.displayTitle(item);
  }

  async connect(): Promise<void> {
    this.stopped = false;
    // The file name only: the full path holds the computer's user name, and logs can end up on stream.
    console.log(`[NowPlaying] Reading "${path.basename(this.file)}" every ${this.pollMs / 1000} s (${this.format === "title" ? "title only" : "Artist - Title"})`);
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
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(this.file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // Not written yet: the app may not have started. Checked fine, just no song.
      this.note("missing", () => console.warn(`[NowPlaying] "${path.basename(this.file)}" isn't there yet; no song until it is`));
      return null;
    }
    if (!stat.isFile()) throw new Error(`"${path.basename(this.file)}" is a folder, not a file. NOW_PLAYING_FILE names the file itself.`);
    if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
      this.note("stale", () => console.log(`[NowPlaying] "${path.basename(this.file)}" hasn't changed in ${STALE_AFTER_MS / 60_000} minutes; no song until it does`));
      return null;
    }
    const handle = await fs.promises.open(this.file, "r");
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
