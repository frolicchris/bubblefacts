import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-credit-"));
jest.mock("./config", () => ({ config: { dataDir: dir, factDurationSeconds: 8 } }));

import { CREDIT_EVERY_SONGS, CREDIT_TEXT, CreditCounter, planCredit, TEST_QUIET_MS, withCredit } from "./credit";
import { loadSession, saveSession } from "./session";
import { Fact } from "./types";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const position = { top: "8%", left: "33%" };
const fact = (text: string, delaySeconds: number): Fact => ({ text, delaySeconds, durationSeconds: 8, position });
const facts = [fact("One.", 0), fact("Two.", 15)];
const NOW = 1_000_000;
const air = { enabled: true, onAir: true, testAt: 0, now: NOW, position };

/** Which of these songs went out with the credit; a song is its facts, or none. */
function run(counter: CreditCounter, songs: Fact[][], context = air): boolean[] {
  return songs.map((f) => !!planCredit(counter, f, context).credit);
}

describe("the credit bubble's timing", () => {
  it("goes with the first song with facts after a start, then with every 5th", () => {
    const shown = run(new CreditCounter(), Array.from({ length: 12 }, () => facts));
    expect(shown.map((s, i) => (s ? i + 1 : 0)).filter(Boolean)).toEqual([1, 1 + CREDIT_EVERY_SONGS, 1 + 2 * CREDIT_EVERY_SONGS]);
  });

  it("does not count songs without facts, and never shows for one", () => {
    const counter = new CreditCounter();
    expect(run(counter, [[], []])).toEqual([false, false]);
    // Still the first song with facts after the start.
    expect(run(counter, [facts])).toEqual([true]);
    // Four songs between, with a run of songs without facts that count for nothing.
    const between = [facts, [], facts, [], [], facts, facts];
    expect(run(counter, between)).toEqual(between.map(() => false));
    expect(run(counter, [[]])).toEqual([false]);
    expect(run(counter, [facts])).toEqual([true]);
  });

  it("is off with the switch, and the count stays where it was", () => {
    const counter = new CreditCounter();
    expect(run(counter, [facts, facts], { ...air, enabled: false })).toEqual([false, false]);
    expect(counter.since).toBeUndefined();
    expect(run(counter, [facts])).toEqual([true]);
  });

  it("waits while paused or with no overlay connected, since nobody sees it", () => {
    const counter = new CreditCounter();
    expect(run(counter, [facts], { ...air, onAir: false })).toEqual([false]);
    expect(run(counter, [facts])).toEqual([true]);
  });

  it("keeps clear of a test bubble and goes with the next song instead", () => {
    const counter = new CreditCounter();
    const justTested = { ...air, testAt: NOW - TEST_QUIET_MS + 1 };
    expect(run(counter, [facts, facts], justTested)).toEqual([false, false]);
    expect(run(counter, [facts], { ...air, testAt: NOW - TEST_QUIET_MS })).toEqual([true]);
    // Due again in 5 songs, and a test just before that one holds it back one song.
    expect(run(counter, [facts, facts, facts, facts])).toEqual([false, false, false, false]);
    expect(run(counter, [facts], justTested)).toEqual([false]);
    expect(run(counter, [facts])).toEqual([true]);
  });
});

describe("the credit bubble's content", () => {
  it("says where facts come from, as a normal bubble in the song's first spot before its facts", () => {
    const planned = planCredit(new CreditCounter(), facts, air);
    expect(planned.credit).toEqual({ text: CREDIT_TEXT, source: "BubbleFacts", delaySeconds: 0, durationSeconds: 8, position });
    expect(CREDIT_TEXT).toBe("Facts from Wikipedia, Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts");
  });

  it("moves the song's facts after it without changing them or adding to them", () => {
    const planned = withCredit(facts, position);
    expect(planned.facts.map((f) => f.text)).toEqual(["One.", "Two."]);
    const lead = planned.facts[0].delaySeconds;
    expect(lead).toBeGreaterThan(8);
    expect(planned.facts[1].delaySeconds).toBe(lead + 15);
    expect(facts[0].delaySeconds).toBe(0);
    expect(planned.facts).not.toContain(planned.credit);
  });

  it("leaves the facts alone when it isn't due", () => {
    const counter = new CreditCounter(2);
    expect(planCredit(counter, facts, air)).toEqual({ facts });
  });
});

describe("the credit count across a restart", () => {
  const save = (creditSince?: number) =>
    saveSession({ song: { title: "The Moon", artist: "DuckTales" }, facts, shownAt: 1000, recent: [], savedAt: 1000, ...(creditSince === undefined ? {} : { creditSince }) });

  it("carries on from the session file instead of crediting again", () => {
    const before = new CreditCounter();
    run(before, [facts, facts, facts]);
    expect(before.since).toBe(2);
    save(before.since);

    const after = new CreditCounter(loadSession(2000)?.creditSince);
    // Two more songs finish the count of 5, so the credit comes with the 3rd.
    expect(run(after, [facts, facts, facts])).toEqual([false, false, true]);
  });

  it("credits first when there is no session from this stream, or none counted yet", () => {
    save();
    expect(loadSession(2000)).not.toBeNull();
    expect(run(new CreditCounter(loadSession(2000)?.creditSince), [facts])).toEqual([true]);
    expect(run(new CreditCounter(loadSession(1000 + 7 * 60 * 60_000)?.creditSince), [facts])).toEqual([true]);
  });

  it("ignores a count in the file that can't be right", () => {
    expect(new CreditCounter(-1).since).toBeUndefined();
    expect(new CreditCounter(Number.NaN).since).toBeUndefined();
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ song: { title: "A", artist: "B" }, facts: [], recent: [], savedAt: 1000, shownAt: 0, creditSince: "3" }));
    expect(loadSession(2000)).toBeNull();
    expect(new CreditCounter(99).since).toBe(CREDIT_EVERY_SONGS - 1);
  });
});
