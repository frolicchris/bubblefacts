import * as os from "os";

/**
 * Keeping the built-in AI in step with a slow or busy computer (issue #314).
 *
 * BubbleFacts watches what it experiences, with no setting: how long each song
 * waited for its AI facts, whether a song ended before they came, the model's
 * own speed, and how busy the computer is with everything else. It then asks
 * for less, in steps, and goes back up once songs come in on time again.
 * Slow means fewer facts, never weaker checks: every caption still goes
 * through the same screening, against exactly the text the AI was given.
 */

/** How the AI is asked for a song's facts. */
export type Pace = "full" | "short" | "quick";

/**
 * Facts this late are late: by a minute into a song, most of its bubbles
 * should already have been up (one every few seconds), so viewers start
 * seeing the next song's facts instead. Over this, on average, the AI is asked
 * for less.
 */
export const LATE_MS = 60_000;
/**
 * A song counts as on time, for stepping back up, when its facts came within
 * half the late time: the shorter request then has room to grow back to the
 * full one without running late again (no flip-flopping between the two).
 */
export const ON_TIME_MS = LATE_MS / 2;
/** The running average covers this many songs: enough that one long article doesn't count as a slow computer. */
export const PACE_WINDOW = 3;
/** Songs needed before an average says anything: a single song may just have been a long article. */
export const MIN_SAMPLES = 2;
/** On-time songs in a row needed to step back up from fewer facts to the full set. */
export const RECOVER_SONGS = 3;
/**
 * In quick-facts-only mode the AI still writes for every this-many-th song,
 * after the quick facts are up, to see whether the computer has calmed down.
 * Without these tries it could never learn that it has.
 */
export const QUICK_PROBE_EVERY = 3;
/** A slow song: this many captions, not the usual count plus spares. Fewer lines to write is what makes it quicker. */
export const SHORT_CAPTIONS = 2;
/**
 * A slow song: the AI reads at most this much of the article (from its start,
 * where the lead is). Reading is a large part of a small model's time on a CPU.
 */
export const SHORT_CONTEXT_CHARS = 1200;

/**
 * Other programs' share of all the computer's CPU at which BubbleFacts makes
 * room: OBS's encoder and a game then need what's left, and a stream that
 * misses frames stutters for viewers. BubbleFacts' own use is left out, or the
 * AI's own work would always look like a busy computer.
 */
export const CPU_BUSY = 0.7;
/** The CPU counts as calm again below this share, a gap below CPU_BUSY so the AI doesn't switch back and forth. */
export const CPU_CALM = 0.5;
/** Calm readings in a row (one every CPU_SAMPLE_MS) needed before the AI gets all its threads back. */
export const CALM_SAMPLES = 6;
/** How often the CPU is read. Often enough to catch a game starting mid-song; reading it costs next to nothing. */
export const CPU_SAMPLE_MS = 5_000;
/** On a busy CPU the AI uses this fraction of its usual threads (at least one), leaving the rest to the stream. */
export const BUSY_THREAD_SHARE = 0.25;

interface Sample {
  ms: number;
  missed: boolean;
}

/**
 * The steps: full, then fewer captions from a shorter part of the article
 * ("short"), then the instant database facts only ("quick"). Facts late on
 * average step down to short; a song that ended before its AI facts came steps
 * straight to quick. Each way back up needs songs that were on time.
 */
export class PaceKeeper {
  private level: Pace = "full";
  private samples: Sample[] = [];
  /** Songs started since the last try of the AI in quick mode. */
  private sinceProbe = 0;

  pace(): Pace {
    return this.level;
  }

  /** A new song started. */
  songStarted(): void {
    if (this.level === "quick") this.sinceProbe++;
  }

  /** Whether the AI writes for the song now starting: always, except in quick mode between tries. */
  aiThisSong(): boolean {
    return this.level !== "quick" || this.sinceProbe >= QUICK_PROBE_EVERY;
  }

  /** How the AI is asked when it writes: a try in quick mode is asked the short way. */
  ask(): Exclude<Pace, "quick"> {
    return this.level === "full" ? "full" : "short";
  }

  /** The AI's facts were ready this long after the song started. */
  ready(ms: number): void {
    this.add({ ms, missed: false });
  }

