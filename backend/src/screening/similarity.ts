import type { SSLSong } from "../types";
import { hasNoArtist } from "../text";
import { MAX_FACT_CHARS } from "../fact-limits";
import { normalizeTitle, resolveGameAndTrack } from "../grounding/titles";
import { STOPWORDS } from "../grounding/relevance";

// Caption vs source: shared content words, quotes, restating the request, plain-word music terms

/** Without "Fact 1:", bullets, numbering and wrapping quotes */
export function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .trim()
    // Quotes around the whole line go; a quoted title at the start stays
    .replace(/^["“]([^"“”]*)["”]$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .trim();
}

export function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

// Words saying only what the request shows: a song, by whom, from what, made how; genre and
// nationality too ("a song by English rock band Coldplay" adds nothing)
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

/** Only the title, artist or game plus filler: "\"Clocks\" was written by Coldplay" for "Coldplay - Clocks" */
export function restatesRequest(fact: string, song: SSLSong): boolean {
  const { game, track } = resolveGameAndTrack(song);
  const known = new Set(
    // Apostrophes dropped on both sides: "Laura's" matches "Lauras"
    [song.title, hasNoArtist(song.artist) ? "" : song.artist, game, track].flatMap((s) => normalizeTitle((s ?? "").replace(/['’]/g, "")).split(" ")).filter(Boolean)
  );
  const left = normalizeTitle(fact.replace(/['’]/g, ""))
    .split(" ")
    .filter((t) => t && !known.has(t) && !RESTATES.has(t));
  return left.length === 0;
}

/** Word overlap, or one mostly inside the other (a restatement that adds words) */
export function tooSimilar(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.5 || shared / Math.min(ta.size, tb.size) >= 0.7;
}

const MAX_QUOTE_WORDS = 12;  // longest quote allowed
export const plainQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();

/** A quote of 3+ words not in the source exactly, or over MAX_QUOTE_WORDS. Shorter ones are titles and nicknames: name checks cover them */
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

// Music terms and their plain words. Fixed text: the model never explains them itself
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

/** Plain words after the caption's first music term, when they fit the bubble (#48) */
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

/** The reference sentence sharing most of a caption's words, if at least half; else "" (a poor match would mislead) */
export function supportingSentence(fact: string, context: string, maxChars = 320): string {
  // Bracketed plain words are ours, not the article's. The space before stays: keeps the pattern linear
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
