jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR } }));

import fs from "fs";
import os from "os";
import path from "path";
import { isCurrent, PreparedEntry, PreparedStore, PREPARED_MAX_AGE_MS, PREPARED_RULES_VERSION } from "./prepared-facts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-prepared-"));
const file = path.join(dir, "prepared-facts.json");
const store = () => new PreparedStore(() => file);

const entry = (over: Partial<PreparedEntry> = {}): PreparedEntry => ({
  title: "Harbor Lights",
  artist: "Marlo Venn",
  outcome: "facts",
  facts: [{ text: "Harbor Lights was recorded in one weekend.", source: "Wikipedia: Harbor Lights (song)", url: "https://en.wikipedia.org/wiki/Harbor_Lights_(song)" }],
  article: "Harbor Lights (song)",
  revision: 77,
  rules: PREPARED_RULES_VERSION,
  model: "standard.gguf",
  preparedAt: new Date().toISOString(),
  checkedAt: new Date().toISOString(),
  ...over,
});

beforeEach(() => fs.rmSync(file, { force: true }));

describe("PreparedStore (issue #292)", () => {
  it("keeps each song's facts across a restart, readable only by the streamer", () => {
    store().put("ssl:1", entry());
    expect(store().get("ssl:1")).toEqual(entry({ preparedAt: expect.any(String), checkedAt: expect.any(String) }));
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Written whole: no temporary file is left beside it.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("drops entries written under other rules, and ignores ones over 30 days old", () => {
    const s = store();
    s.put("ssl:1", entry({ rules: PREPARED_RULES_VERSION + 1 }));
    s.put("ssl:2", entry({ preparedAt: new Date(Date.now() - PREPARED_MAX_AGE_MS - 1000).toISOString() }));
    const again = store();
    expect(again.saved("ssl:1")).toBeUndefined();
    expect(again.saved("ssl:2")).toBeDefined();
    expect(again.get("ssl:2")).toBeUndefined();
  });

  it("forgets one song, and records an unchanged article's check", () => {
    const s = store();
    s.put("ssl:1", entry());
    s.checked("ssl:1", "2026-11-01T00:00:00.000Z");
    expect(store().saved("ssl:1")?.checkedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(s.remove("ssl:1")).toBe(true);
    expect(s.remove("ssl:1")).toBe(false);
    expect(store().saved("ssl:1")).toBeUndefined();
  });

  it("starts empty from a missing, broken or foreign file, and skips malformed entries", () => {
    expect(store().all()).toEqual({});
    fs.writeFileSync(file, "{not json");
    expect(store().all()).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ version: 1, songs: { a: entry(), b: { title: 3 }, c: entry({ outcome: "maybe" as PreparedEntry["outcome"] }) } }));
    expect(Object.keys(store().all())).toEqual(["a"]);
  });

  it("measures the pace on this computer: the latest songs and the time spent each day, two weeks at most", () => {
    const s = store();
    for (let i = 0; i < 60; i++) s.addPace(1000 + i, 0, "2026-11-01");
    for (let d = 1; d <= 20; d++) s.addPace(0, 60_000, `2026-10-${String(d).padStart(2, "0")}`);
    s.addPace(0, 30_000, "2026-10-20");
    const pace = store().getPace();
    expect(pace.recentMs).toHaveLength(50);
    expect(pace.recentMs[49]).toBe(1059);
    expect(Object.keys(pace.activeByDay)).toHaveLength(14);
    expect(pace.activeByDay["2026-10-20"]).toBe(90_000);
  });

  it("saves a song and how long it took in one go", () => {
    const s = store();
    s.put("a", entry(), { ms: 4_000, activeMs: 4_000, day: "2026-11-02" });
    expect(store().saved("a")).toBeDefined();
    expect(store().getPace()).toEqual({ recentMs: [4_000], activeByDay: { "2026-11-02": 4_000 } });
  });

  it("counts an entry as current only under today's rules and within 30 days", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(isCurrent(entry({ preparedAt: "2026-10-20T12:00:00Z" }), now)).toBe(true);
    expect(isCurrent(entry({ preparedAt: "2026-09-20T12:00:00Z" }), now)).toBe(false);
    expect(isCurrent(entry({ preparedAt: "not a date" }), now)).toBe(false);
    expect(isCurrent(entry({ preparedAt: "2026-10-20T12:00:00Z", rules: 0 }), now)).toBe(false);
  });
});
