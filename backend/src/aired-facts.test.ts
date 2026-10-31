jest.mock("./config", () => ({ config: { dataDir: process.env.BUBBLEFACTS_DATA_DIR } }));


import fs from "fs";
import os from "os";
import path from "path";
import { AIRED_FACTS_KEPT, AiredFacts } from "./aired-facts";
import { ShownLog } from "./shown-log";
import { Fact } from "./types";

const fact = (text: string, source?: string, url?: string): Fact => ({ text, delaySeconds: 0, durationSeconds: 8, position: { top: "8%", left: "33%" }, ...(source ? { source } : {}), ...(url ? { url } : {}) });
const song = { title: "Lantern Bay", artist: "Velvet Ferns" };

let dir = "";
let file = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-aired-"));
  file = path.join(dir, "aired-facts.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the aired facts record", () => {
  it("keeps each fact with its song, source, link and time, on disk", () => {
    const aired = new AiredFacts(file);
    aired.add(song, [fact("One.", "Wikipedia: Lantern Bay", "https://en.wikipedia.org/wiki/Lantern_Bay"), fact("Two.")], new Date("2026-10-26T20:15:00Z"));
    const expected = [
      { title: "Lantern Bay", artist: "Velvet Ferns", text: "One.", source: "Wikipedia: Lantern Bay", url: "https://en.wikipedia.org/wiki/Lantern_Bay", at: "2026-10-26T20:15:00.000Z" },
      { title: "Lantern Bay", artist: "Velvet Ferns", text: "Two.", at: "2026-10-26T20:15:00.000Z" },
    ];
    expect(aired.list()).toEqual(expected);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(expected);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("survives a restart", () => {
    new AiredFacts(file).add(song, [fact("One.")]);
    const reloaded = new AiredFacts(file);
    expect(reloaded.list().map((a) => a.text)).toEqual(["One."]);
    reloaded.add(song, [fact("Two.")]);
    expect(new AiredFacts(file).list().map((a) => a.text)).toEqual(["One.", "Two."]);
  });

  it(`keeps only the newest ${AIRED_FACTS_KEPT}, in memory and on disk`, () => {
    const aired = new AiredFacts(file);
    for (let i = 0; i < AIRED_FACTS_KEPT + 30; i += 5) aired.add(song, [0, 1, 2, 3, 4].map((j) => fact(`Fact ${i + j}.`)));
    const kept = aired.list();
    expect(kept).toHaveLength(AIRED_FACTS_KEPT);
    expect(kept[0].text).toBe("Fact 30.");
    expect(kept[kept.length - 1].text).toBe(`Fact ${AIRED_FACTS_KEPT + 29}.`);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(AIRED_FACTS_KEPT);
  });

  it("trims a file over the cap when it loads, and skips anything that isn't an entry", () => {
    const entry = (i: number) => ({ title: "T", artist: "A", text: `F${i}`, at: "2026-10-26T20:00:00.000Z" });
    fs.writeFileSync(file, JSON.stringify([{ text: 5 }, ...Array.from({ length: 8 }, (_, i) => entry(i))]));
    expect(new AiredFacts(file, 5).list().map((a) => a.text)).toEqual(["F3", "F4", "F5", "F6", "F7"]);
    fs.writeFileSync(file, "{ half a fi");
    expect(new AiredFacts(file).list()).toEqual([]);
  });

  it("leaves out a note after the artist's name, such as who requested it (issue #262)", () => {
    const aired = new AiredFacts(file);
    aired.add({ title: "Lantern Bay", artist: "Velvet Ferns, Commissioned by Moss Tinker" }, [fact("One.")]);
    expect(JSON.stringify(aired.list())).not.toContain("Tinker");
  });

  it("gets each fact once per play, as the [Shown] log does", () => {
    const aired = new AiredFacts(file);
    const shown = new ShownLog(aired);
    const batch = [fact("One."), fact("Two.")];
    shown.log(song, batch);
    // A second overlay, or one catching up, gets the same batch.
    shown.log(song, batch);
    shown.log(song, [fact("Two."), fact("Three.")]);
    expect(aired.list().map((a) => a.text)).toEqual(["One.", "Two.", "Three."]);
    shown.newPlay();
    shown.log(song, [fact("One.")]);
    expect(new AiredFacts(file).list().map((a) => a.text)).toEqual(["One.", "Two.", "Three.", "One."]);
  });

  it("never stops the bubbles when it can't be saved", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, "blocker"), "");
    const aired = new AiredFacts(path.join(dir, "blocker", "aired-facts.json"));
    expect(() => aired.add(song, [fact("One.")])).not.toThrow();
    expect(aired.list()).toHaveLength(1);
    warn.mockRestore();
  });
});
