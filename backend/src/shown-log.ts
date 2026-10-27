import type { AiredFacts } from "./aired-facts";
import { Fact, SSLSong } from "./types";

/**
 * What viewers see, as `[Shown] "Song" (source): text`, so a stream's log can
 * be read back for quality, not just counts. The server logs a batch where it
 * actually goes out to an overlay, never where it's written: a skipped,
 * paused or superseded song's facts never reach one. Each fact is logged once
 * per play of a song, however many overlays get it or catch up on it. The
 * same facts go into the aired facts record (aired-facts.ts), when there is one.
 */
export class ShownLog {
  private logged = new Set<string>();

  constructor(private readonly aired?: AiredFacts) {}

  /** A new play of a song: its facts may be logged again, even if it's the same song. */
  newPlay(): void {
    this.logged = new Set();
  }

  log(song: SSLSong, facts: Fact[]): void {
    const fresh: Fact[] = [];
    for (const f of facts) {
      if (this.logged.has(f.text)) continue;
      this.logged.add(f.text);
      fresh.push(f);
      console.log(`[Shown] "${song.title}" (${f.source ?? "no source"}): ${f.text}`);
    }
    this.aired?.add(song, fresh);
  }
}
