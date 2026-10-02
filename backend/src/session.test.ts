import fs from "fs";
import os from "os";
import path from "path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bf-session-"));
jest.mock("./config", () => ({ config: { dataDir: dir } }));

import { loadSession, remainingFacts, REMEMBER_FOR_MS, sameRequest, saveSession } from "./session";
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
