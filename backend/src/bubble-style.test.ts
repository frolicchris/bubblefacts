import fs from "fs";
import path from "path";
import { autoTextColor, BUBBLE_STYLES, contrast, contrastOver, CUSTOM_ALPHA, customColors, MAX_SCALE, MIN_CONTRAST, MIN_SCALE, styleFrom } from "./bubble-style";

/** Bubble Styles (issue #177), checked against the overlay's real CSS. */
const OBS = path.resolve(__dirname, "../../frontend/obs");
const CSS = fs.readFileSync(path.join(OBS, "obs-overlay.css"), "utf8");
const SCRIPT = fs.readFileSync(path.join(OBS, "obs-overlay.js"), "utf8");

/** The declarations in one rule, by its exact selector. */
function block(selector: string): Record<string, string> {
  const at = CSS.indexOf(selector + " {");
  if (at < 0) throw new Error(`No rule for ${selector} in obs-overlay.css`);
  const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(
    body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()])
  );
}

const selectorOf = (style: string) => (style === "classic" ? ":where(:root)" : `:where(html[data-style="${style}"])`);
/** A Style's properties: the classic ones, with the Style's own on top, as the browser sees them. */
const palette = (style: string) => ({ ...block(":where(:root)"), ...block(selectorOf(style)) });

type Rgba = { rgb: [number, number, number]; alpha: number };
function color(value: string): Rgba {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number], alpha: 1 };
  }
  const rgba = value.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  throw new Error(`Not a color the test can read: ${value}`);
}

/** Text on a see-through background, at its worst over the stream's video (black or white under it). */
function worstContrast(text: string, background: string): number {
  const fg = color(text);
  const bg = color(background);
  expect(fg.alpha).toBe(1);
  return contrastOver(fg.rgb, bg.rgb, bg.alpha);
}

