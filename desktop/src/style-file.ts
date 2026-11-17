// Style files (#402): a look someone shared, as a small JSON file of --bf- values. The file is
// untrusted: only known settings, each rebuilt from what was parsed (never copied through), so a
// file can't carry a selector, a web address, a script, a text size or anything that hides a bubble.
// The app and the server are compiled separately: desktop/src/style-file.ts is a copy of this file,
// and a test keeps the two the same.

export const STYLE_FILE_FORMAT = 1;
/** Bigger than any real look by far */
export const STYLE_FILE_MAX_BYTES = 16_384;
/** The first BubbleFacts with Style files; one made for an earlier version is refused */
export const STYLE_FILE_SINCE = "2.3.0";
/** WCAG AA, normal text: as MIN_CONTRAST in bubble-style.ts */
export const STYLE_MIN_CONTRAST = 4.5;
/** A background more see-through than this can't promise readable text over video */
export const STYLE_MIN_BACKGROUND_ALPHA = 0.7;

/** A checked look: every value is one this file wrote */
export interface StyleLook {
  name: string;
  author: string;
  madeFor: string;
  values: Record<string, string>;
}

export type StyleFileResult = { ok: true; look: StyleLook } | { ok: false; reason: string };

interface Color { r: number; g: number; b: number; a: number }

const NUMBER = /^-?\d{1,4}(?:\.\d{1,4})?$/;

function parseColor(raw: string, allowTransparent: boolean): Color | null {
  const value = raw.trim().toLowerCase();
  if (value === "transparent") return allowTransparent ? { r: 0, g: 0, b: 0, a: 0 } : null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const at = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: at(0), g: at(2), b: at(4), a: h.length === 8 ? Math.round((at(6) / 255) * 100) / 100 : 1 };
  }
  const fn = /^rgba?\(([^()]*)\)$/.exec(value);
  if (!fn) return null;
  const parts = fn[1].split(",").map((p) => p.trim());
  if ((parts.length !== 3 && parts.length !== 4) || !parts.every((p) => NUMBER.test(p))) return null;
  const [r, g, b] = parts.slice(0, 3).map(Number);
  const a = parts.length === 4 ? Number(parts[3]) : 1;
  if (![r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255) || a < 0 || a > 1) return null;
  return { r, g, b, a };
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const colorCss = (c: Color) => (c.a === 1 ? `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}` : `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`);

/** A number with the unit or none, inside the range, else null */
function measure(raw: string, unit: "px" | "em", min: number, max: number): number | null {
  const value = raw.trim().toLowerCase();
  const bare = value.endsWith(unit) ? value.slice(0, -unit.length) : value;
  if (!NUMBER.test(bare)) return null;
  const n = Number(bare);
  return n >= min && n <= max ? n : null;
}

