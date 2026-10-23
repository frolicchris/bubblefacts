import { config } from "./config";
import { SSLSong } from "./types";
import { blockedArticles } from "./wrong-facts";
import { escapeRe, hasNoArtist, removeAll, withoutRefsAndComments } from "./text";
import { withinStandard } from "./content-standard";
import { htmlToText } from "./wiki-html";
import { linkedGrounding } from "./musicbrainz";
import { WikidataBusy, WorkItem, clearClassicalCache, itemLabels, knownPerson, personItem, placeOrTeam, searchWorks, wholesOf, workItems } from "./wikidata";

/**
 * Grounding: finding the song's Wikipedia article and pulling out the useful text.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening (fact-verifier.ts) then
 * checks each caption against it.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT =
  `bubblefacts/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/bubblefacts"})`;

export const MAX_CONTEXT_CHARS = 3000;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
export const MIN_CONTEXT_CHARS = 600;
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
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|\d0'?s\b|live\b|acoustic\b|piano\b|vocal\b|instrumental\b|jazzy\b|original\b|a\s?cc?app?ella\b|lo-?fi\b|ext\b|extended\b|unplugged\b|npr\b|tiny desk\b|feat\b|feat\.|ft\b|ft\.|featuring\b|with\s|tv\s*size\b|full\s*size\b|from the vault\b)/i;
/** A tag that ends by saying it's a version: "(Chill Version)", "(Children's Choir Remix)", "(2020 Performance)". */
const VARIANT_END = /\b(remix|mix|version|ver\.?|cover|arrangement|performance|rendition|edit)(?:\s+\d+)?\.?\s*$/i;
/** "(Day)" and "(Night)" are variants only on their own; "(Night in the Woods)" is a game. */
const VARIANT_WORD = /^\s*(day|night)\s*$/i;

/** Whether a tag in brackets or after a dash says how a song is played, not what it is. */
const isVariantTag = (tag: string) => VARIANT_MARKER.test(tag) || VARIANT_END.test(tag);

/** Styles a remix is named for: "80's", "Synthwave", "Trap", "Lofi". They name no work. */
const REMIX_STYLE =
  /^(?:\d0'?s|lo-?fi|trap|edm|synthwave|synth|chill|chillhop|retro|reggae|reggaeton|orchestral|dubstep|downtempo|jazz|jazzy|funk|future|house|techno|disco|rock|metal|piano|acoustic|club|dance|epic|8-?bit|chiptune|vaporwave|waltz|extended|original|official)$/i;

/**
 * "Separate Ways (Worlds Apart) [Instrumental]" is the song "Separate Ways
 * (Worlds Apart)": a tag that says how it's played (instrumental, piano, a
 * cover, a live version, a remix) describes the performance, not the work,
 * and searching with it finds nothing. Song lists add these often, at the
 * end, glued to the title ("Beat It(Arrangement)"), before a dash ("Song of
 * Storms(Lofi) - Ocarina of Time"), or after one ("Numb - 80's Remix"). A
 * dash part that names a work as well keeps the work: "Let the Battles Begin
 * - Final Fantasy VII Remix" is from "Final Fantasy VII".
 */
export function dropVersionTags(title: string): string {
  let t = title.replace(/\s*[([]([^)\]]*)[)\]](?=\s+[-–—]\s)/g, (tag, inner: string) => (isVariantTag(inner) ? "" : tag));
  for (let m; (m = /^(.+?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(t)) && isVariantTag(m[2]); ) t = m[1];
  const dash = /^(.+?)\s+[-–—]\s+([^-–—]+)$/.exec(t);
  if (dash && VARIANT_MARKER.test(dash[2]) && !VARIANT_END.test(dash[2]) && !/^\s*(act|part)\b/i.test(dash[2])) {
    // "Song - Live at Wembley", "Song - 2011 Remaster".
    t = dash[1];
  } else if (dash && VARIANT_END.test(dash[2])) {
    const words = dash[2].replace(VARIANT_END, "").trim().split(/\s+/).filter(Boolean);
    while (words.length && REMIX_STYLE.test(words[words.length - 1])) words.pop();
    t = words.length ? `${dash[1]} - ${words.join(" ")}` : dash[1];
  }
  return t.trim();
}

// --- Classical titles (issue #260) ----------------------------------------

/** A classical title read apart: what the piece is called, and how it is numbered. */
export interface ClassicalTitle {
  /** The title without its catalog numbers, key and movement: "Nocturne", "Moonlight Sonata". */
  name: string;
  /** Another name in brackets: "La Primavera" in "Spring (La Primavera)". */
  alias: string;
  /** Catalog numbers as written in Wikidata's style: "Op. 9", "BWV 1007", "K. 331". */
  catalogs: string[];
  /** Every number the title gives the piece: "9" and "2" for "Op. 9 No. 2". */
  numbers: string[];
  /** The key, spelled out: "E-flat major", "C-sharp minor", "D". */
  key: string;
  /** The movement asked for, kept as a hint: never searched. */
  movement: { n?: number; name?: string } | null;
  /** Whether the title reads like a classical piece: a catalog number, a key, a movement or a form. */
  classical: boolean;
}

