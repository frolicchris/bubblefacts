import { config } from "./config";
import { readingSeconds, RESUME_WITHIN_MS, type Session } from "./session";
import { Fact } from "./types";

/**
 * The credit bubble (issue #278): one extra bubble that tells viewers where the
 * facts come from and that they may be wrong. It goes out before the first
 * song's facts of each stream, then with about every fifth song that has
 * facts, for viewers who joined later. `CREDIT_BUBBLE=off` stops the repeats
 * but not the first one: every stream that shows facts shows it at least once.
 * When an AI other than BubbleFacts' own writes the facts, the credit says so,
 * that BubbleFacts doesn't verify them, and where the full disclaimer is
 * (`OTHER_AI_CREDIT_TEXT`).
 */

export const CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts";
/**
 * The credit when the streamer chose another AI to write the facts: an online service (Groq and
 * other OpenAI-style services, Anthropic) or their own Ollama model. BubbleFacts' screening still
 * runs, but it's word-level, not verification, and the fact check before each release is the
 * built-in AI's, so BubbleFacts doesn't stand behind what another AI writes. Every word is a fact a
 * viewer can check, not a conclusion: who adapted the facts (an AI the streamer chose), that
 * BubbleFacts didn't verify them, that they may be wrong, and the page with the full disclaimer
 * and the license notices (credits.html#other-ai). "Adapted" and the license name are what CC BY-SA
 * 4.0 asks of a modified work (section 3(a)(1)(B) and (C)); the page covers the rest
 * (section 3(a)(2)). Wikidata and MusicBrainz (CC0) need no credit, and the page names them. Within
 * MAX_FACT_CHARS, like any bubble. Its wording was weighed for legal soundness, but not by a lawyer.
 */
export const OTHER_AI_CREDIT_TEXT = "Some facts are adapted from Wikipedia (CC BY-SA 4.0) by an AI the streamer chose. Not verified by BubbleFacts; may be wrong. bubblefacts.frolic.org/credits.html";
/**
 * The credit when no AI writes (`AI_PROVIDER=none`): BubbleFacts Lite, the full app while its AI
 * downloads or can't run, and the command line set to no AI. Some facts can still be sentences
 * taken from a Wikipedia article (`artistGoodFacts`), so Wikipedia keeps its credit, but nothing
 * is "retold by AI".
 */
export const NO_AI_CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz. Spot a mistake? Let the streamer know. · BubbleFacts";
const OTHER_AIS: ReadonlySet<string> = new Set(["openai", "anthropic", "ollama"]);
/** The credit for the AI that writes the facts (`AI_PROVIDER`), or for no AI. */
export function creditText(provider: string | undefined = config.aiProvider): string {
  if (provider === "none") return NO_AI_CREDIT_TEXT;
  return provider !== undefined && OTHER_AIS.has(provider) ? OTHER_AI_CREDIT_TEXT : CREDIT_TEXT;
}
/** The credit comes with a song's facts this often: after one, the next is this many songs with facts later. */
export const CREDIT_EVERY_SONGS = 5;
/** Left clear after the credit before the song's own facts start. */
const GAP_SECONDS = 1;
/** A test bubble this recent is still up or just was: the credit waits for the next song. */
export const TEST_QUIET_MS = 20_000;
/**
 * No facts sent to an overlay for this long, and the next ones start a new stream: the credit goes
 * first again, even with the app left running in between. The same break that makes a restart
 * start the song afresh (`RESUME_WITHIN_MS`). A long break mid-stream may show it once more.
 * This is the fallback: when OBS says the stream went live (`newStream`), the credit is due then,
 * so facts sent to OBS before going live (a soundcheck) can't use up the stream's one credit.
 */
export const STREAM_BREAK_MS = RESUME_WITHIN_MS;

/**
 * When the credit is due. Counts only songs that go out with facts, so a song
 * with none never uses up a turn. `since` is saved in the session file: a
 * restart in the middle of a stream carries on with the count, while a start
 * with no session from that stream credits first. So does a restart whose last
 * facts went out to an overlay a stream break ago, or at no known time.
 */
