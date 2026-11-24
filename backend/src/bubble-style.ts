// Bubble Styles (#177): the built-in look (custom properties in obs-overlay.css) and the streamer's own
// colors over it, with a readable text color. Never the fact text (ARCHITECTURE.md: OBS details)

import { checkStyleLook } from "./style-file";

/** Built-in Styles; "classic" is the dark blue the overlay always had */
export const BUBBLE_STYLES = ["classic", "light", "minimal", "retro", "high-contrast"] as const;
export type BubbleStyleName = (typeof BUBBLE_STYLES)[number];

/** "style" (default): each Style's own icon (Classic rotates a set); "notes": that rotation anywhere; the rest one character */
export const BUBBLE_ICONS = ["style", "notes", "heart", "star", "moon", "diamond"] as const;
export type BubbleIconName = (typeof BUBBLE_ICONS)[number];

export const CUSTOM_ALPHA = 1;     // custom background opacity: only opaque keeps 4.5:1 over any video; the overlay matches
export const MIN_CONTRAST = 4.5;  // WCAG AA, normal text

/** The overlay's custom colors, each #rrggbb */
export interface StyleColors {
  background: string;
  accent: string;
  /** Fact and title text: light or dark, whichever reads better */
  text: string;
  /** "NOW PLAYING": the accent if readable, else the text color */
  label: string;
  /** "LIVE LEARN": gold if readable, else the text color; the words say what it is either way */
  liveLearn: string;
}

/** Sent to the overlay on connecting and on each saved look */
export interface StylePayload {
  type: "style";
  style: BubbleStyleName;
  colors?: StyleColors;
  /** Bubble size, landscape and vertical (`--bf-scale`, `--bf-vertical-scale`), when set */
  scale?: number;
  verticalScale?: number;
  /** The canvas size the streamer chose for each overlay, when set (#544); the overlay fits its bubbles to it */
  canvas?: CanvasSize;
  verticalCanvas?: CanvasSize;
  /** Icon choice, when not the Style's own */
  icon?: BubbleIconName;
  /** An imported Style file (#402), already checked; `style` and `colors` stay as the look to fall back to */
  look?: { name: string; values: Record<string, string> };
}

/** A Style file's look from a request or the environment (an object, or its JSON), else null with a warning */
function lookFrom(file: unknown, warn: (line: string) => void): StylePayload["look"] | null {
  if (file === undefined || file === null || file === "") return null;
  let raw: unknown = file;
  if (typeof file === "string") {
    try {
      raw = file.length <= 20_000 ? JSON.parse(file) : null;
    } catch {
      raw = null;
    }
  }
  const result = checkStyleLook(raw);
  if (result.ok) return { name: result.look.name, values: result.look.values };
  warn(`Imported look not used: ${result.reason} Showing your Style instead.`);
  return null;
}

export const MIN_SCALE = 0.5; // smallest Bubble size: smaller is unreadable
export const MAX_SCALE = 3;   // largest: bigger covers the stream

/** A Bubble size from MIN_SCALE to MAX_SCALE, else null */
export function scaleFrom(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE ? n : null;
}

/** An OBS canvas in pixels (Settings, Video, Base (Canvas) Resolution) */
export interface CanvasSize {
  width: number;
  height: number;
}

// Canvas sizes (#544); the app's settings.ts has the same rules: keep alike
export const MIN_CANVAS_SIDE = 480;  // smaller than 854x480 and text gets unreadable
export const MAX_CANVAS_SIDE = 7680; // 8K wide: OBS's own limit is higher, but nothing streams bigger
export const MAX_CANVAS_RATIO = 4;   // the long side at most 4 times the short one (32:9 is 3.6)
/** What each overlay draws without a setting */
export const DEFAULT_CANVAS: CanvasSize = { width: 1920, height: 1080 };
export const DEFAULT_VERTICAL_CANVAS: CanvasSize = { width: 1080, height: 1920 };

/**
 * Why a canvas size can't be used, or null. `vertical`: the vertical overlay's, which must be taller than wide;
 * the landscape one at least as wide as tall
 */
export function canvasProblem(width: number, height: number, layout: { vertical: boolean }): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "type whole numbers of pixels, like 1920 and 1080.";
  if ([width, height].some((n) => n < MIN_CANVAS_SIDE || n > MAX_CANVAS_SIDE)) return `the width and height must each be from ${MIN_CANVAS_SIDE} to ${MAX_CANVAS_SIDE}.`;
  if (layout.vertical && height <= width) return "the vertical overlay is for a canvas taller than wide. For a wide canvas, use the size under Bubbles.";
  if (!layout.vertical && width < height) return "this is for a canvas at least as wide as tall. For a tall canvas, use the vertical overlay under Vertical stream.";
  if (Math.max(width, height) > MAX_CANVAS_RATIO * Math.min(width, height)) return `the long side can be at most ${MAX_CANVAS_RATIO} times the short one.`;
  return null;
}

