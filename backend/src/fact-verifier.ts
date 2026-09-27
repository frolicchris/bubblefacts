import { config } from "./config";
import { SSLSong } from "./types";
import { topic } from "./topic";

/**
 * Grounding and screening.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening then drops any sentence
 * whose names, years or platforms the source does not contain. Every check
 * is a string comparison: no second model, no added latency.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT =
  `stream-facts-overlay/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/stream-facts-overlay"})`;

const MAX_CONTEXT_CHARS = 2400;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
const MIN_CONTEXT_CHARS = 600;
/** Longest fact that fits a bubble. */
const MAX_FACT_CHARS = 160;
/** How long "no article" is trusted before the lookup is retried. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);

/** Wikipedia throttled us: the article may exist, so the miss is never cached. */
class RateLimited extends Error {}

/**
 * Articles found through the game are shared by every track from it;
 * articles found through the track, and misses, belong to that song only.
 */
const groundingCache = new Map<string, { text: string; at: number }>();

// --- Title parsing -----------------------------------------------------

/** A trailing parenthetical that marks a variant rather than naming the game. */
const VARIANT_MARKER =
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b)/i;
/** Words that are a variant only when they are the whole parenthetical: "(Night)", not "(Night in the Woods)". */
const VARIANT_WORD = /^\s*(live|acoustic|piano|vocal|instrumental|day|night)(\s+(ver\.?|version|mix|arr\.?))?\s*$/i;

/** Split "Game: Track", "Game - Track" or "Track (Game)". */
export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const paren = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && !VARIANT_MARKER.test(paren[2]) && !VARIANT_WORD.test(paren[2])) {
    return { game: paren[2].trim(), track: paren[1].trim() };
  }

  const sep = clean.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (sep) return { game: sep[1].trim(), track: sep[2].trim() };

  return { game: clean, track: clean };
}

/**
 * Song lists usually put the game in the artist field and the track in the
 * title. When the title's own "Game:" prefix extends the artist ("Super
 * Mario" -> "Super Mario 64"), the title is more specific and wins.
 */
export function resolveGameAndTrack(song: SSLSong): { game: string; track: string } {
  const artist = song.artist?.trim();
  const title = song.title.trim();

  if (!artist || /^unknown$/i.test(artist) || artist.toLowerCase() === title.toLowerCase()) {
    return splitGameAndTrack(title);
  }

  const split = splitGameAndTrack(title);
  if (split.game !== title) {
    const a = artist.toLowerCase();
    const g = split.game.toLowerCase();
    if (g === a) return { game: artist, track: split.track };
    if (g.startsWith(a + " ")) return split;
  }
  return { game: artist, track: title };
}

// --- Article relevance -------------------------------------------------

/** Wikipedia disambiguators meaning "a musical work or what it comes from". */
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;
/** Disambiguators for people and groups: right only when we searched for one. */
const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;
/** Words marking a different kind of work under the same name. */
const MEDIUM_SHIFT = /\b(movie|film|musical|discography|anime|manga|novel|list|awards|tour|concert)\b/i;

const KNOWN_ARTIST =
  /\b(beethoven|mozart|bach|chopin|debussy|liszt|ravel|satie|tchaikovsky|schubert|brahms|rachmaninoff|beatles|queen|abba|elton john|billy joel|radiohead|coldplay|adele|taylor swift|joe hisaishi|ryuichi sakamoto|hans zimmer|john williams|ennio morricone|yiruma|ludovico einaudi)\b/i;

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/**
 * Lowercase, strip accents and a trailing "(qualifier)", drop punctuation.
 * "X-2" becomes "x2" so a sequel's number isn't read as a separate token.
 */
function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLowerCase()
    .replace(/(\p{L})-(\d)/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words plus every numeral, roman numerals normalised to arabic. */
function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t && !STOPWORDS.has(t));
  const kept = words.filter((t) => t.length >= 2 || /\d/.test(t) || t in ROMAN);
  return (kept.length ? kept : words).map((t) => ROMAN[t] ?? t);
}

/** "Firstname Lastname", or a well-known composer or band. */
export function looksLikeArtistName(subject: string): boolean {
  if (!subject) return false;
  if (KNOWN_ARTIST.test(subject)) return true;
  return (
    /^\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,2}$/u.test(subject.trim()) &&
    !/\b(the|of|and|a|an)\b/i.test(subject)
  );
}