/** How song lists write a composer's catalog, and Wikidata's spelling of it. "D", "S", "L", "K" and "B" need a number after them. */
const CATALOG = /(?<![\p{L}#♯♭-])(op(?:us)?\.?|bwv|kv?\.?|d\.?|hob\.?|rv|hwv|s\.?|woo|l\.?|b\.?)\s*((?:[ivx]+[a-z]?:)?\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?)(?![\p{L}\d])/giu;
const CATALOG_NAMES: Record<string, string> = { op: "Op.", opus: "Op.", bwv: "BWV", k: "K.", kv: "K.", d: "D.", hob: "Hob.", rv: "RV", hwv: "HWV", s: "S.", woo: "WoO", l: "L.", b: "B." };
/** "No. 2", "No.1", "No 1", "Nr. 2", "#3". */
const NUMBERED = /(?:\b(?:no|nr|nos)\.?\s*|(?<![A-Ga-g])#\s*)(\d+)\b/gi;
/** A key with its mode: "E-flat major", "Eb major", "C# minor", "in d minor". */
const KEY_MODE = /(?:\bin\s+)?(?<![\p{L}])([A-Ga-g])(?:\s*-?\s*(flat|sharp)|\s*([♭♯#]|b(?=\s)))?\s+(major|minor)\b/iu;
/** A key written after "in" without its mode: "Canon in D", "Prelude in C#". */
const KEY_IN = /\bin\s+([A-G])(?:\s*-?\s*(flat|sharp)|([♭♯#]|b\b))?(?![\p{L}\d])/u;
const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
const ROMAN_NUMBER: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
/** Movement tags: "(3rd Movement)", "2nd mvt", "Mvt. 2", "Movement III", "Third Movement", "I. Allegro", "Variation 18". */
const MOVEMENTS: Array<{ re: RegExp; read: (m: RegExpExecArray) => { n?: number; name?: string } }> = [
  { re: /\s*[([]?\b(\d)(?:st|nd|rd|th)\s+(?:movement|mvt\.?|mov\.?)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /\s*[([]?\b(?:movement|mvt\.?|mov\.?)\s+(\d|[ivx]{1,4})\b[)\]]?/i, read: (m) => ({ n: Number(m[1]) || ROMAN_NUMBER[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\b(first|second|third|fourth|fifth|sixth)\s+movement[)\]]?/i, read: (m) => ({ n: ORDINAL_WORDS[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\bvar(?:iation|\.)\s*(\d+)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /(?:^|\s*[:,–—-]\s*|\s+)\b([IV]{1,3})\.\s+(\p{Lu}[\p{L} ]*?)\s*$/u, read: (m) => ({ n: ROMAN_NUMBER[m[1].toLowerCase()], name: m[2] }) },
];
/** Words naming a classical form: a title with one reads like a piece even without a number. */
const FORM_WORDS =
  /\b(sonata|sonatina|nocturne|pr[eé]lude|[eé]tude|etude|waltz|valse|symphony|concerto|suite|fugue|toccata|mazurka|polonaise|ballade|impromptu|rhapsod(?:y|ie)|gymnop[eé]die|arabesque|minuet|menuet|serenade|scherzo|rondo|bagatelle|partita|invention|sinfonia|overture|requiem|cantata|aria|liebestraum|barcarolle|berceuse|fantasia|fantaisie|intermezzo|capriccio|caprice|divertimento|canon|chaconne|passacaglia|gavotte|sarabande|gigue|allemande|courante|lied|lieder|r[eê]verie|humoresque|moment musical)s?\b/i;

/** A key spelled the way Wikipedia and Wikidata write it: "E-flat major", "C-sharp minor", "D". */
function spellKey(letter: string, word = "", sign = "", mode = ""): string {
  const accidental = word ? word.toLowerCase() : sign === "#" || sign === "♯" ? "sharp" : sign ? "flat" : "";
  const name = `${letter.toUpperCase()}${accidental ? `-${accidental}` : ""}`;
  return mode ? `${name} ${mode.toLowerCase()}` : name;
}

/** Keys spelled one way, for comparing: "C# minor", "C♯ minor" and "C-sharp minor" all read "c sharp minor". */
export function normalizeKeys(s: string): string {
  return s
    .replace(/(?<![\p{L}])([A-Ga-g])\s*(?:[#♯]|-?\s*sharp\b)/gu, "$1 sharp")
    .replace(/(?<![\p{L}])([A-Ga-g])\s*(?:♭|-?\s*flat\b|b(?=\s+(?:major|minor)\b))/giu, "$1 flat");
}

/**
 * Reads a classical title apart (issue #260): "Nocturne in E-flat major, Op.
 * 9, No. 2" is the Nocturne, Op. 9, No. 2, in E-flat major; "Moonlight Sonata
 * (3rd Movement)" is the Moonlight Sonata, with the third movement as a hint
 * for which part of its article to read first. Catalogs: Op., BWV, K./KV, D.,
 * Hob., RV, HWV, S., WoO, L. Keys: E-flat, Eb, E♭, C#, C sharp.
 */
/** Drops separators and spaces from both ends ("Nocturne ,;- " is "Nocturne"). A loop, not a regex: linear on any input. */
function trimSeparators(s: string): string {
  const separator = (c: string) => /[\s,:;–—-]/.test(c);
  let start = 0;
  let end = s.length;
  while (start < end && separator(s[start])) start++;
  while (end > start && separator(s[end - 1])) end--;
  return s.slice(start, end);
}

export function parseClassicalTitle(title: string): ClassicalTitle {
  let t = ` ${title.trim()} `;
  let movement: ClassicalTitle["movement"] = null;
  for (const { re, read } of MOVEMENTS) {
    const m = re.exec(t);
    if (m) {
      movement = read(m);
      t = t.slice(0, m.index) + " " + t.slice(m.index + m[0].length);
      break;
    }
  }
  const catalogs: string[] = [];
  const numbers: string[] = [];
  t = t.replace(CATALOG, (_whole, kind: string, num: string) => {
    const name = CATALOG_NAMES[kind.toLowerCase().replace(/\.$/, "")];
    const n = num.replace(/\s+/g, "");
    catalogs.push(`${name} ${n}`);
    numbers.push(...(n.match(/\d+/g) ?? []));
    return " ";
  });
  t = t.replace(NUMBERED, (_, n: string) => {
    numbers.push(n);
    return " ";
  });
  let key = "";
  const mode = KEY_MODE.exec(t);
  if (mode) {
    key = spellKey(mode[1], mode[2], mode[3], mode[4]);
    t = t.slice(0, mode.index) + " " + t.slice(mode.index + mode[0].length);
  } else {
    const bare = KEY_IN.exec(t);
    if (bare) {
      key = spellKey(bare[1], bare[2], bare[3]);
      t = t.slice(0, bare.index) + " " + t.slice(bare.index + bare[0].length);
    }
  }
  const bracket = /^(.*?)\s*[([]([^)\]]+)[)\]]\s*$/.exec(t.trim());
  const alias = bracket && !isVariantTag(bracket[2]) ? bracket[2].trim() : "";
  if (bracket && alias) t = bracket[1];
  const name = trimSeparators(
    t
      .replace(/\s*[([]\s*[)\]]\s*/g, " ")
      .replace(/\s*,\s*(?:,\s*)+/g, ", ")
      .replace(/\s+/g, " ")
  );
  const classical = catalogs.length > 0 || !!key || !!movement || FORM_WORDS.test(name);
  return { name, alias, catalogs, numbers: [...new Set(numbers)], key, movement, classical };
}

/** Split "Game: Track", "Game - Track" or "Track (Game)". */
export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const paren = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && !isVariantTag(paren[2]) && !VARIANT_WORD.test(paren[2])) {
    // "Let It Go (From "Frozen")": the work is what follows "From".
    const from = /^\s*from\s+["“'‘]?(.+?)["”'’]?\s*$/i.exec(paren[2]);
    return { game: (from ? from[1] : paren[2]).trim(), track: paren[1].trim() };
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
  const title = dropVersionTags(song.title.trim());

  if (!artist || hasNoArtist(artist) || artist.toLowerCase() === title.toLowerCase()) {
    return splitGameAndTrack(title);
  }

  const split = splitGameAndTrack(title);
  if (split.game !== title) {
    const a = artist.toLowerCase();
    const g = split.game.toLowerCase();
    if (g === a) return { game: artist, track: split.track };
    // "Yoshi's Story: On the Beach" from "Yoshi": the possessive extends the name too.
    if (g.startsWith(a + " ") || (g.startsWith(a) && /^['’]s /.test(g.slice(a.length)))) return split;
  }
  return { game: artist, track: title };
}

/**
 * The names to look for in a credit, whole credit first: "Earth, Wind & Fire"
 * stays whole, and "Lil Nas X, Jack Harlow" also tries its lead, "Lil Nas X".
 * Only commas and "feat." split a credit: "&", "and" and "x" are often part
 * of a name.
 */
/** "P!nk" and "Ke$ha" are written "Pink" and "Kesha" in their articles: a symbol between letters stands for a letter. */
export const foldSymbols = (name: string): string => name.replace(/(?<=\p{L})!(?=\p{L})/gu, "i").replace(/(?<=\p{L})\$(?=\p{L})/gu, "s");

export function artistNames(artist: string): string[] {
  if (hasNoArtist(artist)) return [];
  const lead = artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? "";
  // Two full names joined by "and": an article may name each alone. Only when
  // both sides are full names, so "Simon and Garfunkel" stays one.
  const pair = artist.split(/\s+(?:and|&)\s+/i);
  const people = pair.length === 2 && pair.every((p) => p.trim().split(/\s+/).length >= 2) ? pair : [];
  // "Simon and Garfunkel" is written "Simon & Garfunkel" in its articles, and the other way round.
  const joined = [lead.replace(/\s+and\s+/gi, " & "), lead.replace(/\s+&\s+/g, " and ")];
  const folded = [artist, lead].map(foldSymbols);
  return [...new Set([artist, lead, ...people, ...joined, ...folded].map(normalizeTitle).filter(Boolean))];
}

/** Whether normalized text names one of these as whole words: "Sia" isn't in "Asia". */
export function mentionsName(normalizedText: string, names: string[]): boolean {
  const padded = ` ${normalizedText} `;
  return names.some((n) => padded.includes(` ${n} `));
}

// --- Article relevance -------------------------------------------------

/** Wikipedia disambiguators meaning "a musical work or what it comes from". */
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;
/** Disambiguators for people and groups: right only when we searched for one. */
const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;
/** An article's opening that describes a performer or a recording. */
const PERFORMER_LEAD = /\b(band|singer|rapper|musician|group|duo|trio|songwriter|record(ing)? artist|vocalist|album|song|single|DJ|producer)\b/i;
/** Disambiguators that can't be a performer. */
const NOT_A_PERFORMER = /\((?:[^)]*\b)?(video game|game|film|television|tv series|novel|manga|anime)\)\s*$/i;
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
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    // Trailing tags in brackets or parentheses: "(Worlds Apart)", "[Instrumental]", "(Live) (Remastered)".
    .replace(/(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*$/, "")
    .toLowerCase()
    .replace(/(\p{L})-(\d)/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A page's trailing qualifier: "song" for "Let It Be (song)", undefined when it has none. */
function qualifierOf(title: string): string | undefined {
  return /\(([^)]*)\)\s*$/.exec(title)?.[1];
}

/** A page title without its trailing qualifier: "Let It Be (song)" is "Let It Be". */
export function withoutQualifier(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, "");
}

/** Content words plus every numeral, roman numerals normalized to arabic. */
function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t && !STOPWORDS.has(t));
  const kept = words.filter((t) => t.length >= 2 || /\d/.test(t) || t in ROMAN);
  return (kept.length ? kept : words).map((t) => ROMAN[t] ?? t);
}

/**
 * Installment numbers with the way each is written, "5" or "v": "Some Game 5"
 * gives ["5:arabic"], "Some Game V" ["5:roman"].
 */
function numeralForms(normalized: string): string[] {
  return normalized
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t) && (/^\d+$/.test(t) || t in ROMAN))
    .map((t) => (t in ROMAN ? `${ROMAN[t]}:roman` : `${Number(t)}:arabic`));
}

/**
 * Whether two titles write the same installment number differently: "Some
 * Game 5" and "Some Game V" may be two different games, and so may "Some
 * Game 10" and "Some Game X". Only Wikipedia's own redirect from the other form says
 * they are one work; the lookup follows that separately.
 */
export function numeralStyleDiffers(a: string, b: string): boolean {
  const fa = numeralForms(normalizeTitle(a));
  const fb = numeralForms(normalizeTitle(b));
  const value = (f: string) => f.split(":")[0];
  const clash = (x: string[], y: string[]) => x.some((f) => y.some((g) => value(g) === value(f)) && !y.includes(f));
  return clash(fa, fb) || clash(fb, fa);
}

/**
 * Edition words: a version of a game with its own credits and release year.
 * Matched on normalized titles ("director's cut" is "director s cut").
 */
const EDITION_WORDS =
  /\b(royal|golden|reload|remastered|remaster|remake|definitive edition|complete edition|special edition|anniversary edition|director s cut|final mix|hd|dx|deluxe|portable|cd)\b/g;

/**
 * The edition a request names that an article's title doesn't: "Some Game
 * Royal" read from "Some Game" gives "royal". The article may still be about
 * the game, but its infobox credits and year are the original's. Never the
 * first word ("Golden Sun" is a name, not an edition). Null when none.
 */
export function editionNotInTitle(subject: string, pageTitle: string): string | null {
  const want = normalizeTitle(subject);
  const got = ` ${normalizeTitle(pageTitle)} `;
  const rest = want.split(" ").slice(1).join(" ");
  for (const m of rest.matchAll(EDITION_WORDS)) if (!got.includes(` ${m[1]} `)) return m[1];
  return null;
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

/** A page qualifier that says what kind of work it is: "(Flight Facilities song)", "(album)". */
const WORK_TYPE = /\b(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)\b/i;

/**
 * True when a page's disambiguator names an artist that is not the subject:
 * "Clair de Lune (Flight Facilities song)" when we wanted Debussy.
 *
 * `track` is the title as requested. A bracket it shares with the page is
 * part of the song's name, not a disambiguator: "Separate Ways (Worlds Apart)".
 * With `bareSubtitlesOk`, a bracket that names no kind of work is taken as a
 * subtitle too; the caller must then check the article names the artist.
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string, track = "", bareSubtitlesOk = false): boolean {
  const qualifier = qualifierOf(pageTitle);
  if (!qualifier) return false;
  const fold = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (track && ` ${fold(track)} `.includes(` ${fold(qualifier)} `)) return false;
  if (bareSubtitlesOk && !WORK_TYPE.test(qualifier)) return false;

  const named = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w))
    .join(" ");
  const qualifierTokens = normalizeTitle(named).split(" ").filter(Boolean);
  const subjectTokens = new Set([subject, foldSymbols(subject)].flatMap((s) => normalizeTitle(s).split(" ")).filter(Boolean));
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

  // "Nier series" is the series' own article: "Nier (series)", or "Star Trek" itself.
  // Never a single installment: "Nier (video game)" isn't the series.
  const series = /^(.+) (?:series|franchise)$/.exec(want);
  if (series) {
    const q = qualifierOf(pageTitle);
    if (significantTokens(series[1]).join(" ") === gotTokens.join(" ")) return !q || /\b(series|franchise)\b/i.test(q);
  }

  // A leading "The" is part of a band's name: "The Midnight" is not "Midnight
  // Club" or "Wangan Midnight", though dropping "the" would leave only "midnight".
  if (/^the\s/.test(want) && !/^the\s/.test(got)) return false;

  const qualifier = qualifierOf(pageTitle);
  if (qualifier) {
    // A work dated in the future (an announced remake) is not what's on air.
    const year = /\b(20\d{2})\b/.exec(qualifier)?.[1];
    if (year && Number(year) > new Date().getFullYear()) return false;

    // Capitalized disambiguators are attributions ("Clair de Lune (Debussy)");
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
  // The same number written the other way is another work: "Some Game 5" is not "Some Game V".
  // A Wikipedia redirect from one form to the other is followed by the lookup, never guessed here.
  if (numeralStyleDiffers(subject, pageTitle)) return false;

  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // The article extends the subject on a token boundary: "Celeste" -> "Celeste (video game)".
  if (gotSeq.startsWith(wantSeq + " ")) {
    // A possessive names another work: "Michael Jackson's This Is It" isn't about Michael Jackson's songs.
    if (got.startsWith(want + " s ")) return false;
    // A topic joined to it is another subject: "Overwatch and pornography" (but "Pokémon Red and Blue" is a pair of games).
    if (got.startsWith(want + " and ") && /\sand\s+\p{Ll}/u.test(pageTitle)) return false;
    // A company named for it: "Qumu Corporation" isn't the musician "Qumu".
    if (COMPANY.test(withoutQualifier(pageTitle)) && !COMPANY.test(subject)) return false;
    return !(MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want));
  }
  // The article truncates the subject: safe only at a subtitle break ("Ys VIII:
  // Lacrimosa of Dana" -> "Ys VIII") and if no numeral was lost. "Everybody
  // Dance Now" is not "Everybody Dance".
  if (wantSeq.startsWith(gotSeq + " ")) {
    const head = significantTokens(normalizeTitle(subject.split(/:|\s[-–—]\s/)[0])).join(" ");
    // An installment number is a subtitle break too: "Ys II The Final Chapter" -> "Ys II".
    const atBreak = head === gotSeq || /^\d+$/.test(gotTokens[gotTokens.length - 1]);
    return atBreak && wantNums.every((n) => gotNums.includes(n));
  }

  // Longer titles that merely contain the subject are about something else:
  // "Queen" -> "Long Live the Queen (video game)".
  if (got.split(" ").length > want.split(" ").length + 1) return false;
  if (gotSeq === wantSeq) return true;
  // A set named in the plural: "Hungarian Dance" is one of the "Hungarian Dances (Brahms)".
  if (gotSeq === wantSeq + "s" && wantTokens.length >= 2) return true;

  const gotSet = new Set(gotTokens);
  const ratio = wantTokens.filter((t) => gotSet.has(t)).length / wantTokens.length;
  if (wantTokens.length >= 3) return ratio >= 0.85;
  // A short subject must be the whole title, in any order: "The Midnight" is
  // not "Wangan Midnight".
  const wantSet = new Set(wantTokens);
  return ratio === 1 && gotTokens.every((t) => wantSet.has(t));
}

// --- Wikipedia lookup --------------------------------------------------

/**
 * Search terms, most likely first. A bare track name ("Overture", "Main
 * Theme") is only worth searching when the subject is a person or band; for
 * a game it finds a generic article.
 */
function searchTerms(game: string, track: string, artist: boolean, notGame = false): string[] {
  const hasTrack = track && track !== game;
  const trackTerms = hasTrack ? [`${track} ${game}`, `${track} ${foldSymbols(game)}`, ...(artist ? [track] : [])] : [];
  const subjectTerms = game ? [...(artist || notGame ? [] : [`${game} video game`]), `${game} soundtrack`, game] : [];
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

/** A search's hits and, when Wikipedia thinks the term is misspelled, its suggested spelling. */
async function wikiSearchSuggestion(term: string): Promise<{ titles: string[]; suggestion: string }> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }>; searchinfo?: { suggestion?: string } } }>(
    `action=query&list=search&srlimit=5&srprop=&srinfo=suggestion&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  return { titles: (data.query?.search ?? []).map((h) => h.title), suggestion: data.query?.searchinfo?.suggestion ?? "" };
}

/**
 * Where Wikipedia files each of these exact titles: the page itself, the
 * page it redirects to (with `fragment` when the redirect points into a
 * section of it), or nothing when no page has that title.
 */
async function wikiResolveTitles(names: string[]): Promise<Map<string, { page: string; redirected: boolean; fragment: boolean }>> {
  const data = await wikiGet<{
    query?: {
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string; tofragment?: string }>;
      pages?: Record<string, { title: string; missing?: string; invalid?: string }>;
    };
  }>(`action=query&redirects=1&titles=${encodeURIComponent(names.join("|"))}`, config.groundingTimeoutMs, "titles");
  const q = data.query ?? {};
  const existing = new Set(Object.values(q.pages ?? {}).filter((p) => p.missing === undefined && p.invalid === undefined).map((p) => p.title));
  const out = new Map<string, { page: string; redirected: boolean; fragment: boolean }>();
  for (const name of names) {
    const title = q.normalized?.find((n) => n.from === name)?.to ?? name;
    const redirect = q.redirects?.find((r) => r.from === title);
    const page = redirect?.to ?? title;
    if (existing.has(page)) out.set(name, { page, redirected: !!redirect, fragment: !!redirect?.tofragment });
  }
  return out;
}

const MUSIC_HEADING = /music|soundtrack|audio|score|style/i;
const BACKGROUND_HEADING = /development|production|career|works|discography/i;

/**
 * Up to `budget` characters of article text: music sections first (with
 * their subsections), then background, then the lead, which holds the
 * release year and platform that screening checks against. The tail of a
 * long context is what a small model reads least carefully.
 */
/** A creator talking about the work: "said", "recalled", "was inspired by". */
const CREATOR_CUE =
  /\b(said|says|stated|recalled|recalls|explained|explains|remembered|described (?:how|the|it|writing|recording)|according to|in an interview|inspired by|inspiration|influenc\w+|based (?:it )?on|modell?ed (?:it )?(?:on|after)|drew (?:on|from)|borrow\w+|homage|tribute to|was written (?:after|while|when|during|in (?:about|just|under))|wrote (?:it|the song|the piece|the track|the music) (?:after|while|when|during|in)|came up with|originally (?:titled|entitled|intended|written|called|planned|composed|named|meant)|intended|wanted|decided|felt that|took (?:only|about|just))\b/i;
/** "Astley told the Los Angeles Times": told, then a name. */
const TOLD_SOMEONE = /\btold (?:the |an? )?\p{Lu}/u;
/** The sentence is about the music, not the business around it. */
export const ABOUT_MUSIC = /\b(music|songs?|tracks?|themes?|score|melody|melodies|soundtrack|compos\w+|record\w*|lyrics?|riff|chords?|album|tune|piece|arrang\w+|vocals?|piano|guitar|demo|title)\b/i;
/** Sections where creators' comments about the music live. */
const MAKING_HEADING = /recording|composition|production|development|conception|background|writing|music|creation|origin|inspiration/i;
/** Sections that are other people's opinions, later uses, or lists. */
const NOT_THE_MAKERS_HEADING =
  /reception|review|accolade|chart|certification|track listing|personnel|credits|legacy|impact|music video|cover|version|popular culture|media|usage|use in|adaptation|sampl|reference|see also|external|release|commercial|performance/i;
/** Critics, the press and scholars: their views aren't the makers'. */
const CRITIC_WORDS =
  /\b(critics?|reviewers?|magazine|publication|newspaper|journalist|correspondent|writer|musicologist|scholar|author|biograph\w+|documentary|interpreted|ranked|listed|review(?:ed|s)?|praised|called it|charts?|streamed|copies|sold)\b/i;
export const CRITIC_NAMES =
  /\b(IGN|GameSpot|GameSpy|GamePro|Game Informer|Nintendo Power|Edge|1UP|Destructoid|Tom's Guide|AllMusic|Pitchfork|Rolling Stone|Billboard|NME|Kotaku|Polygon|RPGFan|Eurogamer|Famitsu|Stereogum|MTV|NPR|BBC|USA Today|Variety|Melody Maker|[A-Z]\w+ (?:Times|News|Post|Tribune|Herald|Guardian|Telegraph))\b/;
const CRITIC = { test: (s: string) => CRITIC_WORDS.test(s) || CRITIC_NAMES.test(s) };
/** A sentence that leans on the one before it can't be retold on its own. */
const LEANS_BACK = /^["“]?(?:I|We|He|She|They|It|His|Her|Their|This|These|That|Those|Hence|However|Instead|Meanwhile|Therefore|The same|A similar|Despite|Asked|When asked)\b/;
const MAX_COLOR_SENTENCES = 5;
const MAX_COLOR_CHARS = 900;

/**
 * The article's sentences where the people who made the music say something
 * about it, in article order (issue #48). Articles summarize interviews in
 * their Recording, Composition and Development sections, usually far past
 * the lead, where a character budget never reached them.
 *
 * A sentence needs a cue ("said", "recalled", "inspired by"), to be about the
 * music, and to stand on its own: someone named, no leaning on the sentence
 * before, no quotation cut off by the sentence split. Then it's scored:
 * naming the track or artist and sitting in a section about making the music
 * count for it; reception and later-use sections, critics and the press, and
 * great length count against it. It needs one point in its favor to be kept.
 */
/** Plainly about music: for an article on a whole game or artist, where "title" and "piece" could mean anything. */
const PLAINLY_MUSIC = /\b(music|songs?|tracks?|soundtrack|score|melody|melodies|compos\w+|lyrics?|theme song|main theme)\b/i;

export function creatorSentences(full: string, names: string[] = [], ownArticle = true): string[] {
  const wanted = names.map((n) => normalizeTitle(n)).filter(Boolean);
  const scored: Array<{ text: string; score: number; at: number }> = [];
  let at = 0;
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  for (const [heading, body] of sections) {
    const making = MAKING_HEADING.test(heading);
    const others = NOT_THE_MAKERS_HEADING.test(heading);
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      at++;
      if (text.length < 40 || !(CREATOR_CUE.test(text) || TOLD_SOMEONE.test(text))) continue;
      const namesTrack = wanted.length > 0 && mentionsName(normalizeTitle(text), wanted);
      // In an article about the whole game or artist, only what names the track, or is plainly about the music.
      if (!namesTrack && !(ownArticle ? ABOUT_MUSIC.test(text) : PLAINLY_MUSIC.test(text) && making)) continue;
      // Leaning on the sentence before, or cut by the split: an open quotation, a trailing colon, a stray initial.
      if (cutOff(text)) continue;
      // Someone has to be named.
      if (!/\b\p{Lu}\p{L}+/u.test(text.slice(1))) continue;
      let score = 3;
      if (namesTrack) score += 2;
      if (making) score += 1;
      if (others) score -= 3;
      if (CRITIC.test(text)) score -= 3;
      if (text.length > 300) score -= 2;
      if (score >= 4) scored.push({ text, score, at });
    }
  }
  const best = scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, MAX_COLOR_SENTENCES);
  const kept: string[] = [];
  let used = 0;
  for (const s of best.sort((a, b) => a.at - b.at)) {
    if (used + s.text.length > MAX_COLOR_CHARS) continue;
    kept.push(s.text);
    used += s.text.length + 1;
  }
  return kept;
}

/** How the work did, in things that can be counted: charts, awards, certifications, sales. */
const RECEIVED_CUE =
  /\b(number[- ]one|number \d+|No\. ?\d+|top (?:ten|five|\d+)|topped|peaked|reached|charted|won|winning|awarded|nominat\w+|Grammy|Academy Award|Oscar|BAFTA|Golden Globe|certified|platinum|gold|diamond|best[- ]selling|million|billion|inducted|Hall of Fame|National Recording Registry|first (?:video game|song|single|piece)\b.{0,40}\bto)\b/i;
const RECEIVED_HEADING = /reception|commercial|chart|accolade|award|legacy|release|impact/i;
const MAX_RECEIVED_SENTENCES = 3;
const MAX_RECEIVED_CHARS = 450;

/** Whether a split left the sentence unable to stand alone. */
const brokenBySplit = (text: string) =>
  (text.match(/["“”]/g)?.length ?? 0) % 2 === 1 || /[:;,]$/.test(text) || /\b\p{Lu}\.$/u.test(text);
const cutOff = (text: string) => LEANS_BACK.test(text) || brokenBySplit(text);

/**
 * The article's sentences on how the work was received, as things that can be
 * counted: chart peaks, awards, certifications and sales. They sit in the
 * lead and in Reception, Charts and Accolades sections, which the music-first
 * ordering skipped. Critics' opinions are left out: screening drops those.
 */
export function receptionSentences(full: string): string[] {
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  const kept: string[] = [];
  let used = 0;
  for (const [heading, body] of sections) {
    if (heading && !RECEIVED_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      // "It reached number one" is fine here: in the song's own article, "it" is the song.
      if (text.length < 40 || text.length > 260 || !RECEIVED_CUE.test(text) || OPINION.test(text) || brokenBySplit(text)) continue;
      if (LEANS_BACK.test(text) && !/^It\b/.test(text)) continue;
      if (kept.length >= MAX_RECEIVED_SENTENCES || used + text.length > MAX_RECEIVED_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** How the music is built: key, tempo, meter, harmony, form. */
const THEORY_CUE =
  /\b(key of|[A-G](?:[-♭♯ ](?:flat|sharp))? (?:major|minor)|in (?:a )?(?:major|minor)|tempo|beats per minute|bpm|time signature|\d\/\d time|common time|chord progression|chords?|arpeggi\w+|ostinato|leitmotifs?|modulat\w+|syncopat\w+|counterpoint|riff|scale|Dorian|Phrygian|Lydian|Mixolydian|pentatonic|octaves?|vocal range|spans|bars?\b|measures|verse[- ]chorus|bridge|coda|waltz)\b/i;
const THEORY_HEADING = /composition|music|structure|analysis|style|lyrics|form|theme/i;
const MAX_THEORY_SENTENCES = 3;
const MAX_THEORY_CHARS = 450;

/** The article's sentences on how the music is built, from its Composition or Structure sections. */
export function theorySentences(full: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const [, heading, body] of full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    if (!THEORY_HEADING.test(heading) || NOT_THE_MAKERS_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      if (text.length < 40 || text.length > 240 || !THEORY_CUE.test(text) || OPINION.test(text) || cutOff(text)) continue;
      if (kept.length >= MAX_THEORY_SENTENCES || used + text.length > MAX_THEORY_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** A section about the music video, or what's worn in it. Not "video game". */
const VIDEO_HEADING = /\b(?:videos?(?!\s*games?)|fashion|visuals?)\b/i;

/**
 * The article without its music-video sections and their subsections (plot,
 * production, fashion). Told as facts, a video's story reads as if it
 * happened ("Papa Emeritus III takes a paper from a hawker"), and a shoot's
 * details as if they were the recording's ("wore a Gucci bathing suit").
 */
export function withoutVideoSections(full: string): string {
  const out: string[] = [];
  let skipBelow = 0; // Skipping while inside a video section of this level.
  for (const line of full.split("\n")) {
    const h = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipBelow && level > skipBelow) continue;
      skipBelow = VIDEO_HEADING.test(h[2]) ? level : 0;
      if (skipBelow) continue;
    } else if (skipBelow) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Cut text back to its last whole sentence, so the model never copies half of one. */
function wholeSentences(text: string): string {
  if (/[.!?]["”)]?$/.test(text)) return text;
  const end = Math.max(text.lastIndexOf(". "), text.lastIndexOf('." '), text.lastIndexOf(".\n"));
  // Only when little is lost: text with few sentence breaks is left as it is.
  return end > text.length * 0.7 ? text.slice(0, end + 1) : text;
}

/**
 * `ownArticle` is false when the article is about the whole game or the
 * artist, not this song: then only what's plainly about the music is lifted,
 * and no reception, which would be the game's or the artist's, not the song's.
 */
export function orderExtract(full: string, budget: number, names: string[] = [], ownArticle = true, primaryHeading: RegExp = MUSIC_HEADING): string {
  full = withoutVideoSections(full);
  // What the makers said goes first: it's the part worth retelling, and a small model reads the top best.
  const color = creatorSentences(full, names, ownArticle);
  const theory = ownArticle ? theorySentences(full).filter((s) => !color.includes(s)) : [];
  const received = ownArticle ? receptionSentences(full).filter((s) => !color.includes(s) && !theory.includes(s)) : [];
  const colorBlock = [
    color.length ? `From the people who made it: ${color.join(" ")}` : "",
    theory.length ? `How the music is built: ${theory.join(" ")}` : "",
    received.length ? `How it was received: ${received.join(" ")}` : "",
  ].filter(Boolean).join("\n\n");
  if (colorBlock) budget = Math.max(0, budget - colorBlock.length - 2);
  const primary: string[] = [];
  const secondary: string[] = [];
  // A subsection inherits the bucket of the section it sits under.
  let parent: { level: number; bucket: string[] | null } = { level: 0, bucket: null };
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    let bucket = primaryHeading.test(heading) ? primary : BACKGROUND_HEADING.test(heading) ? secondary : null;
    if (level > parent.level && parent.bucket) bucket ??= parent.bucket;
    else parent = { level, bucket };
    if (bucket && body.trim()) bucket.push(`${heading}: ${body.trim()}`);
  }

  const lead = wholeSentences(full.split(/\n==/)[0].trim().slice(0, Math.floor(budget * 0.35)));
  const rest = wholeSentences([...primary, ...secondary].join("\n\n").slice(0, Math.max(0, budget - lead.length - 2)));
  return [colorBlock, rest, lead].filter(Boolean).join("\n\n");
}

// --- Section-aware selection ------------------------------------------------

/**
 * SECTION_SELECT=off turns it off. Judged captions err far more often when
 * written from narrative sections (background, development, history) than
 * from the lead, which Wikipedia writes to stand alone, or from sections that
 * report checkable things (composition, release, charts, awards).
 */
export const sectionSelection = { on: process.env.SECTION_SELECT !== "off" };
/** RECEPTION_FILTER=off keeps reception, legacy and accolades sentences as section-select first did. */
export const receptionFilter = { on: process.env.RECEPTION_FILTER !== "off" };
/** SERIES_SCOPE=off reads a series-wide music article whole, as before. */
export const seriesFilter = { on: process.env.SERIES_SCOPE !== "off" };

/** Narrative sections: who did what before or around the work, or a game's story. */
const NARRATIVE_HEADING =
  /\b(background|antecedents?|influences?|development|history|conception|creation|production|early (?:life|years)|plot|gameplay|synopsis|story(?: ?line)?|premise)\b/i;
/** "Release history" and "Chart history" are lists of dates and peaks, not a story. */
const DATA_HISTORY = /\b(release|chart|sales|publication|broadcast) history\b/gi;
/** Sections that report checkable things: how it's built, released, charted, awarded, performed or covered. */
const DATA_HEADING =
  /\b(composition|music and lyrics|lyrics|lyrical content|releases?|charts?|commercial|performances?|sales|certifications?|accolades?|awards?|honou?rs|live|cover versions?|covers|versions|track ?listings?)\b/i;
/** Sections on the music's style and sound. */
const STYLE_HEADING = /\b(music|musical|style|sound|soundtracks?|score|audio|genre|instrumentation|arrangements?|structure)\b/i;
/** Sections with nothing to write from. */
const SKIP_HEADING = /^(references|notes|footnotes|citations|sources|external links|see also|further reading|bibliography)$/i;
/** A sentence about the music, for keeping one from a narrative section. */
const MUSIC_WORD = /\b(compos\w*|scor(?:e|es|ed|ing)|soundtracks?|themes?|songs?|tracks?|melod(?:y|ies|ic))\b/i;

/** Sections of other people's verdicts: reviews and reception. Only their chart, sales and certification numbers are kept. */
const RECEPTION_HEADING = /\b(reception|reviews?|critical|critics|response|reaction|retrospective|appraisal)\b/i;
/** Sections where opinions sit among facts: legacy, accolades, release. Their opinion sentences are left out. */
const LEGACY_HEADING = /\b(legacy|impact|influence|aftermath)\b/i;
const ACCOLADE_HEADING = /\b(accolades?|awards?|honou?rs|rankings?|lists?)\b/i;
const RELEASE_HEADING = /\b(releases?|promotion|singles?)\b/i;
/** A chart peak, a sales figure or a certification: checkable even in a reception section. */
const CHART_WORD =
  /\b(charts?|charted|peak(?:ed|ing)?|Billboard|Hot 100|Oricon|top (?:ten|forty|\d+)|number (?:one|\d+)|No\. ?\d+|sold|sales|copies|units|shipped|certified|certifications?|gold|platinum|diamond)\b/i;
/** A ranking on someone's list is a verdict, not a chart. */
const LIST_RANKING = /\b(ranked|ranking|lists?|greatest|best|favou?rite)\b/i;
/** A critic or a publication judging the work. */
const REVIEW_CUE =
  /\b(critics?|critical(?:ly)?|reviewers?|reviews?|reviewed|praised|praise|acclaim(?:ed)?|hailed|lauded|panned|called (?:it|the (?:song|track|single|album|game|record))|described (?:it|the (?:song|track|single|album|game|record)) as|wrote that|opined|felt (?:that|it)|rated|ranked|listed|gave (?:it|the)|out of (?:five|ten|\d+)|stars|magazine|Cash Box|Record World|Melody Maker|AllMusic|Pitchfork|Rolling Stone|NME|Stereogum|IGN|GameSpot|GamesRadar\+?|Famitsu|Nintendo Power|Game Informer|Eurogamer|Kotaku|Polygon|Destructoid|RPGFan)(?![\p{L}])/iu;
/** An award won or a nomination, the checkable part of an accolades section. */
const AWARD_FACT = /\b(won|wins|winning|nominated|nominations?|awarded|inducted|received (?:an?|the) [^.]*\b(?:award|prize|honou?r))\b/i;

/** A sentence with a chart peak, a sales figure or a certification and a number. */
export function isChartFact(s: string): boolean {
  if (!CHART_WORD.test(s) || LIST_RANKING.test(s)) return false;
  return /\d|\bnumber one\b|\bcertified (?:gold|platinum|diamond)\b/i.test(s);
}

/** Opinion sentences, by a critic or in a critic's words. */
const opinionated = (s: string) => REVIEW_CUE.test(s) || OPINION.test(s);

/**
 * Which sentences a section of verdicts keeps, or null for a section that
 * keeps them all, or undefined when the heading doesn't say (a subsection
 * then follows the section it sits under):
 * - reception and reviews: only chart, sales and certification sentences with numbers;
 * - accolades: those, and awards won or nominated for, never a critic's ranking;
 * - legacy and release: everything but opinions.
 */
function verdictFilter(heading: string): ((s: string) => boolean) | null | undefined {
  const h = heading.replace(DATA_HISTORY, "$1");
  const release = RELEASE_HEADING.test(h);
  if (RECEPTION_HEADING.test(h)) {
    // "Release and reception": the release half is facts.
    return release ? (s) => isChartFact(s) || !opinionated(s) : isChartFact;
  }
  if (ACCOLADE_HEADING.test(h)) return (s) => isChartFact(s) || (AWARD_FACT.test(s) && !opinionated(s));
  if (LEGACY_HEADING.test(h) || release) return (s) => isChartFact(s) || !opinionated(s);
  return headingRank(heading) === null ? undefined : null;
}

/** Lead first, then checkable sections, then style, then the rest; narrative sections only for what names the song or its composer. */
const RANK = { lead: 0, data: 1, style: 2, other: 3, narrative: 4 } as const;

function headingRank(heading: string): number | null {
  const h = heading.replace(DATA_HISTORY, "$1");
  if (NARRATIVE_HEADING.test(h)) return RANK.narrative;
  if (DATA_HEADING.test(h)) return RANK.data;
  if (STYLE_HEADING.test(h)) return RANK.style;
  return null;
}

const PERSON = String.raw`\p{Lu}[\p{L}'’.-]+(?:\s+(?:de |van |von |da |di |le )?\p{Lu}[\p{L}'’.-]+){0,3}`;
const PEOPLE = String.raw`${PERSON}(?:(?:,\s*|,?\s+and\s+)${PERSON})*`;
const COMPOSER_CUE = new RegExp(
  String.raw`\b(?:(?:composed|scored|written|co-written|arranged)(?: and (?:composed|written|produced|arranged|performed))?|music(?: was)?) by (${PEOPLE})|\bcomposers?,? (${PEOPLE})`,
  "gu"
);

/**
 * Who the article says wrote the music: "composed by Ann Example and Bo
 * Sample", "composer Cy Person", "written by ...". Full names and surnames,
 * normalized.
 */
export function composerNames(full: string): string[] {
  const out = new Set<string>();
  for (const m of full.matchAll(COMPOSER_CUE)) {
    for (const name of (m[1] ?? m[2]).split(/,\s*|,?\s+and\s+/)) {
      const n = normalizeTitle(name);
      if (!n) continue;
      out.add(n);
      const last = n.split(" ").pop() ?? "";
      if (n.includes(" ") && last.length >= 4) out.add(last);
    }
  }
  return [...out];
}

/** A body's sentences that can be written from: whole sentences, not list items or table rows. */
function sectionSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && /[.!?]["”)]?$/.test(s));
}

/** The same sentences, each with whether it opens its paragraph (the extract's paragraphs are lines). */
function sectionSentencesWithOpens(body: string): Array<{ text: string; opens: boolean }> {
  return body.split(/\n+/).flatMap((para) =>
    para
      .split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u)
      .map((s, i) => ({ text: s.trim(), opens: i === 0 }))
      .filter((s) => s.text.length >= 25 && /[.!?]["”)]?$/.test(s.text))
  );
}

/**
 * The article's sections in the order a writer should read them, each with
 * the sentences kept: the lead, then sections that report checkable things,
 * then style, then the rest. From a narrative section (background, history,
 * development, plot) only a sentence that names the song (`names[0]`) or its
 * composer and is about music is kept. Subsections without a telling heading
 * go with the section they sit under; music-video sections are left out.
 */
export function selectSections(full: string, names: string[] = []): Array<{ heading: string; rank: number; sentences: string[]; opens: Set<string> }> {
  full = withoutVideoSections(full);
  const song = names[0] ? normalizeTitle(names[0]) : "";
  const makers = composerNames(full);
  const namesIt = (s: string) => mentionsName(normalizeTitle(s), [...(song ? [song] : []), ...makers]);
  const opensOf = (body: string) => new Set(sectionSentencesWithOpens(body).filter((x) => x.opens).map((x) => x.text));
  const leadText = full.split(/\n==/)[0];
  // Sentences about another work (a sequel, a remake) or, for a cover, the original's record: left out (`withoutSentences`).
  const scope = activeDrop;
  const inScope = (list: string[]) => (scope ? list.filter((s) => !scope.drop.has(s) || (scope.trackSaves && !!names[0] && namesTrack(s, names[0]))) : list);
  const out: Array<{ heading: string; rank: number; sentences: string[]; opens: Set<string> }> = [{ heading: "", rank: RANK.lead, sentences: inScope(sectionSentences(leadText)), opens: opensOf(leadText) }];
  const open: Array<{ level: number; rank: number | null; keep: ((s: string) => boolean) | null }> = [];
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const rank = SKIP_HEADING.test(heading.trim()) ? null : (headingRank(heading) ?? open[open.length - 1]?.rank ?? RANK.other);
    const own = verdictFilter(heading);
    const keep = own === undefined ? (open[open.length - 1]?.keep ?? null) : own;
    open.push({ level, rank, keep });
    if (rank === null) continue;
    let sentences = inScope(sectionSentences(body));
    if (rank === RANK.narrative) sentences = sentences.filter((s) => MUSIC_WORD.test(s) && namesIt(s));
    // Critics' verdicts read as facts on stream (issue #21): a 3B drops the "a reviewer called it".
    if (receptionFilter.on && keep) sentences = sentences.filter(keep);
    if (sentences.length) out.push({ heading, rank, sentences, opens: opensOf(body) });
  }
  // A stable sort: article order within a rank.
  return out.sort((a, b) => a.rank - b.rank);
}

/** Sentences long enough to make a caption from. */
const usableSentences = (sentences: string[]) => sentences.filter((s) => s.length >= 40).length;

/**
 * Up to `budget` characters in the `selectSections` order, whole sentences,
 * "Heading: " before each section's first one; sentences in `skip` (already
 * given elsewhere) left out. "" when fewer than 2 usable sentences are kept,
 * so the caller falls back to `orderExtract`.
 */
export function sectionExtract(full: string, budget: number, names: string[] = [], skip: Set<string> = new Set()): string {
  if (tieredSelection.on) return tieredExtract(full, budget, names, skip);
  const blocks: string[] = [];
  const kept: string[] = [];
  let used = 0;
  outer: for (const part of selectSections(full, names)) {
    const take: string[] = [];
    for (const s of part.sentences) {
      if (skip.has(s)) continue;
      const add = s.length + 1 + (take.length ? 0 : part.heading.length + 4);
      if (used + add > budget) {
        if (take.length) blocks.push(`${part.heading ? `${part.heading}: ` : ""}${take.join(" ")}`);
        kept.push(...take);
        break outer;
      }
      take.push(s);
      used += add;
    }
    if (take.length) blocks.push(`${part.heading ? `${part.heading}: ` : ""}${take.join(" ")}`);
    kept.push(...take);
  }
  return usableSentences(kept) >= 2 ? blocks.join("\n\n") : "";
}

// --- Tiered source selection ---------------------------------------------

/** TIERED_SELECTION=off orders the reference by section only, as before. */
export const tieredSelection = { on: process.env.TIERED_SELECTION !== "off" };

/** Someone reported as saying or judging something: the sentence a 3B retells without the "who said it". */
export const REPORTING = /\b(?:said|says|wrote|writes|according to|told|described|called|stated|noted|claimed|recalled|explained)\b/i;
/** Fewer sentences than this in the clean tiers, and the rest of the article is offered too: the writer is asked for 5 captions and 3 spares. */
const TIER_ENOUGH = 8;
/** Body sentences offered last that report what someone said: a caption from one must keep who said it. */
export const reportedSentences = new Set<string>();

/** A body sentence a small model retells safely: under 30 words, no quoted speech of 4+ words (a quoted title is fine), no reporting verb. */
export function isCleanSentence(s: string): boolean {
  if (s.split(/\s+/).length >= 30 || REPORTING.test(s)) return false;
  return ![...s.matchAll(/["“]([^"”]{1,400})["”]/g)].some((m) => m[1].trim().split(/\s+/).length >= 4);
}

/**
 * The reference in tiers, from what an offline look at 2,898 judged captions
 * found safest to retell: 1, the lead (any shape); 2, clean body sentences
 * that open their paragraph; 3, other clean body sentences; 4, the rest, only
 * when tiers 1 to 3 give fewer than 8 usable sentences. Section-aware
 * selection's exclusions (narrative, verdicts) still apply; within a tier,
 * sections keep their `selectSections` order. "" when fewer than 2 usable.
 */
export function tieredExtract(full: string, budget: number, names: string[] = [], skip: Set<string> = new Set()): string {
  const parts = selectSections(full, names);
  const items: Array<{ tier: number; heading: string; text: string }> = [];
  for (const part of parts) {
    for (const text of part.sentences) {
      if (skip.has(text)) continue;
      const tier = part.rank === RANK.lead ? 1 : !isCleanSentence(text) ? 4 : part.opens.has(text) ? 2 : 3;
      items.push({ tier, heading: part.heading, text });
    }
  }
  const clean = items.filter((x) => x.tier < 4);
  const offered = usableSentences(clean.map((x) => x.text)) >= TIER_ENOUGH ? clean : items;
  const ordered = [1, 2, 3, 4].flatMap((t) => offered.filter((x) => x.tier === t));
  const blocks: Array<{ key: string; heading: string; texts: string[] }> = [];
  const kept: string[] = [];
  let used = 0;
  for (const x of ordered) {
    const key = `${x.tier}\0${x.heading}`;
    const last = blocks[blocks.length - 1];
    const add = x.text.length + 1 + (last?.key === key ? 0 : x.heading.length + 4);
    if (used + add > budget) break;
    if (last?.key === key) last.texts.push(x.text);
    else blocks.push({ key, heading: x.heading, texts: [x.text] });
    kept.push(x.text);
    used += add;
    if (x.tier === 4 && REPORTING.test(x.text)) {
      if (reportedSentences.size > 5000) reportedSentences.clear();
      reportedSentences.add(x.text);
    }
  }
  if (usableSentences(kept) < 2) return "";
  return blocks.map((b) => `${b.heading ? `${b.heading}: ` : ""}${b.texts.join(" ")}`).join("\n\n");
}

// --- Work scope: italic titles ----------------------------------------------

/** WORK_SCOPE=off reads every sentence of a game's or a work's article, as before. */
export const workScope = { on: process.env.WORK_SCOPE !== "off" };

/**
 * Sentences left out of the next reference built (set around one synchronous
 * build, then cleared). `trackSaves`: a sentence that names the track stays.
 */
let activeDrop: { drop: Set<string>; trackSaves: boolean } | null = null;

/** Build `fn`'s reference without the sentences in `drop`. */
export function withoutSentences<T>(drop: Set<string> | null, trackSaves: boolean, fn: () => T): T {
  if (!drop?.size) return fn();
  activeDrop = { drop, trackSaves };
  try {
    return fn();
  } finally {
    activeDrop = null;
  }
}

/** One sentence of an article's wikitext as plain words, with the titles it sets in italics. */
export interface ItalicSentence {
  text: string;
  /** Each italic title as shown, its link target when the italics are one link, and whether it's bold too (the article's own subject). */
  works: Array<{ title: string; target: string; subject: boolean }>;
  /** The paragraph the sentence sits in, counted through the article. */
  para: number;
}

/** Inline templates whose text is part of the sentence, and which argument holds it. */
const TEXT_TEMPLATES: Record<string, number> = { nihongo: 1, nihongo2: 1, nihongo3: 1, "nihongo foot": 1, lang: 2, nowrap: 1, nobr: 1, small: 1, ill: 1, "interlanguage link": 1, "not a typo": 1, vgy: 1, "'": -1 };

/** Remove `[[File:...]]` and similar links, which nest other links inside them. */
function withoutFileLinks(t: string): string {
  let out = "";
  let i = 0;
  while (i < t.length) {
    const m = /\[\[(?:File|Image|Category):/i.exec(t.slice(i));
    if (!m) return out + t.slice(i);
    out += t.slice(i, i + m.index);
    let depth = 0;
    let j = i + m.index;
    for (; j < t.length - 1; j++) {
      if (t.startsWith("[[", j)) { depth++; j++; } else if (t.startsWith("]]", j)) { depth--; j++; if (depth === 0) break; }
    }
    i = j + 1;
  }
  return out;
}

/**
 * An article's wikitext as sentences of plain words, each with its italic
 * titles. Wikipedia's style puts the titles of games, albums, films, shows
 * and books in italics (''Title''); the article's own subject in bold
 * italics in its lead. Approximate on purpose: references, tables and other
 * templates are dropped, so the words are matched to the plain text loosely.
 */
export function italicSentences(wikitext: string): ItalicSentence[] {
  let t = withoutRefsAndComments(wikitext);
  t = withoutFileLinks(t);
  // A link's "|" isn't a template's.
  t = t.replace(/\[\[([^[\]]*)\]\]/g, (m) => m.replace(/\|/g, "\u0003"));
  for (let guard = 0; guard < 20 && /\{\{[^{}]*\}\}/.test(t); guard++) {
    t = t.replace(/\{\{([^{}]*)\}\}/g, (_, body: string) => {
      const parts = body.split("|");
      const at = TEXT_TEMPLATES[parts[0].trim().toLowerCase()];
      return at === undefined ? "" : at < 0 ? "'" : (parts[at] ?? "").replace(/^\s*\d+\s*=\s*/, "");
    });
  }
  // Tags go until none is left ("<scr<b>ipt>" leaves "<script>" once), then any stray angle bracket.
  t = removeAll(t.replace(/\{\|[\s\S]*?\|\}/g, ""), /<[^>]+>/g).replace(/[<>]/g, "");
  // Bold italics: the subject's own title. Then bold alone is dropped, and italics marked.
  t = t.replace(/'''''([^'\n][^\n]*?)'''''/g, "\u0001\u0004$1\u0002").replace(/'''/g, "").replace(/''([^'\n][^\n]*?)''/g, "\u0001$1\u0002");
  const linkText = (s: string) => s.replace(/\[\[([^\]\u0003]*)(?:\u0003([^\]]*))?\]\]/g, (_, target: string, shown?: string) => shown ?? target.replace(/#.*$/, "")).replace(/\[https?:\/\/\S+\s*([^\]]*)\]/g, "$1");
  const out: ItalicSentence[] = [];
  let para = 0;
  for (const line of t.split("\n")) {
    if (/^\s*=+[^=]+=+\s*$/.test(line) || !line.trim()) {
      para++;
      continue;
    }
    para++;
    for (const raw of line.split(/(?<=[.!?]["”]?\u0002?)\s+(?=["“\u0001]?\p{Lu})/u)) {
      const works: ItalicSentence["works"] = [];
      for (const m of raw.matchAll(/\u0001(\u0004?)([^\u0002]*)\u0002/g)) {
        const one = /^\[\[([^\]\u0003]+)(?:\u0003([^\]]+))?\]\]$/.exec(m[2].trim());
        const title = linkText(m[2]).replace(/[\u0001-\u0004]/g, "").trim();
        if (title) works.push({ title, target: one ? one[1].replace(/#.*$/, "").trim() : "", subject: !!m[1] });
      }
      const text = linkText(raw).replace(/[\u0001-\u0004]/g, "").replace(/^[*#:;]+\s*/, "").replace(/\s+/g, " ").trim();
      if (text) out.push({ text, works, para });
    }
  }
  return out;
}

/** Words shared by too many titles to say two works are related. */
const GENERIC_TITLE_WORDS = new Set("music game games video series soundtrack soundtracks original edition version theme album songs song live best greatest hits collection volume part chapter story world legend super".split(" "));

/** A title's distinctive words: 4+ letters, not generic. */
const titleWords = (s: string) => normalizeTitle(s).split(" ").filter((w) => w.length >= 4 && !GENERIC_TITLE_WORDS.has(w));

/** "Music of Some Game", "Some Game (soundtrack)", "Some Game (video game)": the work a page is about. */
export function workOfPage(page: string): string {
  return page.replace(/\s*\([^)]*\)\s*$/, "").replace(/^(?:the )?(?:music|soundtracks?|scores?) (?:of|from|for) (?:the )?/i, "").replace(/\s+(?:series|franchise)$/i, "").trim();
}

/**
 * The requested work's names, normalized: the request's game or work field,
 * the work the article is about, and the titles the article's lead sets in
 * bold italics (its subject's own names, by Wikipedia's style).
 */
export function requestedWork(game: string, page: string, sentences: ItalicSentence[] = []): string[] {
  const firstPara = sentences.find((s) => s.works.some((w) => w.subject))?.para;
  const subject = sentences.filter((s) => s.para === firstPara).flatMap((s) => s.works.filter((w) => w.subject).map((w) => w.title));
  const plain = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  const titles = [game, plain, workOfPage(page), ...subject];
  // "Dark Moon" for "Some Mansion: Dark Moon": a subtitle of two words or more is the work's short name.
  const subtitles = titles.map((t) => /:\s*(.+)$/.exec(t)?.[1] ?? "").filter((t) => t.trim().split(/\s+/).length >= 2);
  // Paired versions: "Some Red, Blue and Yellow" is also "Some Red", "Red and Blue" and, in italics, "Blue".
  const versions = titles.flatMap((t) => {
    const m = /^(.*?)\b((?:[\p{L}\p{N}'’-]+,\s+)*[\p{L}\p{N}'’-]+,?\s+(?:and|&)\s+[\p{L}\p{N}'’-]+)$/u.exec(t.trim());
    if (!m) return [];
    const items = m[2].split(/,?\s+(?:and|&)\s+|,\s+/);
    const pairs = items.flatMap((a, i) => items.slice(i + 1).map((b) => `${a} and ${b}`));
    return [...items, ...items.map((i) => `${m[1]}${i}`), ...pairs];
  });
  return [...new Set([...titles, ...subtitles, ...versions].map((t) => normalizeTitle(t).replace(/^the /, "")).filter((n) => n.length >= 3))];
}

/** What an album of a work's own music is called: "Original Soundtrack", "Original Sound Version", "Piano Collections". */
const MUSIC_ALBUM = /\b(?:soundtracks?|OST|OSV|original sound|sound version|music|arranged|arrange|piano|orchestral|orchestra|symphonic|remix(?:es)?|album|tracks|collections?|grand finale|concert|melodies)\b/i;
/** A spoken album or radio play of a work: not its music. */
const NOT_MUSIC_ALBUM = /\b(?:drama|radio)\b/i;

/** Words that make a mention of the requested work one of its editions: "the 2019 remake of Some Game". */
const EDITION_WORD = /\b(?:remake|remaster(?:ed)?|reboot|re-?release|reimagining|sequel|prequel|spin-?off|port|follow-?up|successor)\b/i;
/** A section about other works: "Sequels", "Remake", "Spin-offs". */
const EDITION_HEADING = /\b(?:sequels?|prequels?|remakes?|remasters?|reboots?|spin-?offs?|successors?)\b/i;
/** A sentence about an edition, not the work: "The remake adds ...", "Its 2019 remaster ...". */
const EDITION_LED = /^(?:In \d{4}, )?(?:The|A|An|This|Its|Their) (?:\d{4} |later |enhanced |HD |high-definition |3D |Western |English )?(?:remake|remaster|remastered version|reboot|re-?release|sequel|prequel|spin-?off|port|follow-?up|reimagining)\b/;
/** A sentence that goes on about what the one before it named. */
const LEANS_ON_PREVIOUS = /^["“]?(?:It|Its|They|Their|This|These|The (?:game|remake|remaster|sequel|prequel|port|reboot|film|album|soundtrack|version|release|title))\b/;

/**
 * Whether a plain sentence names a work by its words: the name with word
 * edges, not as part of a longer title the sentence also has in italics,
 * and not next to an edition word ("the remake of Some Game").
 */
function namesWorkPlainly(sentence: string, allNames: string[], longer: string[], exempt = ""): { clean: boolean; edition: boolean } {
  // One word ("red") is too common to be the work's name in plain text; in italics it is.
  const names = allNames.filter((n) => n.includes(" ") || n.length >= 8);
  let text = ` ${normalizeTitle(sentence)} `;
  for (const l of longer.map(normalizeTitle).filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(` ${l} `).join(" \u0005 ");
  let clean = false;
  let edition = false;
  for (const n of names) {
    let from = 0;
    for (let at = text.indexOf(` ${n} `, from); at >= 0; at = text.indexOf(` ${n} `, from)) {
      const before = text.slice(Math.max(0, at - 40), at).split(" ").slice(-4).join(" ");
      const after = text.slice(at + n.length + 2).split(" ").slice(0, 2).join(" ");
      if (n !== exempt && (EDITION_WORD.test(before) || /^(?:remastered|remaster|remake|hd|dx|deluxe|definitive|royal|zero|plus|reloaded|redux)\b/.test(after))) edition = true;
      else clean = true;
      from = at + n.length + 1;
    }
  }
  return { clean, edition };
}

/**
 * The article's plain sentences that are about another work than the one
 * requested: a sentence that names, in italics, a related work (a sequel, a
 * remake, an edition, another game of the series: a title sharing a
 * distinctive word with the requested one) and doesn't name the requested
 * work itself; a sentence about "the remake" or "the sequel"; and the
 * sentences right after one of those that go on with "It" or "The game".
 * A series named as a series ("the Some Game series") is not another work.
 * Unrelated titles (a magazine, the composer's other game) are left alone.
 */
export function otherWorkSentences(full: string, wikitext: string, game: string, page: string): Set<string> {
  const wiki = italicSentences(wikitext);
  const names = requestedWork(game, page, wiki);
  const out = new Set<string>();
  if (!names.length || !wiki.length) return out;
  const own = new Set(names.flatMap(titleWords));
  const index = wiki.map((w) => contentTokens(w.text));
  const namesEdition = EDITION_WORD.test(game);
  const norm = (t: string) => normalizeTitle(t).replace(/^the /, "");
  // An album of the requested work's own music: "Some Game Original Soundtrack", "Piano Collections Some Game".
  // Not an album of a related game's music: "Melodies of Some Game Advance" for "Some Game".
  const games = [...new Set(wiki.flatMap((x) => x.works).map((w) => norm(w.title)).filter((t) => !names.includes(t) && !MUSIC_ALBUM.test(t) && titleWords(t).some((x) => own.has(x))))];
  const ownAlbum = (t: string) => {
    const n = ` ${norm(t)} `;
    return names.some((x) => x.includes(" ") && n.includes(` ${x} `)) && MUSIC_ALBUM.test(t) && !NOT_MUSIC_ALBUM.test(t) && !games.some((g) => n.includes(` ${g} `));
  };
  // A link to "Some Game (TV series)" from "Some Game (video game)" is the show, not the game.
  const qualifier = (t: string) => /\(([^)]*)\)\s*$/.exec(t)?.[1]?.toLowerCase() ?? "";
  const isRequested = (w: { title: string; target: string }) =>
    (w.target
      ? names.includes(norm(w.target)) || (names.includes(norm(workOfPage(w.target))) && (!qualifier(w.target) || qualifier(w.target) === qualifier(page)))
      : names.includes(norm(w.title))) || ownAlbum(w.title);
  // A series named by one word ("Some" for "Some Mania"), or as a kind of game: "the early Some games", "a Some fangame".
  const asSeries = (w: { title: string }, s: string) => {
    const t = norm(w.title);
    if (!t.includes(" ") && names.some((n) => n.startsWith(`${t} `))) return true;
    return new RegExp(String.raw`${escapeRe(w.title)}['’]?s?\s+(?:video game\s+)?(?:series|franchise|saga|games|titles|fans|fangames?|community|universe|characters?|mascot)\b`, "i").test(s);
  };
  const related = (w: { title: string }) => titleWords(w.title).some((x) => own.has(x));
  // Every related work the article names in italics, to tell a section headed with one ("=== Some Game Zero ===").
  const otherTitles = new Set(wiki.flatMap((x) => x.works).filter((w) => !isRequested(w) && related(w)).map((w) => norm(w.title)));
  // A request for "Some Game Zero" from the article on "Some Game": "a remake, Some Game Zero" names the request itself.
  const requestIsEdition = norm(game) !== norm(workOfPage(page)) ? norm(game) : "";
  const heads: Array<{ level: number; other: boolean }> = [];
  for (const line of full.split("\n")) {
    const head = /^(=+)\s*(.+?)\s*=+\s*$/.exec(line.trim());
    if (head) {
      while (heads.length && heads[heads.length - 1].level >= head[1].length) heads.pop();
      const h = norm(head[2]);
      heads.push({ level: head[1].length, other: (otherTitles.has(h) && !names.includes(h)) || (!namesEdition && EDITION_HEADING.test(head[2])) });
      continue;
    }
    const inOther = heads.some((x) => x.other);
    let carry: boolean = false;
    for (const s of line.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).map((x) => x.trim()).filter(Boolean)) {
      if (inOther) {
        out.add(s);
        continue;
      }
      const want = contentTokens(s);
      let best = -1;
      let share = 0;
      if (want.size >= 4) {
        index.forEach((have, i) => {
          let n = 0;
          for (const t of want) if (have.has(t)) n++;
          // Shared words over the longer of the two: a short sentence doesn't match a long one that contains it.
          const fit = n / Math.max(want.size, have.size);
          if (fit > share) [best, share] = [i, fit];
        });
      }
      const works = best >= 0 && share >= 0.5 ? wiki[best].works : [];
      const series = (w: { title: string; target: string }) => /\b(?:series|franchise)\b/i.test(w.target) || asSeries(w, s);
      const others = works.filter((w) => !isRequested(w) && !series(w) && related(w));
      // The work named in words or italics, not as part of another title and not as "the remake of Some Game".
      const plainly = namesWorkPlainly(s, [...names, ...works.filter(isRequested).map((w) => norm(w.title))], works.filter((w) => !isRequested(w)).map((w) => w.title), requestIsEdition);
      // "It was a hit, outselling Some Game 11": a sentence led by "It" or "The game" is about the article's own work,
      // unless the one before it was about another, or it says it is a remake.
      const subjectLed: boolean =
        !carry && !plainly.edition && (/^["“]?(?:It|Its|The game|This game)\b/.test(s) || /^[^.;]{0,80}?,\s+(?:it|the game) (?:is|was|became|remains)\b/.test(s));
      const namesIt: boolean = plainly.clean || subjectLed;
      const edition: boolean = !namesEdition && !namesIt && (EDITION_LED.test(s) || plainly.edition);
      const leansBack: boolean = carry && !namesIt && !works.length && LEANS_ON_PREVIOUS.test(s);
      const drop: boolean = (others.length > 0 && !namesIt) || edition || leansBack;
      if (drop) out.add(s);
      carry = drop;
    }
  }
  return out;
}

/** Wikitext by page, for the infobox facts and the italic titles: one request per article. */
const wikitextCache = new Map<string, { text: string; at: number }>();

/** An article's wikitext ("" for a missing page), remembered; throws when Wikipedia can't be reached. */
export async function loadWikitext(page: string): Promise<string> {
  const hit = wikitextCache.get(page);
  if (hit) return hit.text;
  // The newest version at least STABLE_AGE_MS old, as for the article's text (issue #242).
  const before = new Date(Date.now() - STABLE_AGE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `${WIKI_API}?${new URLSearchParams({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", rvlimit: "1", rvdir: "older", rvstart: before, titles: page, redirects: "1", format: "json", formatversion: "2" })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(config.groundingTimeoutMs), headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { query?: { pages?: Array<{ revisions?: Array<{ slots?: { main?: { content?: string } } }> }> } };
  const text = data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? "";
  if (wikitextCache.size > 60) wikitextCache.delete(wikitextCache.keys().next().value as string);
  wikitextCache.set(page, { text, at: Date.now() });
  return text;
}

/** An article's wikitext, or "" when it can't be had. Never throws. */
export async function wikitextOf(page: string): Promise<string> {
  if (!page) return "";
  try {
    return await loadWikitext(page);
  } catch (err) {
    console.warn(`[Grounding] Wikitext lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return "";
  }
}

const workScopeCache = new Map<string, Set<string>>();
/** Five apostrophes: bold italics, how Wikipedia's style names a work's article subject. */
const BOLD_ITALIC = new RegExp(`${"'".repeat(5)}[^'\n]`);

/** The sentences of these articles about another work than `game`, from their wikitext. */
async function otherWorkScope(articles: Array<{ page: string; full: string } | null | undefined>, game: string): Promise<Set<string> | null> {
  if (!workScope.on || !game.trim()) return null;
  const out = new Set<string>();
  for (const a of articles) {
    if (!a?.full) continue;
    const key = `${a.page}\0${normalizeTitle(game)}`;
    let drop = workScopeCache.get(key);
    if (!drop) {
      const wikitext = await wikitextOf(a.page);
      // Only a work's article: its lead names it in bold italics. A person's or a band's is in bold alone.
      const aWork = BOLD_ITALIC.test(wikitext.split(/\n==/)[0]) || /^(?:music|soundtracks?|scores?) (?:of|from|for)\b|\((?:[^)]*\s)?(?:soundtrack|score|album)\)$/i.test(a.page);
      drop = wikitext && aWork ? otherWorkSentences(a.full, wikitext, game, a.page) : new Set<string>();
      if (workScopeCache.size > 200) workScopeCache.clear();
      workScopeCache.set(key, drop);
      if (drop.size) console.log(`[Grounding] "${a.page}": ${drop.size} sentences about another work than "${game}" left out`);
    }
    for (const s of drop) out.add(s);
  }
  return out.size ? out : null;
}

// --- Covers ------------------------------------------------------------------

/** COVER_SCOPE=off reads a covered song's article whole, as before. */
export const coverScope = { on: process.env.COVER_SCOPE !== "off" };

/** What a cover must not take from the original's article: its release, charts, sales, video and the band's own moves. */
const ORIGINALS_RECORD = /\b(?:charts?|charted|peak(?:ed|s)?|number(?:-| )(?:one|\d+)|No\. ?\d+|top (?:\d+|ten|forty)|Hot 100|Billboard|certifi\w+|platinum|gold|sold|sales|copies|single|singles|released|release|reissue\w*|B-side|music video|video|award\w*|Grammy|nominat\w+|performed|performance|tour\w*|live|concert|the (?:band|group|duo|trio|singer)|(?:their|his|her) (?:album|version|recording))\b/i;

/**
 * Whether the request is a cover of the song an article is about: the
 * request says "cover", or the article is a song's and its lead never names
 * the requested artist (who appears only further down, among the covers).
 */
export function isCoverOf(page: string, full: string, artist: string, title: string): boolean {
  if (!coverScope.on || !full || !artist.trim()) return false;
  if (/\bcover(?:ed)?\b/i.test(title)) return true;
  if (!isPieceArticle(page, full)) return false;
  const names = artistNames(artist.replace(/\s*\([^)]*\)\s*$/, ""));
  const lead = normalizeTitle(full.split(/\n==/)[0]);
  return names.length > 0 && !mentionsName(lead, names) && mentionsName(normalizeTitle(full), names);
}

/** For a cover: the original's sentences that would read as the cover's: its release, charts, sales, video, performers' moves. */
export function originalsRecord(full: string): Set<string> {
  return new Set(full.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).map((s) => s.trim())).filter((s) => ORIGINALS_RECORD.test(s)));
}

/** Every sentence `selectSections` keeps, unbudgeted: what a piece's own sentences are looked for in. */
export function selectedText(full: string, names: string[] = []): string {
  return selectSections(full, names).flatMap((p) => p.sentences).join("\n");
}

/**
 * The text the writer reads from an article: the section-aware selection
 * when it's on and keeps 2+ usable sentences, else `fallback`, the usual
 * ordering. Whether the article is long enough to use is still decided on
 * `fallback`, so the same articles are used either way.
 */
function writingText(full: string, fallback: string, budget: number, names: string[]): string {
  if (!sectionSelection.on) return fallback;
  return sectionExtract(full, budget, names) || fallback;
}

/**
 * How old an article version must be before it is read (issue #242). Most
 * vandalism is reverted within hours; a version that stood for three days
 * has been seen by the article's watchers.
 */
export const STABLE_AGE_MS = 72 * 60 * 60 * 1000;

/** Older versions read this session, as plain text, by revision number. */
const stableTexts = new Map<number, string>();
const MAX_STABLE_TEXTS = 40;
/** How many times an older version couldn't be read: `fetchGrounding` then skips Wikipedia for the song. */
let olderVersionFailures = 0;

/**
 * The text of the newest version of an article that is at least
 * `STABLE_AGE_MS` old, or null when the article is younger than that. Throws
 * when it can't be read: then Wikipedia is skipped for the song this time.
 */
async function stableVersionText(pageTitle: string, now: number): Promise<string | null> {
  const before = new Date(now - STABLE_AGE_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
  const data = await wikiGet<{ query?: { pages?: Record<string, { revisions?: Array<{ revid?: number; timestamp?: string }> }> } }>(
    `action=query&prop=revisions&rvlimit=1&rvdir=older&rvstart=${encodeURIComponent(before)}&rvprop=ids%7Ctimestamp&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingTimeoutMs,
    "older version"
  );
  const rev = Object.values(data.query?.pages ?? {})[0]?.revisions?.[0];
  if (!rev?.revid) return null;
  const known = stableTexts.get(rev.revid);
  if (known !== undefined) return known;
  const parsed = await wikiGet<{ parse?: { text?: string } }>(
    `action=parse&oldid=${rev.revid}&prop=text&formatversion=2&disableeditsection=1&disablelimitreport=1&disabletoc=1`,
    config.groundingExtractTimeoutMs,
    "older version"
  );
  if (typeof parsed.parse?.text !== "string") throw new Error("older version HTTP 200 without text");
  const text = htmlToText(parsed.parse.text);
  stableTexts.set(rev.revid, text);
  if (stableTexts.size > MAX_STABLE_TEXTS) stableTexts.delete(stableTexts.keys().next().value as number);
  return text;
}

/**
 * The article's plain text as the model may read it, or null for a
 * disambiguation page or one with no version old enough. Only a version at
 * least 72 hours old is read (it throws when that version can't be read),
 * and only what meets the content standard (`withinStandard`): private
 * sections and sentences are left out here, so nothing downstream ever sees
 * them.
 */
export async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat=wiki keeps the "==" headings orderExtract relies on.
  const data = await wikiGet<{ query?: { pages?: Record<string, { extract?: string; revisions?: Array<{ timestamp?: string }> }> } }>(
    `action=query&prop=extracts%7Crevisions&rvprop=timestamp&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingExtractTimeoutMs,
    "extract"
  );
  const page = Object.values(data.query?.pages ?? {})[0];
  let raw = page?.extract;
  const now = Date.now();
  const edited = Date.parse(page?.revisions?.[0]?.timestamp ?? "");
  // No date counts as a fresh edit: the article is never read unchecked.
  if (raw && !(now - edited >= STABLE_AGE_MS)) {
    try {
      raw = (await stableVersionText(pageTitle, now)) ?? undefined;
    } catch (err) {
      olderVersionFailures++;
      throw err;
    }
    console.log(`[Grounding] "${pageTitle}" was edited in the last 72 hours: ${raw ? "reading the version from before" : "no older version, skipping it"}`);
  }
  if (!raw) return null;
  const kept = withinStandard(raw, pageTitle);
  if (kept.dropped || kept.sections) {
    console.log(`[Standard] "${pageTitle}": left out ${kept.dropped} of ${kept.sentences} sentences (${kept.sections} sections)`);
  }
  const full = kept.text.trim() ? kept.text : "";
  if (full) rememberArticle(pageTitle, full);
  return full && !isDisambiguation(full) ? full : null;
}

/**
 * A disambiguation or list page, even one that opens with its main meaning:
 * "2 A.M. is a time ... may also refer to:", "Minuet in G major can refer to
 * numerous musical compositions, including:". Its facts are about other works.
 */
export function isDisambiguation(full: string): boolean {
  return /\b(?:may|can) (?:also )?refer to\b/i.test(full.slice(0, 300));
}

// --- Does the article fit the request? -----------------------------------

/**
 * Articles read recently, whole, by title. A reference is cut down to a few
 * thousand characters; whether it fits the request is judged on the whole
 * article: its opening, and every name it mentions.
 */
const articleTexts = new Map<string, string>();
const MAX_ARTICLE_TEXTS = 40;

export function rememberArticle(page: string, full: string): void {
  articleTexts.delete(page);
  articleTexts.set(page, full);
  if (articleTexts.size > MAX_ARTICLE_TEXTS) articleTexts.delete(articleTexts.keys().next().value as string);
}

/** An article's whole text, when it was read this session, or "". */
export function articleText(page: string): string {
  const known = articleTexts.get(page);
  if (known) return known;
  // A game's articles are kept for all its tracks, longer than the list above.
  for (const a of gameArticles.values()) {
    if (a.page === page) return a.full;
    if (a.music?.page === page) return a.music.full;
  }
  return "";
}

/**
 * What an article's opening says its subject is, when that is something a
 * song can come from or be: a song, a record, a performer, a composer, a
 * soundtrack, a game, a film or a show. "Jezebel was a Phoenician princess"
 * and "YouTube is an online video-sharing platform" are neither, and facts
 * written from them are true but about the wrong thing.
 */
const MUSIC_OR_WORK =
  /\b(songs?|singles?|albums?|EPs?|mixtapes?|records?|recordings?|bands?|groups?|duo|trio|quartet|singers?|singer-songwriters?|rappers?|musicians?|composers?|pianists?|guitarists?|drummers?|bassists?|violinists?|cellists?|organists?|songwriters?|DJs?|disc jockey|producers?|vocalists?|lyricists?|conductors?|orchestras?|ensembles?|choirs?|idols?|YouTuber|entertainers?|performers?|soundtracks?|scores?|instrumentals?|compositions?|pieces?|suites?|sonatas?|symphon(?:y|ies)|concert[oi]s?|operas?|operettas?|ballets?|musicals?|hymns?|anthems?|ballads?|carols?|march(?:es)?|waltz(?:es)?|rhapsod(?:y|ies)|[eé]tudes?|nocturnes?|preludes?|fugues?|minuets?|mazurkas?|polonaises?|gavottes?|sarabandes?|gigues?|impromptus?|bagatelles?|ballades?|scherz(?:o|os|i)|rondos?|variations|dances?|lullab(?:y|ies)|works? for|serenades?|overtures?|requiems?|cantatas?|arias?|tunes?|melod(?:y|ies)|tangos?|games?|films?|movies?|television|TV|series|shows?|sitcoms?|anime|manga|novels?|franchises?)\b/i;

/** The article's opening: its first two sentences, or its first 400 characters. */
function openingOf(full: string): string {
  const lead = full.split(/\n==/)[0].trim();
  const sentences = lead.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
  return sentences.slice(0, 2).join(" ").slice(0, 400);
}

/** Whether an article's opening says it is about music, a performer, a game, a film or a show. */
export function opensAboutMusicOrWork(full: string): boolean {
  return MUSIC_OR_WORK.test(openingOf(full));
}

/** Words in a bracket or a subtitle that name nothing in particular. */
const GENERIC_NAME_WORDS = new Set([
  "theme", "themes", "main", "opening", "ending", "op", "ed", "no", "ost", "original", "song", "music", "track", "bgm",
  "intro", "outro", "edit", "mix", "version", "from", "the", "of", "a", "an", "and", "in", "on", "s", "free", "full",
]);

/**
 * Names the request gives that its article has to mention: the character a
 * bracket says the theme is for ("Killer (Yoshikage Kira's Theme)") and the
 * subtitle of the work in the artist field ("Star Wars: Rogue One"). Each
 * comes back normalized, generic words dropped.
 */
export function requestNames(song: SSLSong): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    const words = normalizeTitle(raw.replace(/['’]s\b/g, "")).split(" ").filter((w) => w && !GENERIC_NAME_WORDS.has(w) && !/^\d+$/.test(w));
    if (words.join("").length >= 4) out.push(words.join(" "));
  };
  // Only a bracket naming whose theme it is: "(Wild Canyon)" is a stage the game's article may never name.
  for (const m of song.title.matchAll(/[([]([^)\]]{2,})[)\]]/g)) {
    const whose = /^(.+?)['’]s\s+(?:theme|song|motif)$/i.exec(m[1].trim())?.[1] ?? /^(?:theme|motif) (?:of|for) (.+)$/i.exec(m[1].trim())?.[1];
    if (whose) add(whose);
  }
  // A person's article needn't name a translated title: "Debajo Las Estrellas (Under The Stars)".
  const artist = (song.artist ?? "").trim();
  const subtitle = /^[^:]{2,}:\s*(.{3,})$/.exec(artist)?.[1];
  if (subtitle && !looksLikeArtistName(artist)) add(subtitle);
  return [...new Set(out)];
}

/** Requests that are a slot in the queue, not a song: "Off-List YouTube Request < 5 Min (Free)". */
const PLACEHOLDER_TITLE = /\boff[- ]?list\b|<\s*\d+\s*min|\(\s*free\s*\)|\b(?:yt|youtube|song|any|open|custom|viewers?['’]?s?|paid|free)\s+requests?\b/i;
const PLACEHOLDER_ARTIST = /^(?:youtube|yt|twitch|spotify|requests?|off[- ]?list|tbd|various|n\/?a)$/i;

/** Whether a request is a placeholder for whatever a viewer asks for, rather than a song. */
export function isPlaceholderRequest(song: SSLSong): boolean {
  return PLACEHOLDER_TITLE.test(song.title) || PLACEHOLDER_ARTIST.test((song.artist ?? "").trim());
}

/**
 * Why a found reference doesn't fit the request, or "" when it does. The
 * whole article is read when it was fetched this session; otherwise only
 * the reference itself.
 * - Its opening must say it is about music, a performer, a game, a film or a show.
 * - Each name in the request's brackets or subtitle must be in the article, unless the
 *   artist is a person: then a bracket may be a translation or the film it's from.
 */
export function articleMisfit(song: SSLSong, text: string): string {
  const page = text.split("\n")[0];
  const full = articleText(page);
  if (full && !opensAboutMusicOrWork(full)) return "doesn't open like an article about a song, a performer or a work";
  const own = withoutQualifier(page);
  const haystack = ` ${normalizeTitle(own)} ${normalizeTitle(full || text)} `;
  // "Reprise (Spirited Away)" by Joe Hisaishi: for a person's piece, the bracket may be a film, a translation or a nickname.
  if (looksLikeArtistName((song.artist ?? "").trim())) return "";
  const missing = requestNames(song).find((name) => !haystack.includes(` ${name} `));
  return missing ? `never mentions "${missing}"` : "";
}

// --- Is the article about the requested work? ----------------------------

/**
 * How sure the lookup is that its article is about the requested work
 * (issue #255): `sure`, `unsure` with the reason, or `none` with no article.
 * An unsure article gets no AI captions: a sequel, a series, a film named like
 * the band or the original of a cover gives true captions about the wrong thing.
 */
export interface WorkMatch {
  level: "sure" | "unsure" | "none";
  reason: string;
}

/** Pages reached through MusicBrainz's link rather than a Wikipedia search (issue #245). */
const linkedPages = new Set<string>();

const SERIES_WORD = /\b(series|franchise)\b/i;
/** A kind of work a song is not from when its artist is a performer: "(1961 film)", "a concert documentary film". */
const SCREEN_OR_BOOK = /\b(film|movie|documentary|television|tv series|miniseries|sitcom|novel|manga|play)s?\b/i;
const AN_ALBUM = /\b(album|EP|mixtape|compilation)s?\b/i;

/** The first `n` sentences of an article's lead. */
function leadSentences(full: string, n: number): string {
  const lead = full.split(/\n==/)[0].replace(/\s+/g, " ").trim();
  const ends = [...lead.matchAll(/[.!?](?=\s+[\p{Lu}"“(])/gu)].map((m) => (m.index ?? 0) + 1);
  return ends.length >= n ? lead.slice(0, ends[n - 1]) : lead;
}

/** Whether normalized text names one of these, spelled a letter or two differently ("Colbie Cailat"). */
export function namesLoosely(text: string, names: string[]): boolean {
  if (mentionsName(text, names)) return true;
  const words = text.split(" ");
  return names.some((name) => {
    const want = name.replace(/ /g, "");
    const n = name.split(" ").length;
    if (want.length < 5) return false;
    for (let size = Math.max(1, n - 1); size <= n + 1; size++) {
      for (let i = 0; i + size <= words.length; i++) {
        const got = words.slice(i, i + size).join("");
        if (Math.abs(got.length - want.length) <= 2 && editDistance(got, want) <= Math.max(1, Math.floor(want.length * 0.15))) return true;
      }
    }
    return false;
  });
}

/**
 * `song` is the reading that found the reference; `asked` is the request as typed.
 * - `sure`: the song's own article naming its artist up front; a game's own article
 *   or its music article (the expected unit for a game's track); the artist's article
 *   that names the song, or that was found under the name as typed.
 * - `unsure`: the original of a cover; MusicBrainz's link to the artist; an album's
 *   article for a song; a song article that doesn't name the artist up front (only
 *   its first sentence counts for a short title, "Cherry"); a game's parent article
 *   for an edition or epilogue; a series' article, or its music article, for a track
 *   it never names; a film's, a show's or a book's article that never names the song,
 *   or one named after the artist; the artist's article that never names the song,
 *   found only after dropping a note ("Some Singer (Tribute)", "Song (X cover)").
 */
export function workMatchConfidence(song: SSLSong, grounding: string, asked: SSLSong = song): WorkMatch {
  if (!grounding.trim()) return { level: "none", reason: "no article" };
  const unsure = (reason: string): WorkMatch => ({ level: "unsure", reason });
  const sure = (reason: string): WorkMatch => ({ level: "sure", reason });
  const page = grounding.split("\n")[0];
  const full = articleText(page) || grounding.slice(page.length + 1);
  const base = withoutQualifier(page);
  const qualifier = qualifierOf(page) ?? "";
  const says = openingSays(full);
  const { game, track } = resolveGameAndTrack(song);
  const piece = track && normalizeTitle(track) !== normalizeTitle(game) ? track : "";
  const names = [...new Set([...artistNames(song.artist ?? ""), ...artistNames(asked.artist ?? "")])];
  // As music: "Castlevania" names the "Vampire Killer" whip, and "Punch-Out!!" a character's training.
  const named = Boolean(piece) && (/^About this piece:/m.test(grounding) || namesPiece(full, piece));
  // A note the lookup dropped: in brackets after the artist ("Some Singer (Tribute)"), or a cover's in the title.
  const noted = /\([^)]*\)\s*$/.test(asked.artist ?? "") || /[([][^)\]]*\bcover\b[^)\]]*[)\]]/i.test(asked.title);

  if (/^About this piece: .* is originally by .*\bcover\b/m.test(grounding)) return unsure("the article is about the original of a cover");
  if (linkedPages.has(page) && isPerformerArticle(page, full)) return unsure("MusicBrainz's link led to the artist's article, not the song's");
  // A classical piece found through its Wikidata item (issue #260): its own article, or its parent work's.
  const classical = classicalPages.get(classicalKey(page, asked.title)) ?? classicalPages.get(classicalKey(page, song.title));
  if (classical) {
    if (classical.section === null) return sure("the piece's own article, through its Wikidata item");
    return classical.section ? sure("the parent work's article, with a section on the piece") : unsure("the parent work's article has no section on the piece");
  }

  // The song's own article, by its title.
  const own = piece && (normalizeTitle(base) === normalizeTitle(piece) || isRespelling(piece, base) || aboutThePiece(page, full, piece));
  // "Walk This Way" for "Walk This Way - feat. A Guest": a song's article under part of the title.
  const partOf = piece && !own && isPieceArticle(page, full) && significantTokens(normalizeTitle(base)).length >= 2 &&
    mentionsName(`${normalizeTitle(piece)} ${normalizeTitle(dropVersionTags(asked.title))}`, [normalizeTitle(base)]);
  if (own || partOf) {
    if ((AN_ALBUM.test(qualifier) || AN_ALBUM.test(says)) && !/\bsoundtrack\b/i.test(qualifier + says)) return unsure(`"${page}" is an album's article, not the song's`);
    const short = significantTokens(normalizeTitle(piece)).length <= 1;
    const upFront = normalizeTitle(`${qualifier} ${leadSentences(full, short ? 1 : 3)}`);
    // A game's track: its own article names the game, the way a song's names its artist.
    if (!namesLoosely(upFront, names)) return unsure(`the song's article never names ${asked.artist || song.artist} up front${short ? " (a short title)" : ""}`);
    return sure("the song's own article");
  }

  // A game's music article ("Music of X", "X Soundtrack"): the expected unit for its tracks.
  // A series-wide one counts too, even when it never names the track: its facts are about the music.
  if (/^Music of /i.test(page) || /\bsoundtrack\b/i.test(`${qualifier} ${page}`)) {
    const seriesWide = (/\bseries$/i.test(base) || SERIES_WORD.test(says)) && !SERIES_WORD.test(asked.artist ?? "");
    return sure(seriesWide ? "the series' music article" : "the game's music article");
  }
  // Another piece's article: "Song B" for "Song A".
  if (piece && isPieceArticle(page, full)) return unsure(`"${page}" is another piece's article`);

  // The artist's article.
  const theArtist = isPerformerArticle(page, full) || (names.includes(normalizeTitle(base)) && !isWorkArticle(page, full));
  if (theArtist) {
    if (piece && !named && noted) return unsure("the artist's article never names the song, and was found only after dropping a note");
    return sure(named ? "the artist's article names the song" : "the artist's article");
  }

  // A game's, a film's or a show's article.
  const work = significantTokens(normalizeTitle(game));
  const title = significantTokens(normalizeTitle(base));
  const startsWith = (long: string[], short: string[]) => long.length > short.length && short.every((t, i) => long[i] === t);
  // "Xenoblade Chronicles: Future Connected" from "Xenoblade Chronicles": the parent, unless its first sentence names the rest.
  if (startsWith(work, title)) {
    const rest = work.slice(title.length).join(" ");
    if (!mentionsName(significantTokens(normalizeTitle(leadSentences(full, 1))).join(" "), [rest])) return unsure(`the article is about ${base}, not ${game}`);
  }
  // "Depeche Mode: M" for a Depeche Mode song: another work named after the artist.
  if (piece && !named && startsWith(title, work) && !SERIES_WORD.test(game)) return unsure(`"${page}" is another work named after ${game}`);
  if (piece && !named && SERIES_WORD.test(says) && !SERIES_WORD.test(asked.artist ?? "")) return unsure("a series' article for one game's track, which it never names");
  const kind = (SCREEN_OR_BOOK.exec(qualifier) ?? (/\bgames?\b/i.test(says) ? null : SCREEN_OR_BOOK.exec(says)))?.[0];
  if (piece && !named && kind && !SCREEN_OR_BOOK.test(asked.artist ?? "")) return unsure(`a ${kind.toLowerCase()}'s article that never names the song`);
  return sure("the work's own article");
}

/** Whether a page is a piece of music's own article under another spelling of its title. */
function aboutThePiece(page: string, full: string, piece: string): boolean {
  const base = normalizeTitle(withoutQualifier(page));
  const want = normalizeTitle(piece);
  if (!want || !isPieceArticle(page, full)) return false;
  // Under another name: "Song (also known as Another Song) is a song by...".
  if (mentionsName(normalizeTitle(leadSentences(full, 2)), [want])) return true;
  return editDistance(base.replace(/ /g, ""), want.replace(/ /g, "")) <= Math.max(1, Math.floor(want.length * 0.15));
}

// --- Wikipedia's own summary of the article ------------------------------

/**
 * What Wikipedia's page summary says about an article (the REST endpoint
 * page previews use): the kind of page, and its short description ("2018
 * film directed by ...", "1975 song by Queen").
 */
export interface PageSummary {
  title: string;
  /** "standard" for an article; "disambiguation", "no-extract" or "mainpage" otherwise. */
  type: string;
  description: string;
  extract: string;
}

const SUMMARY_API = "https://en.wikipedia.org/api/rest_v1/page/summary/";
/** Summaries read this session, by title, kept like the articles (null: no such page). */
const summaries = new Map<string, PageSummary | null>();

/** Wikipedia's summary of a page, or null when there is no such page. Throws when it can't be read. */
export async function pageSummary(title: string): Promise<PageSummary | null> {
  if (summaries.has(title)) return summaries.get(title) ?? null;
  const res = await fetch(SUMMARY_API + encodeURIComponent(title.replace(/ /g, "_")), {
    signal: AbortSignal.timeout(config.groundingTimeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited("summary");
  if (!res.ok && res.status !== 404) throw new Error(`summary HTTP ${res.status}`);
  const data = res.ok ? ((await res.json()) as { title?: string; type?: string; description?: string; extract?: string }) : null;
  const summary = data ? { title: data.title ?? title, type: data.type ?? "", description: data.description ?? "", extract: data.extract ?? "" } : null;
  summaries.set(title, summary);
  if (summaries.size > MAX_ARTICLE_TEXTS) summaries.delete(summaries.keys().next().value as string);
  return summary;
}

/** What a short description calls its subject, by the kind word nearest its end before "by", "from", a comma... */
export type DescribedKind = "song" | "album" | "person" | "tv" | "book" | "series" | "game" | "film" | "other";
const DESCRIBED: Array<[DescribedKind, RegExp]> = [
  ["tv", /\b(?:(?:television|tv|anime|web|animated|streaming) (?:series|shows?|programmes?|programs?|films?|specials?)|sitcoms?|miniseries|television)\b/gi],
  ["book", /\b(?:(?:light )?novels?|novellas?|books?|manga(?: series)?|comics?|comic books?|graphic novels?|short stor(?:y|ies)|poems?|(?:novel|book|comic) series)\b/gi],
  ["series", /\b(?:series|franchise)\b/gi],
  ["game", /\b(?:video )?games?\b/gi],
  ["film", /\b(?:films?|movies?|documentar(?:y|ies))\b/gi],
  ["album", /\b(?:albums?|EPs?|mixtapes?|soundtracks?|scores?|compilations?|discograph(?:y|ies))\b/gi],
  ["song", /\b(?:songs?|singles?|instrumentals?|compositions?|hymns?|anthems?|arias?|ballads?|carols?|pieces?|sonatas?|symphon(?:y|ies)|concert[oi]s?|overtures?|nocturnes?|[eé]tudes?|preludes?|waltz(?:es)?|jingles?|themes?)\b/giu],
  ["person", /\b(?:bands?|singers?|singer-songwriters?|songwriters?|rappers?|musicians?|composers?|pianists?|guitarists?|drummers?|bassists?|violinists?|vocalists?|DJs?|disc jockeys?|producers?|groups?|duo|trio|quartet|orchestras?|ensembles?|choirs?|conductors?|actors?|actresses?|idols?|YouTubers?|entertainers?|performers?|artists?|lyricists?|arrangers?|people|person)\b/gi],
];
const DESCRIPTION_HEAD = /\s(?:by|from|of|for|in|on|at|about|featuring|directed|written|composed|created|developed|published|produced|released|recorded|performed|based|starring|with)\b|[,(;:]/i;

/**
 * The kind of thing a short description names: "2018 film directed by Bryan
 * Singer" is a film, "Japanese video game composer" a person, "studio album
 * by Queen" an album. The kind word that ends last before "by", "from" or a
 * comma wins; a longer one at the same place ("television series") beats a
 * shorter one ("series").
 */
export function describedKind(description: string): DescribedKind {
  const head = description.split(DESCRIPTION_HEAD)[0];
  let best: { kind: DescribedKind; end: number; length: number } | null = null;
  for (const [kind, re] of DESCRIBED) {
    for (const m of head.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!best || end > best.end || (end === best.end && m[0].length > best.length)) best = { kind, end, length: m[0].length };
    }
  }
  return best?.kind ?? "other";
}

const SCREEN_KINDS = new Set<DescribedKind>(["film", "tv", "book", "game"]);

/**
 * Why Wikipedia's summary says the article isn't the requested work, or "":
 * - a disambiguation page, or any page that isn't a standard article;
 * - a page named like the song that Wikipedia describes as a film, a show, a
 *   book, a game, an album or a person ("Bohemian Rhapsody (film)");
 * - a film's, a show's, a book's or a game's article that is not the request's
 *   own work (its game or artist field) and never names the song.
 * The artist's article when the song has one of its own is checked by `summaryGate`.
 */
export function summaryMismatch(summary: PageSummary | null, song: SSLSong, grounding: string, asked: SSLSong = song): string {
  if (!summary) return "";
  if (summary.type === "disambiguation") return "Wikipedia's summary calls it a disambiguation page";
  if (summary.type && summary.type !== "standard") return `Wikipedia's summary calls it a "${summary.type}" page, not an article`;
  const kind = describedKind(summary.description);
  const page = grounding.split("\n")[0];
  const base = normalizeTitle(withoutQualifier(page));
  const { game, track } = resolveGameAndTrack(song);
  const piece = track && normalizeTitle(track) !== normalizeTitle(game) ? normalizeTitle(track) : "";
  const described = `Wikipedia describes "${page}" as "${summary.description}"`;
  if (piece && base === piece && kind !== "song" && kind !== "other" && kind !== "series") return `${described}, not the song`;
  if (!SCREEN_KINDS.has(kind)) return "";
  // The request's own work: its game or artist field, in whole words ("Pokemon Red" in "Pokémon Red and Blue").
  const words = significantTokens(base);
  const own = [game, song.artist ?? "", asked.artist ?? ""].some((n) => {
    const want = significantTokens(normalizeTitle(n));
    return want.length > 0 && (want.every((t) => words.includes(t)) || (words.length > 0 && words.every((t) => want.includes(t))));
  });
  if (own || !piece) return "";
  const full = articleText(page) || grounding.slice(page.length + 1);
  if (/^About this piece:/m.test(grounding) || mentionsName(normalizeTitle(full), [piece])) return "";
  return `${described}, another work that never names the song`;
}

/**
 * The work match after Wikipedia's page summary (`summaryMismatch`): the reason the
 * article may not be the requested work, or "" when the summary doesn't say so or
 * can't be read. On a person's or a band's article for a song, it also asks whether
 * the song has an article of its own ("Song (Some Band song)", "Song (song)", "Song")
 * that describes it as a song naming the artist: then the artist's article is not the song's.
 */
export async function summaryGate(song: SSLSong, grounding: string, asked: SSLSong = song): Promise<string> {
  const page = grounding.split("\n")[0];
  try {
    const summary = await pageSummary(page);
    const why = summaryMismatch(summary, song, grounding, asked);
    if (why || !summary || describedKind(summary.description) !== "person") return why;
    const { game, track } = resolveGameAndTrack(song);
    if (!track || normalizeTitle(track) === normalizeTitle(game)) return "";
    const names = [...new Set([...artistNames(song.artist ?? ""), ...artistNames(asked.artist ?? "")])];
    const blocked = blockedArticles(asked);
    for (const title of [...new Set([`${track} (${withoutQualifier(page)} song)`, `${track} (song)`, track])]) {
      if (title === page) continue;
      const own = await pageSummary(title);
      if (!own || own.type !== "standard" || describedKind(own.description) !== "song" || blocked.has(own.title)) continue;
      if (mentionsName(normalizeTitle(`${own.description} ${own.extract}`), names)) return `the song has an article of its own ("${own.title}"), not "${page}"`;
    }
    return "";
  } catch {
    return "";
  }
}

/** Reference text for the song, or "" when no relevant article exists. */
/** Game tracks already found to have no article of their own. */
const noOwnArticle = new Set<string>();

/**
 * A game's article and, when Wikipedia has one, its music article ("Music of
 * Final Fantasy VIII", "Undertale Soundtrack"). Kept whole, so each of the
 * game's tracks gets a reference built around that track without another
 * download (issue #48).
 */
export interface GameArticles {
  page: string;
  full: string;
  /** `series`: about the whole series, so only used for a track it names. */
  music: { page: string; full: string; series?: boolean } | null;
}
const gameArticles = new Map<string, GameArticles>();

/** Track names too common to search an article for: every game has a "Title Theme". */
const GENERIC_TRACK = /^(opening|ending|theme|main theme|title|title theme|title screen|credits|intro|menu|boss|battle|overworld|prologue|epilogue|finale|stage \d+|level \d+|act \d+|\d+ ?[ap]m)$/i;
const MAX_TRACK_SENTENCES = 4;
const MAX_TRACK_CHARS = 800;

/** The article's sentences that name this track: the only ones certainly about it. */
export function trackSentences(full: string, track: string): string[] {
  const name = normalizeTitle(track);
  if (name.length < 5 || GENERIC_TRACK.test(name)) return [];
  const kept: string[] = [];
  let used = 0;
  for (const raw of full.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const text = raw.trim();
    if (text.length < 30 || text.length > 320 || /^=+/.test(text) || brokenBySplit(text)) continue;
    if (!mentionsName(normalizeTitle(text), [name])) continue;
    if (kept.length >= MAX_TRACK_SENTENCES || used + text.length > MAX_TRACK_CHARS) break;
    kept.push(text);
    used += text.length + 1;
  }
  return kept;
}

/** Words that make a sentence about music: a name in one is a piece's, not a weapon's, a level's or an everyday word's. */
const MUSIC_CONTEXT =
  /\b(music\w*|songs?|singles?|tracks?|themes?|soundtracks?|scor(?:e|es|ed|ing)|compos\w*|melod(?:y|ies|ic)|tunes?|pieces?|albums?|arrange\w*|remix\w*|instrumentals?|lyrics?|sung|sings?|ballads?|anthems?|BGM|chart\w*)\b/i;

/**
 * Whether an article names the piece as music, in a sentence about music.
 * Its name alone isn't enough: "from working alone" doesn't name Heart's
 * "Alone", and the whip called the "Vampire Killer" isn't the track.
 */
export function namesPiece(full: string, piece: string): boolean {
  const name = normalizeTitle(piece);
  if (!name || GENERIC_TRACK.test(name)) return false;
  return full.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u).some((s) => MUSIC_CONTEXT.test(s) && mentionsName(normalizeTitle(s), [name]));
}

/**
 * "Punch-Out!! (1984 video game)" when the search also found "Punch-Out!!
 * (1987 video game)" or "Punch-Out!!": one of several works of that name,
 * told apart by a year the request doesn't give.
 */
export function oneOfSeveral(title: string, titles: string[], game: string): boolean {
  const year = /\b(?:19|20)\d\d\b/.exec(qualifierOf(title) ?? "")?.[0];
  if (!year || game.includes(year)) return false;
  const base = normalizeTitle(title);
  return titles.some((t) => t !== title && normalizeTitle(t) === base);
}

/** An article's opening that says it's about a game: "a 1992 platform game". */
const GAME_LEAD = /\b(video|role-playing|platform|action|adventure|puzzle|rhythm|fighting|racing|strategy|simulation)[- ](?:[\w-]+ )?games?\b/i;

/** A film's, a show's or a book's page by its brackets: "Some Game 2 (film)", "Some Game (2019 TV series)". */
export function isScreenPage(title: string): boolean {
  const q = qualifierOf(title);
  return !!q && SCREEN_OR_BOOK.test(q) && !/\bgames?\b/i.test(q);
}

/**
 * The game's own page among these matches, for a track when the best match is
 * a film's, a show's or a book's of the same name: "Some Game 2 (film)" can rank
 * above "Some Game 2". Bare or "(video game)" only: "Some Game 2 (8-bit video
 * game)" is another game.
 */
export function gameInsteadOfScreen(page: string, matches: string[]): string | null {
  if (!isScreenPage(page)) return null;
  return matches.find((t) => t !== page && /^(?:(?:video )?game)?$/i.test(qualifierOf(t) ?? "")) ?? null;
}

/** Whether a title is the music article for this game or its series. */
export function isMusicArticleFor(title: string, game: string): boolean {
  const g = normalizeTitle(game);
  const of = /^Music of (?:the )?(.+?)(?: series)?$/i.exec(title);
  if (of) {
    const subject = normalizeTitle(of[1]);
    // The game itself, or the series it belongs to: "Sonic the Hedgehog" for "Sonic the Hedgehog 3".
    return subject.length >= 2 && (g === subject || g.startsWith(`${subject} `));
  }
  const album = /^(.+?)(?: Original)? Soundtrack$|^(.+?) \(soundtrack\)$/i.exec(title);
  return Boolean(album && normalizeTitle(album[1] ?? album[2]) === g);
}

/** Whether a music article is about this very game, not the series it belongs to. */
const isThisGames = (title: string, game: string) =>
  normalizeTitle(title.replace(/^Music of (?:the )?/i, "").replace(/ series$| (?:Original )?Soundtrack$| \(soundtrack\)$/i, "")) === normalizeTitle(game);

/** After a game's name, a word that makes it another game or the series: "Some Quest 2", "Some Quest series". */
const ANOTHER_ENTRY = /^(?:\d+\w*|i{2,3}|iv|vi{0,3}|ix|x|series|franchise|games|video|media|universe|saga|collection|trilogy)$/;

/**
 * Whether normalized text names this game itself, not a sequel or the series
 * named after it. `others`: other games' names (normalized) that begin with
 * this one's, such as the article's section headings ("Some Quest Zero").
 */
export function namesThisGame(normalizedText: string, game: string, others: string[] = []): boolean {
  const g = normalizeTitle(game);
  if (!g) return false;
  const words = ` ${normalizedText} `;
  for (let at = words.indexOf(` ${g} `); at >= 0; at = words.indexOf(` ${g} `, at + 1)) {
    const after = words.slice(at + 1);
    const next = words.slice(at + g.length + 2).split(" ")[0];
    if (!ANOTHER_ENTRY.test(next) && !others.some((o) => after.startsWith(`${o} `))) return true;
  }
  return false;
}

/** "The music for Some Studio's Some Quest video game series": the music of a series, named right after "music of/for". Not "composed by regular series composer". */
const SERIES_MUSIC = /\b(?:music|soundtracks?|scores?|songs) (?:of|for|from) (?:(?:\p{Lu}[\p{L}\p{N}'’:&.-]*|\d+|the|video|game|media|and|of) ){0,8}(?:series|franchise)\b/u;

/**
 * Whether an article is about a whole series' music, not one game's: a
 * "Music of" or series page named for something other than the game, one
 * whose first sentence is about a series' or franchise's music, or one with
 * a section per game ("Some Quest 2 (1992)", "Some Quest 3 (1994)"). The
 * first game often shares the series' name, so the title alone can't tell.
 */
export function isSeriesWide(page: string, full: string, game: string): boolean {
  const g = normalizeTitle(game);
  if (!g) return false;
  const named = /^Music of (?:the )?(.+?)(?: series)?$/i.exec(page)?.[1] ?? /^(.+?) (?:series|franchise)$/i.exec(page)?.[1];
  if (named && normalizeTitle(named) !== g) return true;
  if (!named && !/\b(soundtracks?|music|score)\b/i.test(page)) return false;
  const first = full.split(/(?<=[.!?])\s+/)[0] ?? "";
  if (SERIES_MUSIC.test(first)) return true;
  const perGame = new Set([...full.matchAll(/^==+\s*(.+?)\s*\(\d{4}\)\s*==+\s*$/gm)].map((m) => normalizeTitle(m[1])));
  return perGame.size >= 3;
}

/**
 * A series-wide music article cut to what is about this game: its own
 * section (and subsections) whole, and elsewhere only sentences that name
 * the game itself or the track. Kept sections are flattened to one level, so
 * a game's section under "History" isn't read as narrative. With fewer than
 * 2 such sentences, the lead alone: the series' introduction, nothing about
 * another game. Otherwise a 3B fills captions about the series' other games
 * (FRESH test: a later game's composers shown for the first game's track).
 */
export function seriesScope(full: string, game: string, track: string): string {
  const g = normalizeTitle(game);
  const t = normalizeTitle(track);
  const trackNamed = t.length >= 5 && !GENERIC_TRACK.test(t);
  const [leadText, ...rest] = full.split(/\n(?===)/);
  // Other games whose names begin with this one's: "Some Quest Zero" for "Some Quest".
  const others = [...full.matchAll(/^==+\s*([^=\n]+?)\s*==+\s*$/gm)].map((m) => normalizeTitle(m[1])).filter((h) => h.startsWith(`${g} `));
  const keeps = (s: string) => namesThisGame(normalizeTitle(s), game, others) || (trackNamed && mentionsName(normalizeTitle(s), [t]));
  const lead = sectionSentences(leadText).filter(keeps);
  const parts: string[] = [];
  let kept = lead.length;
  const open: Array<{ level: number; ours: boolean }> = [];
  for (const chunk of rest) {
    const h = /^(==+)\s*([^=\n]+?)\s*==+\s*\n?([\s\S]*)$/.exec(chunk);
    if (!h) continue;
    const level = h[1].length;
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const ours = normalizeTitle(h[2]) === g || Boolean(open[open.length - 1]?.ours);
    open.push({ level, ours });
    if (SKIP_HEADING.test(h[2].trim())) continue;
    const sentences = sectionSentences(h[3]).filter((s) => ours || keeps(s));
    if (!sentences.length) continue;
    kept += sentences.length;
    parts.push(`== ${h[2]} ==\n${sentences.join(" ")}`);
  }
  if (kept < 2) return leadText.trim();
  return [lead.join(" "), ...parts].filter(Boolean).join("\n\n");
}

/**
 * The game's music article, or null. One search. The game's own article is
 * taken as it is; a series-wide one ("Music of the Final Fantasy series")
 * only when it names this track, since most of it is about other games.
 */
async function findMusicArticle(game: string, usable: (title: string) => boolean): Promise<GameArticles["music"]> {
  const fits = (t: string) => usable(t) && isMusicArticleFor(t, game);
  let titles = (await wikiSearch(`Music of ${game}`)).filter(fits);
  if (!titles.length) titles = (await wikiSearch(`${game} soundtrack`)).filter(fits);
  // The game's own article first, then its series'.
  for (const page of [...titles.filter((t) => isThisGames(t, game)), ...titles.filter((t) => !isThisGames(t, game))].slice(0, 2)) {
    const full = await wikiExtract(page);
    if (!full || full.length < MIN_CONTEXT_CHARS) continue;
    // "Sonic the Hedgehog (soundtrack)" is the 2020 film's album, not the game's music.
    const lead = full.slice(0, 500);
    if (/\b(film|movie|television series|TV series)\b/i.test(lead) && !/\bvideo games?\b/i.test(lead)) continue;
    return { page, full, series: !isThisGames(page, game) };
  }
  return null;
}

/** Section headings that are a kind of section, not the name of a part of a soundtrack. */
const GENERIC_SECTION =
  /^(?:background|development|composition|production|recording|releases?|reception|critical|commercial|legacy|references|notes|external|see also|track listings?|personnel|credits|charts?|certifications?|awards?|accolades|overview|history|music|soundtracks?|albums?|singles|eps|other|musicology|instrumentation|motifs?|themes?|style|influences?|bibliography|further|sales|live|concerts?|creation|concept|writing|lyrics|cast|plot|synopsis|gameplay|setting|story|characters|marketing|reviews?|impact|cover|versions?|remix(?:es)?|formats?|editions?|arrangements?)\b/i;

/** The sections of an article: heading, level, and the lines it runs over, subsections included. */
function sectionsOf(lines: string[]): Array<{ heading: string; quoted: boolean; level: number; from: number; to: number }> {
  const heads = lines.flatMap((line, i) => {
    const h = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line);
    const quoted = h ? /^["“].*["”]$/.test(h[2]) : false;
    return h ? [{ heading: h[2].replace(/^["“](.*)["”]$/, "$1"), quoted, level: h[1].length, from: i, to: lines.length }] : [];
  });
  for (const [n, h] of heads.entries()) {
    const next = heads.slice(n + 1).find((o) => o.level <= h.level);
    if (next) h.to = next.from;
  }
  return heads;
}

/**
 * The part of a soundtrack article a track belongs to, when the track names
 * it: "Fontaine: Remuria" is from the Fontaine section of "Music of Genshin
 * Impact". Returns the article cut to its lead and that section, and the
 * article's other parts ("Mondstadt", "Liyue"), which a caption for this track
 * must not name. Null unless the track names one part and the article has at
 * least two others.
 *
 * A track named for something the article never mentions ("Ganyu: Radiant
 * Dreams", "Raiden Shogun: Awake From A Nightmare") belongs to a part no one
 * can tell: the article is cut to its lead and its general sections (how the
 * music is built, reception), the heading is empty, and every part is
 * another part. Otherwise Mondstadt, which comes first, filled a Liyue
 * character's captions (second fact check).
 */
export function soundtrackPart(full: string, track: string): { heading: string; text: string; others: string[] } | null {
  const lines = withoutVideoSections(full).split("\n");
  const parts = sectionsOf(lines).filter((s) => !GENERIC_SECTION.test(s.heading) && s.heading.split(/\s+/).length <= 5);
  const name = ` ${normalizeTitle(track)} `;
  const matched = parts
    .filter((s) => normalizeTitle(s.heading).length >= 4 && name.includes(` ${normalizeTitle(s.heading)} `))
    .sort((a, b) => b.heading.length - a.heading.length)[0];
  if (!matched) return unknownPart(lines, parts, track);
  // Its own subsections and the sections it sits in aren't other parts.
  // A quoted heading is one track ("Main Theme"), which any part's caption may mention.
  const others = parts.filter((s) => !s.quoted && !(s.from >= matched.from && s.to <= matched.to) && !(s.from <= matched.from && s.to >= matched.to));
  if (others.length < 2) return null;
  const lead = lines.slice(0, lines.findIndex((l) => /^==/.test(l))).join("\n").trim();
  const section = lines.slice(matched.from, matched.to).join("\n");
  return { heading: matched.heading, text: `${lead}\n\n${section}`, others: [...new Set(others.map((s) => s.heading))] };
}

/** The lead and general sections of a soundtrack article in parts, for a "Name: Title" track whose name it never mentions. */
function unknownPart(lines: string[], parts: ReturnType<typeof sectionsOf>, track: string): { heading: string; text: string; others: string[] } | null {
  const prefix = /^([^:]{3,}):\s*\S/.exec(track)?.[1];
  const named = parts.filter((s) => !s.quoted);
  // Only an article about a soundtrack in parts: a composer's article has sections too ("Sonata in A Major, K. 331: i. Andante").
  const lead = lines.slice(0, Math.max(0, lines.findIndex((l) => /^==/.test(l)))).join(" ");
  if (!prefix || !/\b(soundtracks?|score)\b/i.test(lead) || named.filter((s) => s.level === 2).length < 3) return null;
  if (mentionsName(normalizeTitle(lines.join(" ")), [normalizeTitle(prefix)])) return null;
  const text = lines.filter((_, i) => !named.some((s) => i >= s.from && i < s.to)).join("\n").trim();
  return { heading: "", text, others: [...new Set(named.map((s) => s.heading))] };
}

/** The other parts of the soundtrack a reference was cut from, which captions for this track mustn't name. */
export function otherParts(text: string, track: string): string[] {
  const full = articleText(text.split("\n")[0]);
  return full ? (soundtrackPart(full, track)?.others ?? []) : [];
}

/** Any section that isn't a list of tracks, credits or references. */
const NOT_A_LIST = /^(?!.*(track listing|personnel|credits|chart|certification|reference|external|see also|notes)).+$/i;
/** In a music article, how the music was made comes before the lists of albums and releases. */
const MAKING_OF_MUSIC = /creation|development|concept|influence|composition|writing|recording|background|overview|production|style|themes/i;

/**
 * The reference for one track of a game: what the article says about this
 * very track first, then the usual ordering. Built from the music article
 * when there is one, since the game's article is mostly about the game.
 */
export function gameTrackText(a: GameArticles, track: string, usable: (title: string) => boolean = () => true, game = ""): string {
  const fits = a.music && usable(a.music.page) && (!a.music.series || trackSentences(a.music.full, track).length > 0);
  const fromMusic = Boolean(fits && a.music);
  let base = fits && a.music ? a.music : a;
  // A series-wide music article: only what is about this game ("Music of Some Quest" for "Some Quest", the first of several).
  const name = game || a.page.replace(/\s*\([^)]*\)\s*$/, "");
  if (seriesFilter.on && base.full && ((fromMusic && a.music?.series) || isSeriesWide(base.page, base.full, name))) {
    base = { ...base, full: seriesScope(base.full, name, track) };
  }
  // "Liyue: Relaxation in Liyue" from "Music of Genshin Impact": the lead and the Liyue section, nothing about Mondstadt.
  const part = soundtrackPart(base.full, track);
  const full = part ? part.text : withoutVideoSections(base.full);
  // With section-aware selection, a narrative section's sentence about this piece counts only when it's about its music.
  // And only a sentence about music is said to be about the piece: "Castlevania" names the MSX game and the whip "Vampire Killer" too.
  const about = trackSentences(sectionSelection.on ? selectedText(full, [track]) : full, track).filter((s) => MUSIC_CONTEXT.test(s));
  const block = about.length ? `About this piece: ${about.join(" ")}\n\n` : "";
  const budget = MAX_CONTEXT_CHARS - base.page.length - 1 - block.length;
  const picked = sectionSelection.on ? sectionExtract(full, budget, [track], new Set(about)) : "";
  if (picked) return `${base.page}\n${block}${picked}`;
  if (part) return `${base.page}\n${block}${orderExtract(full, budget, [track], true, NOT_A_LIST)}`;
  let body = orderExtract(base.full, budget, [track], fromMusic, fromMusic ? MAKING_OF_MUSIC : MUSIC_HEADING);
  // A music article with no section on how the music was made: take its other sections, bar the lists.
  if (fromMusic && body.length < MIN_CONTEXT_CHARS * 2) body = orderExtract(base.full, budget, [track], true, NOT_A_LIST);
  return `${base.page}\n${block}${body}`;
}

// --- Other readings of a request -----------------------------------------

/**
 * One way to look a request up: the subject (`game`: a game, film, show,
 * series or artist) and the piece (`track`).
 * - `songAlone`: a song by no one in particular, looked up by its title alone.
 * - `notGame`: the subject is a film or a show, never a video game.
 * - `trackOnly`: only the piece's own article will do, never the subject's:
 *   the name may be an arranger's or a fellow musician's.
 * - `page`: Wikipedia said which article the subject's name means; no other
 *   article about the subject will do.
 * - `aPerformer`: one of several names in the credit: the subject's own
 *   article must be a performer's ("Black Caviar" is a racehorse too).
 * - `fromTitle`: the work was read from the title, the artist being someone
 *   else ("Gerudo Valley - Ocarina of Time" by a remixer): the subject's
 *   article must be a game's, a film's or a show's, never a person's or a song's.
 */
export interface Reading {
  game: string;
  track: string;
  page?: string;
  songAlone?: boolean;
  notGame?: boolean;
  trackOnly?: boolean;
  fromTitle?: boolean;
  aPerformer?: boolean;
  /** Read from the song with its list notes dropped (`lookupForm`): cached apart from the reading as listed. */
  cleaned?: boolean;
}

/** An artist field naming a kind of work: "Star Trek TV", "NieR Series", "Super Mario Franchise". */
const CATEGORY_ARTIST = /^(.+?)\s+(series|franchise|games|tv|tv series|tv shows?|movies|films)$/i;
/** Films and shows: their works are never video games. */
const SCREEN_CATEGORY = /^(tv|tv series|tv shows?|movies|films)$/i;
/** Artist fields that name no one: "Traditional", "Italian Folk Song", "Anonymous". */
const NO_ONE = /^(?:traditional|trad\.?|anonymous|anon\.?|unknown|(?:\p{L}+\s+)?folk(?:\s+(?:song|tune|melody))?)$/iu;
/** "Elton John arr. Brent Edstrom", "Arr. Handel Halvorsen": who arranged a piece isn't who wrote it. */
const ARRANGER = /^\s*arr(?:\.|anged by)?\s+|\s+(?:arr(?:\.|anged by)?|arrangement by)\s+.*$/i;
/** What joins several names in one credit: "A - B", "A / B", "A ft. B", "A x B". */
const CREDIT_JOIN = /\s+[-–—]\s+|\s*\/\s*|\s+(?:[Ff]eat\.?|[Ff]t\.?|[Ff]eaturing)\s+|\s+x\s+/;
/** A short tag after the names, a list's own mark ("Some Singer - AB"): never a name to look up. */
const LIST_TAG = /^\p{Lu}{1,2}$/u;
/** Words naming a work's music rather than the work: "Picard Season 1 Theme". */
const THEME_WORDS = /\s+((?:season\s+\d+\s+)?(?:(?:main|opening|ending|end|title|love)\s+)?theme)$/i;

/**
 * "Star Trek II. The Wrath of Khan: Battle At The Mutara Nebula" from "Star
 * Trek Movies": the work is in the title. The title read whole as the work
 * (theme words dropped), then split at a dash or a second colon.
 */
function worksInTitle(franchise: string, title: string, notGame: boolean): Reading[] {
  const m = new RegExp(`^${escapeRe(franchise)}(?=[\\s:])(.*)$`, "i").exec(title);
  if (!m) return [];
  // "II. The Wrath of Khan" is "II: The Wrath of Khan". A tag in brackets names the arrangement, not the work.
  const rest = m[1].replace(/^\s+([IVXL]+|\d+)\.\s+/i, " $1: ").replace(/\s*\[[^\]]*\]\s*$/, "");
  const whole = (franchise + rest).trim();
  const out: Reading[] = [];
  const add = (work: string, track: string) => {
    let w = work.trim();
    let t = track.trim();
    const theme = THEME_WORDS.exec(w);
    if (theme) {
      w = w.slice(0, theme.index);
      t ||= theme[1].replace(/^season\s+\d+\s+/i, "");
    }
    w = w.replace(/\s+season\s+\d+$/i, "").replace(/\s*[-–—:]$/, "").trim();
    // Without a track name of its own, the work's music is "Theme": generic, so nothing in the
    // work's article is taken to be about this one piece.
    if (w && !out.some((r) => r.game === w)) out.push({ game: w, track: t || "Theme", notGame });
  };
  add(whole, "");
  const split = /^(.+?)\s[-–—]\s(.+)$/.exec(whole) ?? /^(.+?:.+?):\s*(.+)$/.exec(whole);
  if (split) add(split[1], split[2]);
  return out;
}

/**
 * The ways to look a request up, most likely first. Usually just the one
 * `resolveGameAndTrack` gives. Song lists also write:
 * - a category for the artist ("Star Trek TV", "NieR Series"): the work named
 *   in the title, then the franchise's own article, never a single installment;
 * - an arranger or a second name ("Elton John arr. Brent Edstrom",
 *   "Frederic Chopin/ButtonPresser7"): each name on its own;
 * - no one ("Traditional", "Italian Folk Song"): the title alone, as a song.
 */
export function readings(song: SSLSong): Reading[] {
  const artist = song.artist?.trim() ?? "";
  const first = resolveGameAndTrack(song);
  if (song.performer || song.artistUncertain) return [first];
  const title = dropVersionTags(song.title.trim());

  const category = CATEGORY_ARTIST.exec(artist);
  if (category) {
    const franchise = category[1];
    const notGame = SCREEN_CATEGORY.test(category[2]);
    const inTitle = worksInTitle(franchise, title, notGame);
    // "Wild World - The Roost" from "Animal Crossing Series" is from "Animal Crossing: Wild World".
    const sep = /^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/.exec(title);
    const installment = !inTitle.length && sep ? [{ game: `${franchise}: ${sep[1]}`, track: sep[2], notGame }] : [];
    // "Aquatic Ambiance (Donkey Kong Country)" from "Super Mario Franchise": a name in brackets
    // may be the game it's really from, so the franchise's article could be the wrong one.
    const series = /\([^)]*\)\s*$/.test(title) ? [] : [{ game: `${franchise} series`, track: title, notGame }];
    return [...inTitle, ...installment, ...series];
  }

  if (hasNoArtist(artist) || NO_ONE.test(artist)) {
    // "Unknown" has long meant "read the title": that comes first.
    return [...(/^unknown$/i.test(artist) ? [first] : []), { game: "", track: title, songAlone: true }];
  }

  const parts = [...new Set(artist.split(CREDIT_JOIN).map((p) => p.replace(ARRANGER, "").trim()).filter(Boolean))];
  const names = parts.some((p) => !LIST_TAG.test(p)) && parts.length > 1 ? parts.filter((p) => !LIST_TAG.test(p)) : parts;
  // "Some Singer - AB" is Some Singer's: a list's own tag is no part of the name.
  const alone = names.length === 1 && names[0].toLowerCase() !== artist.toLowerCase() && parts.length > 1;
  const start = alone ? [{ ...resolveGameAndTrack({ ...song, artist: names[0] }), trackOnly: false }] : [first];
  const others = alone ? [] : names.filter((n) => n.toLowerCase() !== artist.toLowerCase());
  if (names.length <= 1) {
    return [...start, ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false })), ...namedInTitle(title, start[0])];
  }
  // Several names: the song's own article under any of them first ("Can You Feel the Love Tonight"
  // under its third name beats the first name's band), then the work in the title, and only then
  // a name's own article, for a name that reads like a person's and an article about a performer.
  return [
    ...start,
    ...others.map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: true })),
    ...namedInTitle(title, start[0]),
    ...others.filter(looksLikeArtistName).map((name) => ({ ...resolveGameAndTrack({ ...song, artist: name }), trackOnly: false, aPerformer: true })),
  ];
}

/** A year in brackets, "(1979)": when the song came out or was added, not part of its name. */
const YEAR_TAG = /\s*[([]\s*(?:19|20)\d\d\s*[)\]]/g;
/** A featured credit in brackets, "(feat. Some Singer)": another reading's job, not the song's name. */
const FEATURED_TAG = /\s*[([]\s*(?:feat|ft|featuring)\b[^)\]]*[)\]]/gi;
/** A note after the name, closed or not: "(Australian)", "(Cherokee/Irish)", "(LGBTQ+". */
const TRAILING_NOTE = /\s*[([][^)\]]*(?:[)\]]|$)\s*$/;

/**
 * The song as a lookup can read it once a song list's own notes are dropped:
 * brackets after the artist ("Some Band (Australian)"), a year tag or a
 * featured credit in the title. Null when nothing is dropped. Only a lookup
 * tries this, and after the song as listed, so what works today is unchanged;
 * the song itself, shown and kept as listed, is never altered. A bracket that
 * starts a name or sits inside one stays: "(Don't Fear) The Reaper".
 */
export function lookupForm(song: SSLSong): SSLSong | null {
  let artist = (song.artist ?? "").trim();
  for (let m: RegExpExecArray | null; (m = TRAILING_NOTE.exec(artist)) && /\p{L}/u.test(artist.slice(0, m.index)); ) {
    artist = artist.slice(0, m.index).trim();
  }
  const title = song.title.replace(YEAR_TAG, "").replace(FEATURED_TAG, "").trim();
  if (!/\p{L}|\p{N}/u.test(title.replace(/[()[\]]/g, "")) || (title === song.title.trim() && artist === (song.artist ?? "").trim())) return null;
  return { ...song, title, artist };
}

/**
 * What a title names besides the piece, when the artist is someone else (a
 * remixer, a cover band):
 * - the original artist or the work in brackets, "Baby (Justin Bieber)",
 *   "Wind (Naruto)": only the piece's own article, which must name it;
 * - the work after or before a dash, "Gerudo Valley - Ocarina of Time",
 *   "Fire Emblem: Three Houses - Main Theme": the piece's own article, or
 *   the work's, which must be a game's, a film's or a show's.
 */
function namedInTitle(title: string, first: { game: string; track: string }): Reading[] {
  // The usual reading already took the work from the title.
  if (first.track !== title) return [];
  const bracket = /^(.+?)\s*\(([^)]+)\)$/.exec(title);
  if (bracket) return isVariantTag(bracket[2]) ? [] : [{ game: bracket[2].trim(), track: bracket[1].trim(), trackOnly: true }];
  const dash = /^(.+)\s[-–—]\s(.+)$/.exec(title);
  if (!dash || /\s[-–—]\s/.test(dash[1])) return [];
  const [left, right] = [dash[1].trim(), dash[2].trim()];
  return [
    { game: right, track: left, fromTitle: true },
    { game: left, track: right, fromTitle: true },
  ];
}

/** Edit distance: how many letters to add, drop or change to turn one string into the other. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Installment numbers in a title, roman numerals as arabic: "Star Trek II" has 2. */
const numerals = (s: string) => significantTokens(normalizeTitle(s)).filter((t) => /\d/.test(t));

/**
 * The same name spelled differently: a letter or two, in one word, or only
 * the spacing ("Full Metal" and "Fullmetal"). "Eric Satie" and "Erik Satie",
 * but not "Windy Harper" and "Wendy Harmer", two words apart.
 */
export function isRespelling(name: string, page: string): boolean {
  const a = normalizeTitle(name);
  const b = normalizeTitle(page);
  if (!a || !b || a === b) return false;
  // "Memes" isn't a misspelled "Meme": a plural names many, the article one.
  if (a === `${b}s` || b === `${a}s`) return false;
  const d = editDistance(a.replace(/ /g, ""), b.replace(/ /g, ""));
  if (d > 2 || d > a.replace(/ /g, "").length * 0.2) return false;
  if (numerals(name).join(" ") !== numerals(page).join(" ") || numeralStyleDiffers(name, page)) return false;
  const wa = a.split(" ");
  const wb = b.split(" ");
  if (wa.length !== wb.length) return d === 0;
  return wa.filter((w, i) => w !== wb[i]).length <= 1;
}

/** A company's name: "Qumu Corporation", "Some Records", "Some Studios Inc.". */
const COMPANY = /\s(?:corporation|corp\.?|inc\.?|incorporated|company|co\.|ltd\.?|limited|llc|plc|gmbh|records|studios|entertainment|holdings)$/i;

/**
 * Whether a redirect leads to the same thing under its proper name: "Star Wars:
 * The Phantom Menace" to "Star Wars: Episode I – The Phantom Menace", "Red
 * Alert 3" to "Command & Conquer: Red Alert 3". Not to a list, an album or
 * one of several: "Johann Strauss" leads to "Johann Strauss II", and "Honkai
 * Impact" to "Honkai Impact 3rd". A number the request didn't give is only
 * accepted inside the name ("Episode I"), never as its last word.
 */
export function isSameWorkRedirect(from: string, to: string): boolean {
  if (/^List of\b/i.test(to) || /\((?:[^)]*\b)?(album|soundtrack|EP|discography|filmography)\)$/i.test(to)) return false;
  // "FFVII" is "Final Fantasy VII": the initials carry the installment number.
  if (isInitials(from, to)) return true;
  // "Qumu" leads to "Qumu Corporation": a company named the same isn't a musician or a work.
  if (COMPANY.test(to) && !COMPANY.test(from)) return false;
  // "Poirot" leads to "Hercule Poirot" and "Ponce de León" to "Juan Ponce de León": a surname
  // given a first name is one person of that name. A title before a colon is a series name:
  // "Red Alert 3" in "Command & Conquer: Red Alert 3".
  const f = normalizeTitle(from);
  const t = normalizeTitle(to);
  if (t.endsWith(` ${f}`)) {
    const head = withoutQualifier(to);
    if (!/[:–—]\s*$/.test(head.slice(0, Math.max(0, head.length - from.length)))) return false;
  }
  const fromNumbers = numerals(from);
  const toWords = significantTokens(normalizeTitle(to));
  if (/\d/.test(toWords[toWords.length - 1] ?? "") && !fromNumbers.includes(toWords[toWords.length - 1])) return false;
  const fromWords = new Set(significantTokens(normalizeTitle(from)).filter((t) => !/\d/.test(t)));
  return significantTokens(normalizeTitle(to)).some((t) => fromWords.has(t)) || isRespelling(from, to);
}

