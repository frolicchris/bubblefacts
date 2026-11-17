jest.mock("./config", () => ({ config: { topic: "general" } }));

import { readFileSync } from "fs";
import { join } from "path";
import { screenClaims } from "./fact-verifier";
import { NOT_FOR_STREAM, RISKY_PATTERNS } from "./screening/names";
import { escapeRe } from "./text";

interface CaptionCase {
  source: string;
  caption: string;
  expect: "keep" | "drop";
  reason?: string;
  from: string;
  known?: "miss";
  track?: string;
  artists?: string[];
  otherParts?: string[];
  cites?: number;
  before?: string;
  after?: string;
}

/** Reasons no simple row reaches through `screenClaims`, each with why. Keep it empty if you can. */
const KNOWN_GAPS: string[] = [];

describe("the caption corpus", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cases } = require("./fixtures/captions.json") as { cases: CaptionCase[] };
  const results = cases.map((c) => {
    // "cites": the sentence number the model wrote before the caption; "before" and "after": a caption screened in the same batch.
    const cited = c.cites !== undefined;
    const lines = [c.before, cited ? `${c.cites} | ${c.caption}` : c.caption, c.after].filter((l): l is string => Boolean(l));
    const { kept, rejected } = screenClaims(lines, c.source, { track: c.track, artists: c.artists, otherParts: c.otherParts, cited });
    const got = kept.includes(c.caption) ? "keep" : rejected.find((r) => r.text === c.caption)?.reason;
    return { ...c, got, want: c.expect === "keep" ? "keep" : c.reason };
  });

  it.each(results.map((r) => [`${r.expect === "keep" ? "keeps" : "drops"} ${r.caption}`, r] as const))("%s", (_name, r) => {
    // "known": "miss": the screens get this row wrong today, and the row fails once they get it right.
    if (r.known === "miss") expect(r.got === r.want ? 'now right: delete "known": "miss" from the row' : "still a miss").toBe("still a miss");
    else expect(r.got).toBe(r.want);
  });

  it("has a drop row for every reason the screens can give", () => {
    const read = (file: string) => readFileSync(join(__dirname, file), "utf8").replace(/^\s*(?:\/\/|\/?\*).*$/gm, "");
    /** The reasons a piece of code gives, as written: the text in quotes or backticks after "return", "?" or ":". */
    const reasonsIn = (code: string) => [...code.matchAll(/(?:\breturn|[?:])\s+(?:"((?:[^"\\]|\\.)+)"|`((?:[^`\\]|\\.)+)`)/g)].map((m) => m[1] ?? m[2]);
    const body = (file: string, name: string) => {
      const code = read(file);
      const at = code.indexOf(`export function ${name}(`);
      return code.slice(at, code.indexOf("\n}\n", at));
    };
    const screen = read("screening/screen.ts");
    const reasons = screen.slice(screen.indexOf("function captionReason("));
    // Reasons screen.ts hands on as a helper worded them can't be read there: each helper's come from its own list or code.
    const handedOn = [
      ...NOT_FOR_STREAM.map((p) => p.label),
      ...RISKY_PATTERNS.map((p) => p.label),
      ...[...read("content-standard.ts").matchAll(/^\s+label: "([^"]+)",$/gm)].map((m) => `content standard: ${m[1]}`),
      ...reasonsIn(body("screening/sentences.ts", "lostQualifier")),
      ...reasonsIn(body("screening/attribution.ts", "citedMismatch")),
    ];
    // A new reason handed on the same way belongs in the list above.
    const passed = [...reasons.slice(0, reasons.indexOf("export function screenClaims(")).matchAll(/\breturn ([\w.]+);/g)].map((m) => m[1]);
    expect(passed.filter((v) => v !== "null")).toEqual(["unsafe.label", "offStandard", "label", "lost"]);
    expect(reasons).toContain("citedMismatch(");

    // `unsupported year ${year}` is the label "unsupported year …". Two screens may share one: then it needs two rows.
    const label = (written: string) => written.replace(/\$\{[^}]*\}/g, "…");
    const need = new Map<string, number>();
    for (const l of [...reasonsIn(reasons), ...handedOn].map(label)) need.set(l, (need.get(l) ?? 0) + 1);
    const fits = (l: string, reason: string) => new RegExp(`^${l.split("…").map(escapeRe).join(".+")}$`).test(reason);
    /** The label a row's reason was built from: of those it fits, the one with the most fixed text. */
    const labelOf = (reason: string) => [...need.keys()].filter((l) => fits(l, reason)).sort((a, b) => b.replace(/…/g, "").length - a.replace(/…/g, "").length)[0];
    const have = new Map<string, number>();
    for (const r of results) {
      const l = r.expect === "drop" && !r.known && r.reason ? labelOf(r.reason) : undefined;
      if (l) have.set(l, (have.get(l) ?? 0) + 1);
    }
    const missing = [...need].filter(([l, rows]) => (have.get(l) ?? 0) < rows && !KNOWN_GAPS.includes(l)).map(([l, rows]) => `${l} (rows: ${have.get(l) ?? 0} of ${rows})`);
    expect(missing).toEqual([]);
  });
});