/**
 * True when a page's disambiguator names an artist that is not the subject:
 * "Clair de Lune (Flight Facilities song)" when we wanted Debussy.
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (!qualifier) return false;

  const named = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w))
    .join(" ");
  const qualifierTokens = normalizeTitle(named).split(" ").filter(Boolean);
  const subjectTokens = new Set(normalizeTitle(subject).split(" ").filter(Boolean));
  if (!qualifierTokens.length || !subjectTokens.size) return false;

  return !qualifierTokens.some((t) => subjectTokens.has(t));
}

/**
 * Is this article about the subject we searched for?
 *
 * Wikipedia search always returns a best fuzzy match, never "no result", so
 * this guard is what stops a song with no article from being grounded on
 * something merely similar.
 */
export function isRelevantArticle(subject: string, pageTitle: string, subjectIsArtist = false): boolean {
  const want = normalizeTitle(subject);
  const got = normalizeTitle(pageTitle);
  const wantTokens = significantTokens(want);
  const gotTokens = significantTokens(got);
  if (!want || !got || !wantTokens.length || !gotTokens.length) return false;

  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (qualifier) {
    // A work dated in the future (an announced remake) is not what's on air.
    const year = /\b(20\d{2})\b/.exec(qualifier)?.[1];
    if (year && Number(year) > new Date().getFullYear()) return false;

    // Capitalised disambiguators are attributions ("Clair de Lune (Debussy)");
    // lowercase ones are categories and must be musical.
    const isPerformer = PERFORMER_QUALIFIER.test(qualifier);
    const properNoun = /^\p{Lu}/u.test(qualifier.trim()) && !isPerformer;
    if (!MUSICAL_QUALIFIER.test(qualifier) && !(isPerformer && subjectIsArtist) && !properNoun) return false;
  }

  // Installment numbers decide sequels: "Final Fantasy X" is neither
  // "Final Fantasy" nor "Final Fantasy XII".
  const wantNums = wantTokens.filter((t) => /^\d+$/.test(t));
  const gotNums = gotTokens.filter((t) => /^\d+$/.test(t));
  if (wantNums.length && !wantNums.some((n) => gotNums.includes(n))) return false;

  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // The article extends the subject on a token boundary: "Celeste" -> "Celeste (video game)".
  if (gotSeq.startsWith(wantSeq + " ")) return !(MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want));
  // The article truncates the subject: safe only if no numeral was lost.
  if (wantSeq.startsWith(gotSeq + " ")) return wantNums.every((n) => gotNums.includes(n));

  // Longer titles that merely contain the subject are about something else:
  // "Queen" -> "Long Live the Queen (video game)".
  if (got.split(" ").length > want.split(" ").length + 1) return false;
  if (gotSeq === wantSeq) return true;

  const gotSet = new Set(gotTokens);
  const ratio = wantTokens.filter((t) => gotSet.has(t)).length / wantTokens.length;
  return wantTokens.length >= 3 ? ratio >= 0.85 : ratio === 1;
}

// --- Wikipedia lookup --------------------------------------------------

/**
 * Search terms, most likely first. A bare track name ("Overture", "Main
 * Theme") is only worth searching when the subject is a person or band; for
 * a game it finds a generic article.
 */
function searchTerms(game: string, track: string, artist: boolean): string[] {
  const hasTrack = track && track !== game;
  const trackTerms = hasTrack ? [`${track} ${game}`, ...(artist ? [track] : [])] : [];
  const subjectTerms = game ? [...(artist ? [] : [`${game} video game`]), `${game} soundtrack`, game] : [];
  const terms = artist ? [...trackTerms, ...subjectTerms] : [...subjectTerms, ...trackTerms];
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

async function wikiGet<T>(params: string, timeoutMs: number, what: string): Promise<T> {
  const res = await fetch(`${WIKI_API}?${params}&format=json`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited(what);
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function wikiSearch(term: string): Promise<string[]> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }> } }>(
    `action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  return (data.query?.search ?? []).map((h) => h.title);
}

const MUSIC_HEADING = /music|soundtrack|audio|score|style/i;
const BACKGROUND_HEADING = /development|production|career|works|discography/i;

/**
 * Up to `budget` characters of article text: music sections first (with
 * their subsections), then background, then the lead, which holds the
 * release year and platform that screening checks against. The tail of a
 * long context is what a small model reads least carefully.
 */
export function orderExtract(full: string, budget: number): string {
  const primary: string[] = [];
  const secondary: string[] = [];
  // A subsection inherits the bucket of the section it sits under.
  let parent: { level: number; bucket: string[] | null } = { level: 0, bucket: null };
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    let bucket = MUSIC_HEADING.test(heading) ? primary : BACKGROUND_HEADING.test(heading) ? secondary : null;
    if (level > parent.level && parent.bucket) bucket ??= parent.bucket;
    else parent = { level, bucket };
    if (bucket && body.trim()) bucket.push(`${heading}: ${body.trim()}`);
  }

  const lead = full.split(/\n==/)[0].trim().slice(0, Math.floor(budget * 0.35));
  const rest = [...primary, ...secondary].join("\n\n").slice(0, Math.max(0, budget - lead.length - 2));
  return [rest, lead].filter(Boolean).join("\n\n");
}

/** The article's full plain text, or null for a disambiguation page. */
async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat=wiki keeps the "==" headings orderExtract relies on.
  const data = await wikiGet<{ query?: { pages?: Record<string, { extract?: string }> } }>(
    `action=query&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingExtractTimeoutMs,
    "extract"
  );
  const full = Object.values(data.query?.pages ?? {})[0]?.extract;
  return full && !/may refer to:/i.test(full.slice(0, 200)) ? full : null;
}

