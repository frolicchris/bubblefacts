import { isCurrent, PreparedEntry, PreparedOutcome, PreparedStore, PREPARED_RULES_VERSION } from "./prepared-facts";
import type { PreparedSong } from "./fact-generator";
import { SSLSong } from "./types";

/**
 * "Prepare my songs" (issue #293): writes facts for every song the streamer
 * may play, ahead of time, the most requested first, and saves each as it
 * finishes. It runs only while the app says the computer is free (issue #295),
 * stops at once when told, keeps what's done, and carries on from there next
 * time: the store is what's done, so there's nothing else to resume.
 */

/** A song to prepare: from the song list, or seen on stream (issue #297). */
export interface PrepTarget {
  key: string;
  song: SSLSong;
  /** How often it was requested or played: the most first. */
  requests: number;
}

/** Why a song is next. */
export type PrepReason = "new" | "stale" | "check" | "upgrade";

export interface PreparerDeps {
  store: PreparedStore;
  /** Every song to prepare, in list order. Read again before each song: the list or the history may have grown. */
  targets: () => PrepTarget[];
  prepare: (song: SSLSong, signal: AbortSignal, opts: { answers: Map<string, { answer: string; track: string }>; streamModel?: boolean }) => Promise<PreparedSong & { revision: number }>;
  /** The article's settled revision now, to tell whether a prepared song's article changed. */
  revisionOf: (page: string) => Promise<number | null>;
  /** The models that prepare and that write on stream (`prepModelName`, `streamModelName`). */
  prepModel: () => string;
  streamModel: () => string;
  /** After a run: a model loaded only for preparing gives its memory back. */
  release?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Between songs: each takes several Wikipedia requests. */
  gapMs?: number;
  /** Whether the song list has been read. Until it is, running out of songs means waiting for it, not being done. */
  listRead?: () => boolean;
}

/** How often a run that has done every song it knows asks again whether the song list has been read. */
const LIST_WAIT_MS = 5000;

/** An article is checked for a newer version this often. */
export const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
/** A song whose lookups failed is saved as it is after this many tries in a run, rather than tried for ever. */
const MAX_TROUBLED_TRIES = 3;
/** Waiting out throttling: one minute, doubling up to ten. */
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 600_000;

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

