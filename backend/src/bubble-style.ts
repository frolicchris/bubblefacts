/**
 * Bubble Styles (issue #177): which built-in look the overlay uses, and the streamer's own
 * accent and background colors on top of it. The looks themselves are custom properties in
 * frontend/obs/obs-overlay.css; this file picks one and works out a readable text color for
 * custom colors. Styles change the look, never the fact text.
 */

/** The built-in Styles. "classic" is the dark blue the overlay always had. */
export const BUBBLE_STYLES = ["classic", "light", "minimal", "retro", "high-contrast"] as const;
export type BubbleStyleName = (typeof BUBBLE_STYLES)[number];

/**
 * How opaque a custom background is: fully. A see-through mid-tone (a gray, a medium blue) over
 * the stream's video can't keep 4.5:1 with any text color, as light video lightens it and dark
 * video darkens it; opaque, black or white text always does. The overlay uses the same number.
 */
export const CUSTOM_ALPHA = 1;
/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

/** The colors the overlay uses for custom colors, each #rrggbb. */
export interface StyleColors {
  background: string;
  accent: string;
  /** Fact and song title text: light or dark, whichever reads better on the background. */
  text: string;
  /** "NOW PLAYING": the accent when it reads well enough on the background, otherwise the text color. */
  label: string;
  /** "LIVE LEARN": gold when it reads well enough, otherwise the text color. The words say what it is either way. */
  liveLearn: string;
}

/** What the overlay is sent: on connecting, and whenever the streamer saves a new look. */
export interface StylePayload {
  type: "style";
  style: BubbleStyleName;
  colors?: StyleColors;
  /** Bubble size for the landscape overlay and the vertical one (`--bf-scale`, `--bf-vertical-scale`), when set. */
  scale?: number;
  verticalScale?: number;
}

/** The sizes a Bubble size may be: smaller would be unreadable, bigger covers the stream. */
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 3;

/** A bubble size as a number between MIN_SCALE and MAX_SCALE, or null for anything else. */
export function scaleFrom(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE ? n : null;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A strict #rrggbb color, lowercased, or null. */
export function hexColor(value: unknown): string | null {
  return typeof value === "string" && HEX.test(value.trim()) ? value.trim().toLowerCase() : null;
}

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two opaque colors, from 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` at `alpha` over `under`. */
export const over = (color: Rgb, alpha: number, under: Rgb): Rgb => color.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;

/**
 * The contrast of `text` on a see-through background, at its worst: the bubble is over the
 * stream's video, so it's checked over black and over white and the lower one counts.
 */
export function contrastOver(text: Rgb, background: Rgb, alpha: number): number {
  return Math.min(contrast(text, over(background, alpha, [0, 0, 0])), contrast(text, over(background, alpha, [255, 255, 255])));
}

const LIGHT_TEXT = "#ffffff";
const DARK_TEXT = "#111111";
const GOLDS = ["#ffd700", "#7a5200"];

/** The first color that reads on the background, or `fallback`. */
const readable = (candidates: string[], background: Rgb, fallback: string) =>
  candidates.find((c) => contrastOver(rgb(c), background, CUSTOM_ALPHA) >= MIN_CONTRAST) ?? fallback;

/**
 * Light or dark text, whichever reads better on this background: white, or a soft black (pure
 * black where the soft one falls short). On an opaque background one of white and black always
 * reaches 4.5:1, at worst about 4.58:1 on a medium blue or gray.
 */
export function autoTextColor(background: string): string {
  const bg = rgb(background);
  const light = contrastOver(rgb(LIGHT_TEXT), bg, CUSTOM_ALPHA);
  const black = contrastOver([0, 0, 0], bg, CUSTOM_ALPHA);
  if (light >= black) return LIGHT_TEXT;
  return contrastOver(rgb(DARK_TEXT), bg, CUSTOM_ALPHA) >= MIN_CONTRAST ? DARK_TEXT : "#000000";
}

/** Every color the overlay needs for the streamer's accent and background. Both must already be #rrggbb. */
export function customColors(accent: string, background: string): StyleColors {
  const bg = rgb(background);
  const text = autoTextColor(background);
  return { background, accent, text, label: readable([accent], bg, text), liveLearn: readable(GOLDS, bg, text) };
}

/**
 * The look from settings, never refusing: an unknown Style is the classic one, and custom
 * colors are used only when both are a real #rrggbb. A typo must never stop bubbles showing.
 * `warn` hears about anything ignored.
 */
export function styleFrom(style: unknown, accent: unknown, background: unknown, warn: (line: string) => void = () => {}, sizes: { scale?: unknown; verticalScale?: unknown } = {}): StylePayload {
  const raw = typeof style === "string" ? style.trim().toLowerCase() : "";
  const name = (BUBBLE_STYLES as readonly string[]).includes(raw) ? (raw as BubbleStyleName) : "classic";
  if (raw && raw !== name) warn(`Unknown bubble style "${String(style).slice(0, 40)}": using classic. Choose ${BUBBLE_STYLES.join(", ")}.`);
  const a = hexColor(accent);
  const b = hexColor(background);
  const given = [accent, background].some((v) => typeof v === "string" && v.trim());
  if (given && !(a && b)) warn("Custom bubble colors need both an accent and a background, each written like #5b6ee1: using the style's own colors.");
  // Bubble size goes with the look, so it too changes on stream without a Refresh in OBS.
  const scale = scaleFrom(sizes.scale);
  const verticalScale = scaleFrom(sizes.verticalScale);
  return {
    type: "style",
    style: name,
    ...(a && b ? { colors: customColors(a, b) } : {}),
    ...(scale !== null ? { scale } : {}),
    ...(verticalScale !== null ? { verticalScale } : {}),
  };
}