const GENERIC_FONTS = ["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "-apple-system"];

/** Generic fonts that always show letters as letters */
const READABLE_FONTS = ["serif", "sans-serif", "monospace", "system-ui"];
/** Fonts that draw pictures in place of letters (Webdings, Wingdings 2, Symbol, icon fonts): a fact would be unreadable. Known names only */
const SYMBOL_FONT = /dings|dingbat|^symbol$|marlett|mdl2|icons?$|font ?awesome|bookshelf symbol|mt extra|ms outlook|emoji/i;

/**
 * Fonts already on the computer, by name: there is no way to name a file or a web address. Always
 * ends in a plain generic font, for a computer without the named ones
 */
function fontCss(raw: string): string | null {
  const families = raw.split(",").map((f) => f.trim().replace(/^(['"])(.*)\1$/, "$2").trim());
  if (!families.every((f) => /^-?[A-Za-z0-9][A-Za-z0-9 _-]{0,40}$/.test(f)) || families.some((f) => SYMBOL_FONT.test(f))) return null;
  if (!READABLE_FONTS.includes(families[families.length - 1].toLowerCase())) families.push("sans-serif");
  if (families.length > 8) return null;
  return families.map((f) => (GENERIC_FONTS.includes(f.toLowerCase()) ? f.toLowerCase() : `'${f}'`)).join(", ");
}

interface Shadow { x: number; y: number; blur: number; color: Color }

const MAX_SHADOWS = 2;       // one drop shadow and one glow
const MAX_SHADOW_OFFSET = 3; // px; Retro game's hard shadow is 2

/** The shadows of `none` or `x y [blur] color, ...`: a few, close to the text, else null */
function parseShadows(raw: string): Shadow[] | null {
  const value = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (value === "none") return [];
  const parts = value.split(/,(?![^(]*\))/).map((p) => p.trim());
  if (parts.length > MAX_SHADOWS) return null;
  const out: Shadow[] = [];
  for (const part of parts) {
    const m = /^(\S+) (\S+)(?: (-?[\d.]+(?:px)?))? ([#a-z].*)$/.exec(part);
    if (!m) return null;
    const x = measure(m[1], "px", -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET);
    const y = measure(m[2], "px", -MAX_SHADOW_OFFSET, MAX_SHADOW_OFFSET);
    const blur = m[3] === undefined ? 0 : measure(m[3], "px", 0, 24);
    const color = parseColor(m[4], true);
    if (x === null || y === null || blur === null || !color) return null;
    out.push({ x, y, blur, color });
  }
  return out;
}

function shadowCss(raw: string): string | null {
  const shadows = parseShadows(raw);
  if (!shadows) return null;
  return shadows.length ? shadows.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${colorCss(s.color)}`).join(", ") : "none";
}

/**
 * One visible character, kept as itself (an emoji may carry its variation mark). The overlay writes
 * it as a CSS string. Not blank ones: spaces, zero-width and filler characters, or a mark alone
 */
export const STYLE_ICON = /^[^\p{C}\p{Z}\p{M}"'\\\u3164\u115F\u1160\uFFA0\u2800](?:\uFE0E|\uFE0F)?$/u;

function iconCss(raw: string): string | null {
  return STYLE_ICON.test(raw) ? raw : null;
}

type Kind = "background" | "text" | "color" | "radius" | "width" | "spacing" | "weight" | "font" | "shadow" | "icon";

/** Every setting a Style file may hold. Not here on purpose: --bf-scale and --bf-vertical-scale (text size is the streamer's) */
const SETTINGS: Record<string, Kind> = {
  "--bf-font": "font",
  "--bf-weight": "weight",
  "--bf-letter-spacing": "spacing",
  "--bf-toast-letter-spacing": "spacing",
  "--bf-radius": "radius",
  "--bf-icon": "icon",
  "--bf-bg-1": "background",
  "--bf-bg-2": "background",
  "--bf-text": "text",
  "--bf-text-shadow": "shadow",
  "--bf-accent": "color",
  "--bf-border-width": "width",
  "--bf-outline": "color",
  "--bf-outline-width": "width",
  "--bf-cursor": "color",
  "--bf-sparkle": "color",
  "--bf-toast-radius": "radius",
  "--bf-toast-bg-1": "background",
  "--bf-toast-bg-2": "background",
  "--bf-toast-text": "text",
  "--bf-toast-glow": "shadow",
  "--bf-toast-label": "text",
  "--bf-toast-border": "color",
  "--bf-toast-border-width": "width",
  "--bf-toast-highlight": "color",
  "--bf-live-learn": "text",
};

export const STYLE_FILE_SETTINGS: readonly string[] = Object.keys(SETTINGS);

/** The value as this file writes it, else null */
function valueCss(kind: Kind, raw: string): string | null {
  switch (kind) {
    case "background": {
      const c = parseColor(raw, false);
      return c ? colorCss(c) : null;
    }
    case "text": {
      const c = parseColor(raw, false);
      return c && c.a === 1 ? colorCss(c) : null;
    }
    case "color": {
      const c = parseColor(raw, true);
      return c ? colorCss(c) : null;
    }
    case "radius": {
      const n = measure(raw, "px", 0, 40);
      return n === null ? null : `${n}px`;
    }
    case "width": {
      const n = measure(raw, "px", 0, 8);
      return n === null ? null : `${n}px`;
    }
    case "spacing": {
      const n = measure(raw, "em", -0.08, 0.3);
      return n === null ? null : `${n}em`;
    }
    case "weight": {
      const n = measure(raw, "px", 100, 900);
      return n === null || !Number.isInteger(n) || /px$/i.test(raw.trim()) ? null : String(n);
    }
    case "font":
      return fontCss(raw);
    case "shadow":
      return shadowCss(raw);
    case "icon":
      return iconCss(raw);
  }
}

// --- Contrast: text on its own background, over the brightest and darkest video ---

type Rgb = [number, number, number];

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Lowest contrast of opaque `text` on `background`, which may be see-through */
function worstContrast(text: Color, background: Color): number {
  const t: Rgb = [text.r, text.g, text.b];
  const over = (video: number): Rgb => [background.r, background.g, background.b].map((c) => c * background.a + video * (1 - background.a)) as Rgb;
  return Math.min(contrast(t, over(0)), contrast(t, over(255)));
}

/** Classic's own values (obs-overlay.css), which show wherever a file is silent */
const CLASSIC: Record<string, string> = {
  "--bf-bg-1": "rgba(10, 10, 60, 0.94)",
  "--bf-bg-2": "rgba(20, 20, 90, 0.94)",
  "--bf-text": "#f2f2f2",
  "--bf-toast-bg-1": "rgba(10, 10, 50, 0.92)",
  "--bf-toast-bg-2": "rgba(20, 20, 80, 0.92)",
  "--bf-toast-text": "#ffd700",
  "--bf-toast-label": "#8ca0ff",
  "--bf-live-learn": "#ffd700",
};

/** Each text color with the backgrounds it sits on */
const PAIRS: Array<[text: string, backgrounds: string[]]> = [
  ["--bf-text", ["--bf-bg-1", "--bf-bg-2"]],
  ["--bf-toast-text", ["--bf-toast-bg-1", "--bf-toast-bg-2"]],
  ["--bf-toast-label", ["--bf-toast-bg-1", "--bf-toast-bg-2"]],
  ["--bf-live-learn", ["--bf-toast-bg-1", "--bf-toast-bg-2"]],
];

/** A shadow that is a second copy of the words: set off from them, solid enough to see, in nearly their color */
const SHADOW_MIN_CONTRAST = 3;
const SHADOWS: Array<[shadow: string, text: string]> = [["--bf-text-shadow", "--bf-text"], ["--bf-toast-glow", "--bf-toast-text"]];

function smears(values: Record<string, string>): boolean {
  return SHADOWS.some(([shadow, text]) => {
    const t = parseColor(values[text] ?? CLASSIC[text], false)!;
    return (parseShadows(values[shadow] ?? "none") ?? []).some(
      (s) => (s.x !== 0 || s.y !== 0) && s.color.a >= 0.3 && contrast([s.color.r, s.color.g, s.color.b], [t.r, t.g, t.b]) < SHADOW_MIN_CONTRAST
    );
  });
}

function readable(values: Record<string, string>): "ok" | "see-through" | "contrast" {
  const color = (key: string) => parseColor(values[key] ?? CLASSIC[key], false)!;
  for (const [text, backgrounds] of PAIRS) {
    for (const background of backgrounds) {
      const bg = color(background);
      if (bg.a < STYLE_MIN_BACKGROUND_ALPHA) return "see-through";
      if (worstContrast(color(text), bg) < STYLE_MIN_CONTRAST) return "contrast";
    }
  }
  return "ok";
}

// --- The file ---

/** [major, minor, patch] of "2.3.0" or "2.3.0-beta.1", else null */
function versionOf(raw: unknown): [number, number, number] | null {
  const m = typeof raw === "string" ? /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-[0-9A-Za-z.-]{1,30})?$/.exec(raw.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const older = (a: [number, number, number], b: [number, number, number]) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

/** A short plain label: no control characters or markup, 40 characters at most */
function label(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\p{C}<>&"'`\\]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
}

const refuse = (reason: string): StyleFileResult => ({ ok: false, reason });

/**
 * A look from an already parsed Style file, or one plain line saying why not. `appVersion` (when
 * known) also refuses a file made for a later major version.
 */
export function checkStyleLook(raw: unknown, appVersion?: string): StyleFileResult {
  const notOne = "That isn't a BubbleFacts Style file.";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse(notOne);
  const file = raw as Record<string, unknown>;
  if (file.bubblefacts !== "style" && !("values" in file && "madeFor" in file)) return refuse(notOne);
  if (file.format !== undefined && file.format !== STYLE_FILE_FORMAT) return refuse("That Style file needs a newer BubbleFacts. Update, then try again.");
  const madeFor = versionOf(file.madeFor);
  if (!madeFor) return refuse("That Style file doesn't say which BubbleFacts it was made for.");
  if (older(madeFor, versionOf(STYLE_FILE_SINCE)!)) return refuse("That Style file was made for an older BubbleFacts. Ask its maker for a new one.");
  const app = versionOf(appVersion);
  if (app && madeFor[0] > app[0]) return refuse("That Style file needs a newer BubbleFacts. Update, then try again.");
  const given = file.values;
  if (!given || typeof given !== "object" || Array.isArray(given)) return refuse(notOne);
  const entries = Object.entries(given as Record<string, unknown>);
  if (!entries.length) return refuse("That Style file is empty.");
  if (entries.length > STYLE_FILE_SETTINGS.length) return refuse(notOne);
  const checked: Record<string, string> = {};
  for (const [key, value] of entries) {
    const kind = Object.prototype.hasOwnProperty.call(SETTINGS, key) ? SETTINGS[key] : undefined;
    const shown = key.replace(/[^a-z0-9-]/gi, "").slice(0, 40);
    // A setting from a later version, not a mistake
    if (!kind && app && older([app[0], app[1], 0], [madeFor[0], madeFor[1], 0])) return refuse("That Style file needs a newer BubbleFacts. Update, then try again.");
    if (!kind) return refuse(`That Style file has a setting BubbleFacts doesn't use: ${shown || "one with no name"}.`);
    const text = typeof value === "number" ? String(value) : value;
    const css = typeof text === "string" && text.length <= 200 ? valueCss(kind, text) : null;
    if (css === null) return refuse(`That Style file has a value BubbleFacts can't use for ${shown}.`);
    checked[key] = css;
  }
  const verdict = readable(checked);
  if (verdict === "see-through") return refuse("That Style's background is too see-through to read on stream.");
  if (verdict === "contrast") return refuse("That Style's text is too hard to read on its background.");
  if (smears(checked)) return refuse("That Style's shadow would make the words hard to read.");
  // In the order above, whatever order the file used
  const values: Record<string, string> = {};
  for (const key of STYLE_FILE_SETTINGS) if (key in checked) values[key] = checked[key];
  return { ok: true, look: { name: label(file.name) || "Shared look", author: label(file.author), madeFor: madeFor.join("."), values } };
}

/** A look from a Style file's text, or one plain line saying why not */
export function readStyleFile(text: string, appVersion?: string): StyleFileResult {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > STYLE_FILE_MAX_BYTES) return refuse("That file is too big to be a BubbleFacts Style file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return refuse("That isn't a BubbleFacts Style file.");
  }
  return checkStyleLook(parsed, appVersion);
}
