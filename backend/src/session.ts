import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
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
  /** Earlier songs this stream and their facts, newest first, so Wrong works after a song ends. */
  earlier?: Array<{ song: SSLSong; facts: Fact[] }>;
  /** Songs with facts since the credit bubble last went out (credit.ts). Absent before it first has. */
  creditSince?: number;
}

/** A restart this long after the facts went out starts the song afresh: it's another day's stream. */
export const RESUME_WITHIN_MS = 20 * 60_000;
/** Earlier songs' facts are remembered for one stream, not forever. */
export const REMEMBER_FOR_MS = 6 * 60 * 60_000;

const file = () => path.join(config.dataDir, "session.json");

export function saveSession(session: Session): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    writeFileAtomic(file(), JSON.stringify(session));
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
      && s.recent.every((r) => typeof r === "string")
      && (s.creditSince === undefined || (Number.isInteger(s.creditSince) && s.creditSince >= 0));
    return ok && now - s.savedAt < REMEMBER_FOR_MS && now >= s.savedAt ? s : null;
  } catch {
    return null;
  }
}

/**
 * Two requests for the same song: the same title and artist, nothing else.
 * `sameSong` in wrong-target.ts also compares the song and video ids.
 */
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

/** A bubble with less time than this left isn't worth putting back on a reloaded overlay. */
const CATCH_UP_MIN_SECONDS = 2;

/** Where a bubble goes, as the overlay compares spots: one bubble per spot. */
const spotOf = (f: Fact) => [f.position.top, f.position.bottom, f.position.left, f.position.right].join("|");

/**
 * What an overlay that connects or reloads mid-song is sent (issue #279): the song's bubbles
 * that haven't finished showing, on the schedule the other overlays are on. The ones still to
 * come keep their remaining delays. The one on screen now comes back at once for the time it
 * has left (or its reading time, if longer), unless a later bubble already took its spot. A
 * bubble whose time is up never comes back, and nor does one taken off with Wrong, since
 * `record` no longer has it. All of them, from the start, when none went out yet.
 */
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
 * A song's record once its AI captions arrive, after its facts from data went out early
 * (issue #256). `record`: what was sent, delays counted from when it went out, without any
 * fact taken off with Wrong since. `early`: the facts from data as the generator gave them;
 * `all`: its full list, those first. The captions are added in order, each `interval` after
 * the last fact and never before `elapsed` (now, in seconds since the record went out) plus a
 * second. A fact already in the record, or taken off with Wrong, is never added again.
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

/**
 * How long the overlay keeps a bubble up: its own time, or longer for a long
 * fact. Must match readingSeconds in obs-overlay.js.
 */
export function readingSeconds(fact: Pick<Fact, "text" | "durationSeconds">): number {
  const words = fact.text.split(/\s+/).filter(Boolean).length;
  return Math.max(fact.durationSeconds, 2 + words / 3);
}

/** A pedal press this soon after a new bubble pops up was meant for the one before it, if that one is still up. */
const JUST_APPEARED_SECONDS = 1.5;

/**
 * The bubble a hands-free Wrong is for: the one on stream now, or when none
 * is up, the one shown last. Null when none has gone out yet. Delays count
 * from `shownAt`, as in the overlay. Only bubbles that appeared after `since`
 * (the last hands-free Wrong) count, so a held, bouncing or repeated pedal
 * press can't work back through older bubbles nobody objected to.
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

/**
 * What the overlay is showing now, for the dashboard: the texts of the bubbles up, and how many
 * seconds until the next one when none is. Same schedule as the overlay (delays count from
 * `shownAt`, a bubble stays its reading time, a later bubble in the same spot replaces it).
 * Nothing is up before the facts went out (`shownAt` 0).
 */
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