/**
 * Whether a name is the initials of a title, its installment number kept:
 * "FFVII" and "FF7" are "Final Fantasy VII". Only for a redirect Wikipedia
 * itself keeps, so the abbreviation is its, not a guess.
 */
export function isInitials(short: string, long: string): boolean {
  const s = normalizeTitle(short).replace(/ /g, "");
  if (s.length < 2 || /\s/.test(short.trim())) return false;
  const words = normalizeTitle(long).split(" ").filter(Boolean);
  const forms = (keep: (w: string) => boolean) => {
    const kept = words.filter(keep);
    const num = (w: string) => /^\d+$/.test(w) || w in ROMAN;
    return [kept.map((w) => (num(w) ? w : w[0])).join(""), kept.map((w) => (num(w) ? (ROMAN[w] ?? w) : w[0])).join("")];
  };
  return [...forms(() => true), ...forms((w) => !STOPWORDS.has(w))].includes(s);
}

const wikipediaNames = new Map<string, string | null>();

/**
 * A series' own article, as Wikipedia files it: "Kirby (series)", "Nier
 * (series)" (which leads to "Drakengard and Nier"), "Star Trek (franchise)"
 * (which leads to "Star Trek"). Null when it has none under these titles.
 */
async function seriesPage(name: string): Promise<string | null> {
  const key = `\0series\0${name}`;
  const known = wikipediaNames.get(key);
  if (known !== undefined) return known;
  // Titles are case-sensitive: "NieR" is filed as "Nier".
  const cased = name.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  const forms = [...new Set([name, cased])].flatMap((n) => ["series", "franchise", "media franchise"].map((q) => `${n} (${q})`));
  const resolved = await wikiResolveTitles(forms);
  let found: string | null = null;
  for (const f of forms) {
    const hit = resolved.get(f);
    // "(series)" already says which: a series filed under a longer name still shares its name's words.
    const shares = significantTokens(normalizeTitle(hit?.page ?? "")).some((w) => significantTokens(normalizeTitle(name)).includes(w));
    if (hit && !hit.fragment && !/^List of\b/i.test(hit.page) && (!hit.redirected || shares)) {
      found = hit.page;
      break;
    }
  }
  wikipediaNames.set(key, found);
  return found;
}

