jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR } }));

import fs from "fs";
import os from "os";
import path from "path";
import { PreparedStore, PREPARED_RULES_VERSION } from "./prepared-facts";
import { CHECK_EVERY_MS, Preparer, PreparerDeps, PrepTarget } from "./preparer";
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
    prepare: jest.fn(async (song: SSLSong) => {
      prepared.push(song.title);
      return found(song);
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
