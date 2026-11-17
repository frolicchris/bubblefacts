import fs from "fs";
import path from "path";
import { BUBBLE_STYLES, styleFrom } from "./bubble-style";
import { checkStyleLook, readStyleFile, STYLE_FILE_MAX_BYTES, STYLE_FILE_SETTINGS, StyleFileResult } from "./style-file";

/** Style files (#402): a shared look is untrusted, so every bad one is refused with one plain line */
const ROOT = path.resolve(__dirname, "../..");
const CSS = fs.readFileSync(path.join(ROOT, "frontend/obs/obs-overlay.css"), "utf8");

const good = {
  bubblefacts: "style",
  format: 1,
  name: "Sunset Set",
  author: "A Made-Up Maker",
  madeFor: "2.3.0",
  values: {
    "--bf-toast-text": "#FFD700",
    "--bf-bg-1": "rgba(40, 10, 60, 0.95)",
    "--bf-bg-2": "#2a0a3c",
    "--bf-text": "#fff",
    "--bf-accent": "#ff8800",
    "--bf-radius": "12px",
    "--bf-weight": 700,
    "--bf-font": "Georgia, 'Times New Roman', serif",
    "--bf-text-shadow": "0 2px 4px rgba(0, 0, 0, 0.9)",
    "--bf-icon": "♪",
  },
};
const file = (changes: Record<string, unknown> = {}, values: Record<string, unknown> = {}) => ({ ...good, ...changes, values: { ...good.values, ...values } });
const reason = (r: StyleFileResult) => (r.ok ? "accepted" : r.reason);

