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

const CARRY_PAST_MS = 20 * 60 * 1000; // ms past its time a song is still the same play after a restart (session.ts allows a resume as long)

/** What a restart is told about the song's clock (session.json): time played, never a time of day */
export interface SavedClock {
  /** ms the song had been on when this was saved, time paused left out */
  playedMs?: number;
  /** Whether bubbles were paused then: the clock stood still, and stands still until Resume */
  playedPaused?: boolean;
  savedAt?: number;
}

/**
 * ms a song that was on before a restart (a settings save, the watchdog) has been played, so the restart doesn't
 * hand a stale song a fresh clock. Saved paused, it is the time saved: neither the pause nor the time the server
 * was down counts. Saved playing, the song played on since the save. 0 to start afresh: not known (a session
 * from before this, which kept a time of day), or so far past its time that it's likely a new play
 */
export function carriedOnForMs(saved: SavedClock | null | undefined, limitMs: number, now = Date.now()): number {
  const played = saved?.playedMs;
  if (typeof played !== "number" || !Number.isFinite(played) || played < 0) return 0;
  if (saved?.playedPaused) return played;
  const savedAt = saved?.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt > now) return 0;
  const onFor = played + (now - savedAt);
  return onFor < limitMs + CARRY_PAST_MS ? onFor : 0;
}

export class StaleSongWatch {
  private entry: SSLQueueItem | null = null;
  private timer: NodeJS.Timeout | null = null;
  private isStale = false;
  private paused = false;
  /** ms the entry had been on when the clock last started, and when that was */
  private ranMs = 0;
  private startedAt = 0;

  constructor(private readonly onStale: (entry: SSLQueueItem) => void, private readonly afterMs: (entry: SSLQueueItem) => number = staleAfterMs) {}

  /**
   * The entry on now, or null. The same entry again keeps its clock; another one starts fresh, or from
   * `onForMs` when it was already on that long before a restart (stale at once when that is past its time,
   * also while paused, so Resume starts it again as it does without a restart)
   */
  follow(entry: SSLQueueItem | null, more: { onForMs?: number } = {}): void {
    if (entry === this.entry) return;
    this.stop();
    this.entry = entry;
    if (!entry) return;
    this.ranMs = Math.max(0, more.onForMs ?? 0);
    if (!this.paused) this.run();
    else if (this.ranMs >= this.afterMs(entry)) this.isStale = true;
  }

  /** Bubbles paused: the clock stops, since a streamer may line a song up, pause and talk before playing it */
  pause(): void {
    this.paused = true;
    if (!this.timer) return;
    this.ranMs = this.onForMs();
    this.clear();
  }

  /**
   * Bubbles resumed: the clock carries on. Resuming is the streamer saying the song is on, so a stale one
   * counts as current again from now; true when it did, and its bubbles and sharing are to start again
   */
  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    if (!this.entry) return false;
    const wasStale = this.isStale;
    if (wasStale) {
      this.isStale = false;
      this.ranMs = 0;
    }
    this.run();
    return wasStale;
  }

  /** Whether the entry followed has been on too long to trust */
  get stale(): boolean {
    return this.isStale;
  }

  /** ms the entry has been on, time paused left out; 0 with none */
  onForMs(): number {
    return this.ranMs + (this.timer ? Date.now() - this.startedAt : 0);
  }

  stop(): void {
    this.clear();
    this.entry = null;
    this.isStale = false;
    this.ranMs = 0;
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private run(): void {
    const entry = this.entry;
    if (!entry || this.isStale) return;
    const left = this.afterMs(entry) - this.ranMs;
    if (left <= 0) return this.goStale(entry);
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.ranMs = this.onForMs();
      this.timer = null;
      this.goStale(entry);
    }, left);
    this.timer.unref?.();
  }

  private goStale(entry: SSLQueueItem): void {
    this.isStale = true;
    this.onStale(entry);
  }
}
