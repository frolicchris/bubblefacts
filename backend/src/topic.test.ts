jest.mock("./config", () => ({ config: { topic: "video-game,classical,film,pop,piano,general", topicsDir: "" } }));

import fs from "fs";
import os from "os";
import path from "path";
import { config } from "./config";
import { loadTopics } from "./topic";

const ALL = "video-game,classical,film,pop,piano,general";

describe("loadTopics", () => {
  it("merges every pack named in the list", () => {
    const all = loadTopics(ALL);
    const game = loadTopics("video-game");
    expect(all.curatedFacts.length).toBeGreaterThan(game.curatedFacts.length);
    expect(all.curatedFacts).toEqual(expect.arrayContaining(game.curatedFacts));
  });

  it("takes originals lines from whichever packs provide them", () => {
    expect(loadTopics("video-game").originalsFacts).toEqual([]);
    expect(loadTopics("classical,general").originalsFacts.length).toBeGreaterThan(0);
  });

  it("tolerates spaces and repeats in the list", () => {
    expect(loadTopics(" classical , classical,general ")).toEqual(loadTopics("classical,general"));
  });

  it("rejects a pool too small to vary between songs", () => {
    expect(() => loadTopics("piano")).toThrow(/4 curated facts/);
  });

  it("names the available packs when one is unknown", () => {
    expect(() => loadTopics("jazz")).toThrow(/Available: .*classical/);
  });

  it("reads the streamer's own folder first, then the built-in examples", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topics-"));
    const own = ["One.", "Two.", "Three.", "Four.", "Five."];
    fs.writeFileSync(path.join(dir, "my-facts.json"), JSON.stringify({ id: "my-facts", name: "Mine", curatedFacts: own }));
    fs.writeFileSync(path.join(dir, "film.json"), JSON.stringify({ id: "film", name: "Mine too", curatedFacts: ["Six."] }));
    const cfg = config as unknown as { topicsDir: string };
    cfg.topicsDir = dir;
    try {
      expect(loadTopics("my-facts").curatedFacts).toEqual(own);
      expect(loadTopics("my-facts,film").curatedFacts).toContain("Six.");
      expect(loadTopics("classical").curatedFacts.length).toBeGreaterThan(0);
      expect(() => loadTopics("nope")).toThrow(/my-facts/);
    } finally {
      cfg.topicsDir = "";
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
