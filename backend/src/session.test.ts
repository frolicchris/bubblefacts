import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-session-"));
jest.mock("./config", () => ({ config: { dataDir: dir } }));

import { factOnScreen, loadSession, readingSeconds, remainingFacts, REMEMBER_FOR_MS, sameRequest, saveSession } from "./session";
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
