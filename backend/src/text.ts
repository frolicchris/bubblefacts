/** Escape a string for use inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Artist fields that mean no artist (whole field, any case, optional period): "Traditional", "Trad.", "Anon.", "Anonymous", "Unknown", "Folk". */
const NO_ARTIST = /^(?:traditional|trad|anonymous|anon|unknown|folk)\.?$/i;
export const hasNoArtist = (artist?: string | null): boolean => NO_ARTIST.test((artist ?? "").trim());

/** Longest title, artist or name kept from a request. Real ones are far shorter. */
export const MAX_REQUEST_TEXT = 200;

/**
 * Text a viewer typed, made safe to log and to quote: line breaks and other
 * control characters become spaces, runs of spaces collapse, and it's cut to
 * a length no real title needs.
 */
export function cleanRequestText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_TEXT).trim();
}

/** Lowercase, accents removed: the first step of every comparison key (`songIdentity` and the two search and title keys built on it). */
export const foldCase = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Identity for the streamer's own records: case, accents and punctuation
 * don't count, but the words do, including a version in brackets. "Night
 * Drive (Acoustic)" isn't "Night Drive (Remix)"; Wikipedia's lookup
 * normalization, which drops brackets, is deliberately not used here.
 */
export const songIdentity = (s: string): string => foldCase(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
