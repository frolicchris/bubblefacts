import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";

/**
 * Prepared facts (issue #292): each song's facts, written ahead of time by the
 * same pipeline as on stream and kept in `prepared-facts.json` in the data
 * folder, so a prepared song shows its facts at once and a restart keeps them.
 * Private like the rest of the data folder: it stays on this computer, is
 * written whole and atomically, readable only by the streamer's account, and
 * goes with "Remove my data".
 *
 * An entry is redone when the rules change (`PREPARED_RULES_VERSION`), when
 * its article has a newer settled version (the preparer checks), or after
 * `PREPARED_MAX_AGE_MS`. It only ever holds facts from a source; the
 * streamer's own facts, song-list facts and custom facts are built when the
 * song plays, as before.
 */
export const PREPARED_FILE = "prepared-facts.json";

/**
 * Raise whenever a change to the pipeline (the prompt, screening, ranking, the
 * content standard, which sources are read) would write different facts:
 * every saved entry is then prepared again, and none is shown meanwhile.
 */
export const PREPARED_RULES_VERSION = 1;

/** A prepared song is prepared again after this long, whatever else changed. */
export const PREPARED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** One prepared fact: what the dashboard needs to label it and what Wrong needs to block its source. */
export interface PreparedFact {
  text: string;
  source?: string;
  url?: string;
  evidence?: string;
  /** A companion article's fact: the article it was found through (issue #48). */
  via?: string;
}

/**
 * How preparing a song turned out:
 * - "facts": facts from a source, in `facts`;
 * - "none": no source knows the song (it shows the streamer's custom facts, or nothing);
 * - "own": nothing to prepare (the streamer's own facts for it, their original, facts off,
 *   not music); counted as ready;
 * - "live": only found while it plays (a Twitch About), so it's looked up then.
 */
export type PreparedOutcome = "facts" | "none" | "own" | "live";

export interface PreparedEntry {
  /** The song as it was prepared, by its songKey. */
  title: string;
  artist: string;
  outcome: PreparedOutcome;
  facts: PreparedFact[];
  /** The Wikipedia article the facts came from, or "" when none. */
  article: string;
  /** That article's settled revision (the version read), or 0 when unknown. */
  revision: number;
  rules: number;
  /** Which model wrote the captions, "" when no AI was asked. */
  model: string;
  /** When it was prepared, and when its article was last checked for a newer version (ISO dates). */
  preparedAt: string;
  checkedAt: string;
}

/** The preparer's measurements on this computer, for the coverage report's finish date (issue #294). */
export interface PreparedPace {
  /** How long each of the most recent songs took, in ms. */
  recentMs: number[];
  /** Time spent preparing per local day ("2026-11-02"), in ms, the last two weeks. */
  activeByDay: Record<string, number>;
}

interface StoreFile {
  version: 1;
  rules: number;
  songs: Record<string, PreparedEntry>;
  pace?: PreparedPace;
}

const OUTCOMES: ReadonlySet<string> = new Set(["facts", "none", "own", "live"]);

const isFact = (f: unknown): f is PreparedFact => {
  const x = f as PreparedFact;
  return !!x && typeof x.text === "string" && ["source", "url", "evidence", "via"].every((k) => x[k as keyof PreparedFact] === undefined || typeof x[k as keyof PreparedFact] === "string");
};

const isEntry = (e: unknown): e is PreparedEntry => {
  const x = e as PreparedEntry;
  return !!x && typeof x.title === "string" && typeof x.artist === "string" && OUTCOMES.has(x.outcome) && Array.isArray(x.facts) && x.facts.every(isFact)
    && typeof x.article === "string" && typeof x.revision === "number" && typeof x.rules === "number" && typeof x.model === "string"
    && typeof x.preparedAt === "string" && typeof x.checkedAt === "string";
};

/** Whether an entry may still be used as it is: written under today's rules and not too old. */
export function isCurrent(entry: PreparedEntry, now = Date.now()): boolean {
  const at = Date.parse(entry.preparedAt);
  return entry.rules === PREPARED_RULES_VERSION && Number.isFinite(at) && now - at < PREPARED_MAX_AGE_MS && now >= at - 60_000;
}

