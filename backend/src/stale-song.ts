import { SSLQueueItem } from "./types";

// A song list nobody advanced (#451): the streamer's hands are on the instrument, so the list can show a song
// that ended minutes ago. Past a time no song plausibly lasts, the server is "not sure what is playing": no new
// bubbles, no facts shared for it, until the list moves on. One setting (the minutes) and nothing to click

// Minutes a song may be on before it counts as stale: the streamer's setting (STALE_SONG_MINUTES), since a
// medley player and a three-minute-song player need different limits
export const STALE_MINUTES_DEFAULT = 10;
export const STALE_MINUTES_MIN = 5;
export const STALE_MINUTES_MAX = 60;

/** The setting as given: a whole number in range, else the default. A bad value never stops the server or turns the watch off */
export function staleMinutes(raw: string | number | undefined | null): number {
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim() || NaN);
  return Number.isInteger(value) && value >= STALE_MINUTES_MIN && value <= STALE_MINUTES_MAX ? value : STALE_MINUTES_DEFAULT;
}
const LENGTH_TIMES = 2; // a track whose length is known (a StreamElements video) may be paused and talked over
const LENGTH_MARGIN_MS = 2 * 60 * 1000;

/**
 * How long this entry may be on: the streamer's minutes. A track whose length the source knows gets longer when
 * twice its length says so, never shorter: the setting is the least any song gets
 */
export function staleAfterMs(entry: SSLQueueItem, minutes: number = STALE_MINUTES_DEFAULT): number {
  const setting = staleMinutes(minutes) * 60 * 1000;
  const seconds = entry.song?.durationSeconds;
  return typeof seconds === "number" && seconds > 0 ? Math.max(setting, seconds * 1000 * LENGTH_TIMES + LENGTH_MARGIN_MS) : setting;
}

/** The dashboard's words for it, read out by screen readers; no time in it, since the streamer sets that */
export const STALE_NOTICE = "Your song list has shown the same song for a long time, so BubbleFacts isn't sure it's still playing. Bubbles and sharing start again by themselves with your next song.";

export class StaleSongWatch {
  private entry: SSLQueueItem | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isStale = false;

  constructor(private readonly onStale: (entry: SSLQueueItem) => void, private readonly afterMs: (entry: SSLQueueItem) => number = staleAfterMs) {}

  /** The entry on now, or null. The same entry again (a resume) keeps its clock; another one starts fresh */
  follow(entry: SSLQueueItem | null): void {
    if (entry === this.entry) return;
    this.stop();
    this.entry = entry;
    if (!entry) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.isStale = true;
      this.onStale(entry);
    }, this.afterMs(entry));
    this.timer.unref?.();
  }

  /** Whether the entry followed has been on too long to trust */
  get stale(): boolean {
    return this.isStale;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.entry = null;
    this.isStale = false;
  }
}
