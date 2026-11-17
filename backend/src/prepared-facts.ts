import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";

// Prepared facts (#292): songs' facts written ahead by the stream's pipeline, kept private in the data folder.
// Facts from a source only; own, song-list and custom facts are built on play (ARCHITECTURE.md: Prepared songs)
export const PREPARED_FILE = "prepared-facts.json";

/** Raise when the pipeline would write different facts (prompt, screening, ranking, content standard, sources): every entry is prepared again, none shown meanwhile */
export const PREPARED_RULES_VERSION = 2;

export const PREPARED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // ms (30 days) until a song is prepared again regardless
// Pace kept for the finish date (preparer.ts)
export const PACE_KEEP_SONGS = 50; // latest songs' times
export const PACE_KEEP_DAYS = 14;  // days of preparing time

/** One prepared fact: what the dashboard labels and what Wrong blocks */
export interface PreparedFact {
  text: string;
  source?: string;
  url?: string;
  evidence?: string;
  /** Companion article fact: the article it came through (#48) */
  via?: string;
}

/**
 * How preparing went: "facts" from a source; "none", no source knows it (custom facts or nothing); "own", nothing to
 * prepare (own facts, an original, facts off, not music), counts as ready; "live", looked up as it plays (Twitch About)
 */
export type PreparedOutcome = "facts" | "none" | "own" | "live";

export interface PreparedEntry {
  /** The song as prepared, by its songKey */
  title: string;
  artist: string;
  outcome: PreparedOutcome;
  facts: PreparedFact[];
  /** Wikipedia article the facts came from, or "" */
  article: string;
  /** That article's settled revision read, or 0 when unknown */
  revision: number;
  rules: number;
  /** Model that wrote the captions; "" when no AI was asked */
  model: string;
  /** When prepared, and when its article was last checked for a newer version (ISO dates) */
  preparedAt: string;
  checkedAt: string;
}

/** The pace measured on this computer, for the finish date (#294) */
export interface PreparedPace {
  /** Each recent song's time, ms */
  recentMs: number[];
  /** Ms spent preparing per local day ("2026-11-02"), the last two weeks */
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

/** Usable as is: today's rules, and not too old */
export function isCurrent(entry: PreparedEntry, now = Date.now()): boolean {
  const at = Date.parse(entry.preparedAt);
  return entry.rules === PREPARED_RULES_VERSION && Number.isFinite(at) && now - at < PREPARED_MAX_AGE_MS && now >= at - 60_000;
}

export class PreparedStore {
  private songs: Record<string, PreparedEntry> = {};
  private pace: PreparedPace = { recentMs: [], activeByDay: {} };
  private loaded = false;

  constructor(private readonly file = () => path.join(config.dataDir, PREPARED_FILE)) {}

  /** The current entry for a song key, facts or not; undefined when none */
  get(key: string, now = Date.now()): PreparedEntry | undefined {
    const e = this.load()[key];
    return e && isCurrent(e, now) ? e : undefined;
  }

  /** Any saved entry, current or not */
  saved(key: string): PreparedEntry | undefined {
    return this.load()[key];
  }

  /** Every saved entry, by song key */
  all(): Readonly<Record<string, PreparedEntry>> {
    return this.load();
  }

  /** Save a song, and its `pace` when given, in one write (the file is rewritten whole) */
  put(key: string, entry: PreparedEntry, pace?: { ms: number; activeMs: number; day: string }): void {
    this.load()[key] = entry;
    if (pace) this.notePace(pace.ms, pace.activeMs, pace.day);
    this.save();
  }

  /** Forget a song's prepared facts (Wrong on one): prepared again later */
  remove(key: string): boolean {
    const s = this.load();
    if (!(key in s)) return false;
    delete s[key];
    this.save();
    return true;
  }

  /** Its article was checked and is unchanged */
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

  /** One song took `ms`; today's preparing time grows by `activeMs` */
  addPace(ms: number, activeMs: number, day: string, keep = PACE_KEEP_SONGS): void {
    this.load();
    this.notePace(ms, activeMs, day, keep);
    this.save();
  }

  private notePace(ms: number, activeMs: number, day: string, keep = PACE_KEEP_SONGS): void {
    if (ms > 0) this.pace.recentMs = [...this.pace.recentMs, ms].slice(-keep);
    if (activeMs > 0) {
      this.pace.activeByDay[day] = (this.pace.activeByDay[day] ?? 0) + activeMs;
      const days = Object.keys(this.pace.activeByDay).sort();
      for (const d of days.slice(0, Math.max(0, days.length - PACE_KEEP_DAYS))) delete this.pace.activeByDay[d];
    }
  }

  /** For tests: read the file again */
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
        // Other rules' entries are dropped: never shown, and prepared again
        for (const [k, e] of Object.entries(raw.songs)) if (isEntry(e) && e.rules === PREPARED_RULES_VERSION) this.songs[k] = e;
      }
      const p = raw?.pace;
      if (p && Array.isArray(p.recentMs) && p.recentMs.every((n) => typeof n === "number") && p.activeByDay && typeof p.activeByDay === "object") {
        this.pace = { recentMs: p.recentMs, activeByDay: Object.fromEntries(Object.entries(p.activeByDay).filter(([, v]) => typeof v === "number")) };
      }
    } catch {
      // None yet, or unreadable: start anew
    }
    return this.songs;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const data: StoreFile = { version: 1, rules: PREPARED_RULES_VERSION, songs: this.songs, pace: this.pace };
      writeFileAtomic(this.file(), JSON.stringify(data), { mode: 0o600 });
    } catch (err) {
      // Still used this session; only a restart forgets it
      console.warn(`[Prepared] Could not save ${PREPARED_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** The store the server and the fact generator share */
export const preparedStore = new PreparedStore();
