const mockConfig = {
  factsPerSong: 5,
  dataDir: process.env.BUBBLEFACTS_DATA_DIR,
  groundingTimeoutMs: 5000,
  groundingExtractTimeoutMs: 15000,
  topic: "pop,general",
  funHooks: true,
};
jest.mock("./config", () => ({ config: mockConfig }));

import fs from "fs";
import path from "path";
import { articleHooks, hasSubjectHook, hookRisk, plainHook, setHookTable, titleKey, withHooks } from "./dyk-hooks";
import { companionOf, companionPages } from "./fact-verifier";

const song = (title: string, artist = "Velvet Harbor") => ({ title, artist });
const lamp = "Paper Lamp (Velvet Harbor song)";
const article = `${lamp}\n"Paper Lamp" is a song by Velvet Harbor from the album Quiet Tides.`;

beforeEach(() => {
  mockConfig.funHooks = true;
  setHookTable({
    [lamp]: [
      { a: lamp, h: '... that Velvet Harbor recorded "Paper Lamp" in a lighthouse during a three-day storm?', d: "2021-04-02" },
      { a: lamp, h: '... that the band said "Paper Lamp" was "the best thing we ever wrote together"?', d: "2021-04-02" },
    ],
    "Paper Lamp": [{ a: "Paper Lamp", h: "... that Paper Lamp is a lamp?", d: "2020-01-01" }],
    "Quiet Tides": [{ a: "Quiet Tides", h: "... that Velvet Harbor (pictured) sketched Quiet Tides on a tour bus in Ohio?", d: "2019-05-05" }],
    "Other Song": [{ a: "Some Old Title", h: "... that Other Song was written on a ferry in one night?", d: "2018-01-01" }],
  });
});
afterAll(() => setHookTable(null));

describe("plainHook", () => {
  it("drops the question's opening, the question mark and (pictured)", () => {
    expect(plainHook("... that Mia Chen (pictured) wrote it on a napkin?")).toBe("Mia Chen wrote it on a napkin");
    expect(plainHook("...that, at first, it had no words?")).toBe("at first, it had no words");
    expect(plainHook('... that the song "Glow Road" , once a jingle, was a hit?')).toBe('the song "Glow Road", once a jingle, was a hit');
  });
});

describe("titleKey", () => {
  it("keys titles the way Wikipedia does", () => {
    expect(titleKey("paper_Lamp  (song)")).toBe("Paper Lamp (song)");
  });
});

describe("hookRisk", () => {
  it("keeps a plain surprising hook", () => {
    expect(hookRisk("Velvet Harbor recorded the song in a lighthouse during a three-day storm")).toBeNull();
  });
  it("drops quotes of four or more words and someone's words", () => {
    expect(hookRisk('the band said it was "the best thing we ever wrote together"')).not.toBeNull();
  });
});

describe("articleHooks", () => {
  it("returns the article's own screened hooks as sentences", () => {
    expect(articleHooks(lamp)).toEqual(['Velvet Harbor recorded "Paper Lamp" in a lighthouse during a three-day storm.']);
  });
  it("matches the exact title only", () => {
    expect(articleHooks("Paper Lamp (song)")).toEqual([]);
    expect(articleHooks("paper Lamp (Velvet Harbor song)")).toHaveLength(1); // only the first letter is free
    expect(articleHooks("Paper lamp (Velvet Harbor song)")).toEqual([]);
  });
  it("keeps a hook filed under the article's new title after a move", () => {
    expect(articleHooks("Other Song")).toEqual(["Other Song was written on a ferry in one night."]);
  });
});

describe("withHooks", () => {
  it("puts the hook after the title line in the companion format, credited to the article", () => {
    const out = withHooks(article, song("Paper Lamp"), () => true);
    const [title, line] = out.split("\n");
    expect(title).toBe(lamp);
    expect(line).toBe(`From the article "${lamp}": Velvet Harbor recorded "Paper Lamp" in a lighthouse during a three-day storm.`);
    expect(out.endsWith(article.split("\n")[1])).toBe(true);
    expect(companionPages(out)).toEqual([lamp]);
    expect(companionOf("Velvet Harbor recorded \"Paper Lamp\" in a lighthouse during a three-day storm.", out)).toBe(lamp);
    expect(hasSubjectHook(out)).toBe(false);
  });
  it("leaves the reference alone when switched off, blocked or without a hook", () => {
    expect(withHooks(article, song("Paper Lamp"), (t) => t !== lamp)).toBe(article);
    expect(withHooks("Glow Road\nGlow Road is a song.", song("Glow Road"), () => true)).toBe("Glow Road\nGlow Road is a song.");
    mockConfig.funHooks = false;
    expect(withHooks(article, song("Paper Lamp"), () => true)).toBe(article);
  });
  it("marks a hook about the album the song was matched to", () => {
    const album = "Quiet Tides\nQuiet Tides is the second album by Velvet Harbor.";
    const out = withHooks(album, song("Paper Lamp"), () => true);
    expect(out.split("\n")[1]).toBe('From the article "Quiet Tides": Velvet Harbor sketched Quiet Tides on a tour bus in Ohio.');
    expect(hasSubjectHook(out)).toBe(true);
  });
  it("does not repeat a hook the article already says", () => {
    const says = `${lamp}\nVelvet Harbor recorded "Paper Lamp" in a lighthouse during a three-day storm.`;
    expect(withHooks(says, song("Paper Lamp"), () => true)).toBe(says);
  });
});

describe("the bundled file", () => {
  it("is small and keyed by the hooked article", () => {
    const file = path.resolve(__dirname, "../../facts-data/dyk-hooks.json");
    expect(fs.statSync(file).size).toBeLessThan(2_000_000);
    const { hooks } = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks: Record<string, Array<{ a: string; h: string; d: string }>> };
    const entries = Object.entries(hooks);
    expect(entries.length).toBeGreaterThan(1000);
    for (const [, list] of entries.slice(0, 50)) for (const e of list) expect(e.h && e.d && e.a).toBeTruthy();
  });
});
