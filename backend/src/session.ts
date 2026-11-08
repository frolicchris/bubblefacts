import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { Fact, SSLSong } from "./types";

/** What the stream has already seen, kept across a restart so a restart mid-song doesn't repeat bubbles */
export interface Session {
  song: Pick<SSLSong, "title" | "artist">;
  facts: Fact[];
  /** When the facts went out to an overlay; 0 when none was connected */
  shownAt: number;
  recent: string[];
  savedAt: number;
  /** Earlier songs this stream and their facts, newest first, so Wrong works after a song ends */
  earlier?: Array<{ song: SSLSong; facts: Fact[] }>;
  /** Songs with facts since the last credit bubble (credit.ts); absent before the first */
  creditSince?: number;
  /** What that credit said: another AI's doesn't carry over to the built-in one, or back */
  creditText?: string;
  /** Whether OBS was streaming, so a restart mid-stream isn't a stream going live */
  obsStreaming?: boolean;
}

export const RESUME_WITHIN_MS = 20 * 60_000; // ms after the facts went out; a later restart starts the song afresh
export const REMEMBER_FOR_MS = 6 * 60 * 60_000; // ms earlier songs' facts are remembered (one stream)

const file = () => path.join(config.dataDir, "session.json");

export function saveSession(session: Session): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file(), JSON.stringify(session));
  } catch (err) {
    console.warn(`[Server] Couldn't save what was shown: ${err instanceof Error ? err.message : err}`);
  }
}

/** The saved session, or null when there's none, it's unreadable or from an earlier stream */
export function loadSession(now = Date.now()): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(file(), "utf8")) as Session;
    const ok = s && typeof s.song?.title === "string" && Array.isArray(s.facts) && Array.isArray(s.recent)
      && typeof s.savedAt === "number" && typeof s.shownAt === "number"
      && s.facts.every((f) => typeof f?.text === "string" && typeof f.delaySeconds === "number")
      && s.recent.every((r) => typeof r === "string")
      && (s.creditSince === undefined || (Number.isInteger(s.creditSince) && s.creditSince >= 0))
      && (s.creditText === undefined || typeof s.creditText === "string")
      && (s.obsStreaming === undefined || typeof s.obsStreaming === "boolean");
    return ok && now - s.savedAt < REMEMBER_FOR_MS && now >= s.savedAt ? s : null;
  } catch {
    return null;
  }
}

/** Same title and artist, nothing else (`sameSong` in wrong-target.ts also compares ids) */
export const sameRequest = (a: Pick<SSLSong, "title" | "artist"> | null | undefined, b: Pick<SSLSong, "title" | "artist"> | null | undefined) =>
  !!a && !!b && a.title === b.title && (a.artist ?? "") === (b.artist ?? "");

/** The facts still to come, on their remaining delays; all of them when none went out */
export function remainingFacts(facts: Fact[], shownAt: number, now = Date.now()): Fact[] {
  if (!shownAt) return facts;
  const elapsed = (now - shownAt) / 1000;
  return facts.filter((f) => f.delaySeconds > elapsed).map((f) => ({ ...f, delaySeconds: f.delaySeconds - elapsed }));
}

const CATCH_UP_MIN_SECONDS = 2; // seconds left below which a bubble isn't put back on a reloaded overlay

// A bubble's spot, as the overlay compares them: one bubble per spot
const spotOf = (f: Fact) => [f.position.top, f.position.bottom, f.position.left, f.position.right].join("|");

/** What an overlay joining mid-song is sent (#279): bubbles not done showing, on the others' schedule */
export function catchUpFacts(record: Fact[], shownAt: number, now = Date.now()): Fact[] {
  if (!shownAt) return record;
  const elapsed = (now - shownAt) / 1000;
  const started = record.filter((f) => f.delaySeconds <= elapsed);
  const replaced = (f: Fact) => started.some((g) => g !== f && g.delaySeconds > f.delaySeconds && spotOf(g) === spotOf(f));
  return record.flatMap((f) => {
    if (f.delaySeconds > elapsed) return [{ ...f, delaySeconds: f.delaySeconds - elapsed }];
    const left = f.delaySeconds + readingSeconds(f) - elapsed;
    return left >= CATCH_UP_MIN_SECONDS && !replaced(f) ? [{ ...f, delaySeconds: 0, durationSeconds: left }] : [];
  });
}

/**
 * The record plus AI captions arriving after the data facts went out (#256), each `interval` after the last,
 * none sooner than `elapsed` + 1 second. `early`: the data facts sent; a fact sent or taken off never returns
 */
export function withLaterFacts(record: Fact[], early: Fact[], all: Fact[], elapsed: number, interval: number): Fact[] {
  const known = new Set([...record, ...early].map((f) => f.text));
  const later = all.filter((f) => !known.has(f.text));
  const last = record.length ? Math.max(...record.map((f) => f.delaySeconds)) + interval : 0;
  let at = Math.max(elapsed + 1, last);
  return [
    ...record,
    ...later.map((f) => {
      const fact = { ...f, delaySeconds: at };
      at += interval;
      return fact;
    }),
  ];
}

/** Seconds the overlay keeps a bubble up; must match readingSeconds in obs-overlay.js */
export function readingSeconds(fact: Pick<Fact, "text" | "durationSeconds">): number {
  const words = fact.text.split(/\s+/).filter(Boolean).length;
  return Math.max(fact.durationSeconds, 2 + words / 3);
}

const JUST_APPEARED_SECONDS = 1.5; // seconds after a new bubble when a pedal press means the one before, if still up

/**
 * The bubble a hands-free Wrong is for: the one up now, else the last shown. Only bubbles after `since`
 * (the last hands-free Wrong) count, so a held or bouncing pedal can't work back through older ones
 */
export function factOnScreen(facts: Fact[], shownAt: number, now = Date.now(), since = 0): Fact | null {
  if (!shownAt) return null;
  const elapsed = (now - shownAt) / 1000;
  const shown = facts
    .filter((f) => f.delaySeconds <= elapsed && shownAt + f.delaySeconds * 1000 > since)
    .sort((a, b) => a.delaySeconds - b.delaySeconds);
  const latest = shown[shown.length - 1];
  if (!latest) return null;
  const before = shown[shown.length - 2];
  const stillUp = (f: Fact) => elapsed < f.delaySeconds + readingSeconds(f);
  if (before && elapsed - latest.delaySeconds < JUST_APPEARED_SECONDS && stillUp(before)) return before;
  return latest;
}

/** For the dashboard: the bubbles up now (on the overlay's schedule), and seconds until the next when none is */
export function bubbleNow(facts: Fact[], shownAt: number, now = Date.now()): { up: string[]; nextInSeconds: number | null } {
  if (!shownAt) return { up: [], nextInSeconds: null };
  const elapsed = (now - shownAt) / 1000;
  const started = facts.filter((f) => f.delaySeconds <= elapsed);
  const up = started
    .filter((f) => elapsed < f.delaySeconds + readingSeconds(f) && !started.some((g) => g !== f && g.delaySeconds > f.delaySeconds && spotOf(g) === spotOf(f)))
    .map((f) => f.text);
  const later = facts.filter((f) => f.delaySeconds > elapsed).map((f) => f.delaySeconds - elapsed);
  return { up, nextInSeconds: later.length ? Math.ceil(Math.min(...later)) : null };
}
