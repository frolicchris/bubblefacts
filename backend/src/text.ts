/** Escape a string for use inside a RegExp. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with every match of `pattern` (a global RegExp) removed, again and again until
 * none is left: removing "<!---->" from "<!<!---->--" leaves a new "<!--", which goes too.
 */
export function removeAll(text: string, pattern: RegExp): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(pattern, "");
  } while (text !== previous);
  return text;
}

/** A wikitext comment; one left open runs to the end, as MediaWiki reads it. */
export const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const REF = /<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi;

/** Wikitext without its comments, then its references, nested or not, until none of either is left. */
export function withoutRefsAndComments(wikitext: string): string {
  let previous: string;
  do {
    previous = wikitext;
    wikitext = removeAll(removeAll(wikitext, COMMENT), REF);
  } while (wikitext !== previous);
  return wikitext;
}

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

/** Where a note saying who asked or paid for a song starts: "Commissioned by", "requested by", "req. by", "suggested by". */
const REQUEST_CREDIT = /(?:^|[\s,;:|/([–—-])(?:commission(?:ed)?|requested|request|req\.?|suggested|sponsored|donated|gifted|paid)\s+(?:by|from)(?=\s|$)/i;
/** In an artist field, also ", for Name" after a separator. "Tears for Fears" has none, so it stays. */
const FOR_CREDIT = /\s*[,;|–—]\s*for\s+(?=\S)|\s+-\s+for\s+(?=\S)/i;
/** Separators, spaces and an opening bracket left at the end once a credit is cut. */
const LEFT_OVER = /[\s,;:|/([–—-]/;

/**
 * Text without a note naming who asked or paid for the song: "Some Band,
 * Commissioned by Name", "Some Song (requested by Name)", and in an artist field
 * (`artist`) "Some Band, for Name". The note runs to the end and goes whole, so a
 * viewer's name is never searched, sent to the AI, put in a fact, logged or shown.
 */
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
 * The artist field without the notes a song list adds after the name in brackets
 * (issue #262): "Some Band (note)", "Some Band [note]", several, or one left open
 * ("Some Band (note"). A note is the streamer's, kept only to show the song as listed and
 * to match their own facts' aliases: it is never searched, sent to the AI, put in a
 * fact or logged. A streamer's handle ("Jane (@janeplayskeys)") stays, since it says
 * whose piece it is, and so does a name that is all brackets or ends in one it never
 * opened ("Sunn O)))"). No regular expression, so nothing to backtrack. A note naming
 * who asked or paid for the song goes too, bracketed or not (`withoutRequestCredit`).
 */
export function withoutArtistNote(artist: string): string {
  let a = withoutRequestCredit(artist, true);
  for (;;) {
    const closer = a.endsWith(")") ? "(" : a.endsWith("]") ? "[" : "";
    const at = closer ? a.lastIndexOf(closer) : Math.max(a.lastIndexOf("("), a.lastIndexOf("["));
    // Without a closing bracket at the end, only one left open counts: "A (b) c" has no note.
    if (at < 0 || (!closer && (a.includes(")", at) || a.includes("]", at)))) return a;
    const note = a.slice(at + 1).trimStart();
    const rest = a.slice(0, at).trim();
    if (note.startsWith("@") || !/[\p{L}\p{N}]/u.test(rest)) return a;
    a = rest;
  }
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
