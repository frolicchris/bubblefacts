import { config } from "./config";
import { readingSeconds, RESUME_WITHIN_MS, type Session } from "./session";
import { Fact } from "./types";

// The credit bubble (#278): where the facts come from and that they may be wrong, at least once
// each stream, then about every 5th song with facts (ARCHITECTURE.md: The credit bubble)

export const CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts";
// Another AI writes (an online service or the streamer's Ollama): facts a viewer can check, no
// vouching; within MAX_FACT_CHARS (ARCHITECTURE.md: The credit bubble). Wikidata and MusicBrainz
// (CC0) need no credit; the credits page names them
export const OTHER_AI_CREDIT_TEXT = "Some facts are adapted from Wikipedia (CC BY-SA 4.0) by an AI the streamer chose. Not verified by BubbleFacts; may be wrong. bubblefacts.frolic.org/credits.html";
// No AI writes (`AI_PROVIDER=none`): Wikipedia keeps its credit, since some facts are still
// sentences taken from an article (`artistGoodFacts`)
export const NO_AI_CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz. Spot a mistake? Let the streamer know. · BubbleFacts";
const OTHER_AIS: ReadonlySet<string> = new Set(["openai", "anthropic", "ollama"]);
/** The credit for the AI that writes the facts (`AI_PROVIDER`), or for no AI */
export function creditText(provider: string | undefined = config.aiProvider): string {
  if (provider === "none") return NO_AI_CREDIT_TEXT;
  return provider !== undefined && OTHER_AIS.has(provider) ? OTHER_AI_CREDIT_TEXT : CREDIT_TEXT;
}
export const CREDIT_EVERY_SONGS = 5; // songs with facts from one credit to the next
const GAP_SECONDS = 1; // seconds clear between the credit and the song's facts
export const TEST_QUIET_MS = 20_000; // ms after a Test bubble before a credit can show
// No facts on stream this long: the next start a new stream. Fallback to OBS's live signal (`newStream`)
export const STREAM_BREAK_MS = RESUME_WITHIN_MS;

/** When the credit is due; counts only songs that go out with facts, and survives a restart mid-stream */
export class CreditCounter {
  private songs: number;
  private first: boolean;
  /** When facts last went out to an overlay, to tell one stream from the next */
  private lastOnAir: number | undefined;

  /** `restored` and `lastOnAir`: the session file's `creditSince` and `shownAt` */
  constructor(restored?: number, lastOnAir?: number) {
    const known = typeof lastOnAir === "number" && Number.isFinite(lastOnAir) && lastOnAir > 0;
    this.first = !known || typeof restored !== "number" || !Number.isFinite(restored) || restored < 0;
    this.songs = this.first ? 0 : Math.min(Math.floor(restored as number), CREDIT_EVERY_SONGS - 1);
    this.lastOnAir = this.first ? undefined : lastOnAir;
  }

  /** OBS says the stream just went live: the credit is due again, whatever went out before (a soundcheck) */
  newStream(): void {
    this.first = true;
  }

  /** Songs with facts since the last credit, for the session file; undefined until the first */
  get since(): number | undefined {
    return this.first ? undefined : this.songs;
  }

  /**
   * True when the credit goes with this song's facts. Due but `canShow` false (a test bubble up):
   * nothing counted, the next song gets it. `repeats` false (switch off): only the first each stream
   */
  songWithFacts(now: number, canShow = true, repeats = true): boolean {
    if (this.lastOnAir !== undefined && now - this.lastOnAir >= STREAM_BREAK_MS) this.first = true;
    this.lastOnAir = now;
    const due = this.first || (repeats && this.songs + 1 >= CREDIT_EVERY_SONGS);
    if (due && canShow) {
      this.first = false;
      this.songs = 0;
      return true;
    }
    if (!due) this.songs = Math.min(this.songs + 1, CREDIT_EVERY_SONGS - 1);
    return false;
  }
}

// BubbleFacts' own credits (its AI, or none while it downloads) count as one kind; another AI's is different
const creditKind = (text: string) => (text === OTHER_AI_CREDIT_TEXT ? "other" : "own");

/** The counter after a restart; a credit of another kind (AI switched) counts for nothing, so the new one goes first */
export function restoredCredit(s: Pick<Session, "creditSince" | "creditText" | "shownAt"> | null | undefined, text = creditText()): CreditCounter {
  const same = typeof s?.creditText === "string" && creditKind(s.creditText) === creditKind(text);
  return new CreditCounter(same ? s!.creditSince : undefined, s?.shownAt);
}

export interface CreditContext {
  /** The CREDIT_BUBBLE switch: off, the credit still goes out once each stream */
  enabled: boolean;
  /** An overlay is connected and bubbles aren't paused */
  onAir: boolean;
  /** When the streamer last pressed Test, or 0 */
  testAt: number;
  now: number;
  /** The song's first spot */
  position: Fact["position"];
  /** The song's first vertical spot */
  vertical?: Fact["vertical"];
}

/** The song's facts as they are, or the credit ahead of them; no facts, paused or no overlay use up no turn */
export function planCredit(counter: CreditCounter, facts: Fact[], c: CreditContext): { facts: Fact[]; credit?: Fact } {
  if (!facts.length || !c.onAir) return { facts };
  if (!counter.songWithFacts(c.now, c.now - c.testAt >= TEST_QUIET_MS, c.enabled)) return { facts };
  return withCredit(facts, c.position, c.vertical);
}

/** Seconds the song's bubbles move later for the credit: its time up, and a gap */
export function creditLead(credit: Fact): number {
  return Math.ceil(readingSeconds(credit)) + GAP_SECONDS;
}

/** The credit bubble, and the facts moved later; never in the song's record, so Wrong and the logs never see it */
export function withCredit(facts: Fact[], position: Fact["position"], vertical?: Fact["vertical"]): { credit: Fact; facts: Fact[] } {
  const credit: Fact = { text: creditText(), source: "BubbleFacts", delaySeconds: 0, durationSeconds: config.factDurationSeconds, position, ...(vertical ? { vertical } : {}) };
  const lead = creditLead(credit);
  return { credit, facts: facts.map((f) => ({ ...f, delaySeconds: f.delaySeconds + lead })) };
}
