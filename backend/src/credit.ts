import { config } from "./config";
import { readingSeconds, RESUME_WITHIN_MS } from "./session";
import { Fact } from "./types";

/**
 * The credit bubble (issue #278): one extra bubble that tells viewers where the
 * facts come from and that they may be wrong. It goes out before the first
 * song's facts of each stream, then with about every fifth song that has
 * facts, for viewers who joined later. `CREDIT_BUBBLE=off` stops the repeats
 * but not the first one: every stream that shows facts shows it at least once.
 */

export const CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts";
/** The credit comes with a song's facts this often: after one, the next is this many songs with facts later. */
export const CREDIT_EVERY_SONGS = 5;
/** Left clear after the credit before the song's own facts start. */
const GAP_SECONDS = 1;
/** A test bubble this recent is still up or just was: the credit waits for the next song. */
export const TEST_QUIET_MS = 20_000;
/**
 * No facts on stream for this long, and the next ones start a new stream: the credit goes first
 * again, even with the app left running in between. The same break that makes a restart start
 * the song afresh (`RESUME_WITHIN_MS`). A long break mid-stream may show it once more.
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

/**
 * The credit as a bubble, and the song's facts moved later by the time it
 * takes. The credit is only sent to the overlay: it is never in the record of
 * the song's facts, so Wrong, the dashboard and the shown log never see it.
 */
export function withCredit(facts: Fact[], position: Fact["position"], vertical?: Fact["vertical"]): { credit: Fact; facts: Fact[] } {
  const credit: Fact = { text: CREDIT_TEXT, source: "BubbleFacts", delaySeconds: 0, durationSeconds: config.factDurationSeconds, position, ...(vertical ? { vertical } : {}) };
  const lead = Math.ceil(readingSeconds(credit)) + GAP_SECONDS;
  return { credit, facts: facts.map((f) => ({ ...f, delaySeconds: f.delaySeconds + lead })) };
}
