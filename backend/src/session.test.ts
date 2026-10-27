import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-session-"));
jest.mock("./config", () => ({ config: { dataDir: dir } }));

import { bubbleNow, catchUpFacts, factOnScreen, loadSession, readingSeconds, remainingFacts, REMEMBER_FOR_MS, sameRequest, saveSession, withLaterFacts } from "./session";
import { Fact } from "./types";

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fact = (text: string, delaySeconds: number): Fact => ({ text, delaySeconds, durationSeconds: 8, position: { top: "8%", left: "33%" } });
const facts = [fact("One.", 0), fact("Two.", 15), fact("Three.", 30)];

describe("the saved session", () => {
  it("comes back after a restart, with what was shown and when", () => {
    saveSession({ song: { title: "The Moon", artist: "DuckTales" }, facts, shownAt: 1000, recent: ["One.", "Earlier."], savedAt: 1000 });
    expect(loadSession(2000)).toMatchObject({ song: { title: "The Moon" }, shownAt: 1000, recent: ["One.", "Earlier."] });
  });

  it("is forgotten by the next stream, and when the file is damaged", () => {
    saveSession({ song: { title: "The Moon", artist: "DuckTales" }, facts, shownAt: 1000, recent: [], savedAt: 1000 });
    expect(loadSession(1000 + REMEMBER_FOR_MS)).toBeNull();
    fs.writeFileSync(path.join(dir, "session.json"), '{"song":{"title":5},"facts":"no"}');
    expect(loadSession(2000)).toBeNull();
    fs.writeFileSync(path.join(dir, "session.json"), "not json");
    expect(loadSession(2000)).toBeNull();
  });
});

describe("remainingFacts", () => {
  it("gives only the bubbles still to come, on their remaining delays", () => {
    const left = remainingFacts(facts, 1000, 1000 + 20_000);
    expect(left.map((f) => [f.text, f.delaySeconds])).toEqual([["Three.", 10]]);
    expect(remainingFacts(facts, 1000, 1000 + 60_000)).toEqual([]);
  });

  it("gives them all when no overlay had seen them", () => {
    expect(remainingFacts(facts, 0, 99_999)).toBe(facts);
  });
});

describe("catchUpFacts, for an overlay that reloads mid-song (issue #279)", () => {
  it("puts the bubble on screen back for the time it has left, and the rest on their remaining delays", () => {
    const left = catchUpFacts(facts, 1000, 1000 + 20_000);
    expect(left.map((f) => [f.text, f.delaySeconds, f.durationSeconds])).toEqual([["Two.", 0, 3], ["Three.", 10, 8]]);
  });

  it("leaves out a bubble with under 2 seconds left, or one a later bubble already replaced in its spot", () => {
    expect(catchUpFacts(facts, 1000, 1000 + 21_500).map((f) => f.text)).toEqual(["Three."]);
    const oneSpot = [fact("Long one, still within its own reading time here.", 0), fact("Next.", 5)];
    expect(catchUpFacts(oneSpot, 1000, 1000 + 6000).map((f) => f.text)).toEqual(["Next."]);
  });

  it("gives them all when no overlay had seen them", () => {
    expect(catchUpFacts(facts, 0, 99_999)).toBe(facts);
  });
});

describe("sameRequest", () => {
  it("matches on title and artist", () => {
    expect(sameRequest({ title: "A", artist: "B" }, { title: "A", artist: "B" })).toBe(true);
    expect(sameRequest({ title: "A", artist: "B" }, { title: "A", artist: "C" })).toBe(false);
    expect(sameRequest(null, { title: "A", artist: "B" })).toBe(false);
  });
});

describe("the bubble a hands-free Wrong is for", () => {
  const at = (seconds: number) => 1000 + seconds * 1000;

  it("is none before any bubble has gone out, or when no overlay saw them", () => {
    expect(factOnScreen(facts, 0, at(20))).toBeNull();
    expect(factOnScreen([fact("Later.", 10)], 1000, at(5))).toBeNull();
    expect(factOnScreen([], 1000, at(5))).toBeNull();
  });

  it("is the one on stream now", () => {
    expect(factOnScreen(facts, 1000, at(3))?.text).toBe("One.");
    expect(factOnScreen(facts, 1000, at(17))?.text).toBe("Two.");
  });

  it("is the one shown last when none is up", () => {
    expect(factOnScreen(facts, 1000, at(12))?.text).toBe("One.");
    expect(factOnScreen(facts, 1000, at(600))?.text).toBe("Three.");
  });

  it("follows the delays a resumed or restarted song was sent with, in any order", () => {
    expect(factOnScreen([fact("Late.", 20), fact("Early.", 2)], 1000, at(10))?.text).toBe("Early.");
  });

  it("is the one before when a new bubble only just popped up over it", () => {
    const overlapping = [fact("First.", 0), fact("Second.", 6)];
    expect(factOnScreen(overlapping, 1000, at(6.5))?.text).toBe("First.");
    expect(factOnScreen(overlapping, 1000, at(8))?.text).toBe("Second.");
    // One at a time, the earlier bubble is gone, so the new one is meant.
    expect(factOnScreen(facts, 1000, at(15.5))?.text).toBe("Two.");
  });

  it("keeps a long fact up as long as the overlay does", () => {
    const long = { text: Array(30).fill("word").join(" "), durationSeconds: 8 };
    expect(readingSeconds(long)).toBe(12);
    expect(readingSeconds({ text: "Short.", durationSeconds: 8 })).toBe(8);
  });
});

