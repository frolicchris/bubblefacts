import fs from "fs";
import path from "path";
import { config } from "./config";
import { Fact, SSLSong } from "./types";

/**
 * What the stream has already seen, kept across a restart: the song that was
 * showing, its facts and when they went out, and the recent facts of earlier
 * songs. Without it a restart mid-song showed the same bubbles again.
 */
export interface Session {
  song: Pick<SSLSong, "title" | "artist">;
  facts: Fact[];
  /** When the facts went out to an overlay; 0 when none was connected. */
  shownAt: number;
  recent: string[];
  savedAt: number;
}

/** A restart this long after the facts went out starts the song afresh: it's another day's stream. */
export const RESUME_WITHIN_MS = 20 * 60_000;
/** Earlier songs' facts are remembered for one stream, not forever. */
export const REMEMBER_FOR_MS = 6 * 60 * 60_000;

const file = () => path.join(config.dataDir, "session.json");

export function saveSession(session: Session): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(session));
  } catch (err) {
    console.warn(`[Server] Couldn't save what was shown: ${err instanceof Error ? err.message : err}`);
  }
}

/** The saved session, or null when there is none, it's unreadable, or it's from an earlier stream. */
export function loadSession(now = Date.now()): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8")) as Session;
    const ok = s && typeof s.song?.title === "string" && Array.isArray(s.facts) && Array.isArray(s.recent)
      && typeof s.savedAt === "number" && typeof s.shownAt === "number"
      && s.facts.every((f) => typeof f?.text === "string" && typeof f.delaySeconds === "number")
      && s.recent.every((r) => typeof r === "string");
    return ok && now - s.savedAt < REMEMBER_FOR_MS && now >= s.savedAt ? s : null;
  } catch {
    return null;
  }
}

export const sameRequest = (a: Pick<SSLSong, "title" | "artist"> | null | undefined, b: Pick<SSLSong, "title" | "artist"> | null | undefined) =>
  !!a && !!b && a.title === b.title && (a.artist ?? "") === (b.artist ?? "");

/**
 * The facts still to come, on their remaining delays, for an overlay joining
 * `shownAt` after they first went out. All of them when they never went out.
 */
export function remainingFacts(facts: Fact[], shownAt: number, now = Date.now()): Fact[] {
  if (!shownAt) return facts;
  const elapsed = (now - shownAt) / 1000;
  return facts.filter((f) => f.delaySeconds > elapsed).map((f) => ({ ...f, delaySeconds: f.delaySeconds - elapsed }));
}
