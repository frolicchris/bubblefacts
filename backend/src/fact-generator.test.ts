import { clearFactCache } from "./fact-generator";
import { PopUpFact, SSLSong } from "./types";

// Mock the Anthropic SDK
jest.mock("@anthropic-ai/sdk", () => {
  const mock = jest.fn().mockImplementation(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: `This song topped the Billboard Hot 100 for 3 weeks.
The music video was filmed in a single take.
The bass line was inspired by a Motown classic.
It was originally written for another artist.
The recording session lasted only 4 hours.`,
          },
        ],
      }),
    },
  }));
  return { __esModule: true, default: mock };
});

// Mock config to avoid requiring env vars in tests
jest.mock("./config", () => ({
  config: {
    sslStreamerName: "teststreamer",
    streamerDisplayName: "teststreamer",
    instrument: "",
    topic: "video-game-music",
    aiProvider: "anthropic",
    anthropicApiKey: "test-key",
    ollamaBaseUrl: "http://localhost:11434",
    ollamaModel: "llama3.2",
    ollamaTemperature: 0.2,
    // Exercise the plumbing (ids, timing, positions, caching, fallback)
    // without hitting Wikipedia; grounding and screening are covered in
    // fact-verifier.test.ts.
    factVerification: false,
    factsPerSong: 5,
    factIntervalSeconds: 15,
    factDurationSeconds: 8,
  },
}));

describe("fact-generator", () => {
  beforeEach(() => {
    clearFactCache();
  });

  it("produces no facts and no grounding call for a live learn", async () => {
    const verifier = require("./fact-verifier");
    const groundingSpy = jest.spyOn(verifier, "fetchGrounding");
    const { generateFacts, factStats } = require("./fact-generator");

    const before = factStats.liveLearn;
    const song: SSLSong = {
      title: "Some Song Nobody Has Charted",
      artist: "Unknown",
      liveLearn: true,
      requestedBy: "viewer1",
    };
    const facts: PopUpFact[] = await generateFacts(song, {
      id: 9,
      songId: null,
      song: { title: "", artist: "" },
      nonlistSong: "Some Song Nobody Has Charted",
      note: null,
      streamerId: 1,
      createdAt: "2026-09-24T00:00:00Z",
      requests: [{ id: 1, name: "viewer1" }],
    });

    expect(facts).toEqual([]);
    expect(groundingSpy).not.toHaveBeenCalled();
    expect(factStats.liveLearn).toBe(before + 1);
    groundingSpy.mockRestore();
  });

  it("should generate the correct number of facts", async () => {
    const { generateFacts } = require("./fact-generator");

    const song: SSLSong = { title: "Bohemian Rhapsody", artist: "Queen" };
    const facts: PopUpFact[] = await generateFacts(song);

    expect(facts).toHaveLength(5);
  });

  it("should assign unique IDs to each fact", async () => {
    const { generateFacts } = require("./fact-generator");

    const song: SSLSong = { title: "Test Song", artist: "Test Artist" };
    const facts: PopUpFact[] = await generateFacts(song);

    const ids = facts.map((f) => f.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("should stagger fact appearance times", async () => {
    const { generateFacts } = require("./fact-generator");

    const song: SSLSong = { title: "Test Song", artist: "Test Artist" };
    const facts: PopUpFact[] = await generateFacts(song);

    for (let i = 0; i < facts.length; i++) {
      expect(facts[i].appearAtSecond).toBe(i * 15);
    }
  });

  it("should assign positions to each fact", async () => {
    const { generateFacts } = require("./fact-generator");

    const song: SSLSong = { title: "Test Song", artist: "Test Artist" };
    const facts: PopUpFact[] = await generateFacts(song);

    facts.forEach((fact) => {
      expect(fact.position).toBeDefined();
      expect(fact.position.top).toMatch(/^\d+%$/);
      expect(fact.position.left).toMatch(/^\d+%$/);
    });
  });

  it("should return cached facts for the same song", async () => {
    const { generateFacts } = require("./fact-generator");

    const song: SSLSong = { title: "Same Song", artist: "Same Artist" };
    const facts1: PopUpFact[] = await generateFacts(song);
    const facts2: PopUpFact[] = await generateFacts(song);

    expect(facts1).toEqual(facts2);
  });

  it("should return fallback facts on AI error", async () => {
    // Override the mock to throw an error
    jest.resetModules();
    jest.mock("@anthropic-ai/sdk", () => {
      const mock = jest.fn().mockImplementation(() => ({
        messages: {
          create: jest.fn().mockRejectedValue(new Error("API Error")),
        },
      }));
      return { __esModule: true, default: mock };
    });
    jest.mock("./config", () => ({
      config: {
        aiProvider: "anthropic",
        anthropicApiKey: "test-key",
        ollamaBaseUrl: "http://localhost:11434",
        ollamaModel: "llama3.2",
        factsPerSong: 5,
        factIntervalSeconds: 15,
        factDurationSeconds: 8,
      },
    }));

    const { generateFacts, clearFactCache: clear } = require("./fact-generator");
    clear();

    const song: SSLSong = { title: "Error Song", artist: "Error Artist" };
    const facts: PopUpFact[] = await generateFacts(song);

    expect(facts).toHaveLength(5);
    expect(facts[0].text).toContain("Error Song");
  });
});