/** Reference text for the song, or "" when no relevant article exists. */
export async function fetchGrounding(song: SSLSong): Promise<string> {
  const { game, track } = resolveGameAndTrack(song);
  const gameKey = normalizeTitle(game);
  const songKey = `${gameKey}\0${normalizeTitle(track)}`;

  for (const key of [gameKey, songKey]) {
    const hit = key && groundingCache.get(key);
    if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.text;
  }

  const artist = looksLikeArtistName(game);
  // Which way an article matched decides how widely it may be shared. A
  // track article must not be attributed to another artist, and its text
  // must mention the game or artist: "Overture" alone is a generic article.
  const matchedGame = (title: string) => isRelevantArticle(game, title, artist);
  const matchedTrack = (title: string) =>
    track !== game && isRelevantArticle(track, title) && !qualifierNamesAnotherArtist(title, game);

  const terms = searchTerms(game, track, artist);
  let unreachable = "";

  for (const term of terms) {
    try {
      const titles = await wikiSearch(term);
      const page = titles.find((t) => matchedGame(t) || matchedTrack(t));
      if (!page) {
        if (titles.length) console.log(`[Grounding] No relevant match among: ${titles.join(", ")}`);
        continue;
      }
      const byGame = matchedGame(page);
      const full = await wikiExtract(page);
      if (!byGame && full && !normalizeTitle(full).includes(gameKey)) {
        console.log(`[Grounding] "${page}" never mentions "${game}", skipping`);
        continue;
      }
      const extract = full && orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1);
      if (!extract || extract.length < MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${page}" is too short to write from (${extract?.length ?? 0} chars)`);
        continue;
      }
      const text = `${page}\n${extract}`;
      console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars)`);
      groundingCache.set(byGame ? gameKey : songKey, { text, at: Date.now() });
      return text;
    } catch (err) {
      unreachable = err instanceof RateLimited ? "rate-limited" : "lookup failed";
      if (!(err instanceof RateLimited)) {
        console.warn(`[Grounding] Lookup failed for "${term}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(
    `[Grounding] No reference for "${song.title}"` +
      (unreachable ? ` (${unreachable}, not cached)` : "") +
      ` — tried: ${terms.join(" | ")}`
  );
  if (!unreachable) groundingCache.set(songKey, { text: "", at: Date.now() });
  return "";
}

export function clearGroundingCache(): void {
  groundingCache.clear();
}

// --- Screening ---------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, whole-phrase containment. */
const hasWord = (needle: string, haystack: string, flags = "i") =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, flags + "u").test(haystack);

/** Claims that are easy to get wrong and obvious when wrong. */
const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /(#\s?\d+\b|\bnumber one\b|\bno\.\s?\d+\b|\btopped the chart|\bbillboard\b)/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];

/** The model reasoning about its source instead of stating a fact. */
const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|here is|sure[,!])/i,
];

