jest.mock("./config", () => ({ config: { topic: "video-game,classical,film,pop,general" } }));

import { DEFAULT_TOPICS, loadTopics } from "./topic";

describe("loadTopics", () => {
  it("merges every pack named in the list", () => {
    const all = loadTopics(DEFAULT_TOPICS);
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
    expect(() => loadTopics("pop")).toThrow(/2 curated facts/);
  });

  it("names the available packs when one is unknown", () => {
    expect(() => loadTopics("jazz")).toThrow(/Available: .*classical/);
  });
});