/**
 * Wikipedia's own name for a name it files under another one, or null. Its
 * help, not ours: a redirect with that exact title ("Pirates of the Carribean"),
 * else the search's spelling suggestion ("Genshsin Impact" -> "genshin
 * impact"), taken only when it is a respelling, names an article, and that
 * article was among the search's hits (or the search found nothing at all).
 */
async function wikipediaName(name: string): Promise<string | null> {
  if (normalizeTitle(name).length < 3) return null;
  const known = wikipediaNames.get(name);
  if (known !== undefined) return known;
  let found: string | null = null;
  // Titles are case-sensitive: "Manuel da Falla", not "Manuel Da Falla".
  const lowered = name.replace(/(?<=\s)\p{Lu}\p{Ll}{0,2}(?=\s|$)/gu, (w) => w.toLowerCase());
  const variants = [...new Set([name, lowered])];
  const direct = await wikiResolveTitles(variants);
  for (const v of variants) {
    const hit = direct.get(v);
    if (hit?.redirected && !hit.fragment && isSameWorkRedirect(name, hit.page)) {
      found = hit.page;
      break;
    }
  }
  // A page or redirect with this very name: Wikipedia knows it, so it isn't misspelled.
  if (!found && !direct.size) {
    const { titles, suggestion } = await wikiSearchSuggestion(name);
    const wanted = normalizeTitle(name);
    if (suggestion && !titles.some((t) => normalizeTitle(t) === wanted)) {
      const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
      // The suggestion comes in lowercase: cased like the request's words first ("Pirates of the Caribbean").
      const words = name.split(/\s+/);
      const asWritten = suggestion.split(" ").map((w, i) => (/^\p{Lu}/u.test(words[i] ?? "") ? upper(w) : w)).join(" ");
      const forms = [...new Set([upper(asWritten), upper(suggestion), suggestion.split(" ").map(upper).join(" ")])];
      const resolved = await wikiResolveTitles(forms);
      for (const f of forms) {
        const hit = resolved.get(f);
        if (hit && !hit.fragment && isRespelling(name, hit.page) && (!titles.length || titles.includes(hit.page))) {
          found = hit.page;
          break;
        }
      }
    }
  }
  wikipediaNames.set(name, found);
  if (found) console.log(`[Grounding] Wikipedia calls "${name}" "${found}"`);
  return found;
}