  /** The song ended, after `onMs`, before its AI facts were ready. */
  missed(onMs: number): void {
    // A song skipped quickly says nothing about the computer.
    if (onMs < LATE_MS) return;
    this.add({ ms: onMs, missed: true });
  }

  /** The average wait over the last few songs, or null with too few to tell. */
  averageMs(): number | null {
    if (this.samples.length < MIN_SAMPLES) return null;
    return this.samples.reduce((sum, s) => sum + s.ms, 0) / this.samples.length;
  }

  private add(sample: Sample): void {
    this.samples = [...this.samples, sample].slice(-Math.max(PACE_WINDOW, RECOVER_SONGS));
    const before = this.level;
    if (sample.missed) this.level = "quick";
    else if (this.level === "quick") {
      // A try in quick mode: on time steps up one; late but before the song ended waits for the next try.
      if (sample.ms <= LATE_MS) this.level = "short";
    } else if (this.level === "short") {
      const recent = this.samples.slice(-RECOVER_SONGS);
      if (recent.length === RECOVER_SONGS && recent.every((s) => !s.missed && s.ms <= ON_TIME_MS)) this.level = "full";
    } else {
      const recent = this.samples.slice(-PACE_WINDOW);
      const average = recent.reduce((sum, s) => sum + s.ms, 0) / recent.length;
      if (recent.length >= MIN_SAMPLES && average > LATE_MS) this.level = "short";
    }
    if (this.level === "quick") this.sinceProbe = 0;
    // A new step starts its own count: songs from before the change don't decide the next one.
    if (this.level !== before) this.samples = [];
  }
}

/** The dashboard's line under Facts while BubbleFacts is asking the AI for less; empty when it isn't. */
export function paceLine(pace: Pace): string {
  if (pace === "quick") return "Your computer is busy, so quick facts only";
  if (pace === "short") return "Your computer is busy, so fewer facts";
  return "";
}

/**
 * The start of an article for a slow song: its first line (the article's
 * title) and as many whole sentences as fit in `max` characters. The whole
 * text when it already fits.
 */
export function shorterContext(context: string, max = SHORT_CONTEXT_CHARS): string {
  if (context.length <= max) return context;
  const cut = context.slice(0, max);
  // The last sentence end within the budget, but never the title line alone.
  const firstLine = context.indexOf("\n");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n"));
  return end > firstLine ? cut.slice(0, end + 1).trimEnd() : cut.trimEnd();
}

// --- The computer --------------------------------------------------------

/** CPU time so far, summed over every core, in ms. */
export interface CpuTimes {
  busy: number;
  total: number;
}

export function cpuTimes(cpus: Pick<os.CpuInfo, "times">[] = os.cpus()): CpuTimes {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/**
 * Other programs' share of the whole CPU between two readings, 0 to 1:
 * everything busy minus BubbleFacts' own use (`ownMs`). os.loadavg would be
 * simpler but is always zero on Windows, where most streams run.
 */
export function othersCpuShare(before: CpuTimes, after: CpuTimes, ownMs: number): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  const others = after.busy - before.busy - ownMs;
  return Math.min(1, Math.max(0, others / total));
}

/** Whether the AI should make room for the stream, from the CPU's latest readings. */
export class CpuWatch {
  private busy = false;
  private calm = 0;
  latestShare: number | null = null;

  /** One reading; true when the AI should keep to fewer threads at low priority. */
  read(share: number): boolean {
    this.latestShare = share;
    if (share >= CPU_BUSY) {
      this.busy = true;
      this.calm = 0;
    } else if (this.busy && share < CPU_CALM && ++this.calm >= CALM_SAMPLES) {
      this.busy = false;
      this.calm = 0;
    } else if (share >= CPU_CALM) this.calm = 0;
    return this.busy;
  }

  isBusy(): boolean {
    return this.busy;
  }
}

/** The AI's threads on a busy CPU: a share of its usual ones, at least one. */
export function busyThreads(usual: number): number {
  return Math.max(1, Math.floor(usual * BUSY_THREAD_SHARE));
}

/** Words per second in a piece of text written in `ms`; null when too short to tell. */
export function wordsPerSecond(text: string, ms: number): number | null {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words || ms < 100) return null;
  return Math.round((words / (ms / 1000)) * 10) / 10;
}