describe("a Style file", () => {
  it("is read into a look whose values BubbleFacts wrote itself, in a fixed order", () => {
    const result = readStyleFile(JSON.stringify(good), "2.3.0-beta.1");
    expect(result).toEqual({
      ok: true,
      look: {
        name: "Sunset Set",
        author: "A Made-Up Maker",
        madeFor: "2.3.0",
        values: {
          "--bf-font": "'Georgia', 'Times New Roman', serif",
          "--bf-weight": "700",
          "--bf-radius": "12px",
          "--bf-icon": '"\\266a "',
          "--bf-bg-1": "rgba(40, 10, 60, 0.95)",
          "--bf-bg-2": "#2a0a3c",
          "--bf-text": "#ffffff",
          "--bf-text-shadow": "0px 2px 4px rgba(0, 0, 0, 0.9)",
          "--bf-accent": "#ff8800",
          "--bf-toast-text": "#ffd700",
        },
      },
    });
  });

  it("reads its own output again, unchanged", () => {
    const first = checkStyleLook(good);
    if (!first.ok) throw new Error(first.reason);
    // The icon is kept as CSS escapes, which a file doesn't hold: all the rest round-trips
    const { "--bf-icon": _icon, ...values } = first.look.values;
    const second = checkStyleLook({ ...first.look, values });
    expect(second).toEqual({ ok: true, look: { ...first.look, values } });
  });

  it("keeps a name and author short and plain", () => {
    const result = checkStyleLook(file({ name: "  <b>Neon</b>\n\u0007 nights " + "x".repeat(80), author: 42 }));
    if (!result.ok) throw new Error(result.reason);
    expect(result.look.name).toMatch(/^b Neon \/b nights x+$/);
    expect(result.look.name.length).toBeLessThanOrEqual(40);
    expect(result.look.author).toBe("");
    expect((checkStyleLook(file({ name: "" })) as { look: { name: string } }).look.name).toBe("Shared look");
  });

  it.each([
    ["text that isn't JSON", "body { display: none }"],
    ["a list", "[]"],
    ["some other JSON", JSON.stringify({ settings: { channel: "someone" } })],
    ["a file that is far too big", JSON.stringify(file({ name: "x".repeat(STYLE_FILE_MAX_BYTES) }))],
  ])("refuses %s", (_what, text) => {
    expect(readStyleFile(text, "2.3.0").ok).toBe(false);
  });

  it.each([
    ["no version", file({ madeFor: undefined }), /doesn't say which BubbleFacts/],
    ["a version before Style files", file({ madeFor: "2.2.4" }), /older BubbleFacts/],
    ["a later major version", file({ madeFor: "3.0.0" }), /newer BubbleFacts/],
    ["a later file format", file({ format: 2 }), /newer BubbleFacts/],
    ["no values", { ...good, values: {} }, /empty/],
    ["values that aren't a list of settings", { ...good, values: ["--bf-text"] }, /isn't a BubbleFacts Style file/],
  ])("refuses a file with %s", (_what, raw, line) => {
    expect(reason(checkStyleLook(raw, "2.3.0"))).toMatch(line);
  });

  it("takes a file made for a later 2.x, whose settings it knows", () => {
    expect(checkStyleLook(file({ madeFor: "2.9.0" }), "2.3.0").ok).toBe(true);
  });

  it.each([
    ["a text size", "--bf-scale", "3"],
    ["the vertical text size", "--bf-vertical-scale", "3"],
    ["a setting that isn't a --bf- one", "display", "none"],
    ["a selector", ".popup-bubble { display: none } :root", "x"],
    ["an unknown --bf- setting", "--bf-opacity", "0"],
    ["an inherited name", "constructor", "x"],
  ])("refuses %s", (_what, key, value) => {
    const result = checkStyleLook(file({}, { [key]: value }), "2.3.0");
    expect(reason(result)).toMatch(/a setting BubbleFacts doesn't use/);
    expect(reason(result)).not.toMatch(/[{}<>]/);
  });

  it.each([
    ["--bf-bg-1", "url(https://example.com/a.png)"],
    ["--bf-bg-1", "red; } .popup-bubble { display: none } :root {"],
    ["--bf-bg-1", "var(--bf-text)"],
    ["--bf-bg-1", "transparent"],
    ["--bf-bg-1", "rgba(300, 0, 0, 1)"],
    ["--bf-text", "rgba(255, 255, 255, 0.1)"],
    ["--bf-text", "transparent"],
    ["--bf-accent", "expression(alert(1))"],
    ["--bf-icon", "url(https://example.com/a.png)"],
    ["--bf-icon", "\"; } body { display: none } :root { --x: \""],
    ["--bf-icon", "abc"],
    ["--bf-icon", " "],
    ["--bf-font", "x; @import url(https://example.com/a.css)"],
    ["--bf-font", "url(https://example.com/font.woff2)"],
    ["--bf-font", ""],
    ["--bf-weight", "bold; display: none"],
    ["--bf-weight", "5000"],
    ["--bf-radius", "9999px"],
    ["--bf-radius", "50%"],
    ["--bf-border-width", "400px"],
    ["--bf-letter-spacing", "40em"],
    ["--bf-letter-spacing", "-1em"],
    ["--bf-text-shadow", "0 0 0 9999px #000"],
    ["--bf-text-shadow", "0 2px 4px url(x)"],
    ["--bf-toast-glow", "inset 0 0 4px #000, 0 0 4px #000, 0 0 4px #000, 0 0 4px #000"],
    ["--bf-text", { toString: "x" }],
    ["--bf-text", null],
    ["--bf-text", "#fff" + " ".repeat(300)],
  ])("refuses %s set to %j", (key, value) => {
    expect(reason(checkStyleLook(file({}, { [key]: value }), "2.3.0"))).toBe(`That Style file has a value BubbleFacts can't use for ${key}.`);
  });

  it.each([
    ["bubble text", { "--bf-text": "#777777", "--bf-bg-1": "#888888", "--bf-bg-2": "#888888" }],
    ["bubble text on the second background color", { "--bf-text": "#ffffff", "--bf-bg-1": "#000000", "--bf-bg-2": "#eeeeee" }],
    ["text that matches a background the file leaves at Classic", { "--bf-text": "#0a0a3c" }],
    ["the Now Playing title", { "--bf-toast-bg-1": "#ffd700", "--bf-toast-bg-2": "#ffd700" }],
    ["the Now Playing label", { "--bf-toast-label": "#14145a" }],
    ["the Live Learn label", { "--bf-live-learn": "#0a0a32" }],
  ])("refuses %s under 4.5:1", (_what, values) => {
    expect(reason(checkStyleLook({ ...good, values }, "2.3.0"))).toBe("That Style's text is too hard to read on its background.");
  });

  it("refuses a background too see-through to read on, whatever the text color", () => {
    const values = { "--bf-text": "#767676", "--bf-bg-1": "rgba(0, 0, 0, 0)", "--bf-bg-2": "#00000000" };
    expect(reason(checkStyleLook({ ...good, values }, "2.3.0"))).toBe("That Style's background is too see-through to read on stream.");
  });

  it("says why in one short plain line", () => {
    const bad = [file({ madeFor: "1.0.0" }), file({}, { "--bf-bg-1": "url(x)" }), file({}, { nope: 1 }), { ...good, values: {} }, "x", null];
    for (const raw of bad) {
      const line = reason(checkStyleLook(raw, "2.3.0"));
      expect(line.length).toBeLessThan(110);
      expect(line).not.toMatch(/\n|JSON|parse|undefined|null/);
    }
  });
});

describe("every built-in Style, written as a Style file", () => {
  /** The declarations in one rule, by its exact selector */
  function block(selector: string): Record<string, string> {
    const at = CSS.indexOf(selector + " {");
    if (at < 0) throw new Error(`No rule for ${selector}`);
    const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    return Object.fromEntries(body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
  }

  it.each(BUBBLE_STYLES)("%s passes the same checks a shared look must", (style) => {
    const css = { ...block(":where(:root)"), ...(style === "classic" ? {} : block(`:where(html[data-style="${style}"])`)) };
    // What a file can't say: a value taken from another setting, and the icon as a CSS escape
    const values = Object.fromEntries(Object.entries(css).filter(([key, value]) => key !== "--bf-icon" && !value.startsWith("var(")));
    expect(reason(checkStyleLook({ bubblefacts: "style", name: style, madeFor: "2.3.0", values }, "2.3.0"))).toBe("accepted");
  });

  it("covers every look setting in docs/DESIGN.md but the two sizes", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/DESIGN.md"), "utf8");
    const table = doc.slice(doc.indexOf("| Setting |"), doc.indexOf("**The selectors**"));
    const documented = [...new Set(table.match(/--bf-[a-z0-9-]+/g))].filter((k) => !["--bf-scale", "--bf-vertical-scale"].includes(k));
    expect([...STYLE_FILE_SETTINGS].sort()).toEqual(documented.sort());
  });
});

describe("the app's copy", () => {
  it("is this same file, so the app and the server refuse the same looks", () => {
    const here = fs.readFileSync(path.join(__dirname, "style-file.ts"), "utf8");
    expect(fs.readFileSync(path.join(ROOT, "desktop/src/style-file.ts"), "utf8")).toBe(here);
  });
});

describe("styleFrom with an imported look", () => {
  it("sends the checked look, and keeps the Style and colors to fall back to", () => {
    const style = styleFrom("retro", "#ff8800", "#ffffff", undefined, { file: good });
    expect(style.style).toBe("retro");
    expect(style.colors?.accent).toBe("#ff8800");
    expect(style.look?.name).toBe("Sunset Set");
    expect(style.look?.values["--bf-text"]).toBe("#ffffff");
    // From the environment it arrives as text
    expect(styleFrom("retro", "", "", undefined, { file: JSON.stringify(good) }).look).toEqual(style.look);
  });

  it("shows the Style instead of a look that fails a check, and says so", () => {
    const warn = jest.fn();
    for (const bad of [file({}, { "--bf-bg-1": "url(https://example.com/a.png)" }), "{", "x".repeat(30_000), 42, []]) {
      expect(styleFrom("light", "", "", warn, { file: bad })).toEqual({ type: "style", style: "light" });
    }
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[0][0]).toMatch(/Showing your Style instead/);
    expect(styleFrom("light", "", "", warn, { file: "" })).toEqual({ type: "style", style: "light" });
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
