// Small text helpers shared across the backend

/** Escapes a string for use inside a RegExp */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with every match of a global `pattern` removed until none is left ("<!<!---->--" leaves a new "<!--") */
export function removeAll(text: string, pattern: RegExp): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(pattern, "");
  } while (text !== previous);
  return text;
}

// A wikitext comment; one left open runs to the end, as MediaWiki reads it
export const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const REF = /<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi;

/** Wikitext without comments and references, nested or not, until none is left */
export function withoutRefsAndComments(wikitext: string): string {
  let previous: string;
  do {
    previous = wikitext;
    wikitext = removeAll(removeAll(wikitext, COMMENT), REF);
  } while (wikitext !== previous);
  return wikitext;
}

// Artist fields that mean no artist: the whole field, any case, optional period
const NO_ARTIST = /^(?:traditional|trad|anonymous|anon|unknown|folk)\.?$/i;
export const hasNoArtist = (artist?: string | null): boolean => NO_ARTIST.test((artist ?? "").trim());

export const MAX_REQUEST_TEXT = 200; // characters kept of a request's title, artist or name; real ones are far shorter

/** Text a viewer typed, safe to log and quote: control characters become spaces, spaces collapse, length capped */
export function cleanRequestText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REQUEST_TEXT).trim();
}

// Where a note saying who asked or paid for a song starts: "Commissioned by", "req. by", "suggested by"
const REQUEST_CREDIT = /(?:^|[\s,;:|/([–—-])(?:commission(?:ed)?|requested|request|req\.?|suggested|sponsored|donated|gifted|paid)\s+(?:by|from)(?=\s|$)/i;
// In an artist field, also ", for Name" after a separator ("Tears for Fears" has none, so stays)
// No leading \s* or \s+: an unanchored run of spaces backtracks (CodeQL js/polynomial-redos); LEFT_OVER trims them
const FOR_CREDIT = /[,;|–—]\s*for\s+(?=\S)|\s-\s+for\s+(?=\S)/i;
// Separators, spaces and an opening bracket left at the end once a credit is cut
const LEFT_OVER = /[\s,;:|/([–—-]/;

/** Text without who asked or paid ("Some Song (requested by Name)"; with `artist`, also "Some Band, for Name"), to the end */
export function withoutRequestCredit(text: string, artist = false): string {
  const credit = REQUEST_CREDIT.exec(text);
  const forName = artist ? FOR_CREDIT.exec(text) : null;
  const at = Math.min(credit ? credit.index : Infinity, forName ? forName.index : Infinity);
  if (at === Infinity) return text.trim();
  let end = at;
  while (end > 0 && LEFT_OVER.test(text[end - 1])) end--;
  return text.slice(0, end).trim();
}

/**
 * The artist without bracketed notes after the name (#262), even one left open, and without a request credit
 * Kept: a handle ("Jane (@janeplayskeys)"), a name all brackets or with one never opened ("Sunn O)))"); no regex, no backtracking
 */
export function withoutArtistNote(artist: string): string {
  let a = withoutRequestCredit(artist, true);
  for (;;) {
    const closer = a.endsWith(")") ? "(" : a.endsWith("]") ? "[" : "";
    const at = closer ? a.lastIndexOf(closer) : Math.max(a.lastIndexOf("("), a.lastIndexOf("["));
    // Without a closing bracket at the end, only one left open counts: "A (b) c" has no note
    if (at < 0 || (!closer && (a.includes(")", at) || a.includes("]", at)))) return a;
    const note = a.slice(at + 1).trimStart();
    const rest = a.slice(0, at).trim();
    if (note.startsWith("@") || !/[\p{L}\p{N}]/u.test(rest)) return a;
    a = rest;
  }
}

/** Lowercase, accents removed: the first step of every comparison key */
export const foldCase = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Identity for the streamer's records: words count, bracketed versions too, unlike Wikipedia's normalization; not case, accents or punctuation */
export const songIdentity = (s: string): string => foldCase(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