describe("factOnScreen after a hands-free Wrong", () => {
  const shownAt = 1_000_000;
  it("never works back to bubbles that appeared before the last press", () => {
    const facts = [fact("First fact here.", 0), fact("Second fact here.", 10)];
    // The second was marked at 12 s and removed; a repeat press at 30 s finds nothing newer.
    expect(factOnScreen([facts[0]], shownAt, shownAt + 30_000, shownAt + 12_000)).toBeNull();
    // A bubble that appears after the press still counts.
    expect(factOnScreen([...facts, fact("Third fact here.", 20)], shownAt, shownAt + 21_000, shownAt + 12_000)?.text).toBe("Third fact here.");
  });
});

describe("the bubble the dashboard marks as on stream", () => {
  const at = (seconds: number) => 1000 + seconds * 1000;

  it("is none, and nothing next, before the facts went out", () => {
    expect(bubbleNow(facts, 0, at(5))).toEqual({ up: [], nextInSeconds: null });
  });

  it("names the bubble that is up", () => {
    expect(bubbleNow(facts, 1000, at(3))).toEqual({ up: ["One."], nextInSeconds: 12 });
  });

  it("counts down to the next bubble between two", () => {
    expect(bubbleNow(facts, 1000, at(10.5))).toEqual({ up: [], nextInSeconds: 5 });
  });

  it("has no next bubble after the last one is gone", () => {
    expect(bubbleNow(facts, 1000, at(600))).toEqual({ up: [], nextInSeconds: null });
  });

  it("drops a bubble a later one in the same spot replaced, and keeps one in another spot", () => {
    const other = { ...fact("Elsewhere.", 2), position: { bottom: "8%", left: "33%" } };
    const overlapping = [fact("First.", 0), other, fact("Second.", 6)];
    expect(bubbleNow(overlapping, 1000, at(7)).up).toEqual(["Elsewhere.", "Second."]);
  });

  it("keeps a long fact up for its reading time", () => {
    const long = fact(Array(60).fill("word").join(" "), 0);
    expect(bubbleNow([long], 1000, at(15)).up).toEqual([long.text]);
  });
});

describe("the AI's captions after the facts from data (issue #256)", () => {
  const at = (text: string, delaySeconds: number): Fact => ({ text, delaySeconds, durationSeconds: 8, position: { top: "5%", left: "3%" } });
  const early = [at("Data one.", 0), at("Data two.", 15)];
  const all = [...early, at("Caption one.", 30), at("Caption two.", 45)];

  it("adds the captions after the last fact sent, never in the past", () => {
    // Sent with a credit bubble ahead: the record's delays are 7 seconds later.
    const record = [at("Data one.", 7), at("Data two.", 22)];
    expect(withLaterFacts(record, early, all, 3, 15).map((f) => [f.text, f.delaySeconds])).toEqual([
      ["Data one.", 7], ["Data two.", 22], ["Caption one.", 37], ["Caption two.", 52],
    ]);
    // The AI was slow: the facts from data have all been shown.
    expect(withLaterFacts(record, early, all, 60, 15).slice(2).map((f) => f.delaySeconds)).toEqual([61, 76]);
  });

  it("never adds a fact twice, nor one taken off with Wrong", () => {
    const record = [at("Data two.", 15)];
    const merged = withLaterFacts(record, early, [...all, at("Data two.", 60)], 0, 15);
    expect(merged.map((f) => f.text)).toEqual(["Data two.", "Caption one.", "Caption two."]);
  });

  it("leaves the record alone when the AI added nothing", () => {
    expect(withLaterFacts(early, early, early, 5, 15)).toEqual(early);
  });
});