/**
 * The song's own article, read for a reference. When its sections have names
 * the usual ordering doesn't look for ("Origin", "Form"), it would keep little
 * more than the lead: then every section but the lists is read instead.
 */
export function ownArticleExtract(full: string, budget: number, names: string[]): string {
  const extract = orderExtract(full, budget, names);
  return extract.length >= MIN_CONTEXT_CHARS ? extract : orderExtract(full, budget, names, true, NOT_A_LIST);
}

/** What a song is, in its article's opening: "a traditional English folk song". */
const SONG_WORDS = /\b(song|ballad|hymn|carol|tune|melody|lullaby|anthem|folk ?song|canzone|chanson)s?\b/i;

/**
 * A song by no one in particular ("Traditional", "Italian Folk Song"): its
 * own article, found by its title alone, and only when the article opens by
 * calling it a song. "Santa Lucia" is also a town and a saint.
 */
async function groundSongAlone(song: SSLSong, title: string, usable: (title: string) => boolean): Promise<Grounded> {
  const key = `\0alone\0${normalizeTitle(title)}`;
  const hit = groundingCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS) && (!hit.text || usable(hit.text.split("\n")[0]))) return { text: hit.text, unreachable: false };
  const tried = new Set<string>();
  try {
    for (const term of [`${title} song`, title]) {
      const titles = (await wikiSearch(term)).filter((t) => usable(t) && !tried.has(t) && isRelevantArticle(title, t));
      // "Santa Lucia (song)" before "Santa Lucia".
      for (const page of [...titles.filter((t) => /\((?:[^)]*\b)?song\)$/i.test(t)), ...titles.filter((t) => !/\((?:[^)]*\b)?song\)$/i.test(t))]) {
        tried.add(page);
        const full = await wikiExtract(page);
        if (!full || !SONG_WORDS.test(full.slice(0, 300))) {
          console.log(`[Grounding] "${page}" isn't about a song, skipping`);
          continue;
        }
        const extract = ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [title]);
        if (extract.length < MIN_CONTEXT_CHARS) continue;
        const text = `${page}\n${writingText(full, extract, MAX_CONTEXT_CHARS - page.length - 1, [title])}`;
        console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars, the song by its title alone)`);
        groundingCache.set(key, { text, at: Date.now() });
        return { text, unreachable: false };
      }
    }
  } catch (err) {
    if (err instanceof RateLimited) return { text: "", unreachable: true };
    console.warn(`[Grounding] Lookup failed for "${title}": ${err instanceof Error ? err.message : err}`);
    return { text: "", unreachable: true };
  }
  console.log(`[Grounding] No reference for "${song.title}" by its title alone`);
  groundingCache.set(key, { text: "", at: Date.now() });
  return { text: "", unreachable: false };
}

// --- Classical works through Wikidata (issue #260) -------------------------

/**
 * Articles found for a classical piece through its Wikidata item, by page and
 * request: its own (`section` null), or its parent work's, with or without a
 * section about the piece. `workMatchConfidence` reads it.
 */
const classicalPages = new Map<string, { section: boolean | null }>();
const classicalKey = (page: string, title: string) => `${page}\0${normalizeTitle(dropVersionTags(title))}`;

/** Words that say how a piece is numbered or what key it's in, not what it's called. */
const NOT_A_NAME_WORD = new Set(["in", "major", "minor", "sharp", "flat", "op", "opus", "no", "nr", "nos", "bwv", "kv", "hob", "rv", "hwv", "woo", "the", "an", "of", "and", "for", "from", "la", "le", "les", "el", "der", "die", "das"]);

/** The words of a piece's name: no numbers, keys, catalog words or roman numerals. */
export function nameWords(s: string): string[] {
  return normalizeTitle(normalizeKeys(s))
    .split(" ")
    .filter((w) => w.length > 1 && !/\d/.test(w) && !NOT_A_NAME_WORD.has(w) && !(w in ROMAN));
}

/** The key a name gives, spelled "c sharp minor", or "". */
function keyIn(s: string): string {
  const t = normalizeTitle(normalizeKeys(s));
  return /(?:^| )([a-g](?: sharp| flat)? (?:major|minor))(?= |$)/.exec(t)?.[1] ?? /(?:^| )in ([a-g](?: sharp| flat)?)(?= |$)/.exec(t)?.[1] ?? "";
}

const numbersOf = (s: string): string[] => [...(normalizeTitle(s).match(/\d+/g) ?? [])];

/** Whether a request is specific enough to name one work: not a bare "Prelude" or "Nocturne". */
export function namesOneWork(parsed: ClassicalTitle): boolean {
  if (parsed.numbers.length || parsed.key) return true;
  return [...nameWords(parsed.name), ...nameWords(parsed.alias)].some((w) => !FORM_WORDS.test(w));
}

/**
 * Whether a work's Wikidata item is the piece a request names: every number
 * the request gives is among the item's (in its names or catalog codes), a
 * key it names agrees, and one of its names (label, alias, nickname) holds
 * the request's words, or the request holds all of the name's ("Alla Turca"
 * in "Rondo Alla Turca"). Without `strict`, a catalog code the item has is
 * enough ("BWV 1007 Prelude": the request's word names a movement).
 * Returns how it matched, or "".
 */
export function workFits(item: WorkItem, parsed: ClassicalTitle, strict = false): WorkFit {
  const nums = new Set([...item.names, ...item.catalogs].flatMap(numbersOf));
  if (!parsed.numbers.every((n) => nums.has(n))) return !strict && setOfThePiece(item, parsed, nums) ? "set" : "";
  if (parsed.key) {
    const want = normalizeTitle(normalizeKeys(parsed.key));
    const keys = item.names.map(keyIn).filter(Boolean);
    if (keys.length && !keys.some((k) => k === want || (!/major|minor/.test(want) && k.startsWith(`${want} `)))) return "";
  }
  const covers = (req: string[]) =>
    req.length > 0 &&
    item.names.some((n) => {
      const w = nameWords(n);
      return req.every((x) => w.includes(x)) || (w.length >= 2 && w.every((x) => req.includes(x)));
    });
  // "Le cygne" (alias "The Swan") over "The Dying Swan": a name with no other words.
  const exactly = (req: string[]) => req.length > 0 && item.names.some((n) => sameWords(nameWords(n), req));
  if (exactly(nameWords(parsed.name)) || exactly(nameWords(parsed.alias))) return "exact";
  if (covers(nameWords(parsed.name)) || covers(nameWords(parsed.alias))) return "name";
  if (strict || !parsed.catalogs.length) return "";
  // In strict mode (a performer's piece, by its title alone) only a name will do.
  // "BWV 1007" is filed as "1007", with the catalog as a qualifier.
  const codes = parsed.catalogs.map((c) => c.split(" ").slice(1).join(" ").toLowerCase());
  const has = item.catalogs.some((c) => c.toLowerCase().split(/[\s,/]+/).some((x) => codes.includes(x)));
  return has ? "catalog" : "";
}

/** How a work's item fits a request: its name exactly, a name holding the request's words, the set the numbered piece is in, or its catalog code. */
export type WorkFit = "exact" | "name" | "set" | "catalog" | "";
const FIT_ORDER: Array<Exclude<WorkFit, "">> = ["exact", "name", "set", "catalog"];
const sameWords = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
/** Words that count a set's pieces: "Two Arabesques", "Deux arabesques". */
const COUNT_WORDS = new Set(["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twelve", "deux", "trois", "quatre", "cinq", "sept", "huit", "set"]);

/**
 * Whether an item is the set a numbered piece belongs to: "Two Arabesques"
 * for "Arabesque No. 1", "Nocturnes, Op. 9" for "Nocturne Op. 9 No. 2". Its
 * name is the request's in the plural, and its catalog numbers are the request's.
 */
function setOfThePiece(item: WorkItem, parsed: ClassicalTitle, nums: Set<string>): boolean {
  const req = nameWords(parsed.name);
  if (!req.length || !parsed.numbers.length || !parsed.catalogs.flatMap(numbersOf).every((n) => nums.has(n))) return false;
  return item.names.some((n) => {
    const words = nameWords(n).filter((w) => !COUNT_WORDS.has(w));
    const singular = words.map((w) => (w.endsWith("s") && req.includes(w.slice(0, -1)) ? w.slice(0, -1) : w));
    return singular.some((w, i) => w !== words[i]) && sameWords(singular, req);
  });
}

/**
 * The work a request names among search hits, by the best way any fits.
 * Several works fitting as well is a guess, so none is taken ("Mazurka in F
 * minor" is one of three: they come back `tied`), unless only one has an
 * article, or all lead to the same article (two items for one piece); a part
 * beats the whole it is in, and an item with no article and no parent leads nowhere.
 */
export function pickWork(items: WorkItem[], parsed: ClassicalTitle, strict = false): { work: WorkItem; by: Exclude<WorkFit, ""> } | { tied: WorkItem[]; by: Exclude<WorkFit, ""> } | null {
  const fits = items.map((work) => ({ work, by: workFits(work, parsed, strict) })).filter((f) => f.by);
  for (const by of FIT_ORDER) {
    let at = fits.filter((f) => f.by === by).map((f) => f.work);
    at = at.filter((w) => !at.some((o) => o !== w && o.parents.includes(w.id)));
    const leads = at.filter((w) => w.page || w.parents.length);
    if (leads.length) at = leads;
    if (!at.length) continue;
    const paged = at.filter((w) => w.page);
    const leadsTo = (w: WorkItem) => w.page || w.parents[0];
    const one = at.length === 1 || at.every((w) => leadsTo(w) === leadsTo(at[0])) ? at[0] : paged.length === 1 ? paged[0] : null;
    return one ? { work: one, by } : { tied: at, by };
  }
  return null;
}

/**
 * One of several works that fit as well, when only one of them leads to an
 * article through the works it is part of: "Dance of the Sugar Plum Fairy" in
 * "The Nutcracker pas de deux" (in "The Nutcracker") and again in a "Nutcracker
 * Suite" item with no article. Several articles, or none, is a guess: null.
 */
async function breakTie(tied: WorkItem[], parsed: ClassicalTitle): Promise<WorkItem | null> {
  if (!tied.some((w) => w.page)) {
    const parents = await workItems([...new Set(tied.flatMap((w) => w.parents))].slice(0, 10));
    const grand = await workItems([...new Set(parents.filter((p) => !p.page).flatMap((p) => p.parents))].slice(0, 10));
    const pageOf = (id: string): string => {
      const p = [...parents, ...grand].find((x) => x.id === id);
      return p ? p.page || p.parents.map(pageOf).find(Boolean) || "" : "";
    };
    const leads = tied.map((w) => ({ w, to: w.parents.map(pageOf).find(Boolean) ?? "" })).filter((x) => x.to);
    if (leads.length && leads.every((x) => x.to === leads[0].to)) return leads[0].w;
  }
  console.log(`[Grounding] Several works fit "${parsed.name}": ${tied.map((w) => w.label || w.id).join(", ")}, taking none`);
  return null;
}

/** What to search Wikidata for: the title with its numbers, then without the key, then its other name, its catalog code or its name alone. */
export function workQueries(parsed: ClassicalTitle): string[] {
  const numbered = parsed.numbers.filter((n) => !parsed.catalogs.some((c) => numbersOf(c).includes(n))).map((n) => `No. ${n}`);
  const plain = [parsed.name, ...parsed.catalogs, ...numbered].filter(Boolean).join(" ");
  // Wikidata's search wants every word: "Arabesque No. 1" finds nothing where "Arabesque" finds the set.
  const out = [parsed.key ? `${plain} ${parsed.key}` : plain, plain, parsed.alias, parsed.catalogs.join(" "), parsed.name];
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))].slice(0, 3);
}

/**
 * The section of a parent work's article about one piece: its heading holds
 * one of the piece's names, or a name holds the heading's words, and any
 * number in the heading is the piece's ("Suite No. 1 in G major, BWV 1007",
 * not "Suite No. 2"). In a set, a heading of only the piece's number ("No. 2
 * in E♭ major") or one that starts with it ("1. Andantino con moto") counts.
 * Generic sections (Background, Reception) never count.
 */
export function pieceSection(full: string, names: string[], numbers: string[]): { heading: string; text: string } | null {
  const lines = withoutVideoSections(full).split("\n");
  const own = new Set([...numbers, ...names.flatMap(numbersOf)]);
  // The piece's place in its set: "No. 2".
  const position = new Set(names.flatMap((n) => [...n.matchAll(/\b(?:no|nr)\.?\s*(\d+)/gi)].map((m) => m[1])));
  for (const s of sectionsOf(lines)) {
    if (GENERIC_SECTION.test(s.heading)) continue;
    const hw = nameWords(s.heading);
    const hn = numbersOf(s.heading);
    if (!hn.every((n) => own.has(n))) continue;
    const lead = /^(\d+|[IVX]+)\.\s/.exec(s.heading)?.[1];
    const at = lead ? (ROMAN_NUMBER[lead.toLowerCase()] ?? Number(lead)).toString() : "";
    const named =
      (hw.length === 0 && hn.length > 0 && hn.every((n) => position.has(n))) ||
      (!!at && position.has(at)) ||
      names.some((n) => {
        const nw = nameWords(n);
        return (hw.length > 0 && hw.every((x) => nw.includes(x))) || (nw.length > 0 && nw.every((x) => hw.includes(x)));
      });
    if (!named) continue;
    const body = lines.slice(s.from + 1, s.to).filter((l) => !/^==/.test(l)).join("\n").trim();
    if (body.length >= 80) return { heading: s.heading, text: body };
  }
  return null;
}

/** The section of a piece's article about one movement: "III. Presto agitato", "Third movement", "Variation 18". */
export function movementSection(full: string, movement: NonNullable<ClassicalTitle["movement"]>): { heading: string; text: string } | null {
  const lines = withoutVideoSections(full).split("\n");
  const ordinal = Object.entries(ORDINAL_WORDS).find(([, n]) => n === movement.n)?.[0];
  const roman = Object.entries(ROMAN_NUMBER).find(([, n]) => n === movement.n)?.[0];
  for (const s of sectionsOf(lines)) {
    const h = s.heading.toLowerCase();
    const hit =
      (roman && new RegExp(`^${roman}\\.?(?:\\s|$)`).test(h)) ||
      (ordinal && new RegExp(`\\b${ordinal} movement\\b`).test(h)) ||
      (movement.n && new RegExp(`\\b(?:movement|variation) ${movement.n}\\b|^${movement.n}\\.\\s`).test(h)) ||
      (movement.name && sharesName(s.heading, movement.name));
    if (!hit) continue;
    const body = lines.slice(s.from + 1, s.to).filter((l) => !/^==/.test(l)).join("\n").trim();
    if (body.length >= 80) return { heading: s.heading, text: body };
  }
  return null;
}

/** Whether a heading and a name hold the same words, one inside the other: "III. Alla turca" and "Rondo Alla Turca". */
function sharesName(heading: string, name: string): boolean {
  const hw = nameWords(heading);
  const nw = nameWords(name);
  return hw.length > 0 && nw.length > 0 && (hw.every((x) => nw.includes(x)) || nw.every((x) => hw.includes(x)));
}

/** Cut a section to about `max` characters, at a sentence. */
const sectionBlock = (heading: string, text: string, max = 1100) => `${heading}: ${wholeSentences(text.replace(/\s+/g, " ").slice(0, max))}`;

/** What a page can't be for a classical piece: a film, a show or a book, a person who isn't a musician, or a piece in another key. "" when it can. */
export function notForAPiece(page: string, full: string, parsed: ClassicalTitle): string {
  const qualifier = qualifierOf(page) ?? "";
  const says = openingSays(full);
  const musical = (t: string) => FORM_WORDS.test(t) || /\b(operas?|operettas?|ballets?|musicals?|pieces?|compositions?|works?|songs?|arias?|soundtracks?|scores?|movements?|sets?)\b/i.test(t);
  if (SCREEN_OR_BOOK.test(qualifier) || (SCREEN_OR_BOOK.test(says) && !musical(says))) return "is a film's, a show's or a book's article";
  // A person's article opens with their dates: "Edwin Marrow (1790–1850) was an English painter".
  const dated = /^[^.(]{0,80}\((?:[^()]*;\s*)?(?:born\b[^)]*|[^)]*\b1\d{3}\s*[–-]\s*(?:1\d|20)\d{2})\)/.test(full.slice(0, 300));
  if (dated && !isPerformerArticle(page, full) && !musical(says) && !opensAboutMusicOrWork(full)) return "is about a person who isn't a musician";
  const wanted = parsed.key ? normalizeTitle(normalizeKeys(parsed.key)) : "";
  const got = keyIn(page);
  if (wanted && got && got !== wanted && !(!/major|minor/.test(wanted) && got.startsWith(`${wanted} `))) return `is in ${got}, not ${parsed.key}`;
  return "";
}

/** Whether a request asks for a classical piece, as far as the title and what's known of the artist tell. */
function classicalAsk(song: SSLSong): ClassicalTitle | null {
  if (!config.classicalLookup) return null;
  const parsed = parseClassicalTitle(dropVersionTags(song.title.trim()));
  const person = knownPerson(song.artist ?? "");
  return parsed.classical || person?.historic || person?.classicalPerformer ? parsed : null;
}

/** An artist field that could name one person or ensemble: a few words, no numbers, not "Traditional". */
const personLike = (artist: string) => !!artist && artist.split(/\s+/).length <= 5 && !/\d/.test(artist) && !NO_ONE.test(artist) && !CATEGORY_ARTIST.test(artist) && !CREDIT_JOIN.test(artist);

/** The reference built from a work's own article, or from its parent work's, or null. */
async function classicalArticle(
  work: WorkItem,
  parsed: ClassicalTitle,
  composer: string,
  usable: (title: string) => boolean,
  performer = false,
  asSet = false
): Promise<{ text: string; page: string; section: boolean | null } | null> {
  // The set itself was found ("Two Arabesques" for "Arabesque No. 1"): read it as the piece's parent.
  const numbered = parsed.numbers.filter((n) => !parsed.catalogs.some((c) => numbersOf(c).includes(n)));
  const piece = asSet ? { ...work, id: "", label: [parsed.name, ...numbered.map((n) => `No. ${n}`)].join(" "), names: [], catalogs: [], page: "", parents: [] } : work;
  if (asSet) return classicalParent(piece, [work], parsed, composer, usable);
  if (work.page && usable(work.page)) {
    const full = await wikiExtract(work.page);
    const why = full ? notForAPiece(work.page, full, parsed) : "is a disambiguation page";
    if (full && !why) {
      const part = parsed.movement ? movementSection(full, parsed.movement) : null;
      // Played by the artist on the list, written by someone else: the reference says who wrote it.
      const note = performer && composer ? `About this piece: ${work.label || parsed.name} is by ${composer}.\n\n` : "";
      const block = note + (part ? `${sectionBlock(part.heading, part.text)}\n\n` : "");
      const extract = ownArticleExtract(full, MAX_CONTEXT_CHARS - work.page.length - 1 - block.length, [work.label, composer].filter(Boolean));
      if (block.length + extract.length >= MIN_CONTEXT_CHARS) return { text: `${work.page}\n${block}${extract}`, page: work.page, section: null };
    } else console.log(`[Grounding] "${work.page}" ${why}, skipping`);
  }
  // No article of its own: the work it is part of (P361), or one that lists it as a part (P527), two levels up at most.
  return classicalParent(piece, work.parents.length ? await workItems(work.parents.slice(0, 3)) : await wholesOf(work.id), parsed, composer, usable);
}

/** The reference from the article of a work the piece is part of, led by the section about the piece when there is one. */
async function classicalParent(
  work: WorkItem,
  parents: WorkItem[],
  parsed: ClassicalTitle,
  composer: string,
  usable: (title: string) => boolean
): Promise<{ text: string; page: string; section: boolean | null } | null> {
  let level = parents;
  for (let depth = 0; depth < 2 && level.length; depth++) {
    for (const parent of level.filter((p) => p.page && usable(p.page))) {
      const full = await wikiExtract(parent.page);
      if (!full || notForAPiece(parent.page, full, { ...parsed, key: "" })) continue;
      const section = pieceSection(full, [...work.names, work.label, parsed.name, parsed.alias].filter(Boolean), [...parsed.numbers, ...work.catalogs.flatMap(numbersOf)]);
      const note = `About this piece: ${work.label || parsed.name} is part of ${parent.label || parent.page}${composer ? `, by ${composer}` : ""}.`;
      const block = section ? `${sectionBlock(section.heading, section.text)}\n\n` : "";
      const budget = MAX_CONTEXT_CHARS - parent.page.length - 1 - note.length - 2 - block.length;
      const extract = orderExtract(full, budget, [work.label, parsed.name, parent.label].filter(Boolean), true, NOT_A_LIST);
      if (block.length + extract.length < MIN_CONTEXT_CHARS) continue;
      return { text: `${parent.page}\n${note}\n\n${block}${extract}`, page: parent.page, section: !!section };
    }
    const up = [...new Set(level.filter((p) => !p.page).flatMap((p) => p.parents))].slice(0, 3);
    level = up.length ? await workItems(up) : [];
  }
  return null;
}

/**
 * A classical piece's article through Wikidata (issue #260), or "" to look it
 * up the usual way. The artist field is looked up first: a composer's works
 * are searched with the composer (P86), so a nickname or a catalog number
 * ("Moonlight Sonata", "BWV 1007") finds the work, and only a work whose
 * names, numbers and key fit the request counts. A performer (a pianist, an
 * orchestra) has the piece looked up by its title alone, the composer named
 * in the reference. A piece with no article of its own is read from its
 * parent work's ("Clair de lune" in "Suite bergamasque"), led by the section
 * about it when there is one.
 */
async function classicalGrounding(song: SSLSong, usable: (title: string) => boolean): Promise<Grounded> {
  const none = { text: "", unreachable: false };
  const artist = (song.artist ?? "").trim();
  // "Beethoven: Fur Elise" by Beethoven is "Fur Elise".
  const title = resolveGameAndTrack(song).track || dropVersionTags(song.title.trim());
  const parsed = parseClassicalTitle(title);
  if (!personLike(artist) || (!parsed.name && !parsed.catalogs.length) || !namesOneWork(parsed)) return none;
  // "Moonlight Sonata (3rd Movement)" isn't "Moonlight Sonata": the movement leads its reference.
  const key = `\0classical\0${normalizeTitle(artist)}\0${normalizeTitle(title)}\0${JSON.stringify(parsed.movement)}`;
  const hit = groundingCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS) && (!hit.text || usable(hit.text.split("\n")[0]))) return { text: hit.text, unreachable: false };
  try {
    const person = await personItem(artist);
    if (!person || !(parsed.classical || person.historic || person.classicalPerformer)) {
      groundingCache.set(key, { text: "", at: Date.now() });
      return none;
    }
    let found: { work: WorkItem; by: Exclude<WorkFit, ""> } | null = null;
    let composer = "";
    let performer = false;
    if (person.composer) {
      for (const q of workQueries(parsed)) {
        const picked = pickWork(await searchWorks(q, person.id), parsed);
        // Several works fit: another search would only pick one of them.
        if (picked && "tied" in picked) {
          const work = await breakTie(picked.tied, parsed);
          found = work ? { work, by: picked.by } : null;
          break;
        }
        found = picked;
        if (found) break;
      }
      if (found) composer = person.label;
    }
    // A performer, or a composer of our time playing someone else's piece: the piece by its title alone.
    if (!found && !person.historic && (person.classicalPerformer || parsed.classical)) {
      for (const q of workQueries(parsed).slice(0, 2)) {
        const picked = pickWork(await searchWorks(q, null), parsed, true);
        if (picked && "tied" in picked) {
          const work = await breakTie(picked.tied, parsed);
          found = work ? { work, by: picked.by } : null;
          break;
        }
        found = picked;
        if (found) break;
      }
      if (found) {
        composer = Object.values(await itemLabels(found.work.composers.slice(0, 2))).filter(Boolean).join(" and ");
        performer = true;
      }
    }
    if (!found) {
      console.log(`[Grounding] No Wikidata work for "${song.title}" by ${person.label}`);
      groundingCache.set(key, { text: "", at: Date.now() });
      return none;
    }
    // The request names a movement when only the catalog code matched ("Prelude" of BWV 1007),
    // or when the work's name is only part of it ("Rondo Alla Turca" by the sonata's alias "Alla Turca").
    const part = found.by === "catalog" || (found.by === "name" && !found.work.names.some((n) => nameWords(parsed.name).every((w) => nameWords(n).includes(w))));
    const hinted = part && !parsed.movement && parsed.name ? { ...parsed, movement: { name: parsed.name } } : parsed;
    const article = await classicalArticle(found.work, hinted, composer, usable, performer, found.by === "set");
    if (!article) {
      console.log(`[Grounding] Wikidata's work ${found.work.id} (${found.work.label}) for "${song.title}" has no article to read`);
      groundingCache.set(key, { text: "", at: Date.now() });
      return none;
    }
    classicalPages.set(classicalKey(article.page, song.title), { section: article.section });
    const how = article.section === null ? "its own article" : article.section ? "its parent work's article, with a section on it" : "its parent work's article";
    console.log(`[Grounding] "${song.title}" -> ${article.page} (${article.text.length} chars, Wikidata's work ${found.work.id}: ${how})`);
    groundingCache.set(key, { text: article.text, at: Date.now() });
    return { text: article.text, unreachable: false };
  } catch (err) {
    if (err instanceof WikidataBusy || err instanceof RateLimited) {
      console.log(`[Grounding] Classical lookup for "${song.title}" rate-limited, not cached`);
      return { text: "", unreachable: true };
    }
    console.warn(`[Grounding] Classical lookup failed for "${song.title}": ${err instanceof Error ? err.message : err}`);
    return { text: "", unreachable: true };
  }
}