export class PreparedStore {
  private songs: Record<string, PreparedEntry> = {};
  private pace: PreparedPace = { recentMs: [], activeByDay: {} };
  private loaded = false;

  constructor(private readonly file = () => path.join(config.dataDir, PREPARED_FILE)) {}

  /** The usable entry for a song key: current, with facts or not. Undefined when none. */
  get(key: string, now = Date.now()): PreparedEntry | undefined {
    const e = this.load()[key];
    return e && isCurrent(e, now) ? e : undefined;
  }

  /** Any saved entry for the key, current or not. */
  saved(key: string): PreparedEntry | undefined {
    return this.load()[key];
  }

  /** Every saved entry, by song key. */
  all(): Readonly<Record<string, PreparedEntry>> {
    return this.load();
  }

  /** Save a song, and with `pace` how long it took, in one write: the file is rewritten whole each time. */
  put(key: string, entry: PreparedEntry, pace?: { ms: number; activeMs: number; day: string }): void {
    this.load()[key] = entry;
    if (pace) this.notePace(pace.ms, pace.activeMs, pace.day);
    this.save();
  }

  /** Forget a song's prepared facts (Wrong on one of them): it's prepared again later. */
  remove(key: string): boolean {
    const s = this.load();
    if (!(key in s)) return false;
    delete s[key];
    this.save();
    return true;
  }

  /** Its article was checked and is unchanged. */
  checked(key: string, at: string): void {
    const e = this.load()[key];
    if (!e) return;
    e.checkedAt = at;
    this.save();
  }

  getPace(): PreparedPace {
    this.load();
    return this.pace;
  }

  /** One song took `ms`; the time preparing today grows by `activeMs`. */
  addPace(ms: number, activeMs: number, day: string, keep = 50): void {
    this.load();
    this.notePace(ms, activeMs, day, keep);
    this.save();
  }

  private notePace(ms: number, activeMs: number, day: string, keep = 50): void {
    if (ms > 0) this.pace.recentMs = [...this.pace.recentMs, ms].slice(-keep);
    if (activeMs > 0) {
      this.pace.activeByDay[day] = (this.pace.activeByDay[day] ?? 0) + activeMs;
      const days = Object.keys(this.pace.activeByDay).sort();
      for (const d of days.slice(0, Math.max(0, days.length - 14))) delete this.pace.activeByDay[d];
    }
  }

  /** For tests: read the file again. */
  reload(): void {
    this.loaded = false;
  }

  private load(): Record<string, PreparedEntry> {
    if (this.loaded) return this.songs;
    this.loaded = true;
    this.songs = {};
    this.pace = { recentMs: [], activeByDay: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as StoreFile;
      if (raw?.version === 1 && raw.songs && typeof raw.songs === "object") {
        // Entries written under other rules are dropped: they'd never be shown, and are prepared again.
        for (const [k, e] of Object.entries(raw.songs)) if (isEntry(e) && e.rules === PREPARED_RULES_VERSION) this.songs[k] = e;
      }
      const p = raw?.pace;
      if (p && Array.isArray(p.recentMs) && p.recentMs.every((n) => typeof n === "number") && p.activeByDay && typeof p.activeByDay === "object") {
        this.pace = { recentMs: p.recentMs, activeByDay: Object.fromEntries(Object.entries(p.activeByDay).filter(([, v]) => typeof v === "number")) };
      }
    } catch {
      // None yet, or unreadable: start a new one.
    }
    return this.songs;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const data: StoreFile = { version: 1, rules: PREPARED_RULES_VERSION, songs: this.songs, pace: this.pace };
      writeFileAtomic(this.file(), JSON.stringify(data), { mode: 0o600 });
    } catch (err) {
      // Still used this session; only what a restart remembers is lost.
      console.warn(`[Prepared] Could not save ${PREPARED_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** The one store the server and the fact generator share. */
export const preparedStore = new PreparedStore();
