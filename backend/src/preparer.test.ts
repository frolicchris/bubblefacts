jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR } }));

import { getEventListeners } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { PreparedStore, PREPARED_RULES_VERSION } from "./prepared-facts";
import { CHECK_EVERY_MS, coverage, Preparer, PreparerDeps, PrepTarget } from "./preparer";
import type { PreparedSong } from "./fact-generator";
import { SSLSong } from "./types";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-preparer-"));
const file = path.join(dir, "prepared-facts.json");
let store: PreparedStore;

const target = (title: string, requests: number, id: number): PrepTarget => ({ key: `ssl:${id}`, song: { title, artist: "Marlo Venn", songId: id }, requests });
const list = [target("Harbor Lights", 3, 1), target("Tin Roof", 40, 2), target("Low Tide", 12, 3)];

const found = (song: SSLSong, over: Partial<PreparedSong & { revision: number }> = {}): PreparedSong & { revision: number } => ({
  outcome: "facts",
  facts: [{ text: `${song.title} was recorded in one weekend.`, source: `Wikipedia: ${song.title} (song)` }],
  article: `${song.title} (song)`,
  model: "standard.gguf",
  revision: 10,
  trouble: 0,
  ...over,
});

function preparer(over: Partial<PreparerDeps> = {}) {
  const prepared: string[] = [];
  const deps: PreparerDeps = {
    store,
    targets: () => list,
    prepare: jest.fn(async (song: SSLSong, _signal: AbortSignal, opts: { streamModel?: boolean }) => {
      prepared.push(song.title);
      return found(song, { model: opts.streamModel ? "high.gguf" : "standard.gguf" });
    }),
    revisionOf: jest.fn(async () => 10),
    prepModel: () => "standard.gguf",
    streamModel: () => "standard.gguf",
    sleep: async () => undefined,
    gapMs: 0,
    ...over,
  };
  return { p: new Preparer(deps), deps, prepared };
}

beforeEach(() => {
  fs.rmSync(file, { force: true });
  store = new PreparedStore(() => file);
});

