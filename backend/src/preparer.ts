import { isCurrent, PreparedEntry, PreparedOutcome, PreparedStore, PREPARED_RULES_VERSION } from "./prepared-facts";
import type { PreparedSong } from "./fact-generator";
import { SSLSong } from "./types";

// Prepare my songs (#293): facts for every song ahead of time, most requested first, each saved when done.
// Runs only while the app says the computer is free (#295); the store is the progress (ARCHITECTURE.md: Prepared songs)

/** A song to prepare: from the song list, or seen on stream (#297) */
export interface PrepTarget {
  key: string;
  song: SSLSong;
  /** Times requested or played; most first */
  requests: number;
}

/** Why a song is next */
export type PrepReason = "new" | "stale" | "check" | "upgrade";

export interface PreparerDeps {
  store: PreparedStore;
  /** Every song to prepare, in list order; read before each song, as the list or history may grow */
  targets: () => PrepTarget[];
  prepare: (song: SSLSong, signal: AbortSignal, opts: { answers: Map<string, { answer: string; track: string }>; streamModel?: boolean }) => Promise<PreparedSong & { revision: number }>;
  /** The article's settled revision now, to tell whether it changed */
  revisionOf: (page: string) => Promise<number | null>;
  /** Preparing and on-stream models (`prepModelName`, `streamModelName`) */
  prepModel: () => string;
  streamModel: () => string;
  /** After a run: a preparing-only model gives its memory back */
  release?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** ms between songs: each takes several Wikipedia requests */
  gapMs?: number;
  /** Song list read yet? Until then, out of songs means wait, not done */
  listRead?: () => boolean;
}

const LIST_WAIT_MS = 5000; // ms between asks whether the song list is read, once every known song is done

