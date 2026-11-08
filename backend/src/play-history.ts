import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { SSLSong } from "./types";
import { songKey } from "./wrong-facts";

// Songs seen on stream, to prepare after it (#297; ARCHITECTURE.md: Prepared songs): the song, plays and when,
// never who asked. Private: this computer only, owner-readable, goes with "Remove my data"
export const PLAY_HISTORY_FILE = "play-history.json";
export const PLAY_HISTORY_KEPT = 5000; // songs kept, the latest played: a few years of streams for most
const SAME_PLAY_MS = 10 * 60_000; // ms within which a song seen again is the same play

export interface PlayedSong {
  song: SSLSong;
  plays: number;
  /** When it last played, as an ISO date */
  lastAt: string;
}

/** What identifies the song and how to look it up, never who asked */
function kept(song: SSLSong): SSLSong {
  const out: SSLSong = { title: song.title, artist: song.artist ?? "" };
  if (song.songId) out.songId = song.songId;
  if (song.videoId) out.videoId = song.videoId;
  for (const flag of ["liveLearn", "performer", "artistUncertain", "titleOnly"] as const) if (song[flag]) out[flag] = true;
  return out;
}

const isPlayed = (e: unknown): e is PlayedSong => {
  const p = e as PlayedSong;
  return !!p && !!p.song && typeof p.song.title === "string" && typeof p.song.artist === "string" && typeof p.plays === "number" && typeof p.lastAt === "string";
};

export class PlayHistory {
  private songs: Record<string, PlayedSong> | null = null;

  constructor(
    private readonly file = () => path.join(config.dataDir, PLAY_HISTORY_FILE),
    private readonly max = PLAY_HISTORY_KEPT
  ) {}

  /** A song started on stream; never throws, as a failed write mustn't stop the bubbles */
  record(song: SSLSong, now = new Date()): void {
    if (!song.title?.trim()) return;
    const s = this.load();
    const key = songKey(song);
    // Again within minutes is the same play: resumed after a pause, or a restart mid-song
    if (s[key] && now.getTime() - Date.parse(s[key].lastAt) < SAME_PLAY_MS) return;
    s[key] = { song: kept(song), plays: (s[key]?.plays ?? 0) + 1, lastAt: now.toISOString() };
    const keys = Object.keys(s);
    if (keys.length > this.max) {
      for (const k of keys.sort((a, b) => s[a].lastAt.localeCompare(s[b].lastAt)).slice(0, keys.length - this.max)) delete s[k];
    }
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      writeFileAtomic(this.file(), JSON.stringify({ version: 1, songs: s }), { mode: 0o600 });
    } catch (err) {
      console.warn(`[History] Could not save ${PLAY_HISTORY_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Every song seen on stream, by its song key */
  all(): Readonly<Record<string, PlayedSong>> {
    return this.load();
  }

  private load(): Record<string, PlayedSong> {
    if (this.songs) return this.songs;
    this.songs = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as { version?: number; songs?: Record<string, unknown> };
      if (raw?.version === 1 && raw.songs && typeof raw.songs === "object") {
        for (const [k, e] of Object.entries(raw.songs)) if (isPlayed(e)) this.songs[k] = { song: kept(e.song), plays: e.plays, lastAt: e.lastAt };
      }
    } catch {
      // None yet, or unreadable: start a new one
    }
    return this.songs;
  }
}

export const playHistory = new PlayHistory();
