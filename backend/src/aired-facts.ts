import fs from "fs";
import path from "path";
import { writeFileAtomic } from "./atomic-write";
import { config } from "./config";
import { withoutArtistNote } from "./text";
import { Fact, SSLSong } from "./types";

/**
 * The facts that went out to the overlay, newest last, in `aired-facts.json`
 * in the data folder: each with its song, source, link and time, so a report
 * from the app can say exactly which fact it means after the log lines about
 * it have scrolled away. ShownLog (shown-log.ts) adds to it, so it keeps that
 * rule: only facts that really went out, once per play. Private: it stays on
 * this computer and goes with "Remove my data". The newest
 * `AIRED_FACTS_KEPT` are kept.
 */
export const AIRED_FACTS_FILE = "aired-facts.json";
export const AIRED_FACTS_KEPT = 500;

export interface AiredFact {
  title: string;
  /** Without a note after the artist's name (issue #262): reports made from this are public. */
  artist: string;
  text: string;
  /** Its source label as shown, such as "Wikipedia: Some Game". */
  source?: string;
  url?: string;
  /** When it went out, as an ISO date. */
  at: string;
}

const isAired = (e: unknown): e is AiredFact => {
  const a = e as AiredFact;
  return !!a && typeof a.title === "string" && typeof a.artist === "string" && typeof a.text === "string" && typeof a.at === "string"
    && (a.source === undefined || typeof a.source === "string") && (a.url === undefined || typeof a.url === "string");
};

export class AiredFacts {
  private entries: AiredFact[];

  constructor(
    private readonly file = path.join(config.dataDir, AIRED_FACTS_FILE),
    private readonly kept = AIRED_FACTS_KEPT
  ) {
    this.entries = this.load();
  }

  /** The record, oldest first. */
  list(): AiredFact[] {
    return this.entries.map((e) => ({ ...e }));
  }

  /** Facts that just went out for a song. Never throws: a record that can't be written mustn't stop the bubbles. */
  add(song: Pick<SSLSong, "title" | "artist">, facts: Fact[], now = new Date()): void {
    if (!facts.length) return;
    const at = now.toISOString();
    const artist = withoutArtistNote(song.artist ?? "");
    for (const f of facts) {
      this.entries.push({ title: song.title, artist, text: f.text, ...(f.source ? { source: f.source } : {}), ...(f.url ? { url: f.url } : {}), at });
    }
    if (this.entries.length > this.kept) this.entries = this.entries.slice(this.entries.length - this.kept);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.entries), { mode: 0o600 });
    } catch (err) {
      console.warn(`[Aired] Could not save ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private load(): AiredFact[] {
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(saved) ? saved.filter(isAired).slice(-this.kept) : [];
    } catch {
      // None yet, or unreadable: start a new one.
      return [];
    }
  }
}