const YEAR = /\b(1\d{3}|20\d{2})\b/g;
/** Capitalised words, including "McCartney"; two or more, or a single Mc- surname. */
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+)`;
const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy|Nintendo DS|3DS|PlayStation|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

/** Names for the same hardware. Each name corroborates every other in its group. */
const PLATFORM_ALIASES = new Map<string, string[]>();
for (const group of [
  ["nes", "nintendo entertainment system", "famicom"],
  ["snes", "super nintendo", "super famicom", "super nintendo entertainment system"],
  ["n64", "nintendo 64"],
  ["ps1", "psone", "playstation"],
  ["ps2", "playstation 2"],
  ["ps3", "playstation 3"],
  ["ps4", "playstation 4"],
  ["ps5", "playstation 5"],
  ["mega drive", "genesis", "sega genesis"],
  ["game boy", "gameboy"],
  ["c64", "commodore 64"],
  ["pc engine", "turbografx-16", "turbografx"],
]) {
  for (const name of group) PLATFORM_ALIASES.set(name, group.filter((n) => n !== name));
}

/** Console names that are also ordinary words; only the capital tells them apart in the source. */
const AMBIGUOUS_PLATFORMS = new Set(["switch", "saturn", "genesis", "vita"]);

/** Does the reference name this platform, or another name for it? */
export function platformSupported(platform: string, context: string): boolean {
  const p = platform.toLowerCase();
  const direct = AMBIGUOUS_PLATFORMS.has(p)
    ? hasWord(p[0].toUpperCase() + p.slice(1), context, "")
    : hasWord(p, context);
  return direct || (PLATFORM_ALIASES.get(p) ?? []).some((a) => hasWord(a, context));
}

/** Leading words that make a capitalised run look like a name when it isn't one. */
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "in", "on",
  "at", "for", "to", "of", "and", "but", "or", "so", "when", "while", "after",
  "before", "during", "although", "however", "both", "each", "every", "many",
  "most", "some", "several", "one", "two", "three", "first", "second", "third",
  "original", "new", "final", "main", "early", "later", "modern", "classic",
  "his", "her", "their", "they", "he", "she", "we", "you", "i",
  "nintendo", "sega", "sony", "microsoft", "capcom", "konami", "square",
  "atlus", "falcom", "bandai", "namco", "enix", "ubisoft", "activision",
  "japanese", "american", "european", "english", "german", "french",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * The first capitalised name in the fact that the reference doesn't contain.
 * Each word must appear as a whole word, which tolerates "Koshiro" alone or a
 * different romanisation of the given name, but not "Ed" inside "played".
 */
export function unsupportedName(fact: string, context: string): string | null {
  for (const candidate of fact.match(NAME) ?? []) {
    const words = candidate.split(/\s+/);
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    const isName = words.length >= 2 || /^Mc/.test(words[0] ?? "");
    if (!isName || words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    if (words.every((w) => hasWord(w, context))) continue;
    return words.join(" ");
  }
  return null;
}

/** Strip "Fact 1:", bullets, numbering and wrapping quotes. */
function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/^["'“”]|["'“”]$/g, "")
    .trim();
}

function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
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

export interface ScreenResult {
  kept: string[];
  rejected: Array<{ text: string; reason: string }>;
}

/**
 * Keep only facts the reference visibly supports. With no reference (only
 * when FACT_VERIFICATION=off) the source checks are skipped but formatting,
 * meta-commentary, risky claims, length and duplicates are still screened.
 */
export function screenClaims(facts: string[], context: string): ScreenResult {
  const result: ScreenResult = { kept: [], rejected: [] };

  const reasonToDrop = (fact: string): string | null => {
    if (META_PATTERNS.some((re) => re.test(fact))) return "meta-commentary";
    if (fact.length < 20) return "too short";
    for (const { re, label } of RISKY_PATTERNS) {
      const m = fact.match(re);
      if (m && !hasWord(m[0].trim(), context)) return label;
    }
    if (context) {
      const year = (fact.match(YEAR) ?? []).find((y) => !hasWord(y, context));
      if (year) return `unsupported year ${year}`;
      const platform = (fact.match(PLATFORM_PATTERN) ?? []).find((p) => !platformSupported(p, context));
      if (platform) return `unsupported platform "${platform}"`;
      const name = unsupportedName(fact, context);
      if (name) return `unsupported name "${name}"`;
    }
    if (fact.length > MAX_FACT_CHARS) return `too long (${fact.length} chars)`;
    if (result.kept.some((k) => tooSimilar(k, fact))) return "near-duplicate of an earlier fact";
    return null;
  };

  for (const raw of facts) {
    const fact = stripPrefix(raw);
    const reason = reasonToDrop(fact);
    if (reason) result.rejected.push({ text: fact, reason });
    else result.kept.push(fact);
  }
  return result;
}

// --- Curated pool ------------------------------------------------------

/** `count` hand-verified facts from the topic packs, shuffled. */
export function curatedFacts(count: number): string[] {
  const pool = [...topic.curatedFacts];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, count));
}
