import type { AiredFacts } from "./aired-facts";
import { withoutRequesterName } from "./stat-facts";
import { Fact, SSLSong } from "./types";

/**
 * What viewers see, as `[Shown] "Song" (source): text`, logged where facts go out, once per play, and added to aired-facts.ts
 * (ARCHITECTURE.md: How do I see what a stream showed?)
 */
export class ShownLog {
  private logged = new Set<string>();

  constructor(private readonly aired?: AiredFacts) {}

  /** A new play: its facts may be logged again, even for the same song */
  newPlay(): void {
    this.logged = new Set();
  }

  log(song: SSLSong, facts: Fact[]): void {
    const fresh: Fact[] = [];
    for (const f of facts) {
      if (this.logged.has(f.text)) continue;
      this.logged.add(f.text);
      // The log and the aired record feed problem reports, which are public: no viewer's name (stat-facts.ts)
      const text = withoutRequesterName(f.text);
      fresh.push(text === f.text ? f : { ...f, text });
      console.log(`[Shown] "${song.title}" (${f.source ?? "no source"}): ${text}`);
    }
    this.aired?.add(song, fresh);
  }
}
