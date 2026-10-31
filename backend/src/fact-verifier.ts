import { config } from "./config";
import { SSLSong } from "./types";
import { blockedArticles } from "./wrong-facts";
import { topic } from "./topic";
import { escapeRe, hasNoArtist, removeAll, withoutRefsAndComments, withoutRequestCredit } from "./text";
import { IDENTITY_REASON, selfDescribedIdentity, standardBreach, withinStandard } from "./content-standard";
import { htmlToText } from "./wiki-html";
import { anotherArtist, linkedGrounding } from "./musicbrainz";
import { clearClassicalCache, isPersonPage, itemLabels, knownPerson, personItem, placeOrTeam, searchWorks, wholesOf, WikidataBusy, WorkItem, workItems } from "./wikidata";

/**
 * Grounding and screening.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening then drops any sentence
 * whose names, years or platforms the source does not contain. Every check
 * is a string comparison: no second model, no added latency.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT =
  `bubblefacts/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/bubblefacts"})`;

export const MAX_CONTEXT_CHARS = 3000;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
export const MIN_CONTEXT_CHARS = 600;
/** Longest fact that fits a bubble. */
export const MAX_FACT_CHARS = 160;
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

/** Without the quotation marks around it: '"Fantaisie-Impromptu"' is "Fantaisie-Impromptu". */
function unquote(s: string): string {
  const m = /^["“”](.*)["“”]$/.exec(s.trim());
  return (m ? m[1] : s).trim();
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
  // What's left in the brackets once the numbers are out: "(op. 3, no. 1, "Elegie")" names "Elegie";
  // "(L. 75, no. 3, from Suite Bergamasque)" names only the set it's from, which is no other name for it.
  const inner = bracket ? unquote(trimSeparators(bracket[2].replace(/(?:^|[\s,;:])from\s.*$/i, ""))) : "";
  const alias = bracket && !isVariantTag(bracket[2]) ? inner : "";
  if (bracket && (alias || !/[\p{L}\p{N}]/u.test(inner))) t = bracket[1];
  const name = unquote(
    trimSeparators(
      t
        .replace(/\s*[([]\s*[)\]]\s*/g, " ")
        .replace(/\s*,\s*(?:,\s*)+/g, ", ")
        .replace(/\s+/g, " ")
    )
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
function withoutQualifier(title: string): string {
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
  // Single letters aren't significant tokens, so "Luis F. Rodriguez" would match "Luis J. Rodriguez".
  if (initialsDiffer(subject, withoutQualifier(pageTitle))) return false;

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
const ABOUT_MUSIC = /\b(music|songs?|tracks?|themes?|score|melody|melodies|soundtrack|compos\w+|record\w*|lyrics?|riff|chords?|album|tune|piece|arrang\w+|vocals?|piano|guitar|demo|title)\b/i;
/** Sections where creators' comments about the music live. */
const MAKING_HEADING = /recording|composition|production|development|conception|background|writing|music|creation|origin|inspiration/i;
/** Sections that are other people's opinions, later uses, or lists. */
const NOT_THE_MAKERS_HEADING =
  /reception|review|accolade|chart|certification|track listing|personnel|credits|legacy|impact|music video|cover|version|popular culture|media|usage|use in|adaptation|sampl|reference|see also|external|release|commercial|performance/i;
/** Critics, the press and scholars: their views aren't the makers'. */
const CRITIC_WORDS =
  /\b(critics?|reviewers?|magazine|publication|newspaper|journalist|correspondent|writer|musicologist|scholar|author|biograph\w+|documentary|interpreted|ranked|listed|review(?:ed|s)?|praised|called it|charts?|streamed|copies|sold)\b/i;
const CRITIC_NAMES =
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
const REPORTING = /\b(?:said|says|wrote|writes|according to|told|described|called|stated|noted|claimed|recalled|explained)\b/i;
/** A caption that kept a reporting verb (any tense) or quote marks. */
const KEEPS_REPORTING = /\b(?:say|says|said|write|writes|wrote|written|according|tell|tells|told|describe[sd]?|call(?:s|ed)?|state[sd]?|note[sd]?|claim(?:s|ed)?|recall(?:s|ed)?|explain(?:s|ed)?)\b|["“”]/i;
/** Fewer sentences than this in the clean tiers, and the rest of the article is offered too: the writer is asked for 5 captions and 3 spares. */
const TIER_ENOUGH = 8;
/** Body sentences offered last that report what someone said: a caption from one must keep who said it. */
const reportedSentences = new Set<string>();

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

/** Capitalized words that can name a speaker, not sentence openers or the article's own title. */
const NOT_A_SPEAKER = new Set("The A An In On It At By For As When While After Before During This That These Those His Her Their He She They However Also Its According".split(" "));

/**
 * Whether a caption may be shown: true unless the sentence it retells is a
 * tier-4 sentence reporting what someone said, and the caption lost the
 * speaker's name, or kept the name but neither a reporting verb nor quote
 * marks. Offline, captions that kept both erred 12.6%; neither, 45.6%.
 */
export function keepsAttribution(caption: string, context: string): boolean {
  if (!reportedSentences.size) return true;
  const want = contentTokens(caption.replace(/\([^()]*\)/g, " "));
  if (!want.size) return true;
  let best = "";
  let bestShare = 0;
  for (const s of scopeSentences(context)) {
    const have = contentTokens(s.text);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    if (shared / want.size > bestShare) [best, bestShare] = [s.text, shared / want.size];
  }
  if (bestShare < 0.5 || !reportedSentences.has(best) || !REPORTING.test(best)) return true;
  const title = new Set(normalizeTitle(context.split("\n")[0]).split(" "));
  const before = best.split(/["“]/)[0];
  const speakers = new Set(
    [...before.matchAll(/\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+)*/gu)].flatMap((m) =>
      m[0].split(/\s+/).map((w) => w.replace(/[.'’]+$/, "")).filter((w) => !NOT_A_SPEAKER.has(w) && w.length > 2 && !title.has(w.toLowerCase()))
    ).map((w) => w.toLowerCase())
  );
  const words = new Set(caption.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []);
  const named = !speakers.size || [...speakers].some((w) => words.has(w));
  return named && KEEPS_REPORTING.test(caption);
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

const sentencesOf = (text: string) => text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).map((s) => s.trim()));

/** A heading for another recording of the song: "Cover versions", "Gary Jules version", "Other recordings". */
const VERSION_HEADING = /\b(?:versions?|covers?|recordings?|renditions?|remakes?|remix(?:es)?)\b/i;
/** A sentence that says it is about a version: "a cover by...", "the 2001 version by...". */
const VERSION_SENTENCE = /\b(?:covers?|covered|versions?|renditions?|remakes?)\b/i;

/** A version section with no performer in its heading: "Cover versions", "Other recordings". */
const LIST_OF_VERSIONS = /^(?:(?:other|notable|cover|later|selected|alternative|alternate)\s+)*(?:versions?|covers?|recordings?|renditions?|remakes?|remix(?:es)?)$/i;
/** A sentence that gives a recording's own success, not just that it exists. */
const CHART_RECORD = /\b(?:charts?|charted|peak(?:ed|s)?|number(?:-| )(?:one|\d+)|No\. ?\d+|top (?:\d+|ten|forty)|Hot 100|Billboard|certifi\w+|platinum|gold|sold|sales|copies)\b/i;

/** Each section under a version heading, its subsections included: whether the heading names the requested artist, or any performer. */
function versionSections(full: string, names: string[]): Array<{ body: string; own: boolean; list: boolean }> {
  const out: Array<{ level: number; body: string; own: boolean; list: boolean }> = [];
  let open: { level: number; body: string; own: boolean; list: boolean } | null = null;
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    if (open && level > open.level) {
      // A subsection named for one performer is that performer's, whatever the section is.
      if (mentionsName(normalizeTitle(heading), names)) out.push({ level, body, own: true, list: false });
      else open.body += `\n${body}`;
      continue;
    }
    open = VERSION_HEADING.test(heading) ? { level, body, own: mentionsName(normalizeTitle(heading), names), list: LIST_OF_VERSIONS.test(heading.trim()) } : null;
    if (open) out.push(open);
  }
  return out;
}

/**
 * For the original's request, or a song's own article: what would read as this
 * recording's but is another's: a section on one other performer's version
 * ("Gary Jules version"), and elsewhere a sentence on a version's charts or
 * sales, unless it names the requested artist. That others covered the song
 * is true of the song, so "Cover versions" keeps its plain lines.
 */
export function otherVersionsRecord(full: string, artist: string): Set<string> {
  const names = artistNames(artist.replace(/\s*\([^)]*\)\s*$/, ""));
  if (!coverScope.on || !names.length) return new Set();
  const own = (s: string) => mentionsName(normalizeTitle(s), names);
  const drop = versionSections(full, names).filter((v) => !v.own).flatMap((v) => sentencesOf(v.body).filter((s) => !own(s) && (!v.list || CHART_RECORD.test(s))));
  const stated = sentencesOf(full.replace(/^==+.*==+$/gm, "")).filter((s) => VERSION_SENTENCE.test(s) && CHART_RECORD.test(s) && !own(s));
  return new Set([...drop, ...stated]);
}

/** For a cover: the original's sentences that would read as the cover's: its release, charts, sales, video, performers' moves. A section on the requested artist's own version stays. */
export function originalsRecord(full: string, artist = ""): Set<string> {
  const names = artist ? artistNames(artist.replace(/\s*\([^)]*\)\s*$/, "")) : [];
  const own = new Set(versionSections(full, names).filter((v) => names.length && v.own).flatMap((v) => sentencesOf(v.body)));
  return new Set(sentencesOf(full).filter((s) => ORIGINALS_RECORD.test(s) && !own.has(s)));
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
/** A film about a performer, whose lead reads like the performer's: "a 1988 short film about the singer...", not "a film composer". */
const A_FILM_ABOUT = /\b(?:film|movie|documentary|miniseries|novel)\b(?: (?:about|directed|written|based|starring|that)\b|[,.]|$)/i;

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
        if (initialsDiffer(words.slice(i, i + size).join(" "), name)) continue;
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
  const theArtist = !isNonMusicWork(page, full) && !A_FILM_ABOUT.test(says) && (isPerformerArticle(page, full) || (names.includes(normalizeTitle(base)) && !isWorkArticle(page, full)));
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
  // "Superstar: The Karen Carpenter Story" for the Carpenters' song, "Beverly Hills Cop: Axel F" for the theme: a film that
  // uses the name, not where the song comes from. Its article is about the film, even though it names the song.
  if (piece && kind && !title.every((t) => work.includes(t)) && (!work.every((t) => title.includes(t)) || startsWith(title, work))) return unsure(`"${page}" is a ${kind.toLowerCase()}'s article, not the song's`);
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

const bareName = (name: string) => name.replace(/^the /, "");

/**
 * The work match after Wikipedia's page summary (`summaryMismatch`): the reason the
 * article may not be the requested work, or "" when the summary doesn't say so or
 * can't be read. On a person's or a band's article for a song, it also asks whether
 * the song has an article of its own ("Song (Some Band song)", "Song (song)", "Song")
 * that describes it as a song naming the artist: then the artist's article is not the song's.
 * An act that only shares the name, per MusicBrainz, is not the requested one either.
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
    // A band that only shares the name: nothing in the article ties it to the song, and MusicBrainz credits someone else.
    const full = articleText(page);
    if (full && !namesPiece(full, track) && names.map(bareName).includes(bareName(normalizeTitle(withoutQualifier(page)))) && (await anotherArtist(page, track, game))) return `MusicBrainz credits "${track}" to another ${game} than "${page}"`;
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
  const out = listedReadings(song);
  // "Some Song (from Some Show)": the song's own article under the show first. Only that article
  // will do (`trackOnly`), so the usual reading still follows, and its performer's article with it.
  const from = workFromTitle(dropVersionTags(song.title.trim()).replace(TITLE_ARRANGER, ""));
  const at = from ? out.findIndex((r) => r.trackOnly && r.game === from.work && r.track === from.track) : -1;
  return at > 0 ? [out[at], ...out.slice(0, at), ...out.slice(at + 1)] : out;
}

function listedReadings(song: SSLSong): Reading[] {
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
/** The work a song is from, in brackets: "(from Some Show)", "(From "Some Film")". */
const FROM_TAG = /\s*[([]\s*from\s+["“'‘]?([^)\]]*?)["”'’]?\s*[)\]]/i;
/**
 * The work after "from" with no brackets: "Some Song from Some Long Show". Two capitalized words
 * at least, so "Pennies from Heaven" and "The Girl from Ipanema" stay whole.
 */
const FROM_WORK = /^(.+?)\s+[Ff]rom\s+((?:the\s+)?\p{Lu}[\p{L}'’.]*(?:\s+(?:of|the|and|in|on|a|an|to|for|&|\p{Lu}[\p{L}'’.]*|\d+))*\s+\p{Lu}[\p{L}'’.]*(?:\s+\d+)?)\s*$/u;
/** An arranger after the title: "Some Song arr. Some Pianist", "Some Song arranged by Some Pianist". */
const TITLE_ARRANGER = /\s+(?:arr\.|arranged by|arrangement by)\s+\S.*$/i;
/** A track number before the title: "14. Some Song". "1979", "7 AM" and "99 Luftballons" have no period after the number. */
const TRACK_NUMBER = /^\d{1,3}\.\s+(?=\p{L})/u;
/** An arranger's mark between two names: "Some Pianist (arr) Some Composer" is Some Composer's piece. */
const ARRANGED_BY_FIRST = /^.*?\S\s*[([]\s*arr(?:\.|anged|anger)?\s*[)\]]\s*(\p{L}.*)$/iu;

/** The work a title names after "from", bracketed or not, or "": "Some Song (from Some Show)" is from "Some Show". */
export function workFromTitle(title: string): { track: string; work: string } | null {
  const tag = FROM_TAG.exec(title);
  const bare = tag ? null : FROM_WORK.exec(title.trim());
  const found = tag
    ? { track: (title.slice(0, tag.index) + title.slice(tag.index + tag[0].length)).trim(), work: tag[1].replace(/\s+/g, " ").trim() }
    : bare && { track: bare[1].trim(), work: bare[2].trim() };
  // "Theme from Some Show" names no piece of its own: the show's article is another rule's (themeOf).
  if (!found || !found.track || !found.work || GENERIC_TRACK.test(normalizeTitle(found.track)) || /\btheme$/i.test(found.track)) return null;
  return found;
}

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
  // Who arranged it isn't who wrote it: "Some Show arr. Some Pianist", "Some Pianist (arr) Some Composer".
  artist = ARRANGED_BY_FIRST.exec(artist)?.[1].trim() ?? artist;
  if (/\p{L}/u.test(artist.replace(ARRANGER, ""))) artist = artist.replace(ARRANGER, "").trim();
  let title = song.title.replace(YEAR_TAG, "").replace(FEATURED_TAG, "").trim();
  // A list's own notes in the title: a track number, an arranger, the work it's from (another reading's job).
  title = title.replace(TRACK_NUMBER, "").replace(TITLE_ARRANGER, "").trim();
  title = workFromTitle(title)?.track ?? title;
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
  // "Some Song (from Some Show)", "Some Song from Some Long Show": the show is the work, as a game in the artist field is.
  const from = workFromTitle(title.replace(TITLE_ARRANGER, ""));
  if (from) return [{ game: from.work, track: from.track, trackOnly: true }];
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
 * Two names whose initials differ in the same place: "Luis F. Rodriguez" and
 * "Luis J. Rodriguez" are two people, though only one letter apart.
 */
export function initialsDiffer(a: string, b: string): boolean {
  const wa = normalizeTitle(a).split(" ");
  const wb = normalizeTitle(b).split(" ");
  return wa.length === wb.length && wa.some((w, i) => w !== wb[i] && w.length === 1 && wb[i].length === 1);
}

/**
 * The same name spelled differently: a letter or two, in one word, or only
 * the spacing ("Full Metal" and "Fullmetal"). "Eric Satie" and "Erik Satie",
 * but not "Windy Harper" and "Wendy Harmer", two words apart.
 */
export function isRespelling(name: string, page: string): boolean {
  const a = normalizeTitle(name);
  const b = normalizeTitle(page);
  if (!a || !b || a === b) return false;
  if (initialsDiffer(a, b)) return false;
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
export async function fetchGrounding(listed: SSLSong, skip: ReadonlySet<string> = new Set()): Promise<string> {
  // Who asked or paid for the song is never searched: "Some Band, Commissioned by Name" is Some Band.
  const title = withoutRequestCredit(listed.title) || listed.title;
  const artist = withoutRequestCredit(listed.artist ?? "", true);
  const song = title === listed.title.trim() && artist === (listed.artist ?? "").trim() ? listed : { ...listed, title, artist };
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
  // Still nothing for "Some Name Theme": the article of what the theme is named for, gated.
  return linked || (isPlaceholderRequest(song) ? "" : await themeGrounding(song, usable));
}

/** "Some Name Theme", "Some Name Main Theme", "Theme from Some Name": the name the theme is named for, or "" (one word or none). */
export function themeOf(title: string): string {
  const t = dropVersionTags(title.trim());
  const name = (/^(.+?)\s+(?:main\s+)?theme$/i.exec(t)?.[1] ?? /^theme\s+from\s+(.+)$/i.exec(t)?.[1] ?? "").replace(/\s*[-–—:]$/, "").trim();
  // Two words or more: "Love Theme" and "Halloween Theme" name an everyday word's article, not a work's.
  const n = normalizeTitle(name);
  return significantTokens(n).length >= 2 && !GENERIC_TRACK.test(n) ? name : "";
}

/** A section about the subject's own music: "Song", "Music", "Theme song", "Soundtrack". */
const OWN_MUSIC_HEADING = /^(?:the )?(?:songs?|music|theme(?: songs?| music| tune)?|soundtracks?|score|jingles?|music and sound)$/i;
/** A word in the lead for music the subject has: "merged a Japanese denpa song with an animated cat". */
const OWN_MUSIC_WORD = /\b(?:songs?|tunes?|themes?|melod(?:y|ies)|jingles?|music)\b/i;
/** A person's lead: "(born 1967)", "(1900–1980)". */
const LIFE_DATES = /\((?:[^()]*\b)?(?:born|died|née)\b|\(\s*(?:c\.\s*)?\d{3,4}\s*[–-]\s*\d{3,4}\s*\)/;

/**
 * The lead and the sections about the subject's own music, subsections and all, or "" when the
 * article has no such section or its lead never says the subject has music (`themeGrounding`).
 */
export function ownMusicParts(full: string): string {
  const [lead, ...rest] = full.split(/\n(?===)/);
  if (!OWN_MUSIC_WORD.test(lead)) return "";
  const kept: string[] = [];
  let under = 0;
  for (const chunk of rest) {
    const h = /^(=+)\s*([^=\n]+?)\s*=+/.exec(chunk);
    if (!h) continue;
    const level = h[1].length;
    if (under && level <= under) under = 0;
    if (!under && OWN_MUSIC_HEADING.test(h[2])) under = level;
    if (under) kept.push(chunk.trim());
  }
  return kept.length ? [lead.trim(), ...kept].join("\n\n") : "";
}

const themeCache = new Map<string, { text: string; at: number }>();

/**
 * For "Some Name Theme" that every reading missed: the "Some Name" article, when it isn't a
 * person's and says the subject has music of its own (`ownMusicParts`), cut to its lead and those
 * sections. The artist may be an arranger the article never names ("Nyan Cat Theme" by a chiptune
 * artist is the Nyan Cat video's song). Never when a performer has the artist's name, or "".
 */
async function themeGrounding(song: SSLSong, usable: (title: string) => boolean): Promise<string> {
  const name = themeOf(song.title);
  if (!name || song.artistUncertain) return "";
  const artist = (song.artist ?? "").trim();
  const key = `${normalizeTitle(name)}\0${normalizeTitle(artist)}`;
  const hit = themeCache.get(key);
  if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.text && usable(hit.text.split("\n")[0]) ? hit.text : "";
  const refuse = (why: string) => {
    console.log(`[Grounding] "${song.title}": ${why}, not taking it for the theme`);
    themeCache.set(key, { text: "", at: Date.now() });
    return "";
  };
  try {
    if (artist && !hasNoArtist(artist) && (await performerPages(artist.replace(/\s*\([^)]*\)\s*$/, ""), song.title)).performer) return refuse(`a performer is called "${artist}"`);
    const found = (await wikiResolveTitles([name])).get(name);
    if (!found || found.fragment || !usable(found.page) || normalizeTitle(withoutQualifier(found.page)) !== normalizeTitle(name)) return refuse(`no article is called "${name}"`);
    const page = found.page;
    const full = await wikiExtract(page);
    if (!full) return refuse(`"${page}" can't be read`);
    if (isPerformerArticle(page, full) || LIFE_DATES.test(full.slice(0, 400)) || (await isPersonPage(page))) return refuse(`"${page}" is a person's article`);
    const parts = ownMusicParts(full);
    if (!parts) return refuse(`"${page}" never says it has music of its own`);
    const budget = MAX_CONTEXT_CHARS - page.length - 1;
    const extract = ownArticleExtract(parts, budget, [name]);
    if (extract.length < MIN_CONTEXT_CHARS) return refuse(`"${page}" is too short to write from (${extract.length} chars)`);
    const text = `${page}\n${writingText(parts, extract, budget, [name])}`;
    console.log(`[Grounding] "${song.title}" -> ${page} (${text.length} chars, the article of what the theme is named for: its lead and music only)`);
    themeCache.set(key, { text, at: Date.now() });
    return text;
  } catch {
    // Throttled or unreachable: nothing is remembered, and it's asked again next time.
    return "";
  }
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
): Promise<{ page: string; subject: boolean; music?: boolean } | "reject" | null> {
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
  // No performer of the name: a show's or a film's music article whose track listing has the track ("Music of Some Show").
  const music = nonMusic && !concert && !song.performer && !reading.aPerformer ? await listingMusicArticle(artist, track, usable) : null;
  if (music && music !== page) return { page: music, subject: true, music: true };
  return "reject";
}

/** The titles in an article's {{Track listing}} templates, without links, refs or bold. */
export function listedTracks(wikitext: string): string[] {
  const out: string[] = [];
  for (const m of wikitext.matchAll(/\{\{\s*track ?listing\b/gi)) {
    // To the template's own closing braces, past the ones nested in it.
    let depth = 0;
    let end = m.index;
    while (end < wikitext.length) {
      if (wikitext.startsWith("{{", end)) (depth++, (end += 2));
      else if (wikitext.startsWith("}}", end)) {
        end += 2;
        if (--depth === 0) break;
      } else end++;
    }
    const block = wikitext
      .slice(m.index, end)
      .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
      .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
      .replace(/'{2,}/g, "");
    for (const t of block.matchAll(/\|\s*title\d+\s*=([^|\n]*)/gi)) if (t[1].trim()) out.push(t[1].trim());
  }
  return out;
}

/**
 * A show's or a film's own music article ("Music of Some Show", "Some Show
 * (soundtrack)") that names the track as music or lists it on one of its
 * albums, or null. Its prose may never name a short cue that its track
 * listings do ("Green Bird" | "Cowboy Bebop").
 */
async function listingMusicArticle(work: string, track: string, usable: (title: string) => boolean): Promise<string | null> {
  const name = normalizeTitle(track);
  if (!work || name.length < 3 || GENERIC_TRACK.test(name)) return null;
  const named = await wikiResolveTitles([`Music of ${work}`, `${work} (soundtrack)`]);
  for (const page of new Set([...named.values()].filter((r) => !r.fragment).map((r) => r.page))) {
    if (!usable(page) || !isMusicArticleFor(page, work)) continue;
    const full = await wikiExtract(page);
    if (!full) continue;
    const listed = listedTracks(await wikitextOf(page)).some((t) => normalizeTitle(t) === name);
    if (listed || namesPiece(full, track)) return page;
  }
  return null;
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
      // Taken in place of the search's page: never read as a longer-named installment of the subject.
      let swapped = false;
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
          const what = swap.music ? "the work's music article, which lists the track" : swap.subject ? "the performer's article" : "the song's own article";
          console.log(`[Grounding] "${page}" -> ${swap.page} (${what})`);
          page = swap.page;
          full = songFull ?? (await wikiExtract(page));
          byGame = swap.subject;
          toPerformer = swap.subject && !swap.music;
          swapped = true;
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
      const installment = byGame && !swapped && extendsGame(page) && track !== game && !reading.page;
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
      const others = !cover && !byGame && ownArticle && artist && full ? otherVersionsRecord(full, game) : null;
      const drop = cover ? originalsRecord(full!, game) : others?.size ? new Set([...(otherWork ?? []), ...others]) : otherWork;
      let text = withoutSentences(drop, saves && !cover, () =>
        scoped
          ? `${page}\n${writingText(scoped, orderExtract(scoped, MAX_CONTEXT_CHARS - page.length - 1, [track], false), MAX_CONTEXT_CHARS - page.length - 1, [track])}`
          : `${page}\n${full ? writingText(full, extract, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track]) : extract}`
      );
      // "Chrono Trigger" and "Kingdom Hearts" read like people's names, so the article decides: is it a game's?
      const aGame = !artist || /game\)$/i.test(page) || GAME_LEAD.test(full?.slice(0, 600) ?? "");
      if (byGame && aGame && !swapped && !song.performer && !ownArticle && !installment && full) {
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
  themeCache.clear();
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

// --- Screening ---------------------------------------------------------

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

/**
 * Dropped even when the source says so. Critics' opinions read as facts on
 * stream and make the real facts harder to trust (issue #21), and the music
 * video's plot or look is what viewers are already watching (issue #20).
 */
const OPINION = /\b(considered (?:one|to be|as|by|a|an|among|the (?:best|greatest|finest|most|top))|(?:among|some of) the (?:best|greatest|finest|most)|instantly recognizable|regarded|praised|acclaimed|hailed|lauded|critics?|critically|masterpiece|greatest|iconic|beloved|celebrated|described as|one of the (best|finest|most))\b/i;
/**
 * Things no song fact contains, whatever the source says: a link, a chat
 * command or an @mention. A crafted request title or a vandalized article is
 * the only way one gets into a caption.
 */
const NOT_FOR_STREAM: Array<{ re: RegExp; label: string }> = [
  { re: /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(com|net|org|tv|gg|io|ly|co|me|be|xyz|link)\b/i, label: "a link" },
  { re: /(^|\s)![a-z]/i, label: "a chat command" },
  { re: /(^|\s)@\w/, label: "an @mention" },
];

/**
 * The music video, or its shoot: "the original video", "after filming stopped",
 * "the video shoot". Never "the video game" or "in the video game".
 */
const ABOUT_THE_VIDEO =
  /\b(?:music videos?|video clips?|(?:in )?the (?:(?:original|first|second|third|official|accompanying|later|new|lyric) )?videos?(?!\s*games?\b)|filming|(?:video |photo )?shoots?(?!\s*['’]?em\b|-em))\b|(?:['’]s?|\b(?:his|her|their|its))\s+(?:(?:official|music|lyric) )?videos?\b(?!\s*games?\b)/iu;

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
/** Capitalized words, including "McCartney"; two or more, or a single Mc- surname. */
/** "DeVoe", "LaBelle" and "YouTube" are one word each. */
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*)`;
const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy(?: Advance| Colou?r)?|Nintendo DS|3DS|PlayStation(?: [2-5]| Portable| Vita)?|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

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
    ? namesPlatform(p[0].toUpperCase() + p.slice(1), context, "")
    : namesPlatform(p, context);
  return direct || (PLATFORM_ALIASES.get(p) ?? []).some((a) => namesPlatform(a, context));
}

/** What turns one console's name into its sibling's: "Wii U", "PlayStation 4", "Game Boy Advance". */
const SIBLING_SUFFIX = /^[\s-]+(?:U|[2-5]|360|One|Series|Advance|Colou?r|Portable|Vita|Pocket|DSi?|XL|Lite)(?![\p{L}\p{N}])/iu;

/**
 * The platform named on its own, not only as part of a sibling's name: a
 * source about the Wii U doesn't support "came out on the Wii" (review).
 */
function namesPlatform(name: string, context: string, flags = "i"): boolean {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, `g${flags}u`);
  for (const m of context.matchAll(re)) {
    if (!SIBLING_SUFFIX.test(context.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

/** Leading words that make a capitalized run look like a name when it isn't one. */
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
  // "influenced by Western action movies": a place or people, not a person.
  "western", "eastern", "northern", "southern", "british", "irish", "scottish", "italian",
  "spanish", "russian", "chinese", "korean", "asian", "african", "latin", "celtic",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * The first capitalized name in the fact that the reference doesn't contain.
 * Each word must appear as a whole word, which tolerates "Koshiro" alone or a
 * different romanization of the given name, but not "Ed" inside "played".
 */
/**
 * Kinds of credit, and the words that state each. A fact giving someone a
 * credit needs a sentence in the source that names them with the same kind
 * of credit: "John Smith directed the game" doesn't support "John Smith wrote
 * the soundtrack" (issue from review). Writing music counts as composing.
 */
const ROLES: Array<{ fact: RegExp; source: RegExp; musicOnly?: boolean }> = [
  // "Matsuno wrote the story" is no composing credit: "wrote" counts only next to music ("wrote the score", "music was written by").
  { fact: /\b(compos\w*|scored|wr[io]te\s+the\s+(music|score|soundtrack)|written\s+the\s+(music|score|soundtrack)|music\s+(was\s+)?(written|composed)\s+by)\b/i, source: /\b(compos\w*|scored|wr[io]te|written|writer)\b/i, musicOnly: true },
  { fact: /\b(wr[io]te|written|penned|lyrics?)\b/i, source: /\b(wr[io]te|written|writ\w*|lyric\w*|penned|songwrit\w*|compos\w*)\b/i },
  { fact: /\bproduc\w*/i, source: /\bproduc\w*/i },
  { fact: /\bdirect\w*/i, source: /\bdirect\w*/i },
  { fact: /\b(performed|sang|sung|sings|vocals?|recorded)\b/i, source: /\b(perform\w*|sang|sung|sing\w*|vocal\w*|record\w*|band|singer|rapper|musician)\b/i },
  { fact: /\b(designed|developed)\b/i, source: /\b(design\w*|develop\w*)\b/i },
  // "Kana Mizuki illustrated the novels" when the source has them "written by Mizuki and illustrated by Aki Tanabe".
  { fact: /\billustrat(?:ed|es|ions?)\b/i, source: /\billustrat\w*/i },
];
/** What "wrote" must be followed by to mean composing: "wrote the music", "wrote its score". */
const MUSIC_OBJECT = /^(music|musical|score|scores|soundtrack|soundtracks|theme|themes|songs?|melod\w*|tunes?|pieces?|instrumentals?)$/;
/** "Adele composed", "Mia Chen and Toby Fox wrote": a capitalized name right before a credit verb. */
const ACTIVE_NAME = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|originally\s+)?(?:composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|illustrated)\b/gu;
/** Words between a name and its role word, at most, for the source to count as stating that role. */
const ROLE_REACH = 6;
/** The performing family: "Coldplay are a British rock band" is stated loosely, and a mix-up there is harmless. */
const LOOSE_ROLE = /perform/;
/** Any credit verb: a name right before one is that verb's subject, not the end of an earlier list. */
const CREDIT_VERB = /^(composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|arranged|published|illustrated)$/i;
/** "music by", "lyrics by": a noun that credits whoever follows "by". */
const BY_NOUN: Array<{ noun: RegExp; means: RegExp }> = [
  { noun: /^(music|score|soundtrack)$/i, means: /compos/ },
  { noun: /^lyrics?$/i, means: /lyric/ },
];
const NAME_PARTICLE = /^(de|van|von|da|del|la|le|and|&|,)$/i;
/** Words that describe whoever follows "by": "by singer-songwriters", "by the band", "by producer". */
const DESCRIPTOR = /^(?:[\p{L}-]*(?:er|ers|or|ors|ist|ists|ian|ians)|the|band|bands|duo|group|trio|team|his|her|their)$/u;

/**
 * Whether one source sentence gives this person this kind of credit. Being
 * near a role word isn't enough: "John Smith directed, while Mia Chen
 * composed the music" credits Smith with directing only (final QA #1). The
 * sentence has to tie the two together one of three ways:
 *
 *   active   "Smith [and Chen] directed", "Smith directed the game and composed its music"
 *            (only plain words in between: no comma, no other name, and the verb isn't "... by" someone)
 *   passive  "composed [and arranged] by [Chen and] Smith", "music by Smith"
 *            (Smith isn't the subject of a verb that follows)
 *   title    "composer [Mia] Chen"
 *
 * Anything else is ambiguous, and an ambiguous credit is dropped.
 */
function statesRole(sentence: string, surname: string, role: { source: RegExp; musicOnly?: boolean }): boolean {
  const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*|[,;]/gu) ?? [];
  const lower = tokens.map((t) => t.toLowerCase().replace(/['’]s$/, "").replace(/\.+$/, ""));
  const isName = (i: number) => /^\p{Lu}/u.test(tokens[i]) && !NAME_STOPWORDS.has(lower[i]);
  /** In a list of credited names, any capitalized word counts: "Falcom Sound Team jdk". */
  const noCaps = sentence === sentence.toLowerCase(); // Lowercased text can't show where a name ends.
  const isCap = (i: number) => noCaps || /^\p{Lu}/u.test(tokens[i] ?? "");
  const isRole = (i: number) =>
    role.source.test(lower[i]) &&
    !(role.musicOnly && /^(wr[io]te|written|writer)$/.test(lower[i]) && ![...lower.slice(Math.max(0, i - 3), i), ...lower.slice(i + 1, i + 4)].some((w) => MUSIC_OBJECT.test(w)));
  const at = lower.flatMap((w, i) => (w === surname ? [i] : []));
  if (!at.length) return false;
  if (LOOSE_ROLE.test(role.source.source)) return lower.some((_, j) => isRole(j) && at.some((i) => Math.abs(i - j) <= ROLE_REACH));

  return at.some((i) => {
    for (let j = 0; j < tokens.length; j++) {
      const byNoun = BY_NOUN.some((b) => b.noun.test(lower[j]) && b.means.test(role.source.source) && lower[j + 1] === "by");
      if (!isRole(j) && !byNoun) continue;
      if (j > i) {
        // Active: the rest of a name list, then plain words, then the verb.
        if (j - i - 1 > ROLE_REACH || lower[j + 1] === "by" || lower[j + 2] === "by") continue;
        let k = i + 1;
        while (k < j && (isName(k) || NAME_PARTICLE.test(lower[k]))) k++;
        if (lower[k - 1] === "," && lower[k] === "who") k++; // "Chen, who composed"
        else if (lower[k - 1] === "," && k < j) continue;
        let plain = true;
        for (; k < j; k++) if (isName(k) || /^[,;]$/.test(tokens[k]) || /^(while|whereas|but|although)$/.test(lower[k])) plain = false;
        if (plain) return true;
      } else if (j < i) {
        const span = lower.slice(j + 1, i);
        const by = span.indexOf("by");
        if (by === -1) {
          // Title: "composer Mia Chen".
          if (/(er|or|ist)$/.test(lower[j]) && span.every((_, n) => isCap(j + 1 + n))) return true;
          continue;
        }
        // Passive: a few plain words, "by", then only names up to this one.
        const before = span.slice(0, by);
        const list = span.slice(by + 1);
        if (before.length > 3 || before.some((w) => /^[,;]$/.test(w))) continue;
        // "written by singer-songwriters Eugene Wilde and Albert Manno": a descriptor may come first.
        let d = 0;
        while (d < 2 && d < list.length - 1 && DESCRIPTOR.test(list[d]) && !/^\p{Lu}/u.test(tokens[j + 2 + by + d])) d++;
        if (!list.slice(d).every((w, n) => isCap(j + 2 + by + d + n) || NAME_PARTICLE.test(w))) continue;
        if (CREDIT_VERB.test(lower[i + 1] ?? "") && lower[i + 2] !== "by") continue; // "... and Smith directed"
        return true;
      }
    }
    return false;
  });
}

/**
 * The source's sentences for the credit and award checks. A middle initial
 * ends no sentence: "produced by Barry J. Eastmond" stays whole.
 */
const sourceSentences = (context: string) => context.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?])\s+|\n+/u);

/** "by Adele", "by Nobuo Uematsu": a capitalized name after "by". */
const BY_NAME = /\bby\s+((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|de|van|von|da|del|la|le))*)/gu;

/** A credit shared "with" others: "co-wrote the song with A and B". */
const WITH_NAMES =
  /\b(?:co-?)?(?:wr[io]te|written|composed|produced|penned)\b[^.;]*?\b(?:with|alongside)\s+(?:(?:co-)?\p{Ll}[\p{Ll}-]*er\s+)?((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:(?:\s+|\s*,\s*)(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|and|&|de|van|von))*)/gu;

/** The names a fact credits: a name after "by", right before a credit verb, or sharing the credit "with" them. */
function creditedNames(fact: string): string[] {
  const names = new Set<string>();
  for (const m of fact.matchAll(BY_NAME)) names.add(m[1].trim().replace(/[.'’-]+$/, ""));
  for (const m of fact.matchAll(ACTIVE_NAME)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length) names.add(words.join(" "));
  }
  // "Babyface wrote it with L.A. Reid and Daryl Simmons": the partners get the same credit.
  for (const m of fact.matchAll(WITH_NAMES)) {
    for (const n of m[1].split(/\s*,\s*|\s+(?:and|&)\s+/)) if (/^\p{Lu}/u.test(n.trim())) names.add(n.trim().replace(/[.'’-]+$/, ""));
  }
  // Only names in a credit's own grammar count: "by Name", "Name composed". Any
  // other capitalized pair in the sentence is usually a game or a place: "composed
  // the music for Chrono Trigger" doesn't credit Chrono Trigger. On a live stream
  // that rule dropped true facts on most game tracks (October 1 log).
  return [...names];
}

/**
 * A credit the source doesn't give: a named person in a role (composed,
 * wrote, produced, directed, performed, designed) with no source sentence
 * naming them in that kind of role. Returns the name, or null.
 */
export function unsupportedCredit(fact: string, context: string): string | null {
  let roles = ROLES.filter((r) => r.fact.test(fact));
  // "wrote the music" is a composing credit: the plain writing role would accept "wrote the story".
  if (roles.includes(ROLES[0]) && !/\b(lyric\w*|words)\b/i.test(fact)) roles = roles.filter((r) => r !== ROLES[1]);
  if (!roles.length) return null;
  const sentences = sourceSentences(context);
  for (const name of creditedNames(fact)) {
    const words = name.split(/\s+/);
    const surname = (words.pop() ?? name).toLowerCase();
    // "Paul Williams composed the score" isn't supported by "John Williams composed the score".
    // The name just before the surname: "Michael" in "Narada Michael Walden", "Jimmy" in "Engineer Jimmy Douglass".
    const given = words.filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()) && !/^\p{Lu}\.$/u.test(w)).pop();
    const stated = sentences.some((sentence) => roles.some((r) => statesRole(sentence, surname, r)) && sameGivenName(sentence, surname, given));
    if (!stated) return name;
  }
  return null;
}

/**
 * Whether a source sentence names this surname for the same person: with
 * the fact's given name (or its initial), or bare ("Koshiro composed",
 * which a different romanization of the given name still matches), but not
 * with another given name.
 */
function sameGivenName(sentence: string, surname: string, given: string | undefined): boolean {
  if (!given) return true;
  const g = given.replace(/\.$/, "").toLowerCase();
  // A middle initial between them is skipped: "Barry J. Eastmond".
  const re = new RegExp(`(?:([\\p{L}.'’-]+)\\s+)?(?:\\p{Lu}\\.\\s+)?${escapeRe(surname)}(?![\\p{L}])`, "giu");
  for (const m of sentence.matchAll(re)) {
    const before = (m[1] ?? "").replace(/\.$/, "");
    if (!/^\p{Lu}/u.test(before) || NAME_STOPWORDS.has(before.toLowerCase())) return true;
    const b = before.toLowerCase();
    if (b === g || (b.length === 1 && g.startsWith(b)) || (g.length === 1 && b.startsWith(g))) return true;
  }
  return false;
}

/** "Audrey Hepburn won", "Mancini received": a capitalized name right before winning something. */
const WINNER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+)?(?:won|received|earned|was awarded)\b/gu;
const WON = { source: /^(won|wins|winning|awarded|received|earned|winner)$/i };

/**
 * A named winner the source doesn't name as the winner. "The song won an
 * Academy Award" doesn't make its singer the winner (seen replaying a
 * stream: Moon River and Audrey Hepburn). The work itself, named as the
 * article is titled, is left to the award checks.
 */
export function unsupportedWinner(fact: string, context: string): string | null {
  const article = normalizeTitle(context.split("\n")[0]);
  const sentences = sourceSentences(context);
  for (const m of fact.matchAll(WINNER)) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    const name = words.join(" ");
    if (article && mentionsName(article, [normalizeTitle(name)])) continue;
    const surname = words[words.length - 1].toLowerCase();
    if (!sentences.some((s) => statesRole(s, surname, WON))) return name;
  }
  return null;
}

export function unsupportedName(fact: string, context: string): string | null {
  // A single-word name after "by" or before a credit verb ("composed by Adele",
  // "Adele composed") must be there too.
  for (const m of [...fact.matchAll(BY_NAME), ...fact.matchAll(ACTIVE_NAME)]) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length && !words.every((w) => hasWord(w, context))) return words.join(" ");
  }
  for (const candidate of fact.match(NAME) ?? []) {
    // "Colonel Abrams' track": the possessive isn't part of the name.
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, ""));
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    const isName = words.length >= 2 || /^Mc/.test(words[0] ?? "");
    if (!isName || words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    if (words.every((w) => hasWord(w, context))) continue;
    return words.join(" ");
  }
  return null;
}

/** The labels a reference puts before the sentences it lifts (`orderExtract`). */
const REFERENCE_LABEL = /^(About this piece|From the people who made it|How the music is built|How it was received): /;
/** A sentence break: not after a middle initial ("Barry J. Eastmond"), and only before a capital. */
const SENTENCE_BREAK = /(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u;

/** One line of a reference split into its sentences, without the label. */
const lineSentences = (line: string) =>
  line.replace(REFERENCE_LABEL, "").split(SENTENCE_BREAK).map((s) => s.trim()).filter((s) => s && !/^==/.test(s));

/**
 * Every sentence of a reference after its title line, in order: the sentences
 * the prompt numbers for the model to cite (`numberedReference`). Sentence N is
 * `referenceSentences(context)[N - 1]`.
 */
export function referenceSentences(context: string): string[] {
  return context.split("\n").slice(1).flatMap(lineSentences);
}

/**
 * The reference as the model sees it when it must cite: the title line, each
 * label on a line of its own, and every sentence numbered, "[3] ...".
 */
export function numberedReference(context: string): string {
  const [title, ...lines] = context.split("\n");
  const out = [title];
  let n = 0;
  for (const line of lines) {
    const label = REFERENCE_LABEL.exec(line)?.[1];
    if (label) out.push(`${label}:`);
    const sentences = lineSentences(line);
    if (!sentences.length && !line.trim()) out.push("");
    for (const sentence of sentences) out.push(`[${++n}] ${sentence}`);
  }
  return out.join("\n");
}

/** The reference's sentences, without its own labels, for matching a caption to the one it retells. */
function bodySentences(context: string): string[] {
  return referenceSentences(context).filter((s) => s.length >= 20);
}

/**
 * The sentence the model cited for the caption being screened. While it's set,
 * that sentence is the one the caption retells: no guessing by shared words.
 */
let citing: { fact: string; sentence: string } | null = null;

/** How much of a caption's content one sentence holds. */
function share(fact: string, sentence: string): number {
  const want = contentTokens(fact.replace(/\s*\([^)]*\)/g, ""));
  if (!want.size) return 0;
  const have = contentTokens(sentence);
  let shared = 0;
  for (const t of want) if (have.has(t)) shared++;
  return shared / want.size;
}

/**
 * The sentences a caption most likely retells: the best match, and any
 * nearly as good. None when even the best holds under a quarter of it.
 */
export function retoldSentences(fact: string, context: string): string[] {
  if (citing?.fact === fact) return [citing.sentence];
  const scored = bodySentences(context).map((s) => ({ s, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  return best < 0.25 ? [] : scored.filter((x) => x.share >= best - 0.1).map((x) => x.s);
}

/**
 * How well the reference supports a caption: the share of its words in the
 * sentence it cites, or else in the best-matching sentence.
 */
export const support = (fact: string, context: string, cited?: string) =>
  cited !== undefined ? share(fact, cited) : Math.max(0, ...bodySentences(context).map((s) => share(fact, s)));

/** Counts and ordinals written as words, for reading the numbers in a caption (`DIGIT_OF`). */
const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "hundred", "dozen"];
const ORDINALS = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/**
 * Words that join two statements into a cause, an order, an intention or a
 * count. Names and years in a merged caption are all in the source, so only
 * the joining word is new: "Marth and Roy appeared in Melee due to the success
 * of Advance Wars" when the source says the two together "led to" a
 * localization. Each is kept only when the sentence the caption retells has
 * a word of the same kind.
 */
const CONNECTIVES: Array<{ label: string; fact: RegExp; source: RegExp }> = [
  { label: "a cause", fact: /\b(due to|because|owing to|thanks to|as a result)\b/i, source: /\b(due to|because|owing to|thanks to|as a result|since|so|as (?:he|she|they|it|the|a|his|her|their))\b/i },
  { label: "a consequence", fact: /\b(led to|leading to|lead to|resulted in|prompted|caused)\b/i, source: /\b(led|lead|leading|result\w*|prompt\w*|caus\w*)\b/i },
  { label: "an order", fact: /\bafter\b/i, source: /\b(after|following|afterwards?|previously|when|once|upon|then|subsequently)\b/i },
  { label: "an order", fact: /\bbefore\b/i, source: /\b(before|prior|earlier|previously|until|first|originally)\b/i },
  { label: "a first", fact: /\b(?:for )?the first time\b|\bfirst[- ]ever\b/i, source: /\bfirst\b|\bdebut/i },
  { label: "an intention", fact: /\boriginally (?:intended|meant|planned|supposed)|\b(?:was|were) (?:intended|meant|supposed|planned|going) to\b/i, source: /\b(originally|intend\w*|meant|plann?\w*|suppos\w*|initially)\b/i },
  { label: "a count", fact: /\b(twice|thrice|again|\w+ times)\b/i, source: /\b(twice|thrice|again|\w+ times|re-\w+|re(?:issued|released|recorded|turned|appeared|entered))\b/i },
  // "was originally titled X" when the source just names X; "was originally a cover" when someone later covered it.
  { label: "a former title", fact: /\boriginally (?:titled|called|named|known)\b|\bgoing to be (?:titled|called|named)\b/i, source: /^(?=.*\b(?:original\w*|initial\w*|intend\w*|meant|plann?\w*|working title|formerly|previously|renam\w*|retitl\w*)\b)(?=.*\b(?:titl\w*|call\w*|nam\w*|known)\b)/is },
  // "originally from Okinawa", "originally formed in" only say where someone comes from.
  { label: "an origin", fact: /\boriginally\b(?!\s+(?:from|formed|based|born|hails?|titled|called|named|known|intended|meant|planned|supposed|going)\b)/i, source: /\b(original\w*|initial\w*|first|earlier|early|previously|formerly|began|before|pre-\w+|at the time)\b/i },
  // "X performed in 1884, inspiring Y to write Z": a source that only says Z resembles X's piece states no prompt.
  { label: "a prompt", fact: /\binspir(?:ed|ing|es)\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*\s+){1,3}to\b/u, source: /\b(inspir\w*|prompt\w*|led|motivat\w*|encourag\w*|persuad\w*|convinc\w*|urged)\b/i },
  // "The riff was inspired by X" when the source says it resembles X.
  { label: "an influence", fact: /\b(inspir\w*|influenc\w*)\b/i, source: /\b(inspir\w*|influenc\w*|based on|model\w*|drew|draws?|drawn|borrow\w*|deriv\w*|homage|tribute|took reference|references?)\b/i },
  // "born on 17 December" when the source gives the baptism.
  { label: "a birth", fact: /\bborn\b/i, source: /\b(born|birth\w*)\b/i },
  // "one week after its first performance" when the source says "after a performance in Leipzig".
  { label: "a first", fact: /\bfirst\b/i, source: /\b(first|1st|debut\w*|premiere\w*|original\w*|initial\w*|earliest|began|begin\w*|start\w*|introduc\w*|launch\w*|new)\b/i },
];
const DIGIT_OF: Record<string, string> = Object.fromEntries([...NUMBER_WORDS.slice(0, 19).map((w, i) => [w, String(i + 2)]), ["thirty", "30"], ["forty", "40"], ["fifty", "50"], ...ORDINALS.map((w, i) => [w, `${i + 2}`])]);

/**
 * The caption with the names of works blanked out, so a joining word inside
 * a title ("After Burner", "Because of You") isn't read as one. A title is
 * known when it is the article's own (first line), the song's, or a run of
 * capitalized words that starts at the joining word and is in the source
 * exactly as written.
 */
function withoutTitles(fact: string, context: string, titles: string[]): string {
  // Two words or more: a one-word title such as "Because" would blank every capitalized use of the word.
  const own = [withoutQualifier(context.split("\n")[0]), ...titles].map((t) => t.trim()).filter((t) => t.length >= 3 && /\s/.test(t));
  // A run counts as a name only where the source has it mid-sentence, not where it merely opens a sentence.
  const midSentence = (span: string) => new RegExp(`[\\p{L}\\p{N},;:'’"”)]\\s+${escapeRe(span)}(?![\\p{L}\\d])`, "u").test(context);
  let out = fact;
  for (const t of own) out = out.replace(new RegExp(`(?<![\\p{L}\\d])${escapeRe(t)}(?![\\p{L}\\d])`, "gu"), "Title");
  for (const run of out.match(/\p{Lu}[\p{L}'’-]*(?:\s+(?:(?:of|the|a|an|and|in|on|to|for|you|me)\s+)*\p{Lu}[\p{L}'’-]*)+/gu) ?? []) {
    const words = run.split(/\s+/);
    for (let i = 0; i < words.length - 1; i++) {
      for (let j = words.length; j > i + 1; j--) {
        const span = words.slice(i, j).join(" ");
        if (!midSentence(span) || !CONNECTIVES.some((c) => c.fact.test(span))) continue;
        out = out.replace(span, "Title");
        break;
      }
    }
  }
  return out;
}

/**
 * A joining word or a number the sentence the caption retells doesn't have,
 * or null. Numbers (words or figures, not years) must be in that sentence too:
 * "reached number one twice", "the collection's three pieces" when it has five.
 */
export function unsupportedConnective(fact: string, context: string, titles: string[] = []): string | null {
  const retold = retoldSentences(fact, context);
  const worded = withoutTitles(fact, context, titles);
  // "first" is too common to drop when the caption retells no sentence at all; the other checks judge that.
  const used = CONNECTIVES.filter((c) => c.fact.test(worded) && (c.label !== "a first" || retold.length > 0));
  const numbers = numbersIn(fact);
  if (!used.length && !numbers.length) return null;
  if (!retold.length) return used[0]?.fact.exec(worded)?.[0] ?? numbers[0];
  // A number, or "first", may sit in any sentence the caption draws on, not only the closest: "their third film together".
  const related = bodySentences(context).filter((s) => share(fact, s) >= 0.3);
  for (const c of used) {
    if ((c.label === "a first" ? [...retold, ...related] : retold).some((s) => c.source.test(s))) {
      if (c.fact.source === "\\bafter\\b" && afterReversed(worded, retold)) return "after (the other way round)";
      continue;
    }
    if (c.fact.source === "\\bafter\\b" && afterFollowsSource(worded, context)) continue;
    return c.fact.exec(worded)?.[0] ?? c.label;
  }
  for (const n of numbers) if (![...retold, ...related].some((s) => hasNumber(n, s))) return n;
  return null;
}

/** Counts and ordinals in a caption, in words or figures: not years, and not part of a name ("Expedition 33", "Hot 100", "No. 3"). */
function numbersIn(fact: string): string[] {
  return [
    // Lowercase only: "Two Worlds" is a title.
    ...(fact.match(new RegExp(`\\b(${[...NUMBER_WORDS, ...ORDINALS].join("|")})\\b`, "g")) ?? []),
    ...[...fact.matchAll(/(?<![\p{L}\d.,$])\d{1,3}(?:,\d{3})*(?![\d\p{L}])/gu)]
      .filter((m) => !/(?:\p{Lu}[\p{L}.'’-]*|No\.|Op\.|K\.)\s+$/u.test(fact.slice(0, m.index)) && !/^\s+\p{Lu}/u.test(fact.slice((m.index ?? 0) + m[0].length)))
      .map((m) => m[0]),
  ];
}

/** Whether a sentence has this number in any form: "second" is also "2nd", and "1,000" is "1000". */
function hasNumber(n: string, s: string): boolean {
  const forms = [n, DIGIT_OF[n], ...Object.entries(DIGIT_OF).filter(([, d]) => d === n).map(([w]) => w)].filter(Boolean) as string[];
  return forms.some((f) => hasWord(f, s) || hasWord(f.replace(/,/g, ""), s.replace(/(\d),(\d)/g, "$1$2")) || (/^\d+$/.test(f) && hasWord(`${f}${f === "2" ? "nd" : f === "3" ? "rd" : "th"}`, s)));
}

/** A sentence split at "after": the clause it opens ("After X," or "after X" to the next comma), and the rest. */
function splitAtAfter(s: string, word = /\bafter\b/i): { after: string; rest: string } | null {
  const m = word.exec(s);
  if (!m) return null;
  const from = m.index + m[0].length;
  const comma = s.slice(from).search(/[,;]/);
  const to = comma < 0 ? s.length : from + comma;
  return { after: s.slice(from, to), rest: `${s.slice(0, m.index)} ${s.slice(to)}` };
}

/**
 * "A after B" retelling a sentence that says "after A, B": the order turned
 * round. "Marisol began writing the album after deciding to use the hook"
 * when the source says "After Marisol began writing the album, she decided to
 * use the hook". The caption's main clause matches the source's "after" clause
 * better than the caption's own "after" clause does. A "when" clause counts
 * as the earlier event too: "they heard the demo after plans changed" for
 * "plans changed when they heard the demo".
 */
function afterReversed(fact: string, retold: string[]): boolean {
  const own = splitAtAfter(fact);
  if (!own) return false;
  return retold.some((s) => {
    const src = splitAtAfter(s) ?? splitAtAfter(s, /\bwhen\b/i);
    if (!src) return false;
    const main = share(own.rest, src.after);
    return main >= 0.3 && main > share(own.after, src.after);
  });
}

/**
 * "A after B" told from two sentences next to each other, B's first: the
 * article's order is the story's ("threatened to leave. Sakaguchi suggested
 * he score it" is "suggested it after he threatened to leave"). Not when B
 * comes later, or both halves come from one sentence that says otherwise
 * ("The band fell apart, and a few years later, Gleason decided...").
 */
function afterFollowsSource(fact: string, context: string): boolean {
  const [a, b] = fact.split(/\bafter\b/i);
  if (!a || !b) return false;
  const sentences = bodySentences(context);
  const bestIndex = (part: string) => {
    let at = -1;
    let best = 0.5;
    sentences.forEach((s, i) => {
      const sh = share(part, s);
      if (sh >= best) [at, best] = [i, sh];
    });
    return at;
  };
  const ia = bestIndex(a);
  const ib = bestIndex(b);
  return ia > 0 && ib >= 0 && ib < ia && ia - ib <= 2;
}

/**
 * Words for how two people are related, or what someone plays. A small model
 * invents them ("Leon Ware is T-Boy Ross's older brother", "guitarist
 * Furuholmen", "their self-titled album"). The source must have the word in a
 * sentence that also names the caption's subject and the person the word sits
 * next to.
 */
const RELATION =
  /(?<![\p{L}-])(brothers?|sisters?|siblings?|sons?|daughters?|father|mother|parents?|wife|husband|spouse|married|girlfriend|boyfriend|fianc[eé]e?|cousins?|uncle|aunt|nephew|niece|grand(?:son|daughter|father|mother)|partners?|self-titled|eponymous|guitarist|keyboardist|keyboard player|drummer|bassist|pianist|violinist|saxophonist|trumpeter|voice actress|voice actor)\b/gu;
const NAME_RUN = /(?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*)*/gu;

export function unsupportedRelation(fact: string, context: string): string | null {
  const sentences = sourceSentences(context);
  const runs = [...fact.matchAll(NAME_RUN)]
    .map((m) => ({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, words: m[0].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase())) }))
    .filter((r) => r.words.length);
  for (const m of fact.matchAll(RELATION)) {
    const word = m[0].toLowerCase();
    const at = m.index ?? 0;
    const root = word.replace(/s$/, "").replace(/^(fianc)[eé]e?$/, "$1");
    // The subject, and the name nearest the word: "[Leon Ware] is [T-Boy Ross]'s older brother".
    const nearest = [...runs].sort((a, b) => Math.min(Math.abs(a.end - at), Math.abs(a.at - at - word.length)) - Math.min(Math.abs(b.end - at), Math.abs(b.at - at - word.length)))[0];
    // "a new drummer position": a word not next to anyone describes no one in particular.
    const gap = nearest ? fact.slice(Math.min(nearest.end, at + word.length), Math.max(nearest.at, at)).trim().split(/\s+/).filter(Boolean).length : Infinity;
    if (runs.length && gap > 3) continue;
    const people = [...new Set([runs[0], nearest].filter(Boolean))];
    const stated = sentences.some((s) => new RegExp(`\\b${escapeRe(root)}`, "i").test(s) && people.every((p) => p.words.some((w) => hasWord(w, s))));
    if (!stated) return m[0];
  }
  return null;
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const RELEASE_ORDINAL = `(?:first|lead|debut|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th))`;
/** "from their self-titled debut album", "off her third album": an album named only as what something came from. */
const FROM_AN_ALBUM = /\b(?:from|off|of|on)\s+(?:(?:the|their|his|her|its|a|an)\s+)?(?:[\p{L}'’-]+\s+){0,5}(?:album|EP|LP)s?\b/giu;

/**
 * A detail kept while what it belongs to is dropped, so it lands on
 * something else. Each is a real slip of a small model:
 *
 *   paired numbers  "peaked at numbers 15 and 16 on the Hot 100 and Cash Box" told as
 *                   "peaked at numbers 15 and 16 on the Hot 100": one chart, two peaks.
 *   whose ordinal   "the second single from her third album" told as "her second single".
 *   whose date      "released on December 4 as the second single from their debut album"
 *                   told as "their debut album was released on December 4".
 *
 * Returns what was lost, or null.
 */
export function lostQualifier(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  const pair = /\b(\d+) and (\d+)\b/.exec(fact);
  if (pair) {
    const rest = fact.slice(pair.index + pair[0].length);
    const twoPlaces = new RegExp(`\\b${pair[1]} and ${pair[2]} (?:on|in) [^,;]*?\\band\\b`);
    if (retold.some((s) => twoPlaces.test(s)) && !/\band\b|\brespectively\b/.test(rest)) return `${pair[0]}, without the second chart`;
  }
  const ordinal = new RegExp(`\\b${RELEASE_ORDINAL}\\s+(?:official\\s+|US\\s+|UK\\s+)?(single|album)\\b(?!\\s+(?:from|off|of|on)\\b)`, "i").exec(fact);
  if (ordinal) {
    const scoped = new RegExp(`\\b${escapeRe(ordinal[0].split(/\s+/)[0])}\\s+(?:\\S+\\s+){0,2}${ordinal[1]}s?\\s+(?:from|off)\\b`, "i");
    if (retold.some((s) => scoped.test(s))) return `"${ordinal[0]}" without the album it's from`;
  }
  // The album is the caption's subject: named before the verb that dates it.
  // Or its object: "released her debut EP on 10 May".
  const dated = /\b(album|EP|LP)\b[^.]*?\b(?:was\s+|were\s+)?(?:released|issued|came out|out)\b/i.exec(fact) ?? /\b(?:released|issued)\s+(?:[\p{L}'’-]+\s+){0,3}?(album|EP|LP)\b/iu.exec(fact);
  const day = new RegExp(`\\b(?:(${MONTHS})\\s+(\\d{1,2})|(\\d{1,2})\\s+(${MONTHS}))\\b`).exec(fact);
  // Only a full date: a year alone is shared by too many releases to tell whose it is.
  if (dated && day) {
    const when = new RegExp(`\\b(?:${day[1] ?? day[4]}\\s+${day[2] ?? day[3]}|${day[2] ?? day[3]}\\s+${day[1] ?? day[4]})\\b`);
    const noun = new RegExp(`\\b${dated[1]}s?\\b`, "i");
    const withDate = sourceSentences(context).filter((s) => when.test(s) && noun.test(s));
    if (withDate.length && withDate.every((s) => !noun.test(s.replace(FROM_AN_ALBUM, "")))) return `a date the source gives another release, not the ${dated[1]}`;
  }
  return null;
}

/** Who a caption or a source sentence says did something, by the noun alone: "the band", "the company". */
const AGENT = /^the (band|group|company|label|singer|duo|trio|orchestra|studio|developer|publisher|network|magazine|website|choir|producer|composer)\b/i;
/** A name right before a word of saying: "Spinwheel said", "Chen recalled". */
const SPEAKER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s*,?\s+(?:who\s+)?(?:also\s+|later\s+|once\s+)?(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/gu;

/** A word of saying, after which whoever was named first (outside "with", "to", "by" ...) is the speaker. */
const SAYS = /\b(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/;

/** "Ray Tolland, in an interview for the BBC, stated": named before the word of saying, and not inside "an interview with Tolland". */
function namedAsSpeaker(sentence: string, surname: string): boolean {
  const verb = SAYS.exec(sentence);
  if (!verb) return false;
  const re = new RegExp(`(\\S+\\s+)?((?:(?:Mc)?\\p{Lu}[\\p{L}'’.-]*\\s+)*)${escapeRe(surname)}(?![\\p{L}])`, "gu");
  for (const m of sentence.slice(0, verb.index).matchAll(re)) {
    if (!/^(?:with|to|by|of|from|for|about|on|and)\s*$/i.test((m[1] ?? "").trim())) return true;
  }
  return false;
}

const speakers = (s: string): string[] =>
  [...s.matchAll(SPEAKER)].map((m) => m[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? "").filter(Boolean);

/**
 * The statement told with someone else as its subject, which no single word
 * gives away but the sentence it retells does:
 *
 *   "The band had a top 20 downloads section" retelling "The company had ...".
 *   "Ruvo said Spinwheel made a mistake" retelling "According to an interview
 *   with Ruvo, Spinwheel said ...": the source's speaker is someone else.
 *
 * Returns the caption's subject, or null.
 */
export function swappedSubject(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const agent = AGENT.exec(fact);
  if (agent) {
    const others = retold.map((s) => AGENT.exec(s)?.[1].toLowerCase()).filter((a): a is string => Boolean(a) && a !== agent[1].toLowerCase());
    if (others.length && !retold.some((s) => hasWord(agent[1], s))) return `the ${agent[1].toLowerCase()}`;
  }
  const factSpeakers = [...speakers(fact), ...[SAID_BY.exec(fact)?.[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? ""].filter(Boolean)];
  for (const said of new Set(factSpeakers)) {
    const theirs = retold.flatMap(speakers);
    const own = retold.some((s) => theirs.some((t) => t.toLowerCase() === said.toLowerCase()) || namedAsSpeaker(s, said) || new RegExp(`according to ${escapeRe(said)}\\b`, "i").test(s) || new RegExp(`\\b${escapeRe(said)}['’]s?\\s+(?:words|account|interview)`, "i").test(s));
    if (theirs.length && !own) return said;
  }
  return null;
}

/**
 * Someone's reading of the music told as fact: "A theme was written for the
 * villains as a compromise between X and Y" retelling "Music author Dana
 * Reyes described the cue as a compromise between X and Y". The caption takes
 * a word only from a sentence where someone describes the music, and names
 * neither the describer nor the describing. Returns the describer, or null.
 */
export function unattributedView(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  for (const s of retold) {
    const by = /((?:Mc)?\p{Lu}[\p{L}'’.-]*)\s+(?:described|called|deemed|likened|characterized|characterised|considered)\b/u.exec(s);
    if (!by || NAME_STOPWORDS.has(by[1].toLowerCase()) || hasWord(by[1], fact) || /\b(describ|call|deem|liken|characteri[sz]|consider)\w*/i.test(fact)) continue;
    const others = retold.filter((o) => o !== s).map(contentTokens);
    const own = contentTokens(s);
    const only = [...contentTokens(fact)].filter((t) => own.has(t) && !others.some((o) => o.has(t)));
    if (only.length && others.length) return by[1];
  }
  return null;
}

/** A name right before a word of saying in a caption: "Vela described", "Ruvo said", "Okafor recalled". */
const SAID_BY =
  /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|once\s+)?(?:described|said|says|stated|recalled|explained|claimed|admitted|noted|commented|remarked|revealed|insisted|joked|praised|likened|characteri[sz]ed|acknowledged|recounted)\b/u;
/** Any word a source uses to give someone's words or view: "comments that", "defined by", "according to", "in an interview". */
const ATTRIBUTION =
  /\b(?:said|says|say|stat(?:ed|es|ing)|recall\w*|explain\w*|claim\w*|admit\w*|told|tell\w*|not(?:ed|es|ing)|comment\w*|remark\w*|reveal\w*|confirm\w*|insist\w*|jok\w*|describ\w*|call(?:ed|s|ing)|prais\w*|liken\w*|characteri[sz]\w*|acknowledg\w*|recount\w*|defin\w*|summari[sz]\w*|wr(?:ote|ites?|iting) that|interview\w*|according|quot\w*|felt|feel\w*|believ\w*|consider\w*|deem\w*|refer\w*|compar\w*|express\w*|reflect\w*|label\w*|dubb\w*|thought|argu\w*|observ\w*|asked|answer\w*|speak\w*|spoke|mention\w*|announc\w*|cit(?:ed|es|ing)|credit\w*|views?|opinion|marked by)\b|:\s*["“]/i;

/** "he has acknowledged", "She said": a pronoun giving its own words. */
const PRONOUN_SAYS =
  /\b(?:he|she|they)\s+(?:has\s+|have\s+|had\s+|also\s+|later\s+|once\s+)*(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked|described|called|praised|acknowledged|recounted|felt|believed|considered|wrote)\b/i;

/**
 * Words put in someone's mouth. A small model turns a credit into a quote:
 * "Dana Vale described the song as a 'very tender' ballad" when the source
 * only lists Vale as a co-writer, or "Ruvo described the mistake" when Ruvo
 * only gave the interview. A caption saying someone said, described or
 * recalled something needs:
 *
 *   - a source sentence giving that person's words or view at all;
 *   - the person's words in the sentence it retells or another it draws on,
 *     or the one before (a quote often runs on from its attribution);
 *   - every quoted word in the source, in a sentence that gives that person's
 *     words (a quoted title is left to the name checks).
 *
 * Returns the person, or null.
 */
export function misattributedWords(fact: string, context: string): string | null {
  const m = SAID_BY.exec(fact);
  if (!m) return null;
  const names = m[1].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
  const name = names[names.length - 1];
  if (!name) return null;
  const sentences = bodySentences(context);
  // "Chen" or "Zhiyi" for "Chen Zhiyi": a source often uses one part of a name.
  // Outside quotation marks: a name inside someone's quote isn't the one speaking.
  const mentions = (s: string | undefined) => Boolean(s) && names.some((w) => hasWord(w, (s as string).replace(/["“][^"”]*["”]/g, "")));
  const gives = sentences.map((s, i) =>
    ATTRIBUTION.test(s) &&
    (mentions(s) ||
      // "He stated he would retire", with the name in the sentence or two before.
      (PRONOUN_SAYS.test(s) && (mentions(sentences[i - 1]) || mentions(sentences[i - 2]))) ||
      // "marked by the composer as", in the article about the composer's work.
      (/\b(?:by|to) the (?:composer|songwriter|singer|artist|author|band)\b/i.test(s) && mentions(sentences[0]))));
  // A quote running on from the sentence before has no speaker of its own.
  const near = (i: number) => gives[i] || (i > 0 && gives[i - 1] && !ATTRIBUTION.test(sentences[i].replace(/["“][^"”]*["”]/g, "")));
  if (!gives.some(Boolean)) return name;
  for (const q of fact.replace(/[“”]/g, '"').matchAll(/"([^"]+)"/g)) {
    const quoted = q[1].replace(/[.,!?;:]+$/, "").trim();
    // "Lose My Breath": a title, which the speaker needn't have said.
    if (!quoted || quoted.split(/\s+/).every((w) => /^(?:\p{Lu}|\d)/u.test(w) || /^(?:a|an|the|of|in|on|to|and|for|at|by|or)$/.test(w))) continue;
    const words = plainQuotes(quoted);
    const at = sentences.flatMap((s, i) => (plainQuotes(s).includes(words) ? [i] : []));
    if (!at.length || !at.some(near)) return name;
  }
  const scored = sentences.map((s, i) => ({ i, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  if (best < 0.25) return null;
  // The sentence it retells, or another it draws on: "is a Brazilian tango by Nazareth" and "marked by the composer as a "Brazilian tango"".
  const drawn = scored.filter((x) => x.share >= best - 0.1 || x.share >= 0.3).map((x) => x.i);
  return drawn.some(near) ? null : name;
}

/**
 * A caption opening on a person the sentence it retells gives to someone
 * else: "Dale Ortiz pitched the story in 2003" retelling "Mara Quill, the
 * effects supervisor, pitched the story in 2003". The retold sentence never
 * names the caption's person and opens on another name. Returns that name, or null.
 */
export function otherDoer(fact: string, context: string): string | null {
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s+\p{Ll})/u.exec(fact);
  // "Nadia's album": the subject is the album, not Nadia.
  if (!lead || /['’]s?$/.test(lead[1])) return null;
  const words = lead[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
  // A full name: a single word is as often a game, a band or a place.
  if (words.length < 2 || NAME_STOPWORDS.has(lead[1].split(/\s+/)[0].toLowerCase())) return null;
  const retold = retoldSentences(fact, context);
  if (!retold.length || retold.some((s) => words.some((w) => hasWord(w, s)))) return null;
  const subjects = retold.map((s) => {
    // "In 1933, Ada Pell recorded": a time or place first is not the subject.
    const body = s.replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While)\b[^,]{0,80},\s*)+/i, "");
    const m = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s*,|\s+\p{Ll})/u.exec(body);
    const who = (m?.[1] ?? "").split(/\s+/).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    // "Released in 2021, ...": a verb, not a name.
    if (who.length === 1 && /(?:ed|ing|ly)$/.test(who[0])) return "";
    // "Forest of Ash, the fourth album, ...": a subject the caption also names is no one else.
    return m && !/['’]s?$/.test(m[1]) && !NAME_STOPWORDS.has(m[1].split(/\s+/)[0].toLowerCase()) && !who.some((w) => hasWord(w, fact)) ? who.join(" ") : "";
  });
  return subjects.every(Boolean) ? subjects[0] : null;
}

/** Words before a name that make it not the one doing anything: "with Ada Pell", "according to Pell", "feat. Pell". */
const NOT_THE_DOER = /(?:\b(?:with|to|by|of|from|for|about|on|than|and|or|as|featuring|feat\.|ft\.|including|like|according to|over|against|versus|vs\.?)|['’]s?|,)\s*$/i;
/** Small words after a name that make it no subject: "Pell and Ruiz", "Pell as an influence". */
const NOT_A_VERB = /^(?:and|or|as|in|on|at|of|for|with|to|from|by|the|a|an|nor|but)$/i;

/** A single capitalized word at the start of a sentence that is a verb or an adverb, not a name: "Released", "Recording", "Notably". */
const leadingVerb = (word: string) => /(?:ed|ing|ly)$/.test(word);

/**
 * The first person or group a sentence names, as the words of the name: "In
 * 1933, Paul Whiteman recorded" gives Paul Whiteman. Not the work it is about
 * (words of the reference's title), and not a time, a place word or "The".
 */
function firstNamed(sentence: string, title: string, reference = ""): string[] {
  // "Recording and production: The band ...": a section's heading, not a name.
  const body = sentence
    .replace(/^\p{Lu}[\p{L}'’-]*(?:\s+[\p{L}'’-]+){0,3}:\s+/u, (heading) => (SAYS.test(heading) ? heading : ""))
    .replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While|Since|As|Although|Though|Because|Until|With|Without|Following|Despite)\b[^,]{0,80},\s*)+/i, "");
  for (const m of body.matchAll(NAME_RUN)) {
    const words = m[0].split(/\s+/).map((w) => w.replace(/['’]s?$|[.,:;!?]+$/g, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    if (words.every((w) => hasWord(w, title))) continue;
    // "Written in 1909, ...", "Further, ...": a word capitalized only because it starts the sentence.
    // A name is capitalized in the middle of a sentence somewhere too.
    if (m.index === 0 && words.length === 1 && (leadingVerb(words[0]) || !new RegExp(`(?<![.!?:]["”]?\\s*)(?<=\\S\\s+)${escapeRe(words[0])}(?![\\p{L}])`, "u").test(reference))) continue;
    return words;
  }
  return [];
}

/** Whether a sentence has the name as one doing something: followed by a verb, and not after "with", "to", "by" or a possessive. */
function namedAsDoer(sentence: string, name: string): boolean {
  const last = name.split(/\s+/).pop() ?? name;
  for (const m of sentence.matchAll(new RegExp(`(?<![\\p{L}])${escapeRe(last)}(?![\\p{L}])`, "gu"))) {
    // Back to the start of the name, so "with Ada Pell" is read before "Ada".
    const before = sentence.slice(0, m.index).replace(/(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*\s+)*$/u, "");
    const next = /^\s+(\p{Ll}[\p{L}-]*)/u.exec(sentence.slice((m.index ?? 0) + m[0].length));
    if (next && !NOT_A_VERB.test(next[1]) && !NOT_THE_DOER.test(before)) return true;
  }
  return false;
}

/**
 * A caption checked against the one sentence it cites (`numberedReference`):
 *
 *   names    every name in it is in that sentence, the two before it (a
 *            "he" there names someone earlier), the reference's title or the
 *            request's artist (for "the band");
 *   numbers  every count is in that sentence, and every year in it or the one
 *            before or after;
 *   first    "first" only when that sentence has a word of firsts;
 *   words    someone "said", "recalled" or "described" only when that sentence
 *            (or the one before) gives that person's words;
 *   doer     a caption opening on a person other than the one the sentence
 *            names first is dropped, unless the sentence has that person doing
 *            something too, or the caption has the first one doing it ("Gioeli,
 *            who was paid $3,000, said he followed Senoue's demos" is no fee
 *            for Senoue);
 *   overlap  the caption shares at least a quarter of its words with it.
 *
 * `sentences` are `referenceSentences(context)` and `at` the cited one's index.
 * Returns why it doesn't match, or null.
 */
export function citedMismatch(fact: string, sentences: string[], at: number, title: string, artists: string[] = []): string | null {
  const own = sentences[at];
  if (share(fact, own) < 0.25) return "doesn't retell the sentence it cites";
  const near = [sentences[at - 2], sentences[at - 1], own, title, ...artists].filter(Boolean).join("\n");
  const unquoted = fact.replace(/["“][^"”]*["”]/g, " ");
  const names = [
    ...(unquoted.match(NAME) ?? []),
    // A single capitalized word after the first: "Mansfield", "Gioeli".
    ...[...unquoted.matchAll(/(?<=\S\s+)(?<![\p{L}'’])(?:Mc)?\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*/gu)].map((m) => m[0]),
  ];
  const reference = sentences.join(" ");
  for (const candidate of names) {
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    const missing = words.find((w) => !hasWord(w, near));
    // "Nobuo Uematsu" for a sentence's "Uematsu", when the reference gives him in full elsewhere.
    const fullElsewhere = words.length > 1 && hasWord(words[words.length - 1], near) && hasWord(words.join(" "), reference);
    if (missing && !fullElsewhere) return `"${missing}" isn't in the sentence it cites`;
  }
  const number = numbersIn(fact).find((n) => !hasNumber(n, own));
  if (number) return `"${number}" isn't in the sentence it cites`;
  const year = (fact.match(YEAR) ?? []).find((y) => ![sentences[at - 1], own, sentences[at + 1]].some((s) => s && hasWord(y, s)));
  if (year) return `${year} isn't in the sentence it cites`;
  const first = CONNECTIVES.find((c) => c.label === "a first" && c.fact.source === "\\bfirst\\b");
  if (first && first.fact.test(fact) && !first.source.test(own)) return `"first" isn't in the sentence it cites`;
  const said = SAID_BY.exec(fact);
  if (said) {
    const who = said[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? "";
    const gives = (s: string | undefined) => Boolean(s) && ATTRIBUTION.test(s as string) && (hasWord(who, s as string) || PRONOUN_SAYS.test(s as string));
    if (who && !(gives(own) && [own, sentences[at - 1]].some((s) => s && hasWord(who, s)))) return `the sentence it cites doesn't give ${who}'s words`;
  }
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s+\p{Ll})/u.exec(fact);
  if (lead && !/['’]s?$/.test(lead[1])) {
    const words = lead[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    const agent = firstNamed(own, title, sentences.join(" "));
    const isWork = words.every((w) => hasWord(w, title));
    if (words.length && !isWork && agent.length && !namedAsDoer(fact, agent.join(" ")) && !namedAsDoer(own, words.join(" "))) return `the sentence it cites is about ${agent.join(" ")}`;
  }
  return null;
}

const MONTH_DAY = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b`, "g");
/** The days a text names, as "November 22", whichever way round it writes them. */
/** Several days of one month: "3 and 5 June", "June 3, 4 and 5". A comma alone isn't a list: "On July 4, 10,000 fans". */
const DAY_LIST = String.raw`((?:\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,\s*)*\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,?\s*(?:and|&|to|–|-)\s*\d{1,2}(?!\d)(?:st|nd|rd|th)?)`;
const DAYS_MONTH = new RegExp(`\\b${DAY_LIST}\\s+(?:of\\s+)?(${MONTHS})\\b`, "g");
const MONTH_DAYS = new RegExp(`\\b(${MONTHS})\\s+${DAY_LIST}`, "g");
const daysOf = (list: string, month: string) => (list.match(/\d{1,2}/g) ?? []).map((d) => `${month} ${Number(d)}`);
const daysIn = (text: string) => [
  ...[...text.matchAll(MONTH_DAY)].map((m) => `${m[1]} ${Number(m[2])}`),
  ...[...text.matchAll(DAY_MONTH)].map((m) => `${m[2]} ${Number(m[1])}`),
  ...[...text.matchAll(DAYS_MONTH)].flatMap((m) => daysOf(m[1], m[2])),
  ...[...text.matchAll(MONTH_DAYS)].flatMap((m) => daysOf(m[2], m[1])),
];

/**
 * A day or month the source doesn't give: years are checked on their own, so
 * "released on November 22, 1994" passed whenever 1994 was in the source.
 * A month counts only next to a number ("May 1990"), never the word "may".
 * Returns the date, or null.
 */
export function unsupportedDay(fact: string, context: string): string | null {
  const known = new Set(daysIn(context));
  const day = daysIn(fact).find((d) => !known.has(d));
  if (day) return day;
  return [...fact.matchAll(new RegExp(`\\b(${MONTHS})(?=,?\\s+\\d)`, "g"))].map((m) => m[1]).find((month) => !hasWord(month, context, "")) ?? null;
}

/** A month with its year, as a text writes it: "January 2010", "January 22, 2025", "22 January 2025". */
const MONTH_YEAR = new RegExp(
  `\\b(${MONTHS})(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,|\\s+of)?\\s+(1\\d{3}|20\\d{2})\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS}),?\\s+(1\\d{3}|20\\d{2})\\b`,
  "g"
);

/**
 * A month told without the year the source gives it with: "In January 2010, the
 * duo regrouped" retold as "The duo regrouped in January", which reads as cut off.
 * The month must come with a year in every retold sentence that has it, and the
 * caption must give no such year. A month the source gives alone is left alone.
 * Returns the month and its year, or null.
 */
export function droppedYear(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  const given = [...fact.matchAll(MONTH_YEAR)];
  const factYears: string[] = fact.match(YEAR) ?? [];
  for (const month of new Set([...fact.matchAll(new RegExp(`\\b(${MONTHS})\\b`, "g"))].map((m) => m[1]))) {
    if (given.some((m) => (m[1] ?? m[3]) === month)) continue;
    const holders = retold.filter((s) => new RegExp(`\\b${month}\\b`).test(s));
    const years = holders.flatMap((s) => [...s.matchAll(MONTH_YEAR)].filter((m) => (m[1] ?? m[3]) === month).map((m) => m[2] ?? m[4]));
    if (!holders.length || !holders.every((s) => [...s.matchAll(MONTH_YEAR)].some((m) => (m[1] ?? m[3]) === month))) continue;
    if (years.some((y) => factYears.includes(y))) continue;
    return `${month} ${years[0]}`;
  }
  return null;
}

/** "The duo", "the quartet": a group named only by its kind. */
const COLLECTIVE = /^(?:The|This|That) (duo|pair|trio|quartet|quintet|couple|band|group|orchestra|ensemble)\b(?!\s*["“'‘]|\s+\p{Lu})/u;
/** "The group" or "the band" for a trio: either word fits any group; "the duo" fits only a duo. */
const ANY_GROUP = "band|group|duo|pair|trio|quartet|quintet|orchestra|ensemble|choir|unit";
/** "this chart", "the same list": a chart the caption never names. */
const THIS_CHART = /\b(?:this|that|the same) (chart|list|ranking|countdown|poll)\b/i;

/**
 * A caption about something it doesn't name, which only made sense next to
 * a caption the screen dropped: "The duo raised eyebrows" on a solo
 * pianist's article, "their second top-ten hit on this chart". "The band" is
 * fine where the source says its subject is a band ("... is a song by the
 * band Nightjar", "Nightjar were a Welsh band"). Returns the unnamed thing, or null.
 */
export function unnamedReference(fact: string, context: string): string | null {
  const chart = THIS_CHART.exec(fact);
  if (chart && (fact.match(new RegExp(`\\b${chart[1]}\\b`, "gi")) ?? []).length === 1) return chart[0].toLowerCase();
  const group = COLLECTIVE.exec(fact);
  if (!group) return null;
  const kinds = /^(?:band|group)$/i.test(group[1]) ? ANY_GROUP : group[1].toLowerCase();
  const isOne = new RegExp(`\\b(?:is|are|was|were)\\s+(?:an?|the)\\b[^.]{0,80}?\\b(?:${kinds})s?\\b`, "i");
  return sourceSentences(context).some((s) => isOne.test(s)) ? null : `the ${group[1].toLowerCase()}`;
}

/** Words that keep a statement uncertain. */
const HEDGE =
  /\b(?:may|might|could) have\b|\b(?:possibly|reportedly|allegedly|apparently|supposedly|purportedly|reputedly|rumou?red|probably|perhaps|presumably|unconfirmed|disputed)\b|\b(?:is|are|was|were) (?:said|believed|thought|reported|rumou?red|claimed) to\b|\bit is (?:said|believed|thought|claimed)\b|\b(?:legend|tradition) has it\b/i;

/**
 * A hedge the caption drops: "General Ardent suggested the symphony" when the
 * source says it "may have been suggested by General Ardent", or "The song is
 * inspired by a bus driver" for "was reportedly inspired". Every sentence the
 * caption retells hedges, and the caption doesn't. Returns the hedge, or null.
 */
export function droppedHedge(fact: string, context: string): string | null {
  if (HEDGE.test(fact) || /\baccording to\b/i.test(fact)) return null;
  const retold = retoldSentences(fact, context);
  // "Rowe called it "perhaps the first masterpiece"": a hedge inside a quote is the speaker's.
  const unquoted = retold.map((s) => s.replace(/["“][^"”]*["”]/g, ""));
  if (!unquoted.length || !unquoted.every((s) => HEDGE.test(s))) return null;
  return HEDGE.exec(unquoted[0])?.[0] ?? null;
}

/**
 * A year the sentence the caption retells doesn't place there: "demanded an
 * encore a week after its premiere in 1805" retelling "In 1807, after a
 * concert in Leipzig, the public demanded it again", or "performed it at the
 * 1990 halftime show" retelling "He performed it at that year's ceremony and
 * the halftime show", with 2000 in the sentence before. The year must be in
 * the retold sentence (in the clause the caption retells, when a semicolon
 * splits it), in another sentence the caption draws on, or in the one just
 * before or after. Returns the year, or null.
 */
export function misplacedYear(fact: string, context: string): string | null {
  const years = fact.match(YEAR) ?? [];
  if (!years.length) return null;
  const sentences = bodySentences(context);
  const scored = sentences.map((s, i) => ({ s, i, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  if (best < 0.25) return null;
  const retold = scored.filter((x) => x.share >= best - 0.1);
  const related = scored.filter((x) => x.share >= 0.3).map((x) => x.s);
  // The sentence before ("In 2000, ... at that year's ceremony") or after ("... by Nazareth. Written in 1909, ...").
  const before = retold.flatMap((x) => [sentences[x.i - 1] ?? "", sentences[x.i + 1] ?? ""]);
  const withoutYears = fact.replace(YEAR, "");
  for (const y of years) {
    if (![...retold.map((x) => x.s), ...related, ...before].some((s) => hasWord(y, s))) return y;
    // "In 2011, it was the biggest hit since 1985; the song gained airplay": the year is the other clause's.
    const holders = retold.filter((x) => hasWord(y, x.s));
    if (holders.length && holders.every((x) => {
      const clauses = x.s.replace(/\s*\([^)]*;[^)]*\)/g, "").split(/;\s*/);
      if (clauses.length < 2) return false;
      const main = clauses.reduce((a, c) => (share(withoutYears, c) > share(withoutYears, a) ? c : a));
      return !hasWord(y, main);
    })) return y;
  }
  return null;
}

/**
 * A detail the source gives the song's video, single or album, told of
 * another of the three:
 *
 *   video   "The song was inspired by X" retelling "The music video was inspired by X".
 *   sales   "Her debut album sold over 500,000 copies" when every sentence with
 *           500,000 is about the single.
 *   radio   "charted at number 12 in August 2003" retelling "released to radio
 *           on August 12, 2003 and charted at number 12".
 *
 * Returns what the detail belongs to, or null.
 */
export function wrongOwner(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  // The video is the retold sentence's subject: "The music video for X was inspired by", "Its video was shot".
  const videoFirst = /^(?:[^,]{0,40},\s*)?(?:the|its|their|his|her|an?)\s+(?:(?:official|music|lyric|accompanying|original)\s+)*videos?\b(?!\s*games?\b)/i;
  if (retold.length && !ABOUT_THE_VIDEO.test(fact) && retold.every((s) => videoFirst.test(s))) return "the music video";
  const figure = /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s+million\b/.exec(fact);
  if (figure) {
    const kinds = [{ name: "single", re: /\b(?:single|song|track)s?\b/i }, { name: "album", re: /\b(?:album|EP|LP)s?\b/i }];
    const own = kinds.map((k) => ({ ...k, at: fact.search(k.re) })).filter((k) => k.at >= 0).sort((a, b) => a.at - b.at)[0];
    const other = kinds.find((k) => k !== kinds.find((x) => x.name === own?.name));
    const holders = sourceSentences(context).filter((s) => s.includes(figure[0]));
    if (own && other && holders.length && holders.every((s) => !own.re.test(s) && other.re.test(s))) return `the ${other.name}`;
  }
  const month = new RegExp(`\\b(${MONTHS})\\b`).exec(fact);
  if (month && /\b(?:charted|peaked|reached|debuted|topped|climbed|entered)\b/i.test(fact) && !/\b(?:released|issued|radio|out)\b/i.test(fact)) {
    const releasedThen = new RegExp(`\\b(?:released|issued|serviced|sent|radio)\\b[^.;]{0,30}\\b${month[1]}\\b`, "i");
    const withMonth = retold.filter((s) => hasWord(month[1], s));
    if (withMonth.length && withMonth.every((s) => releasedThen.test(s))) return "the release, not the chart peak";
  }
  return null;
}

/**
 * "an exception to his love of atmospheric music" when the source says only
 * "He noted that the series was an exception", after a sentence about what
 * he dislikes: the caption supplies what the exception is to, and a small
 * model gets it backwards. Kept when a retold sentence says "exception to".
 */
export function suppliedException(fact: string, context: string): boolean {
  return /\bexception to\b/i.test(fact) && !retoldSentences(fact, context).some((s) => /\bexception to\b/i.test(s));
}

/**
 * "Kai Moreno's voice actor" when the source says "Juno's voice actor Kai
 * Moreno": the role word followed by the caption's possessor makes that
 * person the one in the role. Returns the role, or null.
 */
export function reversedRole(fact: string, context: string): string | null {
  for (const m of fact.matchAll(/((?:Mc)?\p{Lu}[\p{L}.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}.-]*){0,3})['’]s?\s+((?:voice actor|voice actress|producer|manager|singer|drummer|guitarist|bassist|keyboardist|pianist|composer|lyricist|wife|husband|brother|sister|son|daughter|father|mother))\b/gu)) {
    const who = m[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).join("\\s+");
    if (who && new RegExp(`\\b${m[2]}\\s+${who}\\b`, "u").test(context)) return m[2];
  }
  return null;
}

/** Strip "Fact 1:", bullets, numbering and wrapping quotes. */
function stripPrefix(fact: string): string {
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

function contentTokens(s: string): Set<string> {
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
const plainQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();

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
  const body = context.split("\n").slice(1).join("\n").replace(/^(From the people who made it|How the music is built|How it was received): /gm, "");
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

// --- Scope words a 3B drops ---------------------------------------------

/** SCOPE_REPAIR=off shows captions as written, without putting back a dropped "in Japan" or "the arcade version". */
export const scopeRepair = { on: process.env.SCOPE_REPAIR !== "off" };

/** Countries and regions, with the words a caption may already use for them. */
const REGIONS: Array<[string, string[]]> = [
  ["Japan", ["japan", "japanese"]],
  ["North America", ["north america", "north american"]],
  ["Europe", ["europe", "european"]],
  ["the United States", ["united states", "us", "u s", "american", "america"]],
  ["the US", ["united states", "us", "u s", "american", "america"]],
  ["the United Kingdom", ["united kingdom", "uk", "u k", "britain", "british"]],
  ["the UK", ["united kingdom", "uk", "u k", "britain", "british"]],
  ["Australia", ["australia", "australian"]],
  ["Canada", ["canada", "canadian"]],
  ["Germany", ["germany", "german"]],
  ["France", ["france", "french"]],
  ["Italy", ["italy", "italian"]],
  ["Spain", ["spain", "spanish"]],
  ["South Korea", ["korea", "korean"]],
  ["China", ["china", "chinese"]],
  ["Taiwan", ["taiwan", "taiwanese"]],
  ["Brazil", ["brazil", "brazilian"]],
  ["Mexico", ["mexico", "mexican"]],
  ["Ireland", ["ireland", "irish"]],
  ["New Zealand", ["new zealand"]],
  ["Sweden", ["sweden", "swedish"]],
  ["Norway", ["norway", "norwegian"]],
  ["the Netherlands", ["netherlands", "dutch"]],
  ["Asia", ["asia", "asian"]],
];
const REGION_NAMES = REGIONS.map(([r]) => r.replace(/^the /, "")).sort((a, b) => b.length - a.length).join("|");
const REGION_PHRASE = new RegExp(String.raw`\b(?:in|across|throughout) (?:the )?(${REGION_NAMES})(?: alone)?\b`, "g");
/** Any mention of a region, to tell whether a sentence names only one. */
const ANY_REGION = new RegExp(String.raw`\b(?:${REGION_NAMES}|Japanese|North American|European|American|British)\b`, "g");
/** "on the Billboard Hot 100", "on the UK Singles Chart", "on the Oricon weekly charts": a named chart. */
const CHART_PHRASE = /\bon the ((?:[\w.&'+-]+ ){0,5}?(?:[Cc]harts?|Hot 100|Billboard 200|Top 40))\b/g;
const FIRST_WEEK = /\b(?:in|during) (?:its|their|the) first week(?: of (?:release|sales|its release))?\b/gi;
const SAME_YEAR = /\b(?:(in|during) )?(?:that|the) same year\b/i;
/** Platforms and editions a sentence may limit a claim to: "the Mega Drive/Genesis version", "the Japanese version". */
const PLATFORM = String.raw`(?:Mega Drive|Genesis|Super NES|SNES|Super Famicom|NES|Famicom|Game Boy(?: Color| Advance)?|Game Gear|Master System|Sega CD|Mega-CD|Sega Saturn|Saturn|Dreamcast|PlayStation(?: \d| Portable)?|PSP|PS\d|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Nintendo DS|DS|3DS|Xbox(?: 360| One)?|PC|Windows|Mac|MS-DOS|DOS|Amiga|Commodore 64|ZX Spectrum|arcade|Neo Geo|TurboGrafx-16|PC Engine|32X|mobile|iOS|Android|8-bit|16-bit|Japanese|North American|European|English|Western|PAL|NTSC|international)`;
const VERSION_PHRASE = new RegExp(String.raw`\b(?:[Tt]he|[Ii]ts) (${PLATFORM}(?:\s*\/\s*${PLATFORM})*) (version|release|port)\b`, "g");

/** Words that widen or split a sentence's scope: a region repair can't tell which part a caption kept. */
const WIDER_SCOPE = /\b(?:internationally|worldwide|globally|overseas|abroad|elsewhere|other (?:regions|countries|territories|markets)|outside (?:of )?(?:the )?\p{Lu}\w+)\b/iu;

/** Whether the clause a phrase sits in has one of the caption's numbers (always, for a caption without numbers). */
function sameClause(sentence: string, at: number, capNums: Set<string>): boolean {
  if (!capNums.size) return true;
  const starts = [0, ...[...sentence.matchAll(/[;,]\s|\s(?:while|whereas|but|although)\s/g)].map((m) => (m.index ?? 0) + m[0].length)];
  const from = Math.max(...starts.filter((i) => i <= at));
  const next = starts.find((i) => i > at) ?? sentence.length;
  const clause = sentence.slice(from, next);
  return [...figuresIn(clause)].some((n) => capNums.has(n));
}

/** Numbers in a text, commas and "No." aside: "16,000", "3". */
const figuresIn = (s: string) => new Set([...s.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => m[0].replace(/,/g, "")));
const SMALL_WORDS = new Set(["the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "by", "with", "was", "were", "is", "it", "its", "as", "from", "also"]);

/** The reference's sentences, each with the one before it in its paragraph and without a "Heading: " label. */
function scopeSentences(context: string): Array<{ text: string; before: string }> {
  const out: Array<{ text: string; before: string }> = [];
  for (const para of context.split("\n").slice(1)) {
    let before = "";
    for (const [i, raw] of para.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).entries()) {
      const text = (i === 0 ? raw.replace(/^(?:About this piece|[^:.!?"“]{1,80}): (?=["“]?\p{Lu})/u, "") : raw).trim();
      if (text.length >= 20) out.push({ text, before });
      before = text;
    }
  }
  return out;
}

/** Insert `phrase` after the word or two the source puts before it, when the caption has them once. */
function insertAfterAnchor(caption: string, sentence: string, at: number, phrase: string): string | null {
  const words = sentence.slice(0, at).trim().split(/\s+/);
  for (const n of [1, 2]) {
    const anchor = words.slice(-n).join(" ").replace(/[,;:]$/, "");
    if (!anchor || (n === 1 && SMALL_WORDS.has(anchor.toLowerCase()))) continue;
    const re = new RegExp(String.raw`(^|[^\p{L}\p{N}])(${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=[^\p{L}\p{N}]|$)`, "giu");
    const hits = [...caption.matchAll(re)];
    if (hits.length !== 1) continue;
    const end = (hits[0].index ?? 0) + hits[0][1].length + hits[0][2].length;
    return `${caption.slice(0, end)} ${phrase}${caption.slice(end)}`;
  }
  return null;
}

/**
 * Put back a limit the caption's source sentence sets on a claim the caption
 * keeps, from a closed list: a country or region ("in Japan"), a named chart
 * ("on the Oricon weekly charts"), "in its first week", the year "the same
 * year" means, and an edition ("the Mega Drive/Genesis version"). Only when
 * the caption retells that sentence (half its words, and a number it has),
 * lacks the limit, and the sentence has exactly one limit of that kind with
 * a clear place for it in the caption; otherwise the caption is unchanged.
 * Precise on purpose: a broad repair broke correct captions before.
 */
export function repairScope(caption: string, context: string): string {
  const want = contentTokens(caption.replace(/\([^()]*\)/g, " "));
  if (!want.size) return caption;
  let best: { text: string; before: string } | null = null;
  let bestShare = 0;
  for (const s of scopeSentences(context)) {
    const have = contentTokens(s.text);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    if (shared / want.size > bestShare) [best, bestShare] = [s, shared / want.size];
  }
  if (!best || bestShare < 0.5) return caption;
  const sentence = best.text;
  // It keeps the sentence's claim: a number the sentence has, when it has any.
  const nums = figuresIn(sentence);
  const capNums = figuresIn(caption);
  if (nums.size && ![...capNums].some((n) => nums.has(n))) return caption;
  const said = ` ${normalizeTitle(caption)} `;
  let out = caption;

  // "the same year": the one year the words before it name.
  const same = SAME_YEAR.exec(out);
  if (same && SAME_YEAR.test(sentence)) {
    const inSentence = sentence.slice(0, sentence.search(SAME_YEAR));
    const years = (t: string) => [...new Set(t.match(/\b(?:1[89]\d\d|20\d\d)\b/g) ?? [])];
    const year = years(inSentence).length ? (years(inSentence).length === 1 ? years(inSentence)[0] : "") : years(best.before).length === 1 ? years(best.before)[0] : "";
    if (year && !capNums.has(year)) {
      const lead = same.index === 0;
      out = `${out.slice(0, same.index)}${same[1] ? `${same[1]} ` : lead ? "In " : "in "}${year}${out.slice(same.index + same[0].length)}`;
    }
  }

  // A country or region, when the sentence names only one.
  // "internationally", "in other regions": the sentence sets more than one scope, so which one a caption keeps isn't clear.
  const regions = WIDER_SCOPE.test(sentence) || WIDER_SCOPE.test(caption) ? [] : [...sentence.matchAll(REGION_PHRASE)];
  if (regions.length === 1 && new Set([...sentence.matchAll(ANY_REGION)].map((m) => m[0])).size === 1 && sameClause(sentence, regions[0].index ?? 0, capNums)) {
    const region = regions[0];
    const forms = REGIONS.find(([r]) => r.replace(/^the /, "") === region[1])?.[1] ?? [];
    const anyRegion = REGIONS.some(([, f]) => f.some((w) => said.includes(` ${w} `)));
    if (!forms.some((w) => said.includes(` ${w} `)) && !anyRegion) {
      out = withPhrase(out, sentence, region.index ?? 0, region[0]) ?? out;
    }
  }

  // A named chart, when the caption keeps the peak but not the chart.
  const charts = [...sentence.matchAll(CHART_PHRASE)].filter((m) => /\p{Lu}/u.test(m[1]));
  if (charts.length === 1 && sameClause(sentence, charts[0].index ?? 0, capNums)) {
    const chart = charts[0];
    const names = chart[1].split(" ").filter((w) => /^\p{Lu}/u.test(w) && !/^charts?$/i.test(w));
    if (names.length && !names.some((w) => said.includes(` ${normalizeTitle(w)} `))) {
      const vague = /\bon (?:the|a) (?:\w+ )?charts?\b/i.exec(out);
      if (vague) out = `${out.slice(0, vague.index)}${chart[0]}${out.slice(vague.index + vague[0].length)}`;
      else if (!/\bcharts?\b/i.test(out)) out = withPhrase(out, sentence, chart.index ?? 0, chart[0]) ?? out;
    }
  }

  // "in its first week".
  const weeks = [...sentence.matchAll(FIRST_WEEK)];
  if (weeks.length === 1 && !/\bfirst week\b/i.test(out) && sameClause(sentence, weeks[0].index ?? 0, capNums)) {
    out = withPhrase(out, sentence, weeks[0].index ?? 0, weeks[0][0]) ?? out;
  }

  // An edition: "The Mega Drive/Genesis version of the game was released ..." retold as "The game was released ...".
  const versions = [...sentence.matchAll(VERSION_PHRASE)];
  if (versions.length === 1 && !/\b(?:version|port|release)\b/i.test(out)) {
    const v = versions[0];
    const platformWords = v[1].split(/\s*\/\s*|\s+/).map((w) => normalizeTitle(w));
    if (!platformWords.some((w) => said.includes(` ${w} `))) {
      const subject = new RegExp(String.raw`^(?:[^:.!?"“]{1,80}: )?the ${v[1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} ${v[2]} of (the game|the album|the soundtrack)\b`, "i").exec(sentence);
      const forPart = new RegExp(String.raw`\b(\p{L}+ \p{L}+) (for|of|in) the ${v[1].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} ${v[2]}( of the game)?`, "iu").exec(sentence);
      if (subject && new RegExp(`^${subject[1]}\\b`, "i").test(out)) {
        out = `The ${v[1]} ${v[2]} of ${subject[1].toLowerCase()}${out.slice(subject[1].length)}`;
      } else if (forPart && !SMALL_WORDS.has(forPart[1].split(" ")[0].toLowerCase())) {
        const hits = out.match(new RegExp(String.raw`\b${forPart[1]}\b`, "gi")) ?? [];
        if (hits.length === 1) out = out.replace(new RegExp(String.raw`\b(${forPart[1]})\b`, "i"), `$1 ${forPart[2]} the ${v[1]} ${v[2]}${forPart[3] ?? ""}`);
      }
    }
  }
  return out.length <= MAX_FACT_CHARS ? out : caption;
}

/** Put a phrase from the sentence into the caption: after its anchor word, or first with a comma when it opens the sentence. */
function withPhrase(caption: string, sentence: string, at: number, phrase: string): string | null {
  const opens = sentence.slice(0, at).replace(/^[^:.!?"“]{1,80}: /, "").trim() === "" && sentence.slice(at + phrase.length).startsWith(",");
  if (opens) {
    const first = /^(The|It|Its|A|An|This)\b/.test(caption) ? caption[0].toLowerCase() + caption.slice(1) : caption;
    return `${phrase[0].toUpperCase()}${phrase.slice(1)}, ${first}`;
  }
  return insertAfterAnchor(caption, sentence, at, phrase);
}

// --- Qualifiers a 3B drops ------------------------------------------------

/** QUALIFIER_REPAIR=off shows captions without putting back "about", "usually" or a release's region. */
export const qualifierRepair = { on: process.env.QUALIFIER_REPAIR !== "off" };

/** A limit on a number: "over 200 million", "an estimated 5,000", "about 40%". */
const NUMBER_LIMIT = /\b(an estimated|estimated|approximately|roughly|about|around|nearly|almost|over|more than|less than|fewer than|under|up to)\s+((?:US)?[$£€]?\d[\d,]*(?:\.\d+)?)/gi;
/** Any limit word a caption may already put before its number. */
const ANY_NUMBER_LIMIT = /\b(?:estimated|approximately|roughly|about|around|nearly|almost|over|more than|less than|fewer than|under|up to|some|at least|close to|just)\s+(?:of\s+)?(?:US)?[$£€]?$/i;
/** A word that says a claim holds in general or for the most part: a caption without it says always or all. */
const SCOPE_ADVERB = /\b(usually|typically|mostly|largely|estimated|approximately)\b/gi;
/** Words that already say the same limit: "most of the music" keeps "mostly". */
const SAME_LIMIT: Record<string, RegExp> = {
  usually: /\b(?:usually|typically|often|generally|normally|commonly|tends?)\b/i,
  typically: /\b(?:usually|typically|often|generally|normally|commonly|tends?)\b/i,
  mostly: /\b(?:most|mostly|majority|largely|mainly|primarily|chiefly)\b/i,
  largely: /\b(?:most|mostly|majority|largely|mainly|primarily|chiefly)\b/i,
  estimated: /\b(?:estimat\w*|about|around|roughly|nearly|approximately|some)\b/i,
  approximately: /\b(?:about|around|roughly|nearly|approximately|estimat\w*|some)\b/i,
};
/** A release limited to regions: "in North America", "exclusive to Japan", "Japan-only". */
const RELEASE_REGION = new RegExp(String.raw`\b(?:(?:only |exclusively )?(?:in|across|throughout) (?:the )?(?:${REGION_NAMES})|exclusive to (?:the )?(?:${REGION_NAMES}))\b`, "g");

/** The reference sentence a caption retells: half its words or more, else null. */
function retoldScopeSentence(caption: string, context: string): { text: string; before: string } | null {
  const want = contentTokens(caption.replace(/\([^()]*\)/g, " "));
  if (!want.size) return null;
  let best: { text: string; before: string } | null = null;
  let bestShare = 0;
  for (const s of scopeSentences(context)) {
    const have = contentTokens(s.text);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    if (shared / want.size > bestShare) [best, bestShare] = [s, shared / want.size];
  }
  return best && bestShare >= 0.5 ? best : null;
}

/**
 * Put back, or else drop for, a limit the caption's source sentence puts on
 * the claim it keeps, from a closed list: a limit on a number ("over",
 * "about", "an estimated"); "usually", "typically", "mostly", "largely",
 * "estimated", "approximately"; and a release's region when the
 * sentence names several ("in North America in October 2014 and in Europe
 * in 2015"). Put back when the place for it is clear (the number or the
 * word after it appears once in the caption); dropped when the caption
 * keeps the claim but there is no clear place; unchanged when the caption
 * doesn't retell that part. Returns the caption to show, or why it's dropped.
 */
export function repairQualifier(caption: string, context: string): { text: string } | { drop: string } {
  const best = retoldScopeSentence(caption, context);
  if (!best) return { text: caption };
  const sentence = best.text.replace(/["“][^"”]*["”]/g, (q) => " ".repeat(q.length));
  let out = caption;

  // A number's limit.
  for (const m of sentence.matchAll(NUMBER_LIMIT)) {
    const num = m[2];
    const plain = num.replace(/[$£€,]|US/g, "");
    const hits = [...out.matchAll(/(?:US)?[$£€]?\d[\d,]*(?:\.\d+)?/g)].filter((h) => h[0].replace(/[$£€,]|US/g, "") === plain);
    if (!hits.length) continue;
    if (hits.some((h) => ANY_NUMBER_LIMIT.test(out.slice(0, h.index)))) continue;
    if (hits.length !== 1) return { drop: `"${m[1]} ${num}" without "${m[1]}"` };
    const at = hits[0].index ?? 0;
    const word = m[1].toLowerCase() === "estimated" ? "an estimated" : m[1].toLowerCase();
    out = `${out.slice(0, at)}${at === 0 ? word[0].toUpperCase() + word.slice(1) : word} ${out.slice(at)}`;
  }

  // A word that says "for the most part".
  const said = ` ${normalizeTitle(out)} `;
  for (const m of sentence.matchAll(SCOPE_ADVERB)) {
    const word = m[1].toLowerCase();
    if (said.includes(` ${word.slice(0, 7)}`) || SAME_LIMIT[word]?.test(out)) continue;
    const after = sentence.slice((m.index ?? 0) + m[0].length);
    // "an estimated 5,000": the number step's.
    if (word === "estimated" && /^\s+(?:US)?[$£€]?\d/.test(after)) continue;
    const next = after.split(/[,;.:!?]/)[0].match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
    const content = next.filter((w) => !SMALL_WORDS.has(w.toLowerCase()) && w.length > 2).slice(0, 3);
    const has = (w: string) => [...out.matchAll(new RegExp(String.raw`(^|[^\p{L}\p{N}])${escapeRe(w)}(?=[^\p{L}\p{N}]|$)`, "giu"))];
    if (!content.some((w) => has(w).length)) continue; // the caption doesn't retell this part
    // "usually armed" told as "armed": put it back before the word right after it. "usually the small fox Pip" told as "Pip": no clear place.
    const hits = content[0] && next[0] === content[0] ? has(content[0]) : [];
    const at = hits.length === 1 ? (hits[0].index ?? 0) + hits[0][1].length : 0;
    if (at > 0 && word !== "estimated") {
      out = `${out.slice(0, at)}${word} ${out.slice(at)}`;
      continue;
    }
    return { drop: `"${word}" left out` };
  }

  // A release's region when the sentence names several: the one in the caption's part of it.
  const regionWords = REGIONS.flatMap(([, f]) => f);
  const capSaid = ` ${normalizeTitle(out)} `;
  const regions = [...sentence.matchAll(RELEASE_REGION)];
  const capNums = [...figuresIn(out)].filter((n) => n.length >= 2);
  if (regions.length >= 2 && capNums.length && !regionWords.some((w) => capSaid.includes(` ${w} `)) && !WIDER_SCOPE.test(out)) {
    const parts = [...sentence.matchAll(/[^;,]+?(?=[;,]\s|\s(?:and|while|whereas|but|although)\s|$)/g)];
    const mine = parts.filter((p) => [...figuresIn(p[0])].some((n) => capNums.includes(n)));
    const inMine = regions.filter((r) => mine.some((p) => (r.index ?? 0) >= (p.index ?? 0) && (r.index ?? 0) < (p.index ?? 0) + p[0].length));
    if (mine.length && new Set(inMine.map((r) => r[0])).size === 1) {
      const fixed = withPhrase(out, sentence, inMine[0].index ?? 0, inMine[0][0]);
      if (fixed) out = fixed;
      else return { drop: `"${inMine[0][0]}" left out` };
    } else if (mine.length && inMine.length >= 2) return { drop: "a date the source gives for one region" };
  }
  return out.length <= MAX_FACT_CHARS ? { text: out } : { drop: "too long with its limit" };
}

/** Text naming the track, small words aside: "Through the Fire and Flames" names "Through the Fire and the Flames". */
function namesTrack(text: string, track: string): boolean {
  const want = significantTokens(normalizeTitle(track));
  const have = new Set(normalizeTitle(text).split(" "));
  return mentionsName(normalizeTitle(text), [normalizeTitle(track)]) || (want.length > 0 && want.every((t) => have.has(t)));
}

/** The kinds of work "The song" or "This theme" can stand for. */
const WORK_KINDS = "song|track|piece|tune|musical|show|collection|album|single|EP|record|suite|composition|work|theme|symphony|opera|concerto|sonata|overture";
/** A caption about a work it doesn't name. */
const UNNAMED_WORK = new RegExp(`^(?:The|This|That) (${WORK_KINDS})\\b(?!\\s*["“'‘]|\\s+\\p{Lu})`, "u");

/** Several works, which are never the one requested. */
const WORKS_KINDS = "songs|tracks|pieces|tunes|albums|singles|records|suites|compositions|works|themes|symphonies|operas|concertos|concerti|sonatas|quartets|overtures|ballets";
/** "The symphonies are ...": works the caption doesn't name. */
const UNNAMED_WORKS = new RegExp(`^(?:The|These|Those) (${WORKS_KINDS})\\b(?!\\s*["“'‘]|\\s+\\p{Lu})`, "u");

/** "This was loosely based on ...", "That year ...": a demonstrative with nothing named for it. A kind of work is `UNNAMED_WORK`'s. */
const BARE_DEMONSTRATIVE = new RegExp(`^(This|That|These|Those)\\b(?![’'])(?!\\s*["“'‘]|\\s+\\p{Lu})(?!\\s+(?:${WORK_KINDS}|${WORKS_KINDS})\\b)`, "u");

/** Words a caption may open with that aren't a name: "The", "In 1966", "After". */
const OPENING_WORD = /^(?:The|A|An|This|That|These|Those|It|Its|In|On|At|By|For|After|Before|During|When|While|With|As|From|Of|Some|Many|Most|Both|All|Each|One|Two|Three|Several|Over|Under|Since|Until|Despite|Although|Though|His|Her|Their|He|She|They)\b/;

/** A name in the caption: a capitalized word ("Ada", "ZUN") or a quoted title past its opening word. */
function namesSomeone(fact: string): boolean {
  const rest = fact.replace(OPENING_WORD, "");
  return /["“][^"”]*\p{Lu}/u.test(rest) || /(?<![\p{L}\p{N}'’])\p{Lu}(?:\p{Ll}|\p{Lu})/u.test(rest);
}

/** Someone a "his" or "her" can stand for without a name: "the song's narrator ... his". */
const PERSON_NOUN =
  /\b(?:singer|composer|songwriter|lyricist|narrator|protagonist|character|frontman|frontwoman|vocalist|guitarist|drummer|bassist|pianist|violinist|producer|conductor|artist|musician|rapper|author|writer|director|actor|actress|father|mother|wife|husband|son|daughter|brother|sister|boy|girl|man|woman|king|queen|prince|princess|hero|heroine|villain|player|friend|teacher|child)s?\b/i;

/**
 * "The operas are spread across his whole life": a "he" or "her" with
 * nobody named and no one in the caption it can stand for. A caption on screen stands alone,
 * so a viewer can't tell whose. Words inside quotes are the quote's. Returns the pronoun, or null.
 */
export function unresolvedPronoun(fact: string): string | null {
  if (namesSomeone(fact)) return null;
  const words = fact.replace(/["“][^"”]*["”]/g, " ");
  const m = /\b(he|him|his|himself|she|her|hers|herself)\b/i.exec(words);
  if (!m) return null;
  return PERSON_NOUN.test(words.slice(0, m.index)) ? null : m[1].toLowerCase();
}

/** A company's deal: "signed a five-year deal with", "an agreement with". */
const COMPANY_DEAL = /\b(?:signed|struck|reached|inked)\b[^.;]{0,40}\b(?:deal|contract|agreement)\b|\b(?:deal|contract|agreement) with\b/i;
/** A company bought or merged: "purchased Brightwater Studios", "acquired the rights". */
const COMPANY_BOUGHT = /\b(?:acquired|purchased|bought(?: out)?|took over)\s+(?:the\s+)?(?:rights\b|\p{Lu})|\b(?:merged with|[Mm]erger|[Aa]cquisition|[Tt]akeover|[Bb]uyout|[Ss]ubsidiary)\b/u;
/** A company, by kind or by the word its name ends with. */
const COMPANY_NOUN =
  /\b(?:[Cc]ompan(?:y|ies)|[Ss]tudios?|[Dd]evelopers?|[Pp]ublishers?|[Ff]irms?|[Ss]ubsidiar(?:y|ies)|[Cc]orporations?|Inc|Ltd|LLC|Corp|Entertainment|Interactive|Software|Games|Productions|Pictures)\b/;
/** "The next-generation console was announced to be the Orbis". */
const CONSOLE_NEWS = /\b(?:console|hardware)\b[^.;]{0,40}\bannounced\b|\bannounced\b[^.;]{0,40}\b(?:console|hardware)\b|\bnext[- ]generation (?:console|platform|system|hardware)\b/i;
/** A caption led by the work itself: "The game was announced ...", "It was renamed ...". */
const WORK_LED = /^(?:The|This) (?:game|song|track|piece|album|film|series|soundtrack)\b|^It\b/;

/**
 * A company's business history, not the music or the requested work: "Northwind Media signed a
 * five-year deal with Halcyon Pictures", "Lumen Works purchased Brightwater Studios", "The
 * next-generation console was announced to be the Orbis". Deals and buyouts count unless the caption
 * is about music; a renaming must be a company's; a console announcement counts unless the
 * caption is led by the work (`titles`: the article's and the song's).
 */
export function companyHistory(fact: string, titles: string[] = []): boolean {
  if (ABOUT_MUSIC.test(fact)) return false;
  if (COMPANY_DEAL.test(fact) || COMPANY_BOUGHT.test(fact)) return true;
  const workLed = WORK_LED.test(fact) || titles.some((t) => t && new RegExp(`^${escapeRe(t)}(?![\\p{L}\\p{N}])`, "iu").test(fact));
  if (workLed) return false;
  return (/\b(?:renamed|rebranded)\b/i.test(fact) && COMPANY_NOUN.test(fact)) || CONSOLE_NEWS.test(fact);
}

export interface ScreenResult {
  kept: string[];
  rejected: Array<{ text: string; reason: string }>;
  /** With `cited`: the sentence each kept caption cites. */
  sources?: Map<string, string>;
}

/** "4 | caption", or "[4] caption": the number of the sentence a caption retells, then the caption. */
const CITATION = /^\s*(?:[-*•]\s*)?(?:\d{1,2}\.\s+(?=\[?\d{1,3}\]?\s*\|))?(?:\[(\d{1,3})\]\s*[|:.)-]?|(\d{1,3})\s*[|｜:)\]-])\s*(.*)$/u;

/** A line the model wrote when told to cite: the sentence number (0 when none) and the caption. */
export function parseCitation(line: string): { at: number; text: string } {
  const m = CITATION.exec(line);
  return m ? { at: Number(m[1] ?? m[2]), text: m[3].trim() } : { at: 0, text: line.trim() };
}

/**
 * Why a caption can't go on screen whatever its reference says: unsafe for a stream, off the
 * content standard, about the prompt, too short, an opinion, an unnamed speaker, the music video,
 * or another part of the soundtrack. Null when none. `titles`: the article's and the song's, which
 * a caption may open with; `names`: the request's artist. Both are read as names, not words.
 * `context`: the reference, for the artist's own words about who they are.
 */
function captionReason(fact: string, titles: string[], otherParts: string[], names: string[] = [], context = ""): string | null {
  const unsafe = NOT_FOR_STREAM.find(({ re }) => re.test(fact));
  if (unsafe) return unsafe.label;
  // The content standard, whatever the reference says: a retelling can add what its source didn't ("charged" told as "convicted").
  const offStandard = standardBreach(fact, [...titles, ...names]);
  // Who someone is, only in the artist's own words, with their name and the words that say so
  // kept ("Jane Doe has described herself as ..."): issue #262.
  const ownWords = offStandard === IDENTITY_REASON && mentionsName(normalizeTitle(fact), names.map(normalizeTitle).filter(Boolean)) && selfDescribedIdentity(fact, context, [...titles, ...names]);
  if (offStandard && !ownWords) return offStandard;
  if (META_PATTERNS.some((re) => re.test(fact))) return "meta-commentary";
  if (fact.length < 20) return "too short";
  if (OPINION.test(fact)) return "opinion";
  // "GameSpy called the music incredible": a review outlet's verdict is an opinion too.
  if (CRITIC_NAMES.test(fact) && /\b(called|wrote|said|described|praised|named|ranked|listed|rated|felt|thought|noted)\b/i.test(fact)) return "a critic's view";
  // "He combined two words": a viewer can't tell who.
  if (/^(He|She|They|His|Her|Their)\b/.test(fact)) return "doesn't say who";
  // "I had the whole thing fleshed out": someone's own words with no one named, which read as the streamer's.
  // ...unless the caption opens with the song's or the article's whole title: "My future was released as a single".
  const isTitle = titles.some((t) => new RegExp(`^${escapeRe(t)}(?![\\p{L}\\p{N}])`, "iu").test(fact));
  if (/^(?:I(?:['’](?:m|ve|d|ll))?|We|My|Our)\s+\p{Ll}/u.test(fact) && !isTitle) return "doesn't say who is speaking";
  // A bubble stands alone: "This was loosely based on ..." leans on a sentence that isn't on screen.
  const bare = BARE_DEMONSTRATIVE.exec(fact);
  if (bare && !isTitle) return `doesn't say what "${bare[1].toLowerCase()}" is`;
  // "The operas are spread across his whole life": whose?
  const works = UNNAMED_WORKS.exec(fact);
  if (works && !isTitle && !namesSomeone(fact)) return `doesn't say whose ${works[1]}`;
  const pronoun = unresolvedPronoun(fact);
  if (pronoun) return `doesn't say who "${pronoun}" is`;
  if (companyHistory(fact, titles)) return "a company's business, not the music";
  if (ABOUT_THE_VIDEO.test(fact)) return "about the music video";
  // A Mondstadt fact under a Liyue track: true, but about another part of the soundtrack.
  const other = otherParts.find((p) => hasWord(p, fact, ""));
  if (other) return `about another part of the soundtrack ("${other}")`;
  return null;
}

/**
 * Why the reference doesn't back a caption: a risky claim it doesn't make, then, when there is a
 * reference, each name, date, credit, quote and joining word checked against it. Null when none.
 * `track`: set when the article isn't the track's own, as for `screenClaims`.
 */
function sourceReason(fact: string, context: string, track: string | undefined): string | null {
  for (const { re, label } of RISKY_PATTERNS) {
    const m = fact.match(re);
    if (m && !hasWord(m[0].trim(), context)) return label;
  }
  if (!context) return null;
  const year = (fact.match(YEAR) ?? []).find((y) => !hasWord(y, context));
  if (year) return `unsupported year ${year}`;
  const day = unsupportedDay(fact, context);
  if (day) return `unsupported date "${day}"`;
  const platform = (fact.match(PLATFORM_PATTERN) ?? []).find((p) => !platformSupported(p, context));
  if (platform) return `unsupported platform "${platform}"`;
  const name = unsupportedName(fact, context);
  if (name) return `unsupported name "${name}"`;
  const credit = unsupportedCredit(fact, context);
  if (credit) return `unsupported credit for "${credit}"`;
  const winner = unsupportedWinner(fact, context);
  if (winner) return `award not given to "${winner}" in the source`;
  const quote = alteredQuote(fact, context);
  if (quote) return `quote not in the source: "${quote}"`;
  const joined = unsupportedConnective(fact, context, track ? [track] : []);
  if (joined) return joined.startsWith("after (") ? `"after" turns round the order of the sentence it retells` : `"${joined}" isn't in the sentence it retells`;
  const relation = unsupportedRelation(fact, context);
  if (relation) return `"${relation}" isn't stated for them in the source`;
  const lost = lostQualifier(fact, context);
  if (lost) return lost;
  const owner = wrongOwner(fact, context);
  if (owner) return `the source says this of ${owner}`;
  const subject = swappedSubject(fact, context);
  if (subject) return `the sentence it retells isn't about "${subject}"`;
  const speaker = misattributedWords(fact, context);
  if (speaker) return `words the source doesn't give to ${speaker}`;
  const doer = otherDoer(fact, context);
  if (doer) return `the sentence it retells is about ${doer}`;
  const role = reversedRole(fact, context);
  if (role) return `the source names someone else's ${role}`;
  const hedge = droppedHedge(fact, context);
  if (hedge) return `drops the source's "${hedge}"`;
  const placed = misplacedYear(fact, context);
  if (placed) return `${placed} isn't the year of the sentence it retells`;
  const cutOff = droppedYear(fact, context);
  if (cutOff) return `says the month but not the year the source gives it with (${cutOff})`;
  if (suppliedException(fact, context)) return "says what the exception is to; the source doesn't";
  const unnamedOne = unnamedReference(fact, context);
  if (unnamedOne) return `doesn't say who or what "${unnamedOne}" is`;
  const view = unattributedView(fact, context);
  if (view) return `a view the source gives to ${view}`;
  // "The musical won four Olivier Awards" from an artist's article, shown during another of their songs.
  const unnamed = UNNAMED_WORK.exec(fact);
  if (unnamed && track && !namesTrack(context.split("\n")[0], track) && !retoldSentences(fact, context).some((s) => namesTrack(s, track)))
    return `doesn't say which ${unnamed[1].toLowerCase()}`;
  return null;
}

/**
 * Keep only facts the reference visibly supports. With no reference (only
 * when FACT_VERIFICATION=off) the source checks are skipped but formatting,
 * meta-commentary, risky claims, length and duplicates are still screened.
 *
 * `otherParts`: the other parts of the soundtrack the reference was cut from.
 * `track`: set when the article isn't the track's own (an artist's, a game's):
 * then "The song ..." reads as this track, so it must retell a sentence that names it.
 * `cited`: each line starts with the number of the sentence it retells (`numberedReference`).
 * `artists`: the request's artist, a name a cited caption may use where its sentence says "the band".
 */
export function screenClaims(facts: string[], rawContext: string, opts: { otherParts?: string[]; track?: string; cited?: boolean; artists?: string[] } = {}): ScreenResult {
  const result: ScreenResult = { kept: [], rejected: [], ...(opts.cited ? { sources: new Map<string, string>() } : {}) };
  // "Wagner‐influenced" with U+2010 is "Wagner-influenced": the name checks compare plain hyphens.
  const plainHyphens = (t: string) => t.replace(/[\u2010\u2011\u2012]/g, "-");
  const context = plainHyphens(rawContext);

  const titles = [withoutQualifier(context.split("\n")[0]), opts.track ?? ""].filter(Boolean);
  const reasonToDrop = (fact: string): string | null =>
    captionReason(fact, titles, opts.otherParts ?? [], opts.artists, context) ??
    sourceReason(fact, context, opts.track) ??
    (fact.length > MAX_FACT_CHARS ? `too long (${fact.length} chars)` : null);

  // Told to cite, the model numbers each caption with the sentence it retells (`numberedReference`).
  // That sentence stands in for the guess by shared words, and the caption must match it (`citedMismatch`).
  const sentences = opts.cited ? referenceSentences(context) : [];
  const title = context.split("\n")[0];
  const citedReason = (fact: string, at: number): string | null => {
    if (!at) return "doesn't say which sentence it retells";
    if (at > sentences.length) return `cites sentence ${at}, which the reference doesn't have`;
    return citedMismatch(fact, sentences, at - 1, title, opts.artists);
  };
  const sourceOf = (fact: string) => result.sources?.get(fact);
  // A small model counts its own lines more than it reads the numbers: once it has joined two
  // sentences into one caption, every number after is one short. A caption that doesn't retell
  // the sentence it cites but clearly retells the one next to it cites that one.
  const nextTo = (fact: string, at: number): number => {
    if (at < 1 || at > sentences.length || share(fact, sentences[at - 1]) >= 0.25) return at;
    const [best] = [at - 1, at + 1]
      .filter((n) => n >= 1 && n <= sentences.length)
      .map((n) => ({ n, share: share(fact, sentences[n - 1]) }))
      .filter((x) => x.share >= 0.5)
      .sort((a, b) => b.share - a.share);
    return best?.n ?? at;
  };

  for (const raw of facts) {
    const parsed = opts.cited ? parseCitation(raw) : { at: 0, text: raw };
    const fact = plainHyphens(stripPrefix(parsed.text));
    const line = { ...parsed, at: opts.cited ? nextTo(fact, parsed.at) : 0 };
    const sentence = opts.cited && line.at >= 1 ? sentences[line.at - 1] : undefined;
    citing = sentence !== undefined ? { fact, sentence } : null;
    let reason: string | null;
    try {
      reason = (opts.cited ? citedReason(fact, line.at) : null) ?? reasonToDrop(fact);
    } finally {
      citing = null;
    }
    if (reason) {
      result.rejected.push({ text: fact, reason });
      continue;
    }
    // Of two near-duplicates, the one closer to its source sentence stays: "resembles" over "was inspired by".
    const twin = result.kept.findIndex((k) => tooSimilar(k, fact));
    if (twin < 0) {
      result.kept.push(fact);
      if (sentence !== undefined) result.sources?.set(fact, sentence);
    } else if (context && support(fact, context, sentence) > support(result.kept[twin], context, sourceOf(result.kept[twin]))) {
      result.rejected.push({ text: result.kept[twin], reason: "near-duplicate of a closer retelling" });
      result.sources?.delete(result.kept[twin]);
      result.kept[twin] = fact;
      if (sentence !== undefined) result.sources?.set(fact, sentence);
    } else result.rejected.push({ text: fact, reason: "near-duplicate of an earlier fact" });
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
