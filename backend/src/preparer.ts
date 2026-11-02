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
}

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
const whenAborted = (signal: AbortSignal) =>
  new Promise<null>((resolve) => (signal.aborted ? resolve(null) : signal.addEventListener("abort", () => resolve(null), { once: true })));

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
      else if (entry.outcome === "facts" && entry.model && entry.model === prepModel && prepModel !== streamModel) reason = "upgrade";
      if (!reason) continue;
      const rank = RANK[reason];
      if (!best || rank < best.rank || (rank === best.rank && target.requests > best.target.requests)) best = { target, reason, entry, rank };
    }
    return best && { target: best.target, reason: best.reason, entry: best.entry };
  }

  private async run(signal: AbortSignal): Promise<void> {
    const answers = new Map<string, { answer: string; track: string }>();
    let backoff = FIRST_BACKOFF_MS;
    while (!signal.aborted) {
      const next = this.next();
      if (!next) {
        this.finished = true;
        console.log(`[Prepare] Every song is prepared (${this.doneThisRun} this time)`);
        break;
      }
      const { target, reason, entry } = next;
      const started = this.now();
      this.current = target.song;
      if (reason === "check" && entry) {
        const revision = await this.deps.revisionOf(entry.article).catch(() => undefined);
        if (signal.aborted) break;
        this.addActive(started);
        // Unchanged, or it couldn't be asked (then it's asked again next week): no new facts needed.
        if (revision === undefined || revision === entry.revision || (revision === null && !entry.revision)) {
          this.deps.store.checked(target.key, new Date(this.now()).toISOString());
          continue;
        }
        console.log(`[Prepare] "${target.song.title}": its article has changed, preparing it again`);
      }
      // Raced with the stop: a hosted AI's answer can't be called back, so a stopped run doesn't wait for it.
      const result = await Promise.race([this.deps.prepare(target.song, signal, { answers, ...(reason === "upgrade" ? { streamModel: true } : {}) }), whenAborted(signal)]);
      if (signal.aborted || !result) break;
      const took = this.now() - started;
      if (result.trouble) {
        const tries = (this.troubled.get(target.key) ?? 0) + 1;
        this.troubled.set(target.key, tries);
        if (tries < MAX_TROUBLED_TRIES || !result.outcome || result.outcome !== "facts") {
          // A lookup failed or was throttled: the miss says nothing. Wait, longer each time, then go on.
          this.skipped.add(target.key);
          this.addActive(started);
          console.log(`[Prepare] Lookups are failing or slowed down: waiting ${Math.round(backoff / 1000)} s`);
          this.backingOff = true;
          await this.sleep(backoff, signal);
          this.backingOff = false;
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
          continue;
        }
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
    });
    this.deps.store.addPace(took, took, dayOf(this.now()));
  }

  private addActive(started: number): void {
    const ms = this.now() - started;
    if (ms > 0) this.deps.store.addPace(0, ms, dayOf(this.now()));
  }
}