export class CreditCounter {
  private songs: number;
  private first: boolean;
  /** When facts last went out to an overlay, for telling one stream from the next. */
  private lastOnAir: number | undefined;

  /** `restored` and `lastOnAir`: the session file's `creditSince` and `shownAt`. */
  constructor(restored?: number, lastOnAir?: number) {
    const known = typeof lastOnAir === "number" && Number.isFinite(lastOnAir) && lastOnAir > 0;
    this.first = !known || typeof restored !== "number" || !Number.isFinite(restored) || restored < 0;
    this.songs = this.first ? 0 : Math.min(Math.floor(restored as number), CREDIT_EVERY_SONGS - 1);
    this.lastOnAir = this.first ? undefined : lastOnAir;
  }

  /**
   * OBS says the stream just went live (obs-streaming.ts): the credit is due again, as at a start,
   * with the switch on or off, whatever went out before (a soundcheck with OBS open, say).
   */
  newStream(): void {
    this.first = true;
  }

  /** Songs with facts since the credit last went out, for the session file; undefined until it first has. */
  get since(): number | undefined {
    return this.first ? undefined : this.songs;
  }

  /**
   * A song with facts is about to go out to an overlay at `now`: true when the
   * credit goes with it. When it's due but `canShow` is false (a test bubble is
   * up), nothing is counted and the next song with facts gets it. With
   * `repeats` false (the switch off), only the first of each stream is due.
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

/**
 * The counter after a restart, from the session file. A session whose credit said something else
 * (the streamer switched AI) counts for nothing: the new credit goes first, so every stream shows
 * the one that fits the AI writing its facts.
 */
export function restoredCredit(s: Pick<Session, "creditSince" | "creditText" | "shownAt"> | null | undefined, text = creditText()): CreditCounter {
  return new CreditCounter(s?.creditText === text ? s.creditSince : undefined, s?.shownAt);
}

export interface CreditContext {
  /** The CREDIT_BUBBLE switch: off, the credit still goes out once each stream. */
  enabled: boolean;
  /** An overlay is connected, and bubbles aren't paused: the facts are really going out. */
  onAir: boolean;
  /** When the streamer last pressed Test, or 0. */
  testAt: number;
  now: number;
  /** Where the credit sits: the song's first spot. */
  position: Fact["position"];
  /** And on the vertical overlay: the song's first vertical spot. */
  vertical?: Fact["vertical"];
}

/**
 * What goes out for a song whose facts are ready: the facts as they are, or
 * the credit bubble ahead of them with their delays moved later. A song with
 * no facts and a stream that's paused or has no overlay leave the count alone,
 * so neither uses up a turn: the credit goes with the first facts viewers see.
 * The switch off still credits the first of each stream.
 */
export function planCredit(counter: CreditCounter, facts: Fact[], c: CreditContext): { facts: Fact[]; credit?: Fact } {
  if (!facts.length || !c.onAir) return { facts };
  if (!counter.songWithFacts(c.now, c.now - c.testAt >= TEST_QUIET_MS, c.enabled)) return { facts };
  return withCredit(facts, c.position, c.vertical);
}

/** How much later the song's bubbles go so the credit has its time: as long as it's up, and a gap. */
export function creditLead(credit: Fact): number {
  return Math.ceil(readingSeconds(credit)) + GAP_SECONDS;
}

/**
 * The credit as a bubble, and the song's facts moved later by the time it
 * takes. The credit is only sent to the overlay: it is never in the record of
 * the song's facts, so Wrong, the dashboard and the shown log never see it.
 */
export function withCredit(facts: Fact[], position: Fact["position"], vertical?: Fact["vertical"]): { credit: Fact; facts: Fact[] } {
  const credit: Fact = { text: creditText(), source: "BubbleFacts", delaySeconds: 0, durationSeconds: config.factDurationSeconds, position, ...(vertical ? { vertical } : {}) };
  const lead = creditLead(credit);
  return { credit, facts: facts.map((f) => ({ ...f, delaySeconds: f.delaySeconds + lead })) };
}
