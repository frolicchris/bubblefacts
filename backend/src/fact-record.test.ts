import * as fs from "fs";
import * as path from "path";
import { fingerprint, fromLines, isExpired, newId, normalizeText, parseLine, toLines, validateFact, FactRecord } from "./fact-record";

const NOW = "2026-10-11T21:00:00Z";
let n = 0;
const ids = () => newId("fct", Buffer.alloc(16, ++n));

describe("normalizeText", () => {
  it("straightens quotes, collapses spaces and drops control characters", () => {
    expect(normalizeText("  “Harbor  Lights”\tis Jane’s\u0007 song  ")).toBe(`"Harbor Lights" is Jane's song`);
  });
  it("is idempotent", () => {
    const once = normalizeText("A’s  “B”");
    expect(normalizeText(once)).toBe(once);
  });
});

describe("ids and fingerprints", () => {
  it("makes permanent-looking ids that don't depend on the text", () => {
    const a = newId();
    expect(a).toMatch(/^fct_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(newId()).not.toBe(a);
  });
  it("ignores case, accents and punctuation but not words", () => {
    expect(fingerprint("Café Del Mar!")).toBe(fingerprint("cafe del mar"));
    expect(fingerprint("Night Drive (Acoustic)")).not.toBe(fingerprint("Night Drive (Remix)"));
  });
});

describe("lines to records and back", () => {
  const lines = [
    "I've been composing since I was seven.",
    "[Harbor Lights] “Harbor Lights” is from my album Quiet Hours.",
    "  ",
    "i've been composing since i was seven!",
    "x".repeat(301),
  ];
  it("keeps tags as scopes, drops blanks and duplicates, and reports lines that are too long", () => {
    const { records, skipped } = fromLines(lines, { now: NOW, id: ids });
    expect(records).toHaveLength(2);
    expect(records[1].scope).toEqual({ type: "tag", tag: "Harbor Lights" });
    expect(skipped).toHaveLength(1);
  });
  it("round-trips: lines to records to lines is unchanged", () => {
    const { records } = fromLines(lines, { now: NOW, id: ids });
    const again = toLines(records);
    expect(again).toEqual([`I've been composing since I was seven.`, `[Harbor Lights] "Harbor Lights" is from my album Quiet Hours.`]);
    expect(toLines(fromLines(again, { now: NOW, id: ids }).records)).toEqual(again);
  });
  it("parses a tag only at the start of a line", () => {
    expect(parseLine("[A] b")).toEqual({ tag: "A", text: "b" });
    expect(parseLine("b [A]")).toEqual({ text: "b [A]" });
  });
});

describe("validateFact", () => {
  const good = (): FactRecord => ({ id: "fct_3k9m2x7q1v8c4n6p0r5t2h9wbe", text: "A fact.", kind: "yours", scope: { type: "all" }, created: NOW, modified: NOW });
  it("accepts a good record and keeps unknown fields", () => {
    expect(validateFact({ ...good(), futureField: 1 })).toEqual([]);
  });
  it("names each problem", () => {
    const bad = { ...good(), id: "x", text: "y".repeat(301), kind: "nope", scope: { type: "song" }, expires: "soon", modified: "yesterday" };
    expect(validateFact(bad)).toEqual(expect.arrayContaining(["id is not a permanent id", "kind is not one of yours, joke", "song scope needs a title", "expires is not a date", "modified is not a date and time"]));
  });
  it("shows a fact through its expiry date", () => {
    expect(isExpired({ expires: "2026-12-06" }, "2026-12-06")).toBe(false);
    expect(isExpired({ expires: "2026-12-06" }, "2026-12-07")).toBe(true);
  });
});

describe("the example package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../docs/schema/examples/facts.example.bffacts"), "utf8"));
  it("has only valid records", () => {
    for (const f of pkg.facts) expect({ id: f.id, problems: validateFact(f) }).toEqual({ id: f.id, problems: [] });
  });
});