interface Grounded {
  text: string;
  /** Throttled or unreachable: the miss says nothing, so no other reading is tried. */
  unreachable: boolean;
}

/**
 * Reference text for the song, or "" when no relevant article exists.
 * `skip`: articles already found not to fit this request (`articleMisfit`), passed over like blocked ones.
 * When an article's older version couldn't be read on the way, Wikipedia is skipped for the song this
 * time (issue #242): data facts show instead, and the lookup is tried again later.
 */
export async function fetchGrounding(song: SSLSong, skip: ReadonlySet<string> = new Set()): Promise<string> {
  const failedBefore = olderVersionFailures;
  const text = await findGrounding(song, skip);
  if (olderVersionFailures === failedBefore) return text;
  console.log(`[Grounding] "${song.title}": an article's older version couldn't be read, skipping Wikipedia for now`);
  return "";
}

async function findGrounding(song: SSLSong, skip: ReadonlySet<string>): Promise<string> {
  // Articles the streamer marked wrong for this song are never used for it again.
  const blocked = new Set([...blockedArticles(song), ...skip]);
  const usable = (title: string) => !blocked.has(title);
  const tried = new Set<string>();
  const attempt = async (reading: Reading): Promise<Grounded> => {
    const key = `${reading.songAlone ? "alone" : ""}${reading.trackOnly ? "track" : ""}${reading.cleaned ? "cleaned" : ""}\0${normalizeTitle(reading.game)}\0${normalizeTitle(reading.track)}`;
    if (tried.has(key)) return { text: "", unreachable: false };
    tried.add(key);
    if (tried.size > 1) console.log(`[Grounding] "${song.title}": trying ${reading.songAlone ? "the title alone" : `"${reading.track}" from "${reading.game}"`}`);
    return reading.songAlone ? groundSongAlone(song, reading.track, usable) : groundReading(song, reading, blocked);
  };
  // A classical piece: its work through Wikidata first, so a nickname or a catalog number finds the piece's own article (issue #260).
  if (config.classicalLookup && !song.artistUncertain && !isPlaceholderRequest(song)) {
    const classical = await classicalGrounding(song, usable);
    if (classical.text) return classical.text;
  }
  // The list's text as written first; then, for notes and tags it carries, the same without them.
  const listed = readings(song);
  const stripped = lookupForm(song);
  const same = (a: Reading, b: Reading) => a.game === b.game && a.track === b.track && !a.songAlone === !b.songAlone && !a.trackOnly === !b.trackOnly;
  const extra = stripped ? readings(stripped).filter((r) => !listed.some((l) => same(l, r))).map((r) => ({ ...r, cleaned: true })) : [];
  for (let reading of [...listed, ...extra]) {
    if (/ series$/.test(reading.game)) {
      try {
        const page = await seriesPage(reading.game.slice(0, -" series".length));
        if (page) reading = { ...reading, page };
      } catch (err) {
        if (err instanceof RateLimited) return "";
      }
    }
    const first = await attempt(reading);
    if (first.text || first.unreachable) return first.text;
    // Wikipedia's own name for what the request misspells or calls otherwise:
    // "Eric Satie" is "Erik Satie", "Star Wars: The Phantom Menace" is "Star Wars: Episode I – The Phantom Menace".
    if (reading.songAlone || reading.game.endsWith(" series") || song.performer || song.artistUncertain || !reading.game) continue;
    let { game, track } = reading;
    try {
      game = (await wikipediaName(game)) ?? game;
      // A piece by a composer or performer: "The Beautiful Blue Danube" is "The Blue Danube".
      if (track !== reading.game && looksLikeArtistName(game)) track = (await wikipediaName(track)) ?? track;
    } catch (err) {
      if (err instanceof RateLimited) return "";
      continue;
    }
    if (game === reading.game && track === reading.track) continue;
    // The renamed subject is the very page Wikipedia gave, not whatever a search for it finds:
    // "Pirates of the Caribbean" is the franchise, not "Pirates of the Caribbean (video game)".
    const renamed = await attempt({ ...reading, game, track, page: game === reading.game ? reading.page : game });
    if (renamed.text || renamed.unreachable) return renamed.text;
  }
  // Every reading missed: the article MusicBrainz's own Wikidata link names, gated (issue #245).
  const linked = config.mbLink && !isPlaceholderRequest(song) && !hasNoArtist(song.artist) ? await linkedGrounding(song, usable) : "";
  if (linked) linkedPages.add(linked.split("\n")[0]);
  return linked;
}