export const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // ms (a week) between checks for a newer article version
const MAX_TROUBLED_TRIES = 3;     // tries in a run before a song with failed lookups is saved as it is
const FIRST_BACKOFF_MS = 60_000;  // ms, first wait out of throttling, doubling each time
const MAX_BACKOFF_MS = 600_000;   // ms, the longest wait

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/** `work`, or null if `signal` aborts first; the listener goes with the work, so a long run leaks none */
const unlessAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> =>
  new Promise<T | null>((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

/** Local calendar day of a time, as the pace is kept */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface PreparerStatus {
  running: boolean;
  /** Song being prepared now, if any */
  current: { title: string; artist: string } | null;
  /** Songs prepared this run */
  doneThisRun: number;
  /** Every song prepared, none due again */
  finished: boolean;
  /** Lookups failing or throttled: waiting to try again */
  waitingForLookups: boolean;
}

/** How far preparing has come (#294), for the streamer's one screen; information only, nothing to approve (#258) */
export interface Coverage {
  /** Songs on the list or seen on stream */
  total: number;
  /** With facts, nothing to prepare (own facts, a switch), or looked up as it plays */
  ready: number;
  /** Prepared; no source knows them */
  noFacts: number;
  /** Not prepared yet, or due again */
  left: number;
  /** Share of all requests (plays) for ready songs, 0 to 1; null when none known */
  requestsCovered: number | null;
  /** When the rest should be done at this computer's pace; null when none left or no pace yet */
  finish: { at: string } | { hours: number } | null;
  /** Songs no source knows, most requested first */
  noFactsSongs: Array<{ title: string; artist: string }>;
}

export const NO_FACTS_SHOWN = 200; // most songs listed as having no facts
// A finish date needs this much pace measured; until then, hours
const PACE_SONGS = 3; // songs' times
const PACE_DAYS = 2;  // earlier days of preparing

/** Coverage from the songs, the store and this computer's pace */
export function coverage(targets: PrepTarget[], store: PreparedStore, now = Date.now()): Coverage {
  let ready = 0;
  let noFacts = 0;
  let requests = 0;
  let covered = 0;
  const none: PrepTarget[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    requests += t.requests;
    const entry = store.get(t.key, now);
    if (!entry) continue;
    if (entry.outcome === "none") {
      noFacts++;
      none.push(t);
    } else {
      ready++;
      covered += t.requests;
    }
  }
  const total = seen.size;
  const left = total - ready - noFacts;
  const pace = store.getPace();
  const perSong = pace.recentMs.length >= PACE_SONGS ? pace.recentMs.reduce((a, b) => a + b, 0) / pace.recentMs.length : 0;
  const today = dayOf(now);
  // Preparing time on recent days but today, which is still going
  const days = Object.entries(pace.activeByDay).filter(([d]) => d !== today).sort(([a], [b]) => a.localeCompare(b)).slice(-7).map(([, ms]) => ms);
  const perDay = days.length >= PACE_DAYS ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const work = left * perSong;
  const finish = !left || !perSong ? null : perDay > 0 ? { at: new Date(now + (work / perDay) * 24 * 60 * 60 * 1000).toISOString() } : { hours: Math.max(1, Math.round(work / 3_600_000)) };
  return {
    total,
    ready,
    noFacts,
    left,
    requestsCovered: requests > 0 ? covered / requests : null,
    finish,
    noFactsSongs: none.sort((a, b) => b.requests - a.requests).slice(0, NO_FACTS_SHOWN).map((t) => ({ title: t.song.title, artist: t.song.artist ?? "" })),
  };
}

export class Preparer {
  private stopper: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private current: SSLSong | null = null;
  private doneThisRun = 0;
  private finished = false;
  private backingOff = false;
  /** Songs not prepared this run (stopped, failed): tried next run */
  private skipped = new Set<string>();
  private troubled = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: PreparerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
  }

  get running(): boolean {
    return this.stopper !== null;
  }

  status(): PreparerStatus {
    return {
      running: this.running,
      current: this.current ? { title: this.current.title, artist: this.current.artist } : null,
      doneThisRun: this.doneThisRun,
      finished: this.finished,
      waitingForLookups: this.backingOff,
    };
  }

  /** Start, or carry on; false when already running */
  start(): boolean {
    if (this.stopper) return false;
    const stopper = new AbortController();
    this.stopper = stopper;
    this.doneThisRun = 0;
    this.finished = false;
    this.skipped.clear();
    console.log("[Prepare] Preparing songs while the computer is free");
    this.loop = this.run(stopper.signal)
      .catch((err) => console.error(`[Prepare] Stopped by an error: ${err instanceof Error ? err.message : err}`))
      .finally(async () => {
        if (this.stopper === stopper) this.stopper = null;
        // A new run may have started meanwhile: it keeps its model
        if (this.stopper) return;
        this.current = null;
        this.backingOff = false;
        await this.deps.release?.().catch(() => undefined);
      });
    return true;
  }

  /** Stop at once, aborting the song in progress (unsaved); `stopped` resolves once the run winds down */
  stop(): void {
    const stopper = this.stopper;
    if (!stopper) return;
    this.stopper = null;
    this.current = null;
    stopper.abort();
    console.log(`[Prepare] Stopped (${this.doneThisRun} prepared this time)`);
  }

  /** Resolves once the last run winds down: for tests and a clean exit */
  stopped(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** Next song to prepare and why, or null when none is due; most requested first within each kind */
  next(now = this.now()): { target: PrepTarget; reason: PrepReason; entry?: PreparedEntry } | null {
    const prepModel = this.deps.prepModel();
    const streamModel = this.deps.streamModel();
    let best: { target: PrepTarget; reason: PrepReason; entry?: PreparedEntry; rank: number } | null = null;
    const RANK: Record<PrepReason, number> = { new: 0, stale: 1, check: 2, upgrade: 3 };
    const seen = new Set<string>();
    for (const target of this.deps.targets()) {
      if (seen.has(target.key) || this.skipped.has(target.key)) continue;
      seen.add(target.key);
      const saved = this.deps.store.saved(target.key);
      const entry = saved && isCurrent(saved, now) ? saved : undefined;
      let reason: PrepReason | null = null;
      if (!saved) reason = "new";
      else if (!entry) reason = "stale";
      else if (entry.article && now - Date.parse(entry.checkedAt) >= CHECK_EVERY_MS) reason = "check";
      // The faster model's songs, facts or none, are written again by the stream's (#296)
      else if ((entry.outcome === "facts" || entry.outcome === "none") && entry.model && entry.model === prepModel && prepModel !== streamModel) reason = "upgrade";
      if (!reason) continue;
      const rank = RANK[reason];
      if (!best || rank < best.rank || (rank === best.rank && target.requests > best.target.requests)) best = { target, reason, entry, rank };
    }
    return best && { target: best.target, reason: best.reason, entry: best.entry };
  }

  private async run(signal: AbortSignal): Promise<void> {
    const answers = new Map<string, { answer: string; track: string }>();
    let backoff = FIRST_BACKOFF_MS;
    let waitedForList = false;
    while (!signal.aborted) {
      const next = this.next();
      // The app can start preparing just before the song list's one read, at start
      if (!next && this.deps.listRead && !this.deps.listRead()) {
        if (!waitedForList) console.log("[Prepare] Waiting for the song list to be read");
        waitedForList = true;
        await this.sleep(LIST_WAIT_MS, signal);
        continue;
      }
      if (!next) {
        // Songs skipped this run (failing lookups, a model that won't load) aren't done: next run tries them
        this.finished = this.skipped.size === 0;
        console.log(this.finished ? `[Prepare] Every song is prepared (${this.doneThisRun} this time)` : `[Prepare] Nothing more to try now: ${this.skipped.size} songs wait for the next run`);
        break;
      }
      const { target, reason, entry } = next;
      const started = this.now();
      this.current = target.song;
      // Something failed or was throttled: skip the song, wait longer each time, go on
      const backOff = async (why: string): Promise<void> => {
        this.skipped.add(target.key);
        this.addActive(started);
        console.log(`[Prepare] ${why}: waiting ${Math.round(backoff / 1000)} s`);
        this.backingOff = true;
        await this.sleep(backoff, signal);
        this.backingOff = false;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      };
      if (reason === "check" && entry) {
        const revision = await this.deps.revisionOf(entry.article).catch(() => undefined);
        if (signal.aborted) break;
        // Couldn't ask (Wikipedia slow or down): not a check, and no rush to ask about the next
        if (revision === undefined) {
          await backOff("Wikipedia couldn't be asked for the article's version");
          continue;
        }
        if (revision === entry.revision || (revision === null && !entry.revision)) {
          // Unchanged; checks are paced like songs, so a week's worth never comes as one burst
          this.addActive(started);
          this.deps.store.checked(target.key, new Date(this.now()).toISOString());
          await this.sleep(this.deps.gapMs ?? 2000, signal);
          continue;
        }
        console.log(`[Prepare] "${target.song.title}": its article has changed, preparing it again`);
      }
      // Raced with the stop: a hosted AI's answer can't be called back, so a stopped run doesn't wait
      const result = await unlessAborted(this.deps.prepare(target.song, signal, { answers, ...(reason === "upgrade" ? { streamModel: true } : {}) }), signal);
      if (signal.aborted || !result) break;
      const took = this.now() - started;
      if (result.trouble) {
        const tries = (this.troubled.get(target.key) ?? 0) + 1;
        this.troubled.set(target.key, tries);
        if (tries < MAX_TROUBLED_TRIES || !result.outcome || result.outcome !== "facts") {
          // A lookup failed or was throttled: the miss says nothing
          await backOff("Lookups are failing or slowed down");
          continue;
        }
      } else if (!result.outcome) {
        // No lookup failed: the AI itself (a model that won't load); wait, or every song would fail in a tight loop
        await backOff("The AI couldn't write for the song");
        continue;
      } else backoff = FIRST_BACKOFF_MS;
      if (!result.outcome) {
        this.skipped.add(target.key);
        this.addActive(started);
        continue;
      }
      this.save(target, result.outcome, result, took);
      this.doneThisRun++;
      await this.sleep(this.deps.gapMs ?? 2000, signal);
    }
    this.current = null;
  }

  private save(target: PrepTarget, outcome: PreparedOutcome, result: PreparedSong & { revision: number }, took: number): void {
    const at = new Date(this.now()).toISOString();
    this.deps.store.put(target.key, {
      title: target.song.title,
      artist: target.song.artist ?? "",
      outcome,
      facts: result.facts,
      article: result.article,
      revision: result.revision,
      rules: PREPARED_RULES_VERSION,
      model: result.model,
      preparedAt: at,
      checkedAt: at,
    }, { ms: took, activeMs: took, day: dayOf(this.now()) });
  }

  private addActive(started: number): void {
    const ms = this.now() - started;
    if (ms > 0) this.deps.store.addPace(0, ms, dayOf(this.now()));
  }
}