/** Resolves (to nothing) when the signal aborts. */
/** `work`, or null once `signal` aborts first. The abort listener goes with the work, so a long run leaks none. */
const unlessAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T | null> =>
  new Promise<T | null>((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

/** The local calendar day of a time, as the pace is kept per day. */
export const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export interface PreparerStatus {
  running: boolean;
  /** The song being prepared now, if any. */
  current: { title: string; artist: string } | null;
  /** Songs prepared since this run started. */
  doneThisRun: number;
  /** Every song has been prepared and none is due again. */
  finished: boolean;
  /** Lookups are failing or throttled: waiting before trying again. */
  waitingForLookups: boolean;
}

/**
 * How far preparing has come (issue #294), for the one screen the streamer reads. Information
 * only: nothing in it asks them to check or approve anything (issue #258: they're musicians,
 * not fact checkers).
 */
export interface Coverage {
  /** Songs on the list or seen on stream. */
  total: number;
  /** Prepared with facts, or nothing to prepare (their own facts, a switch), or looked up as it plays. */
  ready: number;
  /** Prepared, and no source knows them. */
  noFacts: number;
  /** Not prepared yet, or due again. */
  left: number;
  /** The share of all requests (plays) that went to ready songs, 0 to 1; null when no plays are known. */
  requestsCovered: number | null;
  /** When the rest should be done at the pace measured on this computer; null when nothing is left or there's no pace yet. */
  finish: { at: string } | { hours: number } | null;
  /** Songs no source knows, the most requested first, at most `NO_FACTS_SHOWN`. */
  noFactsSongs: Array<{ title: string; artist: string }>;
}

/** The songs listed as having no facts at all, at most. */
export const NO_FACTS_SHOWN = 200;
/** A finish date needs this many songs' times, and preparing on this many earlier days; until then, hours. */
const PACE_SONGS = 3;
const PACE_DAYS = 2;

/** Coverage from the songs, the store and the pace measured on this computer. */
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
  // Time spent preparing on recent days other than today, which is still going.
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
  /** Songs that couldn't be prepared this run (stopped, failed): tried again next run. */
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

  /** Start, or carry on: false when it was already running. */
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
        // A new run may have started meanwhile: it keeps its model.
        if (this.stopper) return;
        this.current = null;
        this.backingOff = false;
        await this.deps.release?.().catch(() => undefined);
      });
    return true;
  }

  /**
   * Stop now: the song in progress isn't saved, everything before it is. Returns at once; the
   * AI's turn for that song is aborted. `stopped` resolves once the run has wound down.
   */
  stop(): void {
    const stopper = this.stopper;
    if (!stopper) return;
    this.stopper = null;
    this.current = null;
    stopper.abort();
    console.log(`[Prepare] Stopped (${this.doneThisRun} prepared this time)`);
  }

  /** Resolves once the last run has wound down: for tests and a clean exit. */
  stopped(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** The next song to prepare, and why; null when none is due. Most requested first within each kind. */
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
      // The faster model's songs, facts or none at all, are written again by the one on stream (issue #296).
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
      // The app can start preparing a moment before the song list has been read (it's read once, at start).
      if (!next && this.deps.listRead && !this.deps.listRead()) {
        if (!waitedForList) console.log("[Prepare] Waiting for the song list to be read");
        waitedForList = true;
        await this.sleep(LIST_WAIT_MS, signal);
        continue;
      }
      if (!next) {
        // Songs skipped this run (lookups failing, a model that won't load) aren't done: the next run tries them.
        this.finished = this.skipped.size === 0;
        console.log(this.finished ? `[Prepare] Every song is prepared (${this.doneThisRun} this time)` : `[Prepare] Nothing more to try now: ${this.skipped.size} songs wait for the next run`);
        break;
      }
      const { target, reason, entry } = next;
      const started = this.now();
      this.current = target.song;
      // Something failed or was throttled: skip the song, wait longer each time, then go on.
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
        // It couldn't be asked (Wikipedia slow or down): not a check, and no rush to ask about the next.
        if (revision === undefined) {
          await backOff("Wikipedia couldn't be asked for the article's version");
          continue;
        }
        if (revision === entry.revision || (revision === null && !entry.revision)) {
          // Unchanged: no new facts needed. Checks are paced like songs, so a week's worth never comes as one burst.
          this.addActive(started);
          this.deps.store.checked(target.key, new Date(this.now()).toISOString());
          await this.sleep(this.deps.gapMs ?? 2000, signal);
          continue;
        }
        console.log(`[Prepare] "${target.song.title}": its article has changed, preparing it again`);
      }
      // Raced with the stop: a hosted AI's answer can't be called back, so a stopped run doesn't wait for it.
      const result = await unlessAborted(this.deps.prepare(target.song, signal, { answers, ...(reason === "upgrade" ? { streamModel: true } : {}) }), signal);
      if (signal.aborted || !result) break;
      const took = this.now() - started;
      if (result.trouble) {
        const tries = (this.troubled.get(target.key) ?? 0) + 1;
        this.troubled.set(target.key, tries);
        if (tries < MAX_TROUBLED_TRIES || !result.outcome || result.outcome !== "facts") {
          // A lookup failed or was throttled: the miss says nothing.
          await backOff("Lookups are failing or slowed down");
          continue;
        }
      } else if (!result.outcome) {
        // Nothing came of it and no lookup failed: the AI itself (a model that won't load, say). The
        // next song would hit the same, so it waits rather than trying the whole list in a tight loop.
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