describe("Preparer (issue #293)", () => {
  it("prepares every song, the most requested first, saving each as it finishes", async () => {
    let clock = Date.now();
    const { p, prepared } = preparer({ now: () => (clock += 1000) });
    expect(p.start()).toBe(true);
    await p.stopped();
    expect(prepared).toEqual(["Tin Roof", "Low Tide", "Harbor Lights"]);
    const saved = new PreparedStore(() => file).saved("ssl:2");
    expect(saved).toMatchObject({ title: "Tin Roof", outcome: "facts", article: "Tin Roof (song)", revision: 10, rules: PREPARED_RULES_VERSION, model: "standard.gguf" });
    expect(p.status()).toMatchObject({ running: false, finished: true, doneThisRun: 3 });
    expect(store.getPace().recentMs).toHaveLength(3);
  });

  it("waits for the song list when it starts before the list is read, instead of calling every song done", async () => {
    let read = false;
    const history = [target("Low Tide", 12, 3)];
    const { p, prepared } = preparer({
      targets: () => (read ? list : history),
      listRead: () => read,
      // The list arrives while it waits.
      sleep: async () => void (read = true),
    });
    p.start();
    await p.stopped();
    expect(prepared).toEqual(["Low Tide", "Tin Roof", "Harbor Lights"]);
    expect(p.status()).toMatchObject({ finished: true, doneThisRun: 3 });
  });

  it("stops at once, keeps what's done, and carries on from there next time", async () => {
    let release!: () => void;
    const { p, prepared, deps } = preparer({
      prepare: jest.fn(async (song: SSLSong) => {
        prepared.push(song.title);
        // The second song never finishes on its own: only the stop ends it.
        if (prepared.length === 2) await new Promise<void>((r) => (release = r));
        return found(song);
      }),
    });
    p.start();
    while (prepared.length < 2) await new Promise((r) => setImmediate(r));
    p.stop();
    await p.stopped();
    expect(p.running).toBe(false);
    expect(Object.keys(store.all())).toEqual(["ssl:2"]);
    release();
    // Next time: the ones not done, the one cut short included.
    (deps.prepare as jest.Mock).mockImplementation(async (song: SSLSong) => {
      prepared.push(song.title);
      return found(song);
    });
    p.start();
    await p.stopped();
    expect(prepared.slice(2)).toEqual(["Low Tide", "Harbor Lights"]);
  });

  it("doesn't save a song whose lookups failed, and waits before going on", async () => {
    const waits: number[] = [];
    const { p } = preparer({
      prepare: jest.fn(async (song: SSLSong) => (song.title === "Tin Roof" ? found(song, { outcome: "none", facts: [], article: "", trouble: 1 }) : found(song))),
      sleep: async (ms) => void waits.push(ms),
    });
    p.start();
    await p.stopped();
    expect(store.saved("ssl:2")).toBeUndefined();
    expect(store.saved("ssl:3")).toBeDefined();
    expect(waits).toContain(60_000);
  });

  it("doesn't save a song it couldn't prepare, and tries it again next run", async () => {
    let fail = true;
    const { p, prepared } = preparer({
      prepare: jest.fn(async (song: SSLSong) => {
        prepared.push(song.title);
        return song.title === "Low Tide" && fail ? found(song, { outcome: null }) : found(song);
      }),
    });
    p.start();
    await p.stopped();
    expect(store.saved("ssl:3")).toBeUndefined();
    fail = false;
    p.start();
    await p.stopped();
    expect(prepared.slice(3)).toEqual(["Low Tide"]);
  });

  it("prepares again a song past 30 days, or whose article has a newer version; an unchanged one is only checked", async () => {
    const { p, deps, prepared } = preparer();
    p.start();
    await p.stopped();
    const old = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();
    const weekAgo = new Date(Date.now() - CHECK_EVERY_MS - 1000).toISOString();
    store.put("ssl:1", { ...store.saved("ssl:1")!, preparedAt: old, checkedAt: old });
    store.put("ssl:2", { ...store.saved("ssl:2")!, checkedAt: weekAgo });
    store.put("ssl:3", { ...store.saved("ssl:3")!, checkedAt: weekAgo });
    (deps.revisionOf as jest.Mock).mockImplementation(async (page: string) => (page === "Tin Roof (song)" ? 11 : 10));
    p.start();
    await p.stopped();
    expect(prepared.slice(3)).toEqual(["Harbor Lights", "Tin Roof"]);
    expect(Date.parse(store.saved("ssl:3")!.checkedAt)).toBeGreaterThan(Date.parse(weekAgo));
    expect(store.saved("ssl:3")!.preparedAt).not.toBe(store.saved("ssl:3")!.checkedAt);
  });

  it("writes again with the model on stream, last, the songs the faster model prepared (issue #296)", async () => {
    const { p, deps, prepared } = preparer({ streamModel: () => "high.gguf" });
    p.start();
    await p.stopped();
    // First pass: every song by the Standard model, then each again by Larger AI, most requested first.
    expect(prepared).toEqual(["Tin Roof", "Low Tide", "Harbor Lights", "Tin Roof", "Low Tide", "Harbor Lights"]);
    const calls = (deps.prepare as jest.Mock).mock.calls;
    expect(calls.slice(0, 3).every((c) => !c[2].streamModel)).toBe(true);
    expect(calls.slice(3).every((c) => c[2].streamModel)).toBe(true);
  });

  it("shares one run's answers between its songs (issue #296)", async () => {
    const { p, deps } = preparer();
    p.start();
    await p.stopped();
    const answers = (deps.prepare as jest.Mock).mock.calls.map((c) => c[2].answers);
    expect(new Set(answers).size).toBe(1);
  });

  it("waits before going on when the AI itself got nothing, and doesn't call the run finished", async () => {
    const waits: number[] = [];
    const { p } = preparer({
      prepare: jest.fn(async (song: SSLSong) => (song.title === "Low Tide" ? found(song, { outcome: null }) : found(song))),
      sleep: async (ms) => void waits.push(ms),
    });
    p.start();
    await p.stopped();
    expect(waits).toContain(60_000);
    expect(p.status().finished).toBe(false);
    expect(store.saved("ssl:3")).toBeUndefined();
  });

  it("doesn't count an article as checked when Wikipedia couldn't be asked, and paces the checks it makes", async () => {
    const { p } = preparer();
    p.start();
    await p.stopped();
    const weekAgo = new Date(Date.now() - CHECK_EVERY_MS - 1000).toISOString();
    for (const key of ["ssl:1", "ssl:2", "ssl:3"]) store.put(key, { ...store.saved(key)!, checkedAt: weekAgo });
    const waits: number[] = [];
    const again = preparer({
      revisionOf: jest.fn(async (page: string) => {
        if (page === "Tin Roof (song)") throw new Error("429");
        return 10;
      }),
      sleep: async (ms) => void waits.push(ms),
      gapMs: 7,
    });
    again.p.start();
    await again.p.stopped();
    // Tin Roof's check failed: still due next time, after a wait. The other two were checked, a gap apart.
    expect(store.saved("ssl:2")!.checkedAt).toBe(weekAgo);
    expect(Date.parse(store.saved("ssl:1")!.checkedAt)).toBeGreaterThan(Date.parse(weekAgo));
    expect(Date.parse(store.saved("ssl:3")!.checkedAt)).toBeGreaterThan(Date.parse(weekAgo));
    expect(waits).toContain(60_000);
    expect(waits.filter((w) => w === 7)).toHaveLength(2);
    expect(again.prepared).toEqual([]);
  });

  it("has the model on stream try again a song the faster model got nothing usable for (issue #296)", async () => {
    const { p, prepared } = preparer({
      streamModel: () => "high.gguf",
      prepare: jest.fn(async (song: SSLSong, _signal: AbortSignal, opts: { streamModel?: boolean }) => {
        prepared.push(song.title);
        if (song.title === "Low Tide" && !opts.streamModel) return found(song, { outcome: "none", facts: [], model: "standard.gguf" });
        return found(song, { model: opts.streamModel ? "high.gguf" : "standard.gguf" });
      }),
    });
    p.start();
    await p.stopped();
    expect(prepared.filter((t) => t === "Low Tide")).toHaveLength(2);
    expect(store.saved("ssl:3")).toMatchObject({ outcome: "facts", model: "high.gguf" });
  });

  it("leaves no abort listener behind for each song it prepares", async () => {
    let signal: AbortSignal | undefined;
    const { p } = preparer({
      prepare: jest.fn(async (song: SSLSong, s: AbortSignal) => {
        signal = s;
        return found(song);
      }),
    });
    p.start();
    await p.stopped();
    expect(signal).toBeDefined();
    expect(getEventListeners(signal as AbortSignal, "abort")).toHaveLength(0);
  });

  it("does nothing more once every song is prepared, even after the store was read again", async () => {
    const { p } = preparer();
    p.start();
    await p.stopped();
    store = new PreparedStore(() => file);
    const again = preparer();
    again.p.start();
    await again.p.stopped();
    expect(again.prepared).toEqual([]);
  });

  it("does nothing more once every song is prepared", async () => {
    const { p, prepared } = preparer();
    p.start();
    await p.stopped();
    p.start();
    await p.stopped();
    expect(prepared).toHaveLength(3);
    expect(p.status().finished).toBe(true);
  });
});

