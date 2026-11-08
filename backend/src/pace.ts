import * as os from "os";

// Keeping the built-in AI in step with a slow or busy computer (#314), with no setting: fewer facts,
// never weaker checks (ARCHITECTURE.md: A slow or busy computer)

/** How the AI is asked for a song's facts */
export type Pace = "full" | "short" | "quick";

// --- Songs ---
export const LATE_MS = 60_000;             // ms: facts later on average ask for less (a minute in, most bubbles should be up)
export const ON_TIME_MS = LATE_MS / 2;     // ms counted on time for stepping up: room to grow back without flip-flopping
export const PACE_WINDOW = 3;              // songs averaged: one long article isn't a slow computer
export const MIN_SAMPLES = 2;              // songs before an average counts
export const RECOVER_SONGS = 3;            // on-time songs in a row to step back up to full
export const QUICK_PROBE_EVERY = 3;        // quick mode still asks the AI every this-many-th song, or it never learns it calmed
export const SHORT_CAPTIONS = 2;           // captions for a slow song: fewer lines to write is what's quicker
export const SHORT_CONTEXT_CHARS = 1200;   // article characters a slow song reads, from the lead: reading is much of a CPU model's time

// --- The CPU ---
export const CPU_BUSY = 0.7;               // other programs' share at which the AI makes room for OBS's encoder and a game
export const CPU_CALM = 0.5;               // calm again below this; the gap stops back-and-forth
export const CALM_SAMPLES = 6;             // calm readings in a row before all threads come back
export const CPU_SAMPLE_MS = 5_000;        // ms between readings: catches a game starting mid-song, costs next to nothing
export const BUSY_THREAD_SHARE = 0.25;     // share of the AI's usual threads on a busy CPU (at least one)

interface Sample {
  ms: number;
  missed: boolean;
}

/** Steps between full, short and quick (ARCHITECTURE.md: A slow or busy computer) */
export class PaceKeeper {
  private level: Pace = "full";
  private samples: Sample[] = [];
  /** Songs since the last AI try in quick mode */
  private sinceProbe = 0;

  pace(): Pace {
    return this.level;
  }

  songStarted(): void {
    if (this.level === "quick") this.sinceProbe++;
  }

  /** The AI writes for the song now starting: always, but in quick mode only on tries */
  aiThisSong(): boolean {
    return this.level !== "quick" || this.sinceProbe >= QUICK_PROBE_EVERY;
  }

  /** How the AI is asked; a quick-mode try is asked short */
  ask(): Exclude<Pace, "quick"> {
    return this.level === "full" ? "full" : "short";
  }

  /** The AI's facts were ready `ms` after the song started */
  ready(ms: number): void {
    this.add({ ms, missed: false });
  }

  /** The song ended after `onMs`, before its AI facts */
  missed(onMs: number): void {
    // A song skipped quickly says nothing about the computer
    if (onMs < LATE_MS) return;
    this.add({ ms: onMs, missed: true });
  }

  /** Average wait over the last few songs; null with too few */
  averageMs(): number | null {
    if (this.samples.length < MIN_SAMPLES) return null;
    return this.samples.reduce((sum, s) => sum + s.ms, 0) / this.samples.length;
  }

  private add(sample: Sample): void {
    this.samples = [...this.samples, sample].slice(-Math.max(PACE_WINDOW, RECOVER_SONGS));
    const before = this.level;
    if (sample.missed) this.level = "quick";
    else if (this.level === "quick") {
      // Quick-mode try: on time steps up one; late but not missed waits for the next try
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
    // A new step starts its own count
    if (this.level !== before) this.samples = [];
  }
}

/** The dashboard's line under Facts while the AI is asked for less; "" otherwise */
export function paceLine(pace: Pace): string {
  if (pace === "quick") return "Your computer is busy, so quick facts only";
  if (pace === "short") return "Your computer is busy, so fewer facts";
  return "";
}

/** For a slow song: the article's title line and whole sentences within `max` characters; all of it if it fits */
export function shorterContext(context: string, max = SHORT_CONTEXT_CHARS): string {
  if (context.length <= max) return context;
  const cut = context.slice(0, max);
  // Last sentence end within the budget, never the title line alone
  const firstLine = context.indexOf("\n");
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("\n"));
  return end > firstLine ? cut.slice(0, end + 1).trimEnd() : cut.trimEnd();
}

// --- The computer ---

/** CPU time so far, all cores, ms */
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

/** Other programs' CPU share between readings, 0 to 1, less our own `ownMs` (os.loadavg is always 0 on Windows) */
export function othersCpuShare(before: CpuTimes, after: CpuTimes, ownMs: number): number {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  const others = after.busy - before.busy - ownMs;
  return Math.min(1, Math.max(0, others / total));
}

/** Whether the AI should make room for the stream, from the latest CPU readings */
export class CpuWatch {
  private busy = false;
  private calm = 0;
  latestShare: number | null = null;

  /** One reading; true = fewer threads, low priority */
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

/** The AI's threads on a busy CPU: a share of the usual, at least one */
export function busyThreads(usual: number): number {
  return Math.max(1, Math.floor(usual * BUSY_THREAD_SHARE));
}

/** Words per second of text written in `ms`; null when too short to tell */
export function wordsPerSecond(text: string, ms: number): number | null {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (!words || ms < 100) return null;
  return Math.round((words / (ms / 1000)) * 10) / 10;
}
