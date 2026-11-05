import type { SSLSong } from "../types";
import { hasNoArtist } from "../text";

/**
 * Reading a request's title: game and track, version tags, and classical titles
 * (catalog numbers, keys, movements; issue #260).
 */

// --- Title parsing -----------------------------------------------------

/** A trailing parenthetical that marks a variant rather than naming the game. */
const VARIANT_MARKER =
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|\d0'?s\b|live\b|acoustic\b|piano\b|vocal\b|instrumental\b|jazzy\b|original\b|a\s?cc?app?ella\b|lo-?fi\b|ext\b|extended\b|unplugged\b|npr\b|tiny desk\b|feat\b|feat\.|ft\b|ft\.|featuring\b|with\s|tv\s*size\b|full\s*size\b|from the vault\b)/i;
/** A tag that ends by saying it's a version: "(Chill Version)", "(Children's Choir Remix)", "(2020 Performance)". */
const VARIANT_END = /\b(remix|mix|version|ver\.?|cover|arrangement|performance|rendition|edit)(?:\s+\d+)?\.?\s*$/i;
/** "(Day)" and "(Night)" are variants only on their own; "(Night in the Woods)" is a game. */
const VARIANT_WORD = /^\s*(day|night)\s*$/i;

/** Whether a tag in brackets or after a dash says how a song is played, not what it is. */
export const isVariantTag = (tag: string) => VARIANT_MARKER.test(tag) || VARIANT_END.test(tag);

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
export const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
export const ROMAN_NUMBER: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
/** Movement tags: "(3rd Movement)", "2nd mvt", "Mvt. 2", "Movement III", "Third Movement", "I. Allegro", "Variation 18". */
const MOVEMENTS: Array<{ re: RegExp; read: (m: RegExpExecArray) => { n?: number; name?: string } }> = [
  { re: /\s*[([]?\b(\d)(?:st|nd|rd|th)\s+(?:movement|mvt\.?|mov\.?)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /\s*[([]?\b(?:movement|mvt\.?|mov\.?)\s+(\d|[ivx]{1,4})\b[)\]]?/i, read: (m) => ({ n: Number(m[1]) || ROMAN_NUMBER[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\b(first|second|third|fourth|fifth|sixth)\s+movement[)\]]?/i, read: (m) => ({ n: ORDINAL_WORDS[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\bvar(?:iation|\.)\s*(\d+)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /(?:^|\s*[:,–—-]\s*|\s+)\b([IV]{1,3})\.\s+(\p{Lu}[\p{L} ]*?)\s*$/u, read: (m) => ({ n: ROMAN_NUMBER[m[1].toLowerCase()], name: m[2] }) },
];
/** Words naming a classical form: a title with one reads like a piece even without a number. */
export const FORM_WORDS =
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