describe("every built-in Style", () => {
  it("is in the CSS and the overlay script, under the same names", () => {
    for (const style of BUBBLE_STYLES) {
      if (style !== "classic") block(selectorOf(style));
      expect(SCRIPT).toContain(`"${style}"`);
    }
    expect(SCRIPT).toMatch(new RegExp(`const STYLES = \\[${BUBBLE_STYLES.map((s) => `"${s}"`).join(", ")}\\];`));
  });

  it("is in the app's settings and its Style menu, so the app never turns a new Style back into classic", () => {
    const desktop = path.join(__dirname, "..", "..", "desktop");
    const settings = fs.readFileSync(path.join(desktop, "src", "settings.ts"), "utf8");
    expect(settings).toContain(`export const BUBBLE_STYLES = [${BUBBLE_STYLES.map((s) => `"${s}"`).join(", ")}] as const;`);
    const html = fs.readFileSync(path.join(desktop, "renderer", "index.html"), "utf8");
    const menu = /<select id="s-style"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? "";
    expect([...menu.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])).toEqual([...BUBBLE_STYLES]);
  });

  it("has the overlay keep a bubble size within the server's limits", () => {
    expect(SCRIPT).toContain(`n >= ${MIN_SCALE} && n <= ${MAX_SCALE}`);
  });

  it.each(BUBBLE_STYLES)("%s keeps every text at WCAG AA contrast (4.5:1), over dark or light video", (style) => {
    const p = palette(style);
    for (const bg of ["--bf-bg-1", "--bf-bg-2"]) expect(worstContrast(p["--bf-text"], p[bg])).toBeGreaterThanOrEqual(MIN_CONTRAST);
    for (const bg of ["--bf-toast-bg-1", "--bf-toast-bg-2"]) {
      for (const text of ["--bf-toast-text", "--bf-toast-label", "--bf-live-learn"]) {
        expect([text, bg, worstContrast(p[text], p[bg]) >= MIN_CONTRAST]).toEqual([text, bg, true]);
      }
    }
  });

  it("high contrast keeps every text at WCAG AAA (7:1) on a solid background", () => {
    const p = palette("high-contrast");
    for (const bg of ["--bf-bg-1", "--bf-bg-2", "--bf-toast-bg-1", "--bf-toast-bg-2"]) expect(p[bg]).toMatch(/^#[0-9a-f]{6}$/i);
    for (const [text, bg] of [["--bf-text", "--bf-bg-1"], ["--bf-toast-text", "--bf-toast-bg-1"], ["--bf-toast-label", "--bf-toast-bg-1"], ["--bf-live-learn", "--bf-toast-bg-1"]]) {
      expect([text, worstContrast(p[text], p[bg]) >= 7]).toEqual([text, true]);
    }
    expect(p["--bf-text-shadow"]).toBe("none");
  });

  it.each(BUBBLE_STYLES)("%s changes only the look: no sizes, animations or text", (style) => {
    for (const [name, value] of Object.entries(block(selectorOf(style)))) {
      // Only the look's own custom properties: so text stays at the readable sizes set apart from
      // the Styles (24px on a 1080p canvas, 40px on a 1080-wide vertical one), animations stay
      // transform and opacity, and nothing like content: can change what a bubble says.
      expect(name).toMatch(/^--bf-/);
      expect(name).not.toMatch(/scale|size|width-max|min-width|max-width|animation|transition|content/);
      // No fonts or images from the internet: OBS may be offline, and the overlay must never wait on one.
      expect(value).not.toMatch(/url\(|@import/);
    }
  });

  it("uses the Style's properties in the bubble and the Now Playing bubble, so the classic look is unchanged", () => {
    // Classic is the dark blue the overlay always had.
    expect(palette("classic")).toMatchObject({ "--bf-bg-1": "rgba(10, 10, 60, 0.94)", "--bf-accent": "#5b6ee1", "--bf-text": "#f2f2f2", "--bf-toast-text": "#ffd700" });
    const bubble = block(".popup-bubble");
    expect(bubble).toMatchObject({ color: "var(--bf-text)", "font-family": "var(--bf-font)", "border-radius": "var(--bf-radius)" });
    expect(block(".song-toast")).toMatchObject({ color: "var(--bf-toast-text)", "border-radius": "var(--bf-toast-radius)" });
    // Sizes still come from the bubble size settings alone.
    expect(bubble["font-size"]).toBe("var(--fact-font-size)");
  });

  it("is set with no specificity, so OBS's Custom CSS box still wins", () => {
    expect(CSS).toContain(":where(:root) {");
    expect(CSS).not.toMatch(/(^|\n)html\[data-style/);
  });
});

describe("your own colors", () => {
  /** Every 17th value of each channel, the grays one by one, and some favorites. */
  const backgrounds: string[] = [];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) backgrounds.push(`#${hex(r)}${hex(g)}${hex(b)}`);
  for (let v = 0; v <= 255; v++) backgrounds.push(`#${hex(v)}${hex(v)}${hex(v)}`);
  backgrounds.push("#777777", "#767676", "#808080", "#ff0000", "#00ff00", "#0000ff", "#9146ff", "#53fc18", "#ff69b4");
  const rgbOf = (c: string) => color(c).rgb;

  it("picks light or dark text that reads at WCAG AA on any background", () => {
    for (const bg of backgrounds) {
      const text = autoTextColor(bg);
      expect([bg, text, contrastOver(rgbOf(text), rgbOf(bg), CUSTOM_ALPHA) >= MIN_CONTRAST]).toEqual([bg, text, true]);
    }
    expect(autoTextColor("#0a0a3c")).toBe("#ffffff");
    expect(autoTextColor("#ffffff")).toBe("#111111");
    expect(autoTextColor("#ffd700")).toBe("#111111");
  });

  it("uses the accent for the Now Playing label only when it reads, and the text color otherwise", () => {
    for (const bg of backgrounds.filter((_, i) => i % 7 === 0)) {
      for (const accent of ["#5b6ee1", "#ffd700", "#ff69b4", "#111111", "#ffffff", bg]) {
        const c = customColors(accent, bg);
        for (const key of ["text", "label", "liveLearn"] as const) {
          expect([bg, accent, key, contrastOver(rgbOf(c[key]), rgbOf(bg), CUSTOM_ALPHA) >= MIN_CONTRAST]).toEqual([bg, accent, key, true]);
        }
      }
    }
    expect(customColors("#ffd700", "#0a0a3c").label).toBe("#ffd700");
    // Yellow on white can't be read: the label is the dark text instead. Its words still say NOW PLAYING.
    expect(customColors("#ffd700", "#ffffff").label).toBe("#111111");
  });

  it("is checked at the opacity the overlay draws the background with", () => {
    expect(SCRIPT).toContain(`const CUSTOM_ALPHA = ${CUSTOM_ALPHA};`);
  });

  it("has contrast that agrees with WCAG's own examples", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([118, 118, 118], [255, 255, 255])).toBeCloseTo(4.54, 2);
  });
});

