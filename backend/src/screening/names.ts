import { escapeRe } from "../text";
import { mentionsName, normalizeTitle } from "../grounding/titles";

/**
 * Screening names and credits: a caption's people, roles, winners and
 * platforms must be in the source.
 */

// --- Screening ---------------------------------------------------------

/** Whole-word, whole-phrase containment. */
export const hasWord = (needle: string, haystack: string, flags = "i") =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, flags + "u").test(haystack);

/** Claims that are easy to get wrong and obvious when wrong. */
export const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /(#\s?\d+\b|\bnumber one\b|\bno\.\s?\d+\b|\btopped the chart|\bbillboard\b)/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];
/**
 * Things no song fact contains, whatever the source says: a link, a chat
 * command or an @mention. A crafted request title or a vandalized article is
 * the only way one gets into a caption.
 */
export const NOT_FOR_STREAM: Array<{ re: RegExp; label: string }> = [
  { re: /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(com|net|org|tv|gg|io|ly|co|me|be|xyz|link)\b/i, label: "a link" },
  { re: /(^|\s)![a-z]/i, label: "a chat command" },
  { re: /(^|\s)@\w/, label: "an @mention" },
];
/** Why text from outside can't go on stream at all, or null: the first of NOT_FOR_STREAM it breaks. */
export const notForStream = (text: string): string | null => NOT_FOR_STREAM.find(({ re }) => re.test(text))?.label ?? null;

/**
 * The music video, or its shoot: "the original video", "after filming stopped",
 * "the video shoot". Never "the video game" or "in the video game".
 */
export const ABOUT_THE_VIDEO =
  /\b(?:music videos?|video clips?|(?:in )?the (?:(?:original|first|second|third|official|accompanying|later|new|lyric) )?videos?(?!\s*games?\b)|filming|(?:video |photo )?shoots?(?!\s*['’]?em\b|-em))\b|(?:['’]s?|\b(?:his|her|their|its))\s+(?:(?:official|music|lyric) )?videos?\b(?!\s*games?\b)/iu;

/** The model reasoning about its source instead of stating a fact. */
export const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|here is|sure[,!])/i,
];

export const YEAR = /\b(1\d{3}|20\d{2})\b/g;
/** Capitalized words, including "McCartney"; two or more, or a single Mc- surname. */
/** "DeVoe", "LaBelle" and "YouTube" are one word each. */
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*)`;
export const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

export const PLATFORM_PATTERN =
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
export const NAME_STOPWORDS = new Set([
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
export const sourceSentences = (context: string) => context.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?])\s+|\n+/u);

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
