import fs from "fs";
import os from "os";
import path from "path";
import {
  BACKUPS_KEPT, emptyStore, FACT_LENGTH, linesOf, loadOwnFacts, MAX_LINES, newId, normalizeLines, normalizeText, OWN_FACTS_BACKUPS, OWN_FACTS_FILE, parseLine, readStore, saveOwnFacts, toLine, withLines,
} from "./own-facts";
import { customFactsProblem } from "./settings";

jest.mock("electron", () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => "2.0.0" }, safeStorage: {} }));

const NOW = "2026-11-24T21:00:00.000Z";
const LATER = "2026-11-25T21:00:00.000Z";
let n = 0;
const ids = () => newId(Buffer.alloc(16, ++n));

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-own-facts-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const lines = {
  myFacts: ["I've been composing since I was seven.", "[Harbor Lights] “Harbor Lights” is from my album Quiet Hours.", "[Made-Up Band] They practise in a barn."],
  myOriginals: ["Every song on this list is my own.", "[Not a tag here] Shown as written."],
};
const store = () => JSON.parse(fs.readFileSync(path.join(dir, OWN_FACTS_FILE), "utf8"));

describe("normalizeText", () => {
  it("joins spaces, drops control characters and composes accents", () => {
    expect(normalizeText("  Café  del\tMar\u0007 \n")).toBe("Café del Mar");
  });
  it("straightens quotes and keeps emoji sequences", () => {
    expect(normalizeText("“Hi” it’s 👩‍🎤")).toBe(`"Hi" it's 👩‍🎤`);
  });
  it("is the same done twice", () => {
    const once = normalizeText(" a  b ");
    expect(normalizeText(once)).toBe(once);
  });
});