/** A canvas size from the environment or a request ("1440x1080", or { width, height }), else null; `warn` hears why */
export function canvasFrom(value: unknown, layout: { vertical: boolean }, warn: (line: string) => void = () => {}): CanvasSize | null {
  if (value === undefined || value === null || value === "") return null;
  let width = NaN;
  let height = NaN;
  if (typeof value === "string") {
    const m = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(value);
    if (m) [width, height] = [Number(m[1]), Number(m[2])];
  } else if (typeof value === "object") {
    const c = value as Record<string, unknown>;
    if (typeof c.width === "number" && typeof c.height === "number") [width, height] = [c.width, c.height];
  }
  const shown = (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 40);
  if (Number.isNaN(width) || Number.isNaN(height)) {
    warn(`Canvas size "${shown}" not used: write it as width x height, like 1920x1080.`);
    return null;
  }
  const problem = canvasProblem(width, height, layout);
  if (problem) {
    warn(`Canvas size "${shown}" not used: ${problem}`);
    return null;
  }
  return { width, height };
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Strict #rrggbb, lowercased, else null */
export function hexColor(value: unknown): string | null {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toLowerCase() : null;
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** WCAG relative luminance */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colors, 1 to 21 */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` at `alpha` over `under` */
export const over = (color: Rgb, alpha: number, under: Rgb): Rgb => color.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;

/** Worst contrast of `text` on a see-through background: over black and white video, the lower */
export function contrastOver(text: Rgb, background: Rgb, alpha: number): number {
  return Math.min(contrast(text, over(background, alpha, [0, 0, 0])), contrast(text, over(background, alpha, [255, 255, 255])));
}

const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#111111";
const GOLDS = ["#ffd700", "#7a5200"];

/** First candidate readable on the background, else `fallback` */
const readable = (candidates: string[], background: Rgb, fallback: string) =>
  candidates.find((c) => contrastOver(rgb(c), background, CUSTOM_ALPHA) >= MIN_CONTRAST) ?? fallback;

/** White or a soft black, whichever reads better (pure black where soft falls short); opaque, one always reaches 4.5:1 */
export function autoTextColor(background: string): string {
  const bg = rgb(background);
  const light = contrastOver(rgb(LIGHT_TEXT), bg, CUSTOM_ALPHA);
  const black = contrastOver([0, 0, 0], bg, CUSTOM_ALPHA);
  if (light >= black) return LIGHT_TEXT;
  return contrastOver(rgb(DARK_TEXT), bg, CUSTOM_ALPHA) >= MIN_CONTRAST ? DARK_TEXT : "#000000";
}

/** Every color the overlay needs for this accent and background, both already #rrggbb */
export function customColors(accent: string, background: string): StyleColors {
  const bg = rgb(background);
  const text = autoTextColor(background);
  return { background, accent, text, label: readable([accent], bg, text), liveLearn: readable(GOLDS, bg, text) };
}

/**
 * The look from settings, never refusing (a typo mustn't stop bubbles): unknown Style = Classic, custom
 * colors only when both are #rrggbb. `warn` hears what's ignored
 */
export function styleFrom(style: unknown, accent: unknown, background: unknown, warn: (line: string) => void = () => {}, sizes: { scale?: unknown; verticalScale?: unknown; canvas?: unknown; verticalCanvas?: unknown; icon?: unknown; file?: unknown } = {}): StylePayload {
  const raw = typeof style === "string" ? style.trim().toLowerCase() : "";
  const name = (BUBBLE_STYLES as readonly string[]).includes(raw) ? (raw as BubbleStyleName) : "classic";
  if (raw && raw !== name) warn(`Unknown bubble style "${String(style).slice(0, 40)}": using classic. Choose ${BUBBLE_STYLES.join(", ")}.`);
  const a = hexColor(accent);
  const b = hexColor(background);
  const given = [accent, background].some((v) => typeof v === "string" && v.trim());
  if (given && !(a && b)) warn("Custom bubble colors need both an accent and a background, each written like #5b6ee1: using the style's own colors.");
  // Size goes with the look, so it too changes live, no Refresh in OBS
  const scale = scaleFrom(sizes.scale);
  const verticalScale = scaleFrom(sizes.verticalScale);
  const canvas = canvasFrom(sizes.canvas, { vertical: false }, warn);
  const verticalCanvas = canvasFrom(sizes.verticalCanvas, { vertical: true }, warn);
  const rawIcon = typeof sizes.icon === "string" ? sizes.icon.trim().toLowerCase() : "";
  const icon = (BUBBLE_ICONS as readonly string[]).includes(rawIcon) ? (rawIcon as BubbleIconName) : "style";
  // Any supplied non-choice is reported, whatever its type (a number or object from a hand-written request)
  const iconGiven = sizes.icon !== undefined && sizes.icon !== null && rawIcon !== "";
  const iconSupplied = iconGiven || (sizes.icon !== undefined && sizes.icon !== null && typeof sizes.icon !== "string");
  if (iconSupplied && rawIcon !== icon) warn(`Unknown bubble icon "${String(sizes.icon).slice(0, 40)}": using the Style's own. Choose ${BUBBLE_ICONS.join(", ")}.`);
  const look = lookFrom(sizes.file, warn);
  return {
    type: "style",
    style: name,
    ...(a && b ? { colors: customColors(a, b) } : {}),
    ...(scale !== null ? { scale } : {}),
    ...(verticalScale !== null ? { verticalScale } : {}),
    ...(canvas ? { canvas } : {}),
    ...(verticalCanvas ? { verticalCanvas } : {}),
    ...(icon !== "style" ? { icon } : {}),
    ...(look ? { look } : {}),
  };
}
