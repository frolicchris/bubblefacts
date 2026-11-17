import { SSLQueueItem } from "./types";

// A song list nobody advanced (#451): the streamer's hands are on the instrument, so the list can show a song
// that ended minutes ago. Past a time no song plausibly lasts, the server is "not sure what is playing": no new
// bubbles, no facts shared for it, until the list moves on. Nothing to set and nothing to click

/** ms a song with no known length may be on before it counts as stale. Long enough for a long piece or a short medley */
export const STALE_AFTER_MS = 10 * 60 * 1000;
const LENGTH_TIMES = 2; // a track whose length is known (a StreamElements video) may be paused and talked over
const LENGTH_MARGIN_MS = 2 * 60 * 1000;

/** How long this entry may be on: by its length when the source knows it, else a fixed time */
export function staleAfterMs(entry: SSLQueueItem): number {
  const seconds = entry.song?.durationSeconds;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1000 * LENGTH_TIMES + LENGTH_MARGIN_MS : STALE_AFTER_MS;
}

/** The dashboard's words for it, read out by screen readers */
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
