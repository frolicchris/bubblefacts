// How sure a fact must be (FACT_CERTAINTY, issue #542): what each level changes, and that "standard" is today's
jest.mock("./config", () => ({
  config: { groundingTimeoutMs: 5000, groundingExtractTimeoutMs: 15000, dataDir: process.env.BUBBLEFACTS_DATA_DIR, topic: "general" },
}));

import fs from "fs";
import path from "path";
import { config } from "./config";
import { CERTAINTIES, Candidate, Certainty, FLOOR, FLOORS, MAX_BUBBLES, rankFacts } from "./fact-ranking";
import { certaintyNow, isCurrent, PreparedEntry, PREPARED_RULES_VERSION } from "./prepared-facts";
import { BARS, DATA_ONLY, MARGIN, SURE, candidateProfile, requestProfile, resolveWork } from "./work-resolver";

type Decision = "sure" | "data-only" | "abstain";
interface MatchCase {
  label: string;
  request: { title: string; artist: string; credited?: boolean };
  article: { page: string; text: string; rank: number };
  sameName?: string[];
  expect: Record<Certainty, Decision>;
}
interface RankingCase {
  label: string;
  candidates: Candidate[];
  expect: Record<Certainty, string[]>;
}
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/certainty-levels.json"), "utf8")) as { match: MatchCase[]; ranking: RankingCase[] };
const LONG = " It was made by a small team over three years.".repeat(10);

const matchOf = (c: MatchCase) => {
  const song = { title: c.request.title, artist: c.request.artist };
  return [
    requestProfile(song, song, c.request.credited ? true : undefined),
    candidateProfile(c.article.page, c.article.text + LONG, "", c.article.rank),
    (c.sameName ?? []).map((t) => candidateProfile(t)),
  ] as const;
};

describe("the certainty levels (labeled cases)", () => {
  for (const c of cases.match) {
    it(`article match: ${c.label}`, () => {
      const [req, pick, others] = matchOf(c);
      for (const level of CERTAINTIES) expect([level, resolveWork(req, pick, others, BARS[level]).decision]).toEqual([level, c.expect[level]]);
    });
  }
  for (const c of cases.ranking) {
    it(`ranking: ${c.label}`, () => {
      for (const level of CERTAINTIES) expect([level, rankFacts(c.candidates, { floor: FLOORS[level] }).map((r) => r.text)]).toEqual([level, c.expect[level]]);
    });
  }

  it("covers a change at each level that moves something, and a wrong work that no level lets through", () => {
    const moved = (level: Certainty) => cases.match.some((c) => c.expect[level] !== c.expect.standard) || cases.ranking.some((c) => c.expect[level].join("\n") !== c.expect.standard.join("\n"));
    expect(moved("surest")).toBe(true);
    expect(moved("more")).toBe(true);
    expect(cases.match.filter((c) => /wrong work/.test(c.label)).every((c) => CERTAINTIES.every((l) => c.expect[l] !== "sure"))).toBe(true);
  });

  it("only ever moves toward fewer facts at surest and more facts at more", () => {
    const rank: Record<Decision, number> = { abstain: 0, "data-only": 1, sure: 2 };
    for (const c of cases.match) {
      expect(rank[c.expect.surest]).toBeLessThanOrEqual(rank[c.expect.standard]);
      expect(rank[c.expect.more]).toBeGreaterThanOrEqual(rank[c.expect.standard]);
    }
  });
});

describe("the default, standard, is today's behavior", () => {
  it("keeps today's numbers", () => {
    expect([SURE, MARGIN, DATA_ONLY, FLOOR]).toEqual([6, 3, 3, 3]);
    expect(BARS.standard).toEqual({ sure: SURE, margin: MARGIN, dataOnly: DATA_ONLY });
    expect(FLOORS.standard).toBe(FLOOR);
    // More facts never loosens the article match: it was tried, and it captioned covers' originals
    expect(BARS.more).toEqual(BARS.standard);
    expect(FLOORS.more).toBe(MAX_BUBBLES);
  });

  it("would caption the wrong work with one point off SURE, which is why More facts keeps the bars", () => {
    const looser = { ...BARS.standard, sure: SURE - 1 };
    const flipped = cases.match.filter((c) => {
      const [req, pick, others] = matchOf(c);
      return /wrong work/.test(c.label) && resolveWork(req, pick, others, looser).decision === "sure";
    });
    expect(flipped.map((c) => c.article.page)).toEqual(["Cherry Fields (Tom Orchard song)", "Starlight Avenue (song)"]);
  });

  it("decides exactly as with no level given, for every labeled case", () => {
    for (const c of cases.match) {
      const [req, pick, others] = matchOf(c);
      expect(resolveWork(req, pick, others, BARS.standard)).toEqual(resolveWork(req, pick, others));
      // A config without the setting (an older test mock) reads as standard too
      expect(resolveWork(req, pick, others, BARS[undefined as unknown as Certainty])).toEqual(resolveWork(req, pick, others));
    }
    for (const c of cases.ranking) {
      const log = (lines: string[]) => (line: string) => lines.push(line);
      const [a, b]: string[][] = [[], []];
      expect(rankFacts(c.candidates, { floor: FLOORS.standard, log: log(a) })).toEqual(rankFacts(c.candidates, { log: log(b) }));
      expect(a).toEqual(b);
    }
  });

  it("keeps prepared songs current, and writes nothing new into them", () => {
    const entry: PreparedEntry = {
      title: "Paper Lanterns", artist: "Dana Reyes", outcome: "facts", facts: [{ text: "A fact." }], article: "Paper Lanterns",
      revision: 1, rules: PREPARED_RULES_VERSION, model: "m", preparedAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
    };
    expect(certaintyNow()).toBe("standard");
    expect(isCurrent(entry)).toBe(true);
    expect(isCurrent({ ...entry, certainty: "more" })).toBe(false);
    const mutable = config as unknown as { factCertainty?: Certainty };
    mutable.factCertainty = "surest";
    try {
      expect(isCurrent(entry)).toBe(false);
      expect(isCurrent({ ...entry, certainty: "surest" })).toBe(true);
    } finally {
      delete mutable.factCertainty;
    }
  });
});

describe("what no level touches", () => {
  // The content standard, the link, @mention and chat command screen and every caption check read no level
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");
  const screens = ["content-standard.ts", "not-music.ts", "fact-verifier.ts", ...fs.readdirSync(path.join(__dirname, "screening")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => `screening/${f}`)];

  it.each(screens)("%s never reads the certainty level", (file) => {
    expect(read(file)).not.toMatch(/factCertainty|FACT_CERTAINTY|\bBARS\b|\bFLOORS\b/);
  });

  it("is read in two places only: the match's bars and the ranking floor", () => {
    const uses = read("fact-generator.ts").match(/config\.factCertainty/g) ?? [];
    expect(uses).toHaveLength(2);
    expect(read("fact-generator.ts")).toMatch(/BARS\[config\.factCertainty\]/);
    expect(read("fact-generator.ts")).toMatch(/floor: FLOORS\[config\.factCertainty\]/);
  });
});
