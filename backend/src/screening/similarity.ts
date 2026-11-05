import type { SSLSong } from "../types";
import { hasNoArtist } from "../text";
import { MAX_FACT_CHARS } from "../fact-limits";
import { normalizeTitle, resolveGameAndTrack } from "../grounding/titles";
import { STOPWORDS } from "../grounding/relevance";

/**
 * Comparing a caption with its source: shared content words, quotes,
 * restating the request, and plain-word music terms.
 */

/** Strip "Fact 1:", bullets, numbering and wrapping quotes. */
export function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .trim()
    // Quotes around the whole line go; a quoted title at the start stays whole.
    .replace(/^["“]([^"“”]*)["”]$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .trim();
}

export function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Words that only say what the request already shows: that it's a song, who
 * it's by or what it's from, and how it was made in general terms. Genre and
 * nationality words count too: "a song by English rock band Coldplay" tells
 * a viewer nothing the request didn't.
 */
const RESTATES = new Set(
  (
    "is was are were be been a an the this that it its one here now so just " +
    "song songs track tracks single tune piece music musical instrumental theme composition compositions original originals cover " +
    "by from of in on for and with to as " +
    "written wrote writes composed composer performed performer recorded sung sings sang released credited " +
    "artist band group singer songwriter duo trio musician rapper " +
    "video game games soundtrack ost score album " +
    "you youre re hearing listening playing straight person who " +
    "english british american canadian australian irish scottish welsh japanese korean swedish french german " +
    "rock pop hip hop rap country folk indie jazz electronic dance metal punk alternative soul r b"
  ).split(" ")
);

/**
 * A caption that only repeats what viewers already see: the title, the artist
 * or game, and filler. "\"Clocks\" was written by Coldplay" says nothing when the
 * request read "Coldplay - Clocks"; "\"Clocks\" was written by Chris Martin" or
 * "came out in 2002" adds something and stays.
 */
export function restatesRequest(fact: string, song: SSLSong): boolean {
  const { game, track } = resolveGameAndTrack(song);
  const known = new Set(
    // Apostrophes go on both sides, so "Laura's" in the title is "Lauras" in the caption too.
    [song.title, hasNoArtist(song.artist) ? "" : song.artist, game, track].flatMap((s) => normalizeTitle((s ?? "").replace(/['’]/g, "")).split(" ")).filter(Boolean)
  );
  const left = normalizeTitle(fact.replace(/['’]/g, ""))
    .split(" ")
    .filter((t) => t && !known.has(t) && !RESTATES.has(t));
  return left.length === 0;
}

/** Jaccard or containment overlap; containment catches a restatement that adds words. */
export function tooSimilar(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.5 || shared / Math.min(ta.size, tb.size) >= 0.7;
}

const MAX_QUOTE_WORDS = 12;
export const plainQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();

/**
 * Words in quotation marks are someone's own words, so they must be in the
 * source exactly, and short: a quote of three or more words that the source
 * doesn't contain, or one over twelve words, is returned. One- and two-word
 * quotes are titles and nicknames, which the name checks cover.
 */
export function alteredQuote(fact: string, context: string): string | null {
  const source = plainQuotes(context);
  for (const m of plainQuotes(fact).matchAll(/"([^"]+)"/g)) {
    const words = m[1].replace(/[.,!?;:]+$/, "").trim();
    const count = words.split(" ").length;
    if (count < 3) continue;
    if (count > MAX_QUOTE_WORDS || !source.includes(words)) return words;
  }
  return null;
}

/** Music terms a viewer may not know, each with a few plain words. Fixed text: the model never explains them itself. */
const PLAIN_WORDS: Array<[RegExp, string]> = [
  [/\barpeggi(?:o|os|ated)\b/i, "a chord's notes played one at a time"],
  [/\bostinato\b/i, "a short pattern repeated over and over"],
  [/\bleitmotifs?\b/i, "a tune tied to a character or idea"],
  [/\bcounterpoint\b/i, "two melodies at once"],
  [/\bsyncopat(?:ed|ion)\b/i, "accents off the beat"],
  [/\bmodulat(?:es|ed|ion)\b/i, "a change of key"],
  [/\bpentatonic\b/i, "a five-note scale"],
  [/\b(?:Dorian|Phrygian|Lydian|Mixolydian)\b/, "an old kind of scale"],
  [/\bchord progression\b/i, "the order of the chords"],
  [/\btime signature\b/i, "how the beats are counted"],
  [/\bcoda\b/i, "a closing section"],
  [/\bbeats per minute\b/i, "how fast it goes"],
];

/** Add a few plain words after the first music term in a caption, when they fit in the bubble (issue #48). */
export function explainMusicTerms(fact: string): string {
  for (const [term, plain] of PLAIN_WORDS) {
    const m = term.exec(fact);
    if (!m || fact.includes(plain)) continue;
    const at = m.index + m[0].length;
    const explained = `${fact.slice(0, at)} (${plain})${fact.slice(at)}`;
    return explained.length <= MAX_FACT_CHARS ? explained : fact;
  }
  return fact;
}

/**
 * The sentence in the reference a caption was most likely written from, so
 * the streamer can see what it rests on. The one sharing the most of the
 * caption's content words, when it shares at least half; otherwise none:
 * showing a poor match as "the source" would mislead.
 */
export function supportingSentence(fact: string, context: string, maxChars = 320): string {
  // The plain-word explanations in brackets are ours, not the article's. Only the words are
  // compared, so the space before a bracket can stay; this keeps the pattern linear on any text.
  const want = contentTokens(fact.replace(/\([^()]*\)/g, " "));
  if (!want.size) return "";
  let best = "";
  let bestShare = 0;
  const body = context.split("\n").slice(1).join("\n").replace(/^(?:From the people who made it|How the music is built|How it was received|From the article "[^"\n]+"): /gm, "");
  for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const sentence = raw.trim();
    if (sentence.length < 20) continue;
    const have = contentTokens(sentence);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const share = shared / want.size;
    if (share > bestShare) [best, bestShare] = [sentence, share];
  }
  return bestShare >= 0.5 ? (best.length > maxChars ? `${best.slice(0, maxChars - 3)}…` : best) : "";
}
