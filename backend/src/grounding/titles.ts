import type { SSLSong } from "../types";
import { hasNoArtist } from "../text";

// A request's title read apart: game and track, version tags, classical titles (#260)

// --- Title parsing ---

// A tag that marks a version, not the game
const VARIANT_MARKER =
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|\d0'?s\b|live\b|acoustic\b|piano\b|vocal\b|instrumental\b|jazzy\b|original\b|a\s?cc?app?ella\b|lo-?fi\b|ext\b|extended\b|unplugged\b|npr\b|tiny desk\b|feat\b|feat\.|ft\b|ft\.|featuring\b|with\s|tv\s*size\b|full\s*size\b|from the vault\b)/i;
// Ends with what kind of version: "(Chill Version)", "(Children's Choir Remix)", "(2020 Performance)"
const VARIANT_END = /\b(remix|mix|version|ver\.?|cover|arrangement|performance|rendition|edit)(?:\s+\d+)?\.?\s*$/i;
// "(Day)", "(Night)" are versions only alone; "(Night in the Woods)" is a game
const VARIANT_WORD = /^\s*(day|night)\s*$/i;

/** Whether a bracket or dash tag says how a song is played, not what it is */
export const isVariantTag = (tag: string) => VARIANT_MARKER.test(tag) || VARIANT_END.test(tag);

// Remix styles ("80's", "Synthwave", "Lofi"): they name no work
const REMIX_STYLE =
  /^(?:\d0'?s|lo-?fi|trap|edm|synthwave|synth|chill|chillhop|retro|reggae|reggaeton|orchestral|dubstep|downtempo|jazz|jazzy|funk|future|house|techno|disco|rock|metal|piano|acoustic|club|dance|epic|8-?bit|chiptune|vaporwave|waltz|extended|original|official)$/i;

/** The title without version tags, which find nothing: "Numb - 80's Remix" is "Numb" (ARCHITECTURE.md: choosing the article) */
export function dropVersionTags(title: string): string {
  let t = title.replace(/\s*[([]([^)\]]*)[)\]](?=\s+[-–—]\s)/g, (tag, inner: string) => (isVariantTag(inner) ? "" : tag));
  for (let m; (m = /^(.+?)\s*[([]([^)\]]*)[)\]]\s*$/.exec(t)) && isVariantTag(m[2]); ) t = m[1];
  const dash = /^(.+?)\s+[-–—]\s+([^-–—]+)$/.exec(t);
  if (dash && VARIANT_MARKER.test(dash[2]) && !VARIANT_END.test(dash[2]) && !/^\s*(act|part)\b/i.test(dash[2])) {
    // "Song - Live at Wembley", "Song - 2011 Remaster"
    t = dash[1];
  } else if (dash && VARIANT_END.test(dash[2])) {
    // "Let the Battles Begin - FFVII Remix" keeps "FFVII", the work
    const words = dash[2].replace(VARIANT_END, "").trim().split(/\s+/).filter(Boolean);
    while (words.length && REMIX_STYLE.test(words[words.length - 1])) words.pop();
    t = words.length ? `${dash[1]} - ${words.join(" ")}` : dash[1];
  }
  return t.trim();
}

// --- Classical titles (#260) ---

/** A classical title read apart: its name and numbering */
export interface ClassicalTitle {
  /** Without catalog numbers, key and movement: "Nocturne", "Moonlight Sonata" */
  name: string;
  /** Another name in brackets: "La Primavera" in "Spring (La Primavera)" */
  alias: string;
  /** In Wikidata's style: "Op. 9", "BWV 1007", "K. 331" */
  catalogs: string[];
  /** Every number given: "9" and "2" for "Op. 9 No. 2" */
  numbers: string[];
  /** Spelled out: "E-flat major", "C-sharp minor", "D" */
  key: string;
  /** A hint, never searched */
  movement: { n?: number; name?: string } | null;
  /** Reads like a piece: a catalog number, key, movement or form */
  classical: boolean;
}