/** What a game, a film or a show is called in its article's first sentence or its title's brackets. */
const WORK_WORDS =
  /\b(video games?|games?|films?|movies?|television (?:series|programs?|programmes?|shows?|films?)|tv series|animated series|anime|web series|sitcom|musical|soundtrack|franchise|series)\b/i;

/** Who or what else an article opens by naming: "a German film score composer", "a Middle Eastern folk tale". */
const NOT_WORK_WORDS =
  /\b(singer|band|composer|musician|rapper|songwriter|producer|actor|actress|director|DJ|duo|group|orchestra|person|character|company|developer|publisher|studio|label|tale|song|single|album|EP)s?\b/i;

/**
 * Whether an article is about a game, a film or a show: by its brackets, or
 * by what its first sentence says it is ("a 1997 role-playing video game"),
 * up to who made it.
 */
export function isWorkArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier) return WORK_WORDS.test(qualifier) && !NOT_WORK_WORDS.test(qualifier.replace(/\bsoundtrack album\b/i, "soundtrack"));
  const what = openingSays(full);
  return WORK_WORDS.test(what) && !NOT_WORK_WORDS.test(what.replace(/\bsoundtrack album\b/i, "soundtrack"));
}

/** What an article's first sentence says its subject is, up to who made it: "a 1997 role-playing video game". */
export function openingSays(full: string): string {
  // "Dwayne Michael Carter Jr. (born 1982), known professionally as Lil Wayne, is an American rapper".
  const opening = full.slice(0, 600).replace(/\s*\([^()]*\)/g, "");
  const says = /\b(?:is|was|are|were)\s+((?:an?|the|one)\b[^.]*)/.exec(opening)?.[1] ?? "";
  return says.split(/,|;|\s(?:by|developed|directed|created|produced|published|written|released|that|which|who|based|starring|featuring|from|for|in)\b/)[0];
}

/** What a piece of music is called in its brackets or its first sentence. */
const PIECE_WORDS = /\b(song|single|ballad|anthem|theme|instrumental|track|piece|composition|aria|hymn|tune|jingle)s?\b/i;

/** Whether an article is about a piece of music: "(Bee Gees song)", or "a song from the film Aladdin". */
export function isPieceArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier && PIECE_WORDS.test(qualifier)) return true;
  return PIECE_WORDS.test(openingSays(full));
}

/**
 * What a performer is called in an article's first sentence. The three performer lists differ by where
 * they look: PERFORMER_QUALIFIER reads a title's brackets, PERFORMER_LEAD an article's opening, where a
 * recording counts too, and this one only what the first sentence says the subject is.
 */
const PERFORMER_WORDS =
  /\b(singers?|bands?|rappers?|musicians?|composers?|songwriters?|producers?|DJs?|disc jockeys?|duo|trio|group|vocalists?|pianists?|guitarists?|drummers?|violinists?|saxophonists?|orchestra|ensemble|choir|entertainers?|performers?|YouTuber)\b/i;

/**
 * Whether an article is about a performer: by its brackets ("(band)"), or by
 * what its first sentence says ("an American singer"). "Black Caviar" is a
 * duo's name and a racehorse's article.
 */
export function isPerformerArticle(page: string, full: string): boolean {
  const qualifier = qualifierOf(page);
  if (qualifier) return PERFORMER_QUALIFIER.test(qualifier);
  return PERFORMER_WORDS.test(openingSays(full));
}

// --- A performer's name shared with a film or a book ------------------------

/** An artist field's own bracket saying it is a performer: "Some Band (British)", "Some Name (singer)". */
const PERFORMER_BRACKET =
  /\((?:[^)]*\s)?(?:band|singer|rapper|musician|group|duo|trio|DJ|British|English|American|Canadian|Australian|Irish|Scottish|Welsh|Swedish|Norwegian|Finnish|Danish|German|French|Italian|Spanish|Dutch|UK|US)\)\s*$/i;
/** Works that aren't music: a film, a show, a book, a play, a tale, a character. */
const NON_MUSIC_WORK =
  /\b(films?|movies?|television|TV|miniseries|sitcoms?|soap operas?|web series|anime|novels?|novellas?|books?|plays?|short stor(?:y|ies)|comics?|manga|fairy tales?|folk tales?|tales?|poems?|paintings?|characters?)\b/i;
/** What makes an article about music or a game after all: "(Some Band song)", "a 1990 single", "a video game". */
const MUSIC_OR_GAME_WORK =
  /\b(songs?|singles?|albums?|EPs?|soundtracks?|bands?|singers?|rappers?|musicians?|groups?|duo|operas?|video games?|games?)\b/i;

/**
 * Whether an article is about a film, a show, a book, a play or another
 * work that isn't music or a game, by its brackets ("(1963 film)") or its
 * first sentence ("is a 1950 American animated musical fantasy film").
 */
export function isNonMusicWork(page: string, full: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  const what = qualifier ?? openingSays(full);
  return NON_MUSIC_WORK.test(what) && !MUSIC_OR_GAME_WORK.test(what);
}

/** A film or video of a performance or about performers: "a 2025 concert documentary film", "(live video)". */
const CONCERT_FILM =
  /\b(?:concert (?:films?|documentar(?:y|ies)|videos?|movies?|specials?)|documentar(?:y|ies)|rockumentar(?:y|ies)|live (?:films?|videos?|video albums?|DVDs?)|video albums?|tour films?|music films?)\b/i;

/**
 * Whether an article is about a concert film, a documentary or a live
 * video, by its brackets or its first sentence. Its lead names the band
 * because it is about them; its facts are still the film's.
 */
export function isConcertFilm(page: string, full: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(page)?.[1];
  return CONCERT_FILM.test(qualifier ?? "") || CONCERT_FILM.test(openingSays(full));
}

/**
 * Whether an article's lead names the performer as one, not just as its own
 * title: "a film about the British rock band Some Band" does, "Some Band is a
 * 1963 film" doesn't.
 */
export function leadNamesPerformer(page: string, full: string, artist: string): boolean {
  const lead = normalizeTitle(full.split(/\n==/)[0]);
  const own = normalizeTitle(page);
  const names = artistNames(artist);
  if (!names.includes(own)) return mentionsName(lead, names);
  const as = String.raw`(?:band|singer|rapper|musician|group|duo|by|performed by|recorded by)`;
  return names.some((n) => new RegExp(String.raw`(?:^| )${as} (?:the )?${escapeRe(n)}(?: |$)|(?:^| )${escapeRe(n)} s? ?(?:frontman|singer|members?|album|song|single)(?: |$)`).test(lead));
}

interface PerformerPages {
  /** The performer's own article: the plain name, or "(band)", "(singer)" and so on. */
  performer: string | null;
  /** The song's own article, "<Title> (<Artist> song)", or "<Title> (song)" when its description names the artist. */
  song: string | null;
}
const performerPagesCache = new Map<string, PerformerPages>();

/**
 * One title lookup with Wikipedia's short descriptions: the performer's own
 * article and the song's disambiguated one, when they exist.
 */
