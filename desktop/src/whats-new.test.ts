import fs from "fs";
import os from "os";
import path from "path";
import { MAX_HIGHLIGHTS, readWhatsNew, whatsNewOnStart } from "./whats-new";

const notes = { "2.0.0-beta.12": ["Hands-free Wrong.", "Song search."] };

describe("whatsNewOnStart", () => {
  it("shows the highlights the first time an updated app opens", () => {
    expect(whatsNewOnStart("2.0.0-beta.12", "2.0.0-beta.11", true, notes)).toEqual({
      show: { version: "2.0.0-beta.12", highlights: ["Hands-free Wrong.", "Song search."] },
      remember: false,
    });
  });

  it("shows them after an update from a version older than this notice (nothing remembered yet)", () => {
    expect(whatsNewOnStart("2.0.0-beta.12", "", true, notes).show?.version).toBe("2.0.0-beta.12");
  });

  it("shows nothing again once that version was seen or dismissed", () => {
    expect(whatsNewOnStart("2.0.0-beta.12", "2.0.0-beta.12", true, notes)).toEqual({ show: null, remember: false });
  });

  it("shows nothing on a new install, and remembers the version so finishing setup doesn't bring it up", () => {
    expect(whatsNewOnStart("2.0.0-beta.12", "", false, notes)).toEqual({ show: null, remember: true });
  });

  it("shows nothing after going back to an older version", () => {
    expect(whatsNewOnStart("2.0.0-beta.12", "2.0.0", true, notes)).toEqual({ show: null, remember: true });
  });

  it("shows nothing for a version without highlights, and remembers it", () => {
    expect(whatsNewOnStart("2.0.1", "2.0.0", true, notes)).toEqual({ show: null, remember: true });
  });

  it("treats 2.0.0 as newer than its betas", () => {
    expect(whatsNewOnStart("2.0.0", "2.0.0-rc.1", true, { "2.0.0": ["Stable."] }).show?.version).toBe("2.0.0");
  });
});

describe("readWhatsNew", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bubblefacts-whatsnew-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (text: string) => {
    const file = path.join(dir, "whats-new.json");
    fs.writeFileSync(file, text);
    return file;
  };

  it("is empty when the file is missing or broken, so the app opens as usual", () => {
    expect(readWhatsNew(path.join(dir, "missing.json"))).toEqual({});
    expect(readWhatsNew(write("{not json"))).toEqual({});
    expect(readWhatsNew(write("[]"))).toEqual({});
  });

  it("keeps only text lines, trimmed, and at most a few", () => {
    const lines = ["  One. ", "", 3, "Two.", "Three.", "Four.", "Five."];
    expect(readWhatsNew(write(JSON.stringify({ "2.1.0": lines, "2.2.0": "not a list", "2.3.0": [] })))).toEqual({
      "2.1.0": ["One.", "Two.", "Three.", "Four."],
    });
  });
});

describe("the shipped whats-new.json", () => {
  const file = path.resolve(__dirname, "../renderer/whats-new.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string[]>;

  it("reads back exactly as written: versions, and two to four short lines each", () => {
    expect(readWhatsNew(file)).toEqual(raw);
    for (const [version, lines] of Object.entries(raw)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThanOrEqual(MAX_HIGHLIGHTS);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(200);
    }
  });

  it("uses plain punctuation (no em dashes)", () => {
    expect(JSON.stringify(raw)).not.toMatch(/—/);
  });
});