// Catalogs as lists write them, and Wikidata's spelling; "D", "S", "L", "K", "B" need a number after
const CATALOG = /(?<![\p{L}#♯♭-])(op(?:us)?\.?|bwv|kv?\.?|d\.?|hob\.?|rv|hwv|s\.?|woo|l\.?|b\.?)\s*((?:[ivx]+[a-z]?:)?\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?)(?![\p{L}\d])/giu;
const CATALOG_NAMES: Record<string, string> = { op: "Op.", opus: "Op.", bwv: "BWV", k: "K.", kv: "K.", d: "D.", hob: "Hob.", rv: "RV", hwv: "HWV", s: "S.", woo: "WoO", l: "L.", b: "B." };
// "No. 2", "No.1", "No 1", "Nr. 2", "#3"
const NUMBERED = /(?:\b(?:no|nr|nos)\.?\s*|(?<![A-Ga-g])#\s*)(\d+)\b/gi;
// Key with mode: "E-flat major", "Eb major", "C# minor", "in d minor"
const KEY_MODE = /(?:\bin\s+)?(?<![\p{L}])([A-Ga-g])(?:\s*-?\s*(flat|sharp)|\s*([♭♯#]|b(?=\s)))?\s+(major|minor)\b/iu;
// Key after "in", no mode: "Canon in D", "Prelude in C#"
const KEY_IN = /\bin\s+([A-G])(?:\s*-?\s*(flat|sharp)|([♭♯#]|b\b))?(?![\p{L}\d])/u;
export const ORDINAL_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
export const ROMAN_NUMBER: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
// Movement tags: "(3rd Movement)", "2nd mvt", "Mvt. 2", "Movement III", "Third Movement", "I. Allegro", "Variation 18"
const MOVEMENTS: Array<{ re: RegExp; read: (m: RegExpExecArray) => { n?: number; name?: string } }> = [
  { re: /\s*[([]?\b(\d)(?:st|nd|rd|th)\s+(?:movement|mvt\.?|mov\.?)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /\s*[([]?\b(?:movement|mvt\.?|mov\.?)\s+(\d|[ivx]{1,4})\b[)\]]?/i, read: (m) => ({ n: Number(m[1]) || ROMAN_NUMBER[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\b(first|second|third|fourth|fifth|sixth)\s+movement[)\]]?/i, read: (m) => ({ n: ORDINAL_WORDS[m[1].toLowerCase()] }) },
  { re: /\s*[([]?\bvar(?:iation|\.)\s*(\d+)[)\]]?/i, read: (m) => ({ n: Number(m[1]) }) },
  { re: /(?:^|\s*[:,–—-]\s*|\s+)\b([IV]{1,3})\.\s+(\p{Lu}[\p{L} ]*?)\s*$/u, read: (m) => ({ n: ROMAN_NUMBER[m[1].toLowerCase()], name: m[2] }) },
];
// Classical forms: a title with one reads like a piece even without a number
export const FORM_WORDS =
  /\b(sonata|sonatina|nocturne|pr[eé]lude|[eé]tude|etude|waltz|valse|symphony|concerto|suite|fugue|toccata|mazurka|polonaise|ballade|impromptu|rhapsod(?:y|ie)|gymnop[eé]die|arabesque|minuet|menuet|serenade|scherzo|rondo|bagatelle|partita|invention|sinfonia|overture|requiem|cantata|aria|liebestraum|barcarolle|berceuse|fantasia|fantaisie|intermezzo|capriccio|caprice|divertimento|canon|chaconne|passacaglia|gavotte|sarabande|gigue|allemande|courante|lied|lieder|r[eê]verie|humoresque|moment musical)s?\b/i;

/** A key as Wikipedia and Wikidata write it: "E-flat major", "C-sharp minor", "D" */
function spellKey(letter: string, word = "", sign = "", mode = ""): string {
  const accidental = word ? word.toLowerCase() : sign === "#" || sign === "♯" ? "sharp" : sign ? "flat" : "";
  const name = `${letter.toUpperCase()}${accidental ? `-${accidental}` : ""}`;
  return mode ? `${name} ${mode.toLowerCase()}` : name;
}

/** Keys spelled one way for comparing: "C# minor", "C♯ minor", "C-sharp minor" all read "c sharp minor" */
export function normalizeKeys(s: string): string {
  return s
    .replace(/(?<![\p{L}])([A-Ga-g])\s*(?:[#♯]|-?\s*sharp\b)/gu, "$1 sharp")
    .replace(/(?<![\p{L}])([A-Ga-g])\s*(?:♭|-?\s*flat\b|b(?=\s+(?:major|minor)\b))/giu, "$1 flat");
}

/** Separators and spaces off both ends ("Nocturne ,;- " is "Nocturne"); a loop, not a regex, so linear on any input */
function trimSeparators(s: string): string {
  const separator = (c: string) => /[\s,:;–—-]/.test(c);
  let start = 0;
  let end = s.length;
  while (start < end && separator(s[start])) start++;
  while (end > start && separator(s[end - 1])) end--;
  return s.slice(start, end);
}

/** Without the quotation marks around it */
function unquote(s: string): string {
  const m = /^["“”](.*)["“”]$/.exec(s.trim());
  return (m ? m[1] : s).trim();
}

/** Reads a classical title apart: "Nocturne in E-flat major, Op. 9, No. 2"; a movement is a hint (#260) */
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
  // Brackets without numbers: "(op. 3, no. 1, "Elegie")" names "Elegie"; "from Some Suite" is the set, not a name
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

/** Splits "Game: Track", "Game - Track" or "Track (Game)" */
export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const paren = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && !isVariantTag(paren[2]) && !VARIANT_WORD.test(paren[2])) {
    // "Let It Go (From "Frozen")": the work follows "From"
    const from = /^\s*from\s+["“'‘]?(.+?)["”'’]?\s*$/i.exec(paren[2]);
    return { game: (from ? from[1] : paren[2]).trim(), track: paren[1].trim() };
  }

  const sep = clean.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (sep) return { game: sep[1].trim(), track: sep[2].trim() };

  return { game: clean, track: clean };
}

/** Game from the artist field, track from the title, unless the title's "Game:" extends it ("Super Mario" -> "Super Mario 64") */
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
    // "Yoshi's Story: On the Beach" from "Yoshi": a possessive extends the name too
    if (g.startsWith(a + " ") || (g.startsWith(a) && /^['’]s /.test(g.slice(a.length)))) return split;
  }
  return { game: artist, track: title };
}

/** "P!nk", "Ke$ha" -> "Pink", "Kesha", as their articles write them */
export const foldSymbols = (name: string): string => name.replace(/(?<=\p{L})!(?=\p{L})/gu, "i").replace(/(?<=\p{L})\$(?=\p{L})/gu, "s");

/** Names to look for in a credit, whole then lead; only commas and "feat." split ("&", "and", "x" are often in a name) */
export function artistNames(artist: string): string[] {
  if (hasNoArtist(artist)) return [];
  const lead = artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? "";
  // Two full names joined by "and": an article may name each alone; "Simon and Garfunkel" stays one
  const pair = artist.split(/\s+(?:and|&)\s+/i);
  const people = pair.length === 2 && pair.every((p) => p.trim().split(/\s+/).length >= 2) ? pair : [];
  // Articles write "and" as "&", and the other way round
  const joined = [lead.replace(/\s+and\s+/gi, " & "), lead.replace(/\s+&\s+/g, " and ")];
  const folded = [artist, lead].map(foldSymbols);
  return [...new Set([artist, lead, ...people, ...joined, ...folded].map(normalizeTitle).filter(Boolean))];
}

/** Whether normalized text names one of these as whole words: "Sia" isn't in "Asia" */
export function mentionsName(normalizedText: string, names: string[]): boolean {
  const padded = ` ${normalizedText} `;
  return names.some((n) => padded.includes(` ${n} `));
}

/** Lowercase, no accents, trailing "(qualifier)" or punctuation; "X-2" -> "x2", one word with its sequel number */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    // Trailing bracket tags: "(Worlds Apart)", "[Instrumental]", "(Live) (Remastered)"
    .replace(/(?:\s*(?:\([^)]*\)|\[[^\]]*\]))+\s*$/, "")
    .toLowerCase()
    .replace(/(\p{L})-(\d)/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