export async function performerPages(artist: string, track: string): Promise<PerformerPages> {
  const key = `${normalizeTitle(artist)}\0${normalizeTitle(track)}`;
  const hit = performerPagesCache.get(key);
  if (hit) return hit;
  const forms = ["", " (band)", " (singer)", " (musician)", " (rapper)", " (group)"].map((q) => artist + q);
  const songs = [`${track} (${artist} song)`, `${track} (song)`];
  const names = [...forms, ...songs];
  const data = await wikiGet<{
    query?: {
      normalized?: Array<{ from: string; to: string }>;
      redirects?: Array<{ from: string; to: string }>;
      pages?: Record<string, { title?: string; missing?: string; invalid?: string; description?: string }>;
    };
  }>(`action=query&redirects=1&prop=description&titles=${encodeURIComponent(names.join("|"))}`, config.groundingTimeoutMs, "titles");
  const q = data.query ?? {};
  const pages = new Map(
    Object.values(q.pages ?? {})
      .filter((p) => p.title && p.missing === undefined && p.invalid === undefined)
      .map((p) => [p.title!, p.description ?? ""])
  );
  const resolve = (name: string) => {
    const title = q.normalized?.find((n) => n.from === name)?.to ?? name;
    const page = q.redirects?.find((r) => r.from === title)?.to ?? title;
    return pages.has(page) ? { page, description: pages.get(page)! } : null;
  };
  const who = artistNames(artist);
  const performer =
    forms.map(resolve).find((r) => r && PERFORMER_WORDS.test(r.description) && !NON_MUSIC_WORK.test(r.description))?.page ?? null;
  // Named for the track, not a redirect to the album or the artist: "Some Song (Some Band song)" -> "Some Album" isn't the song's.
  const ofTrack = (r: { page: string; description: string } | null) =>
    r && normalizeTitle(r.page) === normalizeTitle(track) ? r : null;
  const [byArtist, plain] = songs.map(resolve).map(ofTrack);
  const song =
    (byArtist && !NON_MUSIC_WORK.test(byArtist.description) ? byArtist.page : null) ??
    (plain && /\b(song|single)\b/i.test(plain.description) && mentionsName(normalizeTitle(plain.description), who) ? plain.page : null);
  const out = { performer, song };
  performerPagesCache.set(key, out);
  return out;
}

/**
 * For a performer's song, what to do with the subject's article a search
 * found: null to keep it; the song's own article when Wikipedia has one;
 * the performer's article, or "reject", for a film, a show or a book that
 * only shares the performer's name ("Some Band (1963 film)").
 *
 * The artist is a performer when the request says so (a music video, a
 * bracket like "(British)", a person's name) or Wikipedia has a performer's
 * article under the name. Games keep the usual lookup: game music lists put
 * the game in the artist field. A film that names the requested track (its
 * own score) is kept too.
 *
 * An article that never names the piece as music (`namesPiece`) may be
 * another work that only shares the name, even a game's or an album's:
 * "Heart of Darkness (video game)" for Heart's "Alone", Elton John's "The
 * Muse" for Muse's "Space Dementia". Then the song's own article wins
 * wherever it's found, and an album or a soundtrack gives way to a
 * performer's article under the name. A game's article stays: a band may
 * share a game's name.
 */
async function performerArticle(
  song: SSLSong,
  reading: Reading,
  page: string,
  full: string,
  usable: (title: string) => boolean
): Promise<{ page: string; subject: boolean } | "reject" | null> {
  const { game, track } = reading;
  const aGame = /game\)$/i.test(page) || /\b(?:video )?games?\b/i.test(openingSays(full));
  const unnamed = !namesPiece(full, track);
  const concert = !aGame && isConcertFilm(page, full);
  const nonMusic = !aGame && (isNonMusicWork(page, full) || concert);
  const told = !!song.performer || !!reading.aPerformer || looksLikeArtistName(game) || PERFORMER_BRACKET.test(game);
  if (aGame ? !unnamed : !nonMusic && !told && !unnamed) return null;
  const artist = game.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const found = await performerPages(artist, track);
  if (found.song && found.song !== page && usable(found.song)) return { page: found.song, subject: false };
  if (aGame) return null;
  // Only to another page: a person's own article stays even when the opening doesn't call them a performer.
  const otherMusic = !nonMusic && unnamed && !!found.performer && found.performer !== page && !isPerformerArticle(page, full);
  if (!otherMusic && (!nonMusic || !(told || found.performer))) return null;
  const name = normalizeTitle(track);
  // A concert film or documentary names the band throughout: only its lead naming the track keeps it.
  if (concert) {
    if (name.length >= 5 && mentionsName(normalizeTitle(full.split(/\n==/)[0]), [name])) return null;
  } else if (!otherMusic && (leadNamesPerformer(page, full, artist) || (name.length >= 5 && mentionsName(normalizeTitle(full), [name])))) return null;
  if (found.performer && found.performer !== page && usable(found.performer)) return { page: found.performer, subject: true };
  return "reject";
}

/**
 * A game's track with an article of its own ("Megalovania", "Baba Yetu"): the reference, or "" when
 * it has none, or null when Wikipedia couldn't be asked (throttled or unreachable).
 */
async function trackOwnArticle(song: SSLSong, game: string, track: string, usable: (title: string) => boolean): Promise<string | null> {
  try {
    const own = (await wikiSearch(`${track} ${game}`)).find(
      (t) => usable(t) && isRelevantArticle(track, t) && !qualifierNamesAnotherArtist(t, game, track, true)
    );
    const full = own ? await wikiExtract(own) : null;
    // It has to be an article about a piece of music: "Dragonborn" from Skyrim is also an expansion pack.
    const aboutMusic = full && /\b(song|theme|piece|composition|instrumental|track|single|anthem|aria|soundtrack)\b/i.test(full.slice(0, 400));
    const extract = full && aboutMusic && mentionsName(normalizeTitle(full), artistNames(game)) ? ownArticleExtract(full, MAX_CONTEXT_CHARS - own!.length - 1, [track, game]) : "";
    if (own && full && extract && extract.length >= MIN_CONTEXT_CHARS) {
      console.log(`[Grounding] "${song.title}" -> ${own} (${extract.length} chars, the track's own article)`);
      return `${own}\n${writingText(full, extract, MAX_CONTEXT_CHARS - own.length - 1, [track, game])}`;
    }
    return "";
  } catch {
    return null;
  }
}

/**
 * What the grounding cache holds under a key, if it can be used: the reference, "" for a
 * recent miss, or undefined when there's nothing (a blocked article, an expired miss).
 */
function cachedGrounding(key: string, usable: (title: string) => boolean): string | undefined {
  const hit = groundingCache.get(key);
  if (!hit) return undefined;
  if (hit.text) return usable(hit.text.split("\n")[0]) ? hit.text : undefined;
  return Date.now() - hit.at < NEGATIVE_TTL_MS ? "" : undefined;
}

/** What to search Wikipedia for, in order, for one reading of the request. */
function groundingTerms(song: SSLSong, reading: Reading, artist: boolean): string[] {
  const { game, track } = reading;
  const terms = song.artistUncertain && track !== game
    ? [track]
    : searchTerms(game, track, artist || !!song.performer, reading.notGame || reading.fromTitle);
  // The page Wikipedia named is searched for by its own title; a series also by its bare name ("Star Trek").
  const series = /^(.+) (?:series|franchise)$/i.exec(game)?.[1];
  for (const extra of [reading.page, series]) {
    if (extra && !terms.includes(extra)) terms.splice(terms.includes(game) ? terms.indexOf(game) : terms.length, 0, extra);
  }
  // A music video's artist may share a name with a game or film; ask for the performer.
  if (song.performer && !looksLikeArtistName(game) && game.trim()) {
    const at = terms.indexOf(game);
    terms.splice(at < 0 ? terms.length : at, 0, `${game} band`);
  }
  return terms;
}

/**
 * Why a search result doesn't fit this reading, or "" when it does. `byGame`: it matched as the
 * game's or artist's article, not the track's; `installment`: as a longer title than the game's.
 */
function pageMisfit(
  song: SSLSong,
  reading: Reading,
  page: string,
  full: string | null,
  how: { byGame: boolean; installment: boolean; names: string[]; classical: ClassicalTitle | null }
): string {
  if (!full) return "";
  const { game, track } = reading;
  const { byGame, installment, names, classical } = how;
  // An installment or spin-off is only right when it's the song's own game: it must name the track.
  // A generic name ("Main Theme") is in every installment's article, so it names none of them.
  // Its name alone isn't enough: "Castlevania: Belmont's Curse" names the "Vampire Killer" whip, not the track.
  if (installment && (GENERIC_TRACK.test(normalizeTitle(track)) || !namesPiece(full, track))) return `never names "${track}" as music`;
  // A performer's name alone can be an everyday word: "Milestone" is about road markers.
  if (byGame && song.performer && !/\(/.test(page) && !PERFORMER_LEAD.test(full.slice(0, 400))) return "isn't about a performer";
  // One of several names may be anything: its own article must be a performer's ("Black Caviar" is a racehorse too),
  // A game's or a show's own article under that very name serves too: "Kingdom Hearts / Some Remixer".
  const workByName = () => !/\(/.test(page) && normalizeTitle(page) === normalizeTitle(game) && isWorkArticle(page, full);
  if (byGame && reading.aPerformer && !isPerformerArticle(page, full) && !workByName()) return "isn't about a performer";
  // A piece read from the title must be one: "Overwatch" read as a track name isn't "Overwatch and pornography".
  if (!byGame && reading.fromTitle && !isPieceArticle(page, full)) return "isn't about a piece of music";
  // A work read from the title must be a game, a film or a show: "Aladdin" is also a folk tale.
  if (byGame && reading.fromTitle && !isWorkArticle(page, full)) return "isn't a game, a film or a show";
  // "Passacaglia (Handel/Halvorsen)" names its composers in its title.
  const qualifier = qualifierOf(page) ?? "";
  if (!byGame && !mentionsName(`${normalizeTitle(full)} ${normalizeTitle(qualifier)}`, names)) return `never mentions "${game}"`;
  return classical ? notForAPiece(page, full, classical) : "";
}

/**
 * The part of an article to write from: the song's own article whole, or a game's or an artist's
 * cut to what's about the track. `ownArticle`: the article is the song's own (or the request is the game).
 */
function articleExtract(page: string, full: string | null, ownArticle: boolean, byGame: boolean, game: string, track: string): string {
  if (!full) return "";
  return ownArticle && !byGame
    ? ownArticleExtract(full, MAX_CONTEXT_CHARS - page.length - 1, [track, game])
    : orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track], ownArticle);
}

/** The first of these articles that names the piece as music (`namesPiece`), reading at most three. */
async function namingPiece(titles: string[], track: string): Promise<string | null> {
  for (const t of titles.slice(0, 3)) {
    const full = await wikiExtract(t);
    if (full && namesPiece(full, track)) return t;
  }
  return null;
}

/** One reading of the request, looked up the usual way. */
async function groundReading(song: SSLSong, reading: Reading, blocked: Set<string>): Promise<Grounded> {
  const { game, track } = reading;
  // A subject pinned to one page is remembered apart: another song's search may have found another page for the name.
  // A lookup for the song's own article alone says nothing about the subject's article.
  const gameCacheKey = normalizeTitle(game) + (reading.page ? `\0${reading.page}` : "") + (reading.trackOnly ? "\0track" : "") + (reading.cleaned ? "\0cleaned" : "");
  const trackCacheKey = `${gameCacheKey}\0${normalizeTitle(track)}`;

  // A game's tracks share one lookup. An artist's songs never share: each may
  // have its own article. The artist test is a heuristic, and guessing
  // "artist" for a game only costs extra lookups, never wrong facts.
  // A music video's artist counts as one too (issue: "Muse - Starlight" must
  // search for Starlight, not reuse Muse's article cached for another song).
  const artist = looksLikeArtistName(game) || !!song.performer;
  const usable = (title: string) => !blocked.has(title);
  // A game's track with an article of its own ("Megalovania", "Baba Yetu") is
  // far richer than the game's article, so it's tried first: one search per
  // track, remembered either way (issue #48).
  // A generic name ("Theme") has no article of its own: "Theme from Star Trek" is another show's.
  const generic = GENERIC_TRACK.test(normalizeTitle(track));
  if (!artist && track && track !== game && !generic && !song.artistUncertain && !noOwnArticle.has(trackCacheKey) && !groundingCache.get(trackCacheKey)?.text) {
    const own = await trackOwnArticle(song, game, track, usable);
    if (own) {
      groundingCache.set(trackCacheKey, { text: own, at: Date.now() });
      return { text: own, unreachable: false };
    }
    // Null when throttled or unreachable: the game's article below still serves, and this is tried again next time.
    if (own === "") noOwnArticle.add(trackCacheKey);
  }
  // The track's own article, found before.
  const ownHit = artist ? undefined : cachedGrounding(trackCacheKey, usable);
  if (ownHit) return { text: ownHit, unreachable: false };
  // A game already looked up: this track's reference is built from the kept articles.
  const kept = !song.performer && track !== game ? gameArticles.get(gameCacheKey) : undefined;
  if (kept && usable(kept.page)) {
    const drop = isPerformerArticle(kept.page, kept.full) ? null : await otherWorkScope([kept, kept.music], game);
    const text = withoutSentences(drop, !!track && track !== game && !generic, () => gameTrackText(kept, track, usable, game));
    groundingCache.set(trackCacheKey, { text, at: Date.now() });
    return { text, unreachable: false };
  }
  // The game's reference or the track's, or a recent miss.
  for (const key of artist ? [trackCacheKey] : [gameCacheKey, trackCacheKey]) {
    const hit = key ? cachedGrounding(key, usable) : undefined;
    if (hit !== undefined) return { text: hit, unreachable: false };
  }

  // "Ecco the Dolphin CD" is the game "Ecco the Dolphin": an edition word isn't part of its name.
  const edition = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  // Which way an article matched decides how widely it may be shared. A
  // track article must not be attributed to another artist, and its text
  // must mention the game or artist: "Overture" alone is a generic article.
  const matchedGame = (title: string) =>
    // An artist that's only a guess from the uploader's channel is never looked up
    // as the subject: an uploader called "Apollo" isn't the god (issue from review).
    !song.artistUncertain &&
    // Only the piece's own article for a name that may be an arranger's or a fellow musician's.
    !reading.trackOnly &&
    // A film or a show is never a video game of the same name.
    !(reading.notGame && /\((?:[^)]*\b)?games?\b[^)]*\)\s*$/i.test(title)) &&
    // The page Wikipedia gave for the name, and only that one.
    (reading.page
      ? title === reading.page
      : isRelevantArticle(game, title, artist || !!song.performer) || (edition !== game && isRelevantArticle(edition, title, artist || !!song.performer))) &&
    // A music video's artist is a band or singer, never a game or film of the same name.
    !(song.performer && NOT_A_PERFORMER.test(title));
  // A longer title than the subject: "Final Fantasy" -> "Final Fantasy VII".
  const gameTokens = significantTokens(normalizeTitle(game)).length;
  const extendsGame = (title: string) => significantTokens(normalizeTitle(title)).length > gameTokens;
  const matchedTrack = (title: string) =>
    track !== game &&
    !generic && isRelevantArticle(track, title) && !qualifierNamesAnotherArtist(title, game, track);

  // "Lil Nas X, Jack Harlow": a song's article may name only its lead artist.
  const names = artistNames(game);
  const terms = groundingTerms(song, reading, artist);
  let unreachable = "";
  // A classical piece is never read from a film's, a show's or a non-musician's article, or another key's piece (issue #260).
  const classical = classicalAsk(song);

  for (const term of terms) {
    try {
      const titles = await wikiSearch(term);
      // For an artist, the song's own article beats the artist's, wherever it ranks:
      // "Industry Baby" over "Lil Nas X".
      // The same for a game's track that has an article of its own: "Megalovania" over "Undertale".
      // Among articles named for the track, the song's beats the album's: "Let It Be (song)" over "Let It Be (album)".
      const ofTrack = titles.filter((t) => usable(t) && matchedTrack(t));
      let page =
        ofTrack.find((t) => /\((?:[^)]*\b)?(song|composition|instrumental|theme)\)$/i.test(t)) ??
        ofTrack.find((t) => !/\((?:[^)]*\b)?(album|EP|soundtrack|film|musical)\)$/i.test(t)) ??
        ofTrack[0] ??
        // An edition's own article beats the original's: "Some Game Remake" over "Some Game".
        // One of several works of the name ("Some Game (1984 video game)") comes last.
        titles.find((t) => usable(t) && matchedGame(t) && !editionNotInTitle(game, t) && !oneOfSeveral(t, titles, game)) ??
        titles.find((t) => usable(t) && matchedGame(t) && !oneOfSeveral(t, titles, game)) ??
        titles.find((t) => usable(t) && matchedGame(t));
      if (!page) {
        if (titles.length) console.log(`[Grounding] No relevant match among: ${titles.join(", ")}`);
        continue;
      }
      // Several works share the name and the request doesn't say which: the one that names the piece as music, or none.
      const several = titles.filter((t) => usable(t) && matchedGame(t) && oneOfSeveral(t, titles, game) && normalizeTitle(t) === normalizeTitle(page));
      if (several.length && !matchedTrack(page) && track !== game && !generic) {
        const which = await namingPiece(several, track);
        if (which) page = which;
        else if (oneOfSeveral(page, titles, game)) {
          console.log(`[Grounding] "${page}" is one of several works named "${game}" and none names "${track}" as music, skipping`);
          continue;
        }
      }
      // A game's track: the game's own article over a film or a show of its name that never names the track,
      // from the search or, when it ranked lower, Wikipedia's pages for the name.
      if (!artist && !reading.notGame && !reading.page && !song.performer && track !== game && !generic && !matchedTrack(page) && isScreenPage(page) && !namesPiece((await wikiExtract(page)) ?? "", track)) {
        const fits = (t: string) => usable(t) && matchedGame(t) && !oneOfSeveral(t, titles, game);
        let ofGame = gameInsteadOfScreen(page, titles.filter(fits));
        if (!ofGame) {
          const named = await wikiResolveTitles([`${game} (video game)`, game]);
          ofGame = gameInsteadOfScreen(page, [...named.values()].filter((r) => !r.fragment).map((r) => r.page).filter(fits));
        }
        const lead = ofGame ? ((await wikiExtract(ofGame)) ?? "").slice(0, 600) : "";
        if (ofGame && (/game\)$/i.test(ofGame) || GAME_LEAD.test(lead))) {
          console.log(`[Grounding] "${page}" is another work that never names "${track}": the game's "${ofGame}" instead`);
          page = ofGame;
        }
      }
      let byGame = matchedGame(page);
      let full = await wikiExtract(page);
      let toPerformer = false;
      // A performer's song: its own article if Wikipedia has one, and never a film or a book that shares the name.
      if (byGame && full && track && track !== game && !generic && !reading.fromTitle && !reading.notGame && !song.artistUncertain) {
        const swap = await performerArticle(song, reading, page, full, usable);
        if (swap === "reject") {
          console.log(`[Grounding] "${page}" is a work that only shares the performer's name, skipping`);
          continue;
        }
        // The performer's own article stays when the song's is too short to write from.
        const songFull = swap && !swap.subject ? await wikiExtract(swap.page) : null;
        const tooShort = !!swap && !swap.subject && (!songFull || articleExtract(swap.page, songFull, true, false, game, track).length < MIN_CONTEXT_CHARS);
        if (swap && tooShort && isPerformerArticle(page, full)) {
          console.log(`[Grounding] "${swap.page}" is too short to write from: keeping the performer's article "${page}"`);
        } else if (swap) {
          console.log(`[Grounding] "${page}" -> ${swap.page} (${swap.subject ? "the performer's article" : "the song's own article"})`);
          page = swap.page;
          full = songFull ?? (await wikiExtract(page));
          byGame = swap.subject;
          toPerformer = swap.subject;
        }
      }
      // A concert film or documentary named for the song or the band is the film's article, not the song's.
      if (!byGame && full && artist && isConcertFilm(page, full)) {
        console.log(`[Grounding] "${page}" is a concert film or documentary that shares the song's name, skipping`);
        continue;
      }
      // A city, a country or a sports team named like the song or its artist ("Havana" the city): never
      // the song's, like a film that shares a band's name. Its Wikidata item says so; music and games aren't asked.
      const place = full && (isPieceArticle(page, full) || isPerformerArticle(page, full) || /\b(?:video )?games?\b/i.test(openingSays(full))) ? "" : await placeOrTeam(page);
      if (place) {
        console.log(`[Grounding] "${page}" is a place or a team (Wikidata: ${place}), not a work, skipping`);
        continue;
      }
      const installment = byGame && extendsGame(page) && track !== game && !reading.page;
      const why = pageMisfit(song, reading, page, full, { byGame, installment, names, classical });
      if (why) {
        console.log(`[Grounding] "${page}" ${why}, skipping`);
        continue;
      }
      // The song's own article, or one about the whole game or artist?
      const ownArticle = !byGame || track === game || matchedTrack(page);
      const extract = articleExtract(page, full, ownArticle, byGame, game, track);
      if (extract.length < MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${page}" is too short to write from (${extract.length} chars)`);
        continue;
      }
      // A series' music article found for one of its games: only what is about that game.
      const scoped = full && byGame && !ownArticle && seriesFilter.on && isSeriesWide(page, full, game) ? seriesScope(full, game, track) : "";
      // A game's or a work's article: not its sentences about a sequel, a remake or an edition.
      const ofWork = byGame && !ownArticle && !toPerformer && !song.performer && !!full && !isPerformerArticle(page, full);
      const saves = !!track && track !== game && !generic;
      const otherWork = ofWork ? await otherWorkScope([{ page, full: full! }], game) : null;
      // A cover's request read from the original's article: not the original's release, charts or video.
      const cover = !byGame && ownArticle && artist && !!full && isCoverOf(page, full, game, song.title);
      if (cover) console.log(`[Grounding] "${page}": the request is a cover; the original's release and charts left out`);
      const drop = cover ? originalsRecord(full!) : otherWork;
      let text = withoutSentences(drop, saves && !cover, () =>
        scoped
          ? `${page}\n${writingText(scoped, orderExtract(scoped, MAX_CONTEXT_CHARS - page.length - 1, [track], false), MAX_CONTEXT_CHARS - page.length - 1, [track])}`
          : `${page}\n${full ? writingText(full, extract, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track]) : extract}`
      );
      // "Chrono Trigger" and "Kingdom Hearts" read like people's names, so the article decides: is it a game's?
      const aGame = !artist || /game\)$/i.test(page) || GAME_LEAD.test(full?.slice(0, 600) ?? "");
      if (byGame && aGame && !toPerformer && !song.performer && !ownArticle && !installment && full) {
        let music: GameArticles["music"] = null;
        try {
          music = await findMusicArticle(game, usable);
        } catch {
          // Throttled or unreachable: the game's article serves on its own.
        }
        const articles = { page, full, music };
        // Shared by the game's tracks, unless this track has blocked articles of its own.
        if (!blocked.size) gameArticles.set(gameCacheKey, articles);
        const both = ofWork ? await otherWorkScope([articles, music], game) : null;
        text = withoutSentences(both, saves, () => gameTrackText(articles, track, usable, game));
        if (music) console.log(`[Grounding] "${game}" has a music article: ${music.page}${music.series ? " (series-wide: used for tracks it names)" : ""}`);
      }
      console.log(`[Grounding] "${song.title}" -> ${text.split("\n")[0]} (${text.length} chars)`);
      // Shared by the game's tracks, unless this track has blocked articles of its own.
      groundingCache.set(byGame && !artist && !toPerformer && !blocked.size && !installment ? gameCacheKey : trackCacheKey, { text, at: Date.now() });
      return { text, unreachable: false };
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
  // A miss caused by this song's blocked articles says nothing about the game's other tracks.
  if (!unreachable) groundingCache.set(artist || blocked.size ? trackCacheKey : gameCacheKey, { text: "", at: Date.now() });
  return { text: "", unreachable: !!unreachable };
}

export function clearGroundingCache(): void {
  linkedPages.clear();
  summaries.clear();
  classicalPages.clear();
  clearClassicalCache();
  noOwnArticle.clear();
  wikitextCache.clear();
  workScopeCache.clear();
  performerPagesCache.clear();
  wikipediaNames.clear();
  gameArticles.clear();
  groundingCache.clear();
}

// --- Shared with screening (fact-verifier.ts imports these) ----------------

/**
 * Dropped even when the source says so. Critics' opinions read as facts on
 * stream and make the real facts harder to trust (issue #21), and the music
 * video's plot or look is what viewers are already watching (issue #20).
 */
export const OPINION = /\b(considered (?:one|to be|as|by|a|an|among|the (?:best|greatest|finest|most|top))|(?:among|some of) the (?:best|greatest|finest|most)|instantly recognizable|regarded|praised|acclaimed|hailed|lauded|critics?|critically|masterpiece|greatest|iconic|beloved|celebrated|described as|one of the (best|finest|most))\b/i;

export function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/** Text naming the track, small words aside: "Through the Fire and Flames" names "Through the Fire and the Flames". */
export function namesTrack(text: string, track: string): boolean {
  const want = significantTokens(normalizeTitle(track));
  const have = new Set(normalizeTitle(text).split(" "));
  return mentionsName(normalizeTitle(text), [normalizeTitle(track)]) || (want.length > 0 && want.every((t) => have.has(t)));
}
