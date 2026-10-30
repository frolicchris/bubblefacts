import { config } from "./config";
import { readingSeconds } from "./session";
import { Fact } from "./types";

/**
 * The credit bubble (issue #278): one extra bubble that tells viewers where the
 * facts come from and that they may be wrong. It goes out before the first
 * song's facts after BubbleFacts starts, then with about every fifth song that
 * has facts, for viewers who joined later. `CREDIT_BUBBLE=off` turns it off.
 */

export const CREDIT_TEXT = "Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts";
/** The credit comes with a song's facts this often: after one, the next is this many songs with facts later. */
export const CREDIT_EVERY_SONGS = 5;
/** Left clear after the credit before the song's own facts start. */
const GAP_SECONDS = 1;
/** A test bubble this recent is still up or just was: the credit waits for the next song. */
export const TEST_QUIET_MS = 20_000;

/**
 * When the credit is due. Counts only songs that go out with facts, so a song
 * with none never uses up a turn. `since` is saved in the session file: a
 * restart in the middle of a stream carries on with the count, while a start
 * with no session from that stream credits first.
 */
export class CreditCounter {
  private songs: number;
  private first: boolean;

  constructor(restored?: number) {
    this.first = typeof restored !== "number" || !Number.isFinite(restored) || restored < 0;
    this.songs = this.first ? 0 : Math.min(Math.floor(restored as number), CREDIT_EVERY_SONGS - 1);
  }

  /** Songs with facts since the credit last went out, for the session file; undefined until it first has. */
  get since(): number | undefined {
    return this.first ? undefined : this.songs;
  }

  /**
   * A song with facts is about to go out: true when the credit goes with it.
   * When it's due but `canShow` is false (a test bubble is up), nothing is
   * counted and the next song with facts gets it.
   */
  songWithFacts(canShow = true): boolean {
    const due = this.first || this.songs + 1 >= CREDIT_EVERY_SONGS;
    if (due && canShow) {
      this.first = false;
      this.songs = 0;
      return true;
    }
    if (!due) this.songs++;
    return false;
  }
}

export interface CreditContext {
  /** The CREDIT_BUBBLE switch. */
  enabled: boolean;
  /** An overlay is connected, and bubbles aren't paused: the facts are really going out. */
  onAir: boolean;
  /** When the streamer last pressed Test, or 0. */
  testAt: number;
  now: number;
  /** Where the credit sits: the song's first spot. */
  position: Fact["position"];
}

/**
 * What goes out for a song whose facts are ready: the facts as they are, or
 * the credit bubble ahead of them with their delays moved later. A song with
 * no facts, a stream that's paused or has no overlay, and the switch off all
 * leave the count alone, so none of them uses up a turn.
 */
export function planCredit(counter: CreditCounter, facts: Fact[], c: CreditContext): { facts: Fact[]; credit?: Fact } {
  if (!c.enabled || !facts.length || !c.onAir) return { facts };
  if (!counter.songWithFacts(c.now - c.testAt >= TEST_QUIET_MS)) return { facts };
  return withCredit(facts, c.position);
}

/**
 * The credit as a bubble, and the song's facts moved later by the time it
 * takes. The credit is only sent to the overlay: it is never in the record of
 * the song's facts, so Wrong, the dashboard and the shown log never see it.
 */
export function withCredit(facts: Fact[], position: Fact["position"]): { credit: Fact; facts: Fact[] } {
  const credit: Fact = { text: CREDIT_TEXT, source: "BubbleFacts", delaySeconds: 0, durationSeconds: config.factDurationSeconds, position };
  const lead = Math.ceil(readingSeconds(credit)) + GAP_SECONDS;
  return { credit, facts: facts.map((f) => ({ ...f, delaySeconds: f.delaySeconds + lead })) };
}