describe("ids", () => {
  it("are random, never from the text", () => {
    const a = newId();
    expect(a).toMatch(/^fct_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(newId()).not.toBe(a);
    const one = withLines(emptyStore(), { myFacts: ["Same."], myOriginals: [] }, NOW);
    const two = withLines(emptyStore(), { myFacts: ["Same."], myOriginals: [] }, NOW);
    expect(one.facts[0].id).not.toBe(two.facts[0].id);
  });
});

describe("lines to records and back", () => {
  it("gives the same lines back, duplicates and all", () => {
    const withDuplicate = { ...lines, myFacts: [...lines.myFacts, lines.myFacts[0]] };
    const s = withLines(emptyStore(), withDuplicate, NOW, ids);
    expect(linesOf(s)).toEqual(withDuplicate);
    expect(s.facts).toHaveLength(6);
  });
  it("reads a tag as the scope, in Your own facts only", () => {
    expect(parseLine("[Harbor Lights] Mine.", "myFacts")).toEqual({ text: "Mine.", scope: { type: "tag", tag: "Harbor Lights" } });
    expect(parseLine("[Harbor Lights] Mine.", "myOriginals")).toEqual({ text: "[Harbor Lights] Mine.", scope: { type: "originals" } });
    expect(parseLine("Mine [Harbor Lights]", "myFacts")).toEqual({ text: "Mine [Harbor Lights]", scope: { type: "all" } });
    // As the server reads them: a tag with nothing after, or nothing in it, isn't one
    expect(parseLine("[Harbor Lights]", "myFacts")?.scope).toEqual({ type: "all" });
    expect(toLine(parseLine("[ ] Mine.", "myFacts")!)).toBe("[ ] Mine.");
    expect(parseLine("   ", "myFacts")).toBeNull();
  });
  it("stores each record with its kind, scope and times", () => {
    const [first, second] = withLines(emptyStore(), lines, NOW, ids).facts;
    expect(first).toMatchObject({ text: lines.myFacts[0], kind: "yours", scope: { type: "all" }, created: NOW, modified: NOW });
    expect(second.scope).toEqual({ type: "tag", tag: "Harbor Lights" });
    expect(first).not.toHaveProperty("expires");
  });
  it("normalizes a record's text, and keeps the line exactly as typed for the box and the stream", () => {
    const typed = ["[ Harbor Lights ]Two  spaces “here”.", "x\u0007y", "Café"];
    expect(normalizeLines(["  padded  ", "", ...typed])).toEqual(["padded", ...typed]);
    const s = withLines(emptyStore(), { myFacts: typed, myOriginals: typed }, NOW, ids);
    expect(s.facts[0]).toMatchObject({ text: `Two spaces "here".`, scope: { type: "tag", tag: "Harbor Lights" }, asTyped: typed[0] });
    expect(s.facts[1]).toMatchObject({ text: "x y", asTyped: "x\u0007y" });
    expect(s.facts[2].text).toBe("Café");
    expect(linesOf(s)).toEqual({ myFacts: typed, myOriginals: typed });
    // A canonical line needs no copy
    expect(withLines(emptyStore(), { myFacts: ["[Harbor Lights] Mine."], myOriginals: [] }, NOW, ids).facts[0]).not.toHaveProperty("asTyped");
  });
});

describe("saving keeps who a fact is", () => {
  it("keeps an unchanged fact whole, gives an edit in the same place a new modified time, and a new line a new id", () => {
    const first = withLines(emptyStore(), lines, NOW, ids);
    const edited = { ...lines, myFacts: [lines.myFacts[0], "[Harbor Lights] Edited.", lines.myFacts[2], "Brand new."] };
    const second = withLines(first, edited, LATER, ids);
    expect(second.facts[0]).toEqual(first.facts[0]);
    expect(second.facts[1]).toMatchObject({ id: first.facts[1].id, text: "Edited.", created: NOW, modified: LATER });
    expect(second.facts[2]).toEqual(first.facts[2]);
    expect(second.facts[3]).toMatchObject({ text: "Brand new.", created: LATER });
    expect(new Set(second.facts.map((f) => f.id)).size).toBe(second.facts.length);
  });
  it("follows a fact that moved", () => {
    const first = withLines(emptyStore(), lines, NOW, ids);
    const moved = withLines(first, { ...lines, myFacts: [...lines.myFacts].reverse() }, LATER, ids);
    expect(moved.facts.slice(0, 3).map((f) => f.id)).toEqual(first.facts.slice(0, 3).map((f) => f.id).reverse());
    expect(moved.facts.every((f) => f.modified === NOW)).toBe(true);
  });
});

describe("what a newer version saved", () => {
  const newer = () => ({
    format: "bubblefacts-own-facts",
    version: 2,
    somethingNew: { a: 1 },
    facts: [
      { id: "fct_a", text: "A joke.", kind: "joke", scope: { type: "all" }, expires: "2027-01-01", created: NOW, modified: NOW, color: "teal" },
      { id: "fct_b", text: "For one song.", kind: "yours", scope: { type: "song", title: "Harbor Lights", artist: "Made-Up Band" }, created: NOW, modified: NOW },
      { id: "fct_c", text: "Somewhere new.", kind: "yours", scope: { type: "playlist", name: "Chill" }, created: NOW, modified: NOW },
    ],
  });

  it("keeps fields, records and scopes it doesn't know when it saves", () => {
    fs.writeFileSync(path.join(dir, OWN_FACTS_FILE), JSON.stringify(newer()));
    expect(loadOwnFacts(dir, {}).lines).toEqual({ myFacts: ["A joke."], myOriginals: [] });
    saveOwnFacts(dir, { myFacts: ["A joke.", "Mine."], myOriginals: [] }, LATER);
    const saved = store();
    expect(saved).toMatchObject({ version: 2, somethingNew: { a: 1 } });
    expect(saved.facts[0]).toEqual(newer().facts[0]);
    expect(saved.facts.slice(2)).toEqual(newer().facts.slice(1));
  });
});

describe("moving today's lines in", () => {
  const backups = () => fs.readdirSync(path.join(dir, OWN_FACTS_BACKUPS)).sort();
  const backup = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, OWN_FACTS_BACKUPS, name), "utf8"));

  it("backs up first, then writes the store", () => {
    const { lines: got, moved } = loadOwnFacts(dir, lines, NOW);
    expect(moved).toBe(true);
    expect(got).toEqual(lines);
    expect(backups()).toHaveLength(1);
    expect(backup(backups()[0])).toEqual({ savedAt: NOW, fromSettings: lines, store: null });
    expect(linesOf(store())).toEqual(got);
  });

  it("run twice gives the same result, and the first backup stays", () => {
    loadOwnFacts(dir, lines, NOW);
    const once = fs.readFileSync(path.join(dir, OWN_FACTS_FILE), "utf8");
    const first = backups();
    loadOwnFacts(dir, lines, LATER);
    expect(fs.readFileSync(path.join(dir, OWN_FACTS_FILE), "utf8")).toBe(once);
    expect(backups()).toEqual(first);
  });

  it("adds lines it doesn't have yet after the stored ones, in their order, never replacing any", () => {
    loadOwnFacts(dir, lines, NOW);
    const before = store().facts;
    const { lines: got } = loadOwnFacts(dir, { myFacts: ["Newer one.", lines.myFacts[1], "Newer two."], myOriginals: [] }, LATER);
    expect(got).toEqual({ myFacts: [...lines.myFacts, "Newer one.", "Newer two."], myOriginals: lines.myOriginals });
    expect(store().facts.slice(0, 3)).toEqual(before.slice(0, 3));
    // A backup for each bring-in, at the same moment too, and none written over
    loadOwnFacts(dir, { myFacts: ["Newest."] }, LATER);
    expect(backups()).toHaveLength(3);
    expect(backup(backups()[0]).store).toBeNull();
  });

  it("keeps only the newest backups", () => {
    for (let i = 0; i < BACKUPS_KEPT + 3; i++) loadOwnFacts(dir, { myFacts: [`Fact ${i}.`] }, `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`);
    expect(backups()).toHaveLength(BACKUPS_KEPT);
    expect(backups()[0]).toContain("2026-11-04");
  });

  it("never throws when it can't write: the lines stay where they were", () => {
    fs.writeFileSync(path.join(dir, OWN_FACTS_BACKUPS), "not a folder");
    const result = loadOwnFacts(dir, lines, NOW);
    expect(result).toEqual({ lines, moved: false });
    expect(fs.existsSync(path.join(dir, OWN_FACTS_FILE))).toBe(false);
  });

  it("writes nothing for someone with no facts", () => {
    expect(loadOwnFacts(dir, { myFacts: [], myOriginals: [] }).lines).toEqual({ myFacts: [], myOriginals: [] });
    saveOwnFacts(dir, { myFacts: [], myOriginals: [] });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ignores lists of the wrong type", () => {
    expect(loadOwnFacts(dir, { myFacts: [1, 2], myOriginals: "no" }).lines).toEqual({ myFacts: [], myOriginals: [] });
  });

  it("loads an old store missing what it can do without", () => {
    fs.writeFileSync(path.join(dir, OWN_FACTS_FILE), JSON.stringify({ facts: [{ id: "fct_x", text: "Old.", scope: { type: "all" } }, "junk", { text: "No id." }] }));
    expect(loadOwnFacts(dir, {}).lines).toEqual({ myFacts: ["Old."], myOriginals: [] });
    saveOwnFacts(dir, { myFacts: ["Old."], myOriginals: [] });
    expect(store().facts).toEqual([{ id: "fct_x", text: "Old.", scope: { type: "all" } }, "junk", { text: "No id." }]);
  });

  it("keeps a broken store aside and starts from the lines it has", () => {
    fs.writeFileSync(path.join(dir, OWN_FACTS_FILE), "{not json");
    expect(readStore(dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, OWN_FACTS_FILE + ".unreadable"))).toBe(true);
  });
});

describe("limits", () => {
  it("keeps 500 lines a box", () => {
    const many = Array.from({ length: MAX_LINES + 1 }, (_, i) => `Fact ${i}.`);
    const s = withLines(emptyStore(), { myFacts: many, myOriginals: many }, NOW, ids);
    expect(linesOf(s).myFacts).toHaveLength(MAX_LINES);
    expect(linesOf(s).myOriginals).toHaveLength(MAX_LINES);
    expect(normalizeLines(many)).toHaveLength(MAX_LINES);
  });

  it("refuses a fact over 300 characters where it's typed, and never trims one already saved", () => {
    expect(FACT_LENGTH).toBe(300);
    expect(customFactsProblem({ myFacts: ["x".repeat(FACT_LENGTH)] })).toBeNull();
    expect(customFactsProblem({ myFacts: ["x".repeat(FACT_LENGTH + 1)] })).toMatch(/301 characters/);
    // One saved long before the limit (or by hand) is kept whole: nothing is lost by moving it
    const long = "y".repeat(FACT_LENGTH + 20);
    expect(linesOf(withLines(emptyStore(), { myFacts: [long], myOriginals: [] }, NOW, ids)).myFacts).toEqual([long]);
  });
});