describe("coverage (issue #294)", () => {
  const now = Date.parse("2026-11-02T20:00:00");
  const at = new Date(now - 3600_000).toISOString();
  const put = (id: number, outcome: "facts" | "none" | "own" | "live") =>
    store.put(`ssl:${id}`, { title: "x", artist: "y", outcome, facts: [], article: "", revision: 0, rules: PREPARED_RULES_VERSION, model: "", preparedAt: at, checkedAt: at });
  const songs = [target("Harbor Lights", 30, 1), target("Tin Roof", 10, 2), target("Low Tide", 5, 3), target("Paper Kites", 5, 4), target("Glass Orchard", 50, 5)];

  it("counts the songs ready, the songs no source knows, the songs left, and the share of requests covered", () => {
    put(1, "facts");
    put(2, "own");
    put(3, "none");
    const c = coverage(songs, store, now);
    expect(c).toMatchObject({ total: 5, ready: 2, noFacts: 1, left: 2, noFactsSongs: [{ title: "Low Tide", artist: "Marlo Venn" }] });
    expect(c.requestsCovered).toBeCloseTo(40 / 100);
  });

  it("gives no finish date before it knows the pace, then hours, then a date from the time spent preparing each day", () => {
    expect(coverage(songs, store, now).finish).toBeNull();
    for (let i = 0; i < 3; i++) store.addPace(60_000, 0, "2026-11-02");
    // Five songs left at a minute each, with no days measured yet: hours, at least one.
    expect(coverage(songs, store, now).finish).toEqual({ hours: 1 });
    // Five minutes of work a day on earlier days: five songs take a day.
    store.addPace(0, 5 * 60_000, "2026-10-31");
    store.addPace(0, 5 * 60_000, "2026-11-01");
    const finish = coverage(songs, store, now).finish as { at: string };
    expect(Date.parse(finish.at) - now).toBeCloseTo(24 * 3600_000, -3);
  });

  it("has no finish date when every song is done", () => {
    for (const id of [1, 2, 3, 4, 5]) put(id, id === 4 ? "live" : "facts");
    for (let i = 0; i < 3; i++) store.addPace(60_000, 0, "2026-11-02");
    expect(coverage(songs, store, now)).toMatchObject({ left: 0, ready: 5, finish: null, requestsCovered: 1 });
  });
});
