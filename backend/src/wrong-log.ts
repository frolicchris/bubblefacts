import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { withoutArtistNote } from "./text";
import { SSLSong } from "./types";

// Every Wrong press as one line, to replay later as a test case (scripts/wrong-cases.mjs)
// Private: this computer only, in the streamer's backups, goes with "Remove my data"
export const WRONG_LOG_FILE = "wrong-log.jsonl";
export const WRONG_LOG_LINES = 500; // lines kept, the newest

export interface WrongLogLine {
  song: { title: string; artist: string; songId?: number; videoId?: string };
  /** The caption the streamer marked wrong */
  caption: string;
  /** Its source label as shown, such as "Wikipedia: Some Game", or null */
  source: string | null;
  /** The article (or STRUCTURED source) blocked for the song, or null */
  article: string | null;
  appVersion: string;
  date: string;
}

const file = () => path.join(config.dataDir, WRONG_LOG_FILE);

/** Adds one line; never throws, as a failed write mustn't stop Wrong */
export function logWrong(song: SSLSong, caption: string, source: string | undefined, article: string | null, now = new Date()): void {
  const line: WrongLogLine = {
    // Without a note after the artist's name (#262): backups carrying this file get shared
    song: { title: song.title, artist: withoutArtistNote(song.artist ?? ""), ...(song.songId !== undefined ? { songId: song.songId } : {}), ...(song.videoId ? { videoId: song.videoId } : {}) },
    caption,
    source: source ?? null,
    article,
    appVersion: process.env.BUBBLEFACTS_VERSION || "unknown",
    date: now.toISOString(),
  };
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const text = JSON.stringify(line) + "\n";
    let old = "";
    try {
      old = fs.readFileSync(file(), "utf8");
    } catch {
      // No log yet
    }
    const lines = old.split("\n").filter(Boolean);
    if (lines.length >= WRONG_LOG_LINES) {
      writeFileAtomic(file(), [...lines.slice(lines.length - WRONG_LOG_LINES + 1), text.trimEnd()].join("\n") + "\n", { mode: 0o600 });
    } else {
      // A line cut short by a crash gets its own line break, so the new one stays whole
      fs.appendFileSync(file(), (old && !old.endsWith("\n") ? "\n" : "") + text, { mode: 0o600 });
    }
  } catch (err) {
    console.warn(`[WrongLog] Could not save ${file()}: ${err instanceof Error ? err.message : err}`);
  }
}