describe("styleFrom", () => {
  it("never refuses: an unknown Style is classic, and broken colors are ignored", () => {
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    expect(styleFrom("retro", "", "", warn)).toEqual({ type: "style", style: "retro" });
    expect(styleFrom("RETRO ", undefined, undefined, warn)).toEqual({ type: "style", style: "retro" });
    expect(warnings).toEqual([]);
    expect(styleFrom("neon", "", "", warn)).toEqual({ type: "style", style: "classic" });
    expect(styleFrom(undefined, undefined, undefined, warn)).toEqual({ type: "style", style: "classic" });
    expect(styleFrom(42, null, {}, warn)).toEqual({ type: "style", style: "classic" });
    expect(styleFrom("light", "#ff8800", "white", warn)).toEqual({ type: "style", style: "light" });
    expect(styleFrom("light", "#ff8800", "", warn)).toEqual({ type: "style", style: "light" });
    expect(warnings).toHaveLength(3);
  });

  it("carries a bubble size between 0.5 and 3, and leaves out anything else", () => {
    expect(styleFrom("classic", "", "", undefined, { scale: "1.25", verticalScale: 1.5 })).toEqual({ type: "style", style: "classic", scale: 1.25, verticalScale: 1.5 });
    for (const bad of ["", "big", "0.2", 4, NaN, undefined]) expect(styleFrom("classic", "", "", undefined, { scale: bad })).toEqual({ type: "style", style: "classic" });
  });

  it("keeps the bubble size's default with no specificity, so OBS's Custom CSS still wins", () => {
    expect(CSS).toMatch(/:where\(html\) \{\s*--bf-scale: 1;/);
    expect(CSS).not.toMatch(/(^|\n):root \{[^}]*--bf-scale:/);
  });

  it("works out every color the overlay needs from an accent and a background", () => {
    expect(styleFrom("minimal", "#FF8800", "#ffffff")).toEqual({
      type: "style",
      style: "minimal",
      colors: { background: "#ffffff", accent: "#ff8800", text: "#111111", label: "#111111", liveLearn: "#7a5200" },
    });
  });
});

describe("the bubble icon choice", () => {
  const { styleFrom: from, BUBBLE_ICONS: ICONS } = jest.requireActual("./bubble-style") as typeof import("./bubble-style");
  it("is left out when it's the Style's own, and sent when chosen", () => {
    expect(from("classic", "", "", () => {}, {})).not.toHaveProperty("icon");
    expect(from("classic", "", "", () => {}, { icon: "style" })).not.toHaveProperty("icon");
    for (const icon of ICONS.filter((i) => i !== "style")) expect(from("light", "", "", () => {}, { icon })).toMatchObject({ icon });
    expect(from("light", "", "", () => {}, { icon: " Heart " })).toMatchObject({ icon: "heart" });
  });

  it("never refuses: an unknown icon is the Style's own, with a line in the log", () => {
    const lines: string[] = [];
    const out = from("minimal", "", "", (l) => lines.push(l), { icon: "skull" });
    expect(out).not.toHaveProperty("icon");
    expect(lines.join(" ")).toMatch(/Unknown bubble icon/);
  });
});
