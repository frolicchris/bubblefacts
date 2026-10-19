import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { SSLSong } from "./types";

/**
 * Every Wrong press, kept as one line in `wrong-log.jsonl` in the data
 * folder, so each one can be replayed later as a test case
 * (`scripts/wrong-cases.mjs`). Private: it stays on this computer, is part of
 * the streamer's backups and goes with "Remove my data". The newest
 * `WRONG_LOG_LINES` lines are kept.
 */
export const WRONG_LOG_FILE = "wrong-log.jsonl";
export const WRONG_LOG_LINES = 500;

export interface WrongLogLine {
  song: { title: string; artist: string; songId?: number; videoId?: string };
  /** The caption the streamer marked wrong. */
  caption: string;
  /** Its source label as shown, such as "Wikipedia: Some Game", or null when it had none. */
  source: string | null;
  /** The article (or STRUCTURED source) that was blocked for the song, or null when nothing was. */
  article: string | null;
  appVersion: string;
  date: string;
}

const file = () => path.join(config.dataDir, WRONG_LOG_FILE);

/** Add one line. Never throws: a log that can't be written mustn't stop Wrong. */
export function logWrong(song: SSLSong, caption: string, source: string | undefined, article: string | null, now = new Date()): void {
  const line: WrongLogLine = {
    song: { title: song.title, artist: song.artist, ...(song.songId !== undefined ? { songId: song.songId } : {}), ...(song.videoId ? { videoId: song.videoId } : {}) },
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
      // No log yet.
    }
    const lines = old.split("\n").filter(Boolean);
    if (lines.length >= WRONG_LOG_LINES) {
      writeFileAtomic(file(), [...lines.slice(lines.length - WRONG_LOG_LINES + 1), text.trimEnd()].join("\n") + "\n", { mode: 0o600 });
    } else {
      // A line cut short by a crash gets its own line break, so the new one stays whole.
      fs.appendFileSync(file(), (old && !old.endsWith("\n") ? "\n" : "") + text, { mode: 0o600 });
    }
  } catch (err) {
    console.warn(`[WrongLog] Could not save ${file()}: ${err instanceof Error ? err.message : err}`);
  }
}
