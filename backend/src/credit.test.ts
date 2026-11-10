import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-credit-"));
jest.mock("./config", () => ({ config: { dataDir: dir, factDurationSeconds: 8 } }));

import { config } from "./config";
import { CREDIT_EVERY_SONGS, CREDIT_TEXT, CreditCounter, creditText, NO_AI_CREDIT_TEXT, OTHER_AI_CREDIT_TEXT, planCredit, restoredCredit, STREAM_BREAK_MS, TEST_QUIET_MS, withCredit } from "./credit";
import { MAX_FACT_CHARS } from "./fact-limits";
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

  it("still goes with the first song of a stream when switched off, and only that one", () => {
    const off = { ...air, enabled: false };
    const counter = new CreditCounter();
    const shown = run(counter, Array.from({ length: 12 }, () => facts), off);
    expect(shown.map((s, i) => (s ? i + 1 : 0)).filter(Boolean)).toEqual([1]);
    // Songs without facts, paused or with no overlay don't use it up: it waits for the first facts viewers see.
    const later = new CreditCounter();
    expect(run(later, [[], facts], { ...off, onAir: false })).toEqual([false, false]);
    expect(run(later, [[], facts, facts], off)).toEqual([false, true, false]);
  });

  it("waits for a test bubble to clear when switched off too, and still goes with the next song", () => {
    const counter = new CreditCounter();
    const off = { ...air, enabled: false };
    expect(run(counter, [facts], { ...off, testAt: NOW - TEST_QUIET_MS + 1 })).toEqual([false]);
    expect(run(counter, [facts, facts], off)).toEqual([true, false]);
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

describe("OBS saying the stream went live", () => {
  it("makes the credit due again, even switched off and used up on a soundcheck", () => {
    const off = { ...air, enabled: false };
    const counter = new CreditCounter();
    // Songs with OBS open before going live: the one credit goes with the first.
    expect(run(counter, [facts, facts], off)).toEqual([true, false]);
    counter.newStream();
    expect(run(counter, [facts, facts], off)).toEqual([true, false]);
  });

  it("restarts the count of 5 when switched on", () => {
    const counter = new CreditCounter();
    expect(run(counter, [facts, facts, facts])).toEqual([true, false, false]);
    counter.newStream();
    expect(run(counter, Array.from({ length: 6 }, () => facts))).toEqual([true, false, false, false, false, true]);
  });
});

describe("a new stream with the app left running", () => {
  /** Songs with facts, each at its own time. */
  const at = (counter: CreditCounter, times: number[], enabled = true) => times.map((now) => !!planCredit(counter, facts, { ...air, enabled, now }).credit);

  it("credits first again after a break with no facts on stream, switched on or off", () => {
    for (const enabled of [true, false]) {
      const counter = new CreditCounter();
      const next = NOW + 2 * 60_000 + STREAM_BREAK_MS;
      expect(at(counter, [NOW, NOW + 60_000, NOW + 2 * 60_000, next, next + 60_000], enabled)).toEqual([true, false, false, true, false]);
    }
  });

  it("carries on when the gap between songs is shorter than a break", () => {
    const counter = new CreditCounter();
    const times = Array.from({ length: 12 }, (_, i) => NOW + i * (STREAM_BREAK_MS - 1));
    expect(at(counter, times, false)).toEqual(times.map((_, i) => i === 0));
  });

  it("counts only time with facts on stream: an overlay that's away doesn't move the clock", () => {
    const counter = new CreditCounter();
    expect(at(counter, [NOW], false)).toEqual([true]);
    // Facts that went nowhere don't count as on stream.
    expect(planCredit(counter, facts, { ...air, enabled: false, onAir: false, now: NOW + STREAM_BREAK_MS - 1 }).credit).toBeUndefined();
    expect(at(counter, [NOW + STREAM_BREAK_MS], false)).toEqual([true]);
  });
});

describe("the credit bubble's content", () => {
  it("says where facts come from, as a normal bubble in the song's first spot before its facts", () => {
    const planned = planCredit(new CreditCounter(), facts, air);
    expect(planned.credit).toEqual({ text: CREDIT_TEXT, source: "BubbleFacts", delaySeconds: 0, durationSeconds: 8, position });
    expect(CREDIT_TEXT).toBe("Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz, retold by AI. Spot a mistake? Let the streamer know. · BubbleFacts");
  });

  it("says when another AI writes the facts that BubbleFacts doesn't verify them, at a bubble's length", () => {
    expect(OTHER_AI_CREDIT_TEXT).toBe("Some facts are adapted from Wikipedia (CC BY-SA 4.0) by an AI the streamer chose. Not verified by BubbleFacts; may be wrong. bubblefacts.frolic.org/credits.html");
    for (const text of [CREDIT_TEXT, OTHER_AI_CREDIT_TEXT, NO_AI_CREDIT_TEXT]) expect(text.length).toBeLessThanOrEqual(MAX_FACT_CHARS);
    // Groq and other OpenAI-style services, Anthropic, and the streamer's own Ollama.
    for (const ai of ["openai", "anthropic", "ollama"]) expect(creditText(ai)).toBe(OTHER_AI_CREDIT_TEXT);
    // BubbleFacts' own AI keeps the usual credit.
    for (const ai of ["builtin", undefined]) expect(creditText(ai)).toBe(CREDIT_TEXT);
    // With no AI (the app while its AI downloads, the command line), it never says "retold by AI",
    // but Wikipedia keeps its credit: some facts can still be its sentences.
    expect(creditText("none")).toBe(NO_AI_CREDIT_TEXT);
    expect(NO_AI_CREDIT_TEXT).toBe("Facts from Wikipedia (CC BY-SA 4.0), Wikidata and MusicBrainz. Spot a mistake? Let the streamer know. · BubbleFacts");
    expect(NO_AI_CREDIT_TEXT).not.toMatch(/\bAI\b/);
  });

  it("goes out with the other AI's wording when one is writing, switched on or off", () => {
    const cfg = config as { aiProvider?: string };
    cfg.aiProvider = "anthropic";
    try {
      for (const enabled of [true, false]) expect(planCredit(new CreditCounter(), facts, { ...air, enabled }).credit?.text).toBe(OTHER_AI_CREDIT_TEXT);
    } finally {
      delete cfg.aiProvider;
    }
    expect(planCredit(new CreditCounter(), facts, air).credit?.text).toBe(CREDIT_TEXT);
  });

  it("takes the song's first vertical spot on the vertical overlay (issue #175)", () => {
    const vertical = { top: "15%" };
    expect(planCredit(new CreditCounter(), facts, { ...air, vertical }).credit).toMatchObject({ position, vertical });
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
    const counter = new CreditCounter(2, NOW - 60_000);
    expect(planCredit(counter, facts, air)).toEqual({ facts });
  });
});

describe("the credit count across a restart", () => {
  const SHOWN = NOW - 60_000;
  const save = (creditSince?: number, shownAt = SHOWN) =>
    saveSession({ song: { title: "The Moon", artist: "DuckTales" }, facts, shownAt, recent: [], savedAt: SHOWN, ...(creditSince === undefined ? {} : { creditSince }) });
  const restart = (now = NOW) => {
    const s = loadSession(now);
    return new CreditCounter(s?.creditSince, s?.shownAt);
  };

  it("carries on from the session file instead of crediting again", () => {
    const before = new CreditCounter();
    run(before, [facts, facts, facts]);
    expect(before.since).toBe(2);
    save(before.since);

    // Two more songs finish the count of 5, so the credit comes with the 3rd.
    expect(run(restart(), [facts, facts, facts])).toEqual([false, false, true]);
    // Switched off, a restart in the middle of a stream doesn't credit again.
    save(2);
    expect(run(restart(), [facts, facts, facts], { ...air, enabled: false })).toEqual([false, false, false]);
  });

  it("credits first when there is no session from this stream, or none counted yet", () => {
    save();
    expect(loadSession(NOW)).not.toBeNull();
    expect(run(restart(), [facts])).toEqual([true]);
    expect(run(restart(SHOWN + 7 * 60 * 60_000), [facts])).toEqual([true]);
  });

  it("credits first when the last facts went out a stream break ago, or to no overlay, switched on or off", () => {
    for (const enabled of [true, false]) {
      // Still in the session file's window, but after a break: another stream.
      save(2, NOW - STREAM_BREAK_MS);
      expect(run(restart(), [facts], { ...air, enabled })).toEqual([true]);
      // The last song went out with no overlay connected, so when viewers last saw facts isn't known.
      save(2, 0);
      expect(run(restart(), [facts], { ...air, enabled })).toEqual([true]);
    }
  });

  it("credits first after a switch to another AI mid-stream, or back, so each stream shows the credit that fits", () => {
    const session = { creditSince: 2, creditText: CREDIT_TEXT, shownAt: SHOWN };
    expect(run(restoredCredit(session, CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([false]);
    expect(run(restoredCredit(session, OTHER_AI_CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([true]);
    expect(run(restoredCredit({ ...session, creditText: OTHER_AI_CREDIT_TEXT }, CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([true]);
    // The built-in AI finishing its download restarts the server: the no-AI credit counts, not another one.
    expect(run(restoredCredit({ ...session, creditText: NO_AI_CREDIT_TEXT }, CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([false]);
    expect(run(restoredCredit(session, NO_AI_CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([false]);
    expect(run(restoredCredit({ ...session, creditText: NO_AI_CREDIT_TEXT }, OTHER_AI_CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([true]);
    // A session from before the credit's wording was saved credits first, once.
    expect(run(restoredCredit({ creditSince: 2, shownAt: SHOWN }, CREDIT_TEXT), [facts])).toEqual([true]);
    expect(run(restoredCredit(null, CREDIT_TEXT), [facts])).toEqual([true]);
    // The wording goes through the session file and back.
    saveSession({ song: { title: "The Moon", artist: "DuckTales" }, facts, shownAt: SHOWN, recent: [], savedAt: SHOWN, creditSince: 2, creditText: OTHER_AI_CREDIT_TEXT });
    expect(run(restoredCredit(loadSession(NOW), OTHER_AI_CREDIT_TEXT), [facts], { ...air, enabled: false })).toEqual([false]);
  });

  it("ignores a count in the file that can't be right", () => {
    expect(new CreditCounter(-1).since).toBeUndefined();
    expect(new CreditCounter(Number.NaN).since).toBeUndefined();
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ song: { title: "A", artist: "B" }, facts: [], recent: [], savedAt: 1000, shownAt: 0, creditSince: "3" }));
    expect(loadSession(2000)).toBeNull();
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ song: { title: "A", artist: "B" }, facts: [], recent: [], savedAt: 1000, shownAt: 0, creditSince: 3, creditText: 7 }));
    expect(loadSession(2000)).toBeNull();
    expect(new CreditCounter(99, NOW).since).toBe(CREDIT_EVERY_SONGS - 1);
    // A count with no time facts were last on stream can't say which stream it's from.
    expect(new CreditCounter(2).since).toBeUndefined();
    expect(new CreditCounter(2, Number.NaN).since).toBeUndefined();
  });
});
