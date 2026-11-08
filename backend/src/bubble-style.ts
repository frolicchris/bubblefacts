// Bubble Styles (#177): the built-in look (custom properties in obs-overlay.css) and the streamer's own
// colors over it, with a readable text color. Never the fact text (ARCHITECTURE.md: OBS details)

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
  /** Icon choice, when not the Style's own */
  icon?: BubbleIconName;
}

export const MIN_SCALE = 0.5; // smallest Bubble size: smaller is unreadable
export const MAX_SCALE = 3;   // largest: bigger covers the stream

/** A Bubble size from MIN_SCALE to MAX_SCALE, else null */
export function scaleFrom(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE ? n : null;
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

/** The look from settings, never refusing (a typo mustn't stop bubbles): unknown Style = Classic; `warn` hears what's ignored */
export function styleFrom(style: unknown, accent: unknown, background: unknown, warn: (line: string) => void = () => {}, sizes: { scale?: unknown; verticalScale?: unknown; icon?: unknown } = {}): StylePayload {
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
  const rawIcon = typeof sizes.icon === "string" ? sizes.icon.trim().toLowerCase() : "";
  const icon = (BUBBLE_ICONS as readonly string[]).includes(rawIcon) ? (rawIcon as BubbleIconName) : "style";
  // Any supplied non-choice is reported, whatever its type (a number or object from a hand-written request)
  const iconGiven = sizes.icon !== undefined && sizes.icon !== null && rawIcon !== "";
  const iconSupplied = iconGiven || (sizes.icon !== undefined && sizes.icon !== null && typeof sizes.icon !== "string");
  if (iconSupplied && rawIcon !== icon) warn(`Unknown bubble icon "${String(sizes.icon).slice(0, 40)}": using the Style's own. Choose ${BUBBLE_ICONS.join(", ")}.`);
  return {
    type: "style",
    style: name,
    ...(a && b ? { colors: customColors(a, b) } : {}),
    ...(scale !== null ? { scale } : {}),
    ...(verticalScale !== null ? { verticalScale } : {}),
    ...(icon !== "style" ? { icon } : {}),
  };
}
