/** Escape a string for use inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/**
 * Identity for the streamer's own records: case, accents and punctuation
 * don't count, but the words do, including a version in brackets. "Night
 * Drive (Acoustic)" isn't "Night Drive (Remix)"; Wikipedia's lookup
 * normalization, which drops brackets, is deliberately not used here.
 */
export const songIdentity = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
