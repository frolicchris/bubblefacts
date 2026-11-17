import { escapeRe } from "../text";
import { mentionsName, normalizeTitle } from "../grounding/titles";

// Names and credits: a caption's people, roles, winners and platforms must be in the source

// --- Screening ---

/** Whole-word, whole-phrase match */
export const hasWord = (needle: string, haystack: string, flags = "i") =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, flags + "u").test(haystack);

// Claims easy to get wrong and obvious when wrong
export const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /(#\s?\d+\b|\bnumber one\b|\bno\.\s?\d+\b|\btopped the chart|\bbillboard\b)/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];
// Never in a song fact: only a crafted request title or a vandalized article puts one there
export const NOT_FOR_STREAM: Array<{ re: RegExp; label: string }> = [
  { re: /\bhttps?:|\bwww\.|\b[a-z0-9-]+\.(com|net|org|tv|gg|io|ly|co|me|be|xyz|link)\b/i, label: "a link" },
  { re: /(^|\s)![a-z]/i, label: "a chat command" },
  { re: /(^|\s)@\w/, label: "an @mention" },
];
/** The first NOT_FOR_STREAM rule outside text breaks, or null */
export const notForStream = (text: string): string | null => NOT_FOR_STREAM.find(({ re }) => re.test(text))?.label ?? null;

// The music video or its shoot ("after filming stopped"), never "the video game"
export const ABOUT_THE_VIDEO =
  /\b(?:music videos?|video clips?|(?:in )?the (?:(?:original|first|second|third|official|accompanying|later|new|lyric) )?videos?(?!\s*games?\b)|filming|(?:video |photo )?shoots?(?!\s*['’]?em\b|-em))\b|(?:['’]s?|\b(?:his|her|their|its))\s+(?:(?:official|music|lyric) )?videos?\b(?!\s*games?\b)/iu;

// The model talking about its source instead of stating a fact
export const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|here is|sure[,!])/i,
];

export const YEAR = /\b(1\d{3}|20\d{2})\b/g;
// Two or more capitalized words, or one Mc- surname; "DeVoe", "LaBelle", "YouTube" are one word
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*)`;
export const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

export const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy(?: Advance| Colou?r)?|Nintendo DS|3DS|PlayStation(?: [2-5]| Portable| Vita)?|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

// Names for the same hardware: each supports the others in its group
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

// Also ordinary words: only the capital tells them apart
const AMBIGUOUS_PLATFORMS = new Set(["switch", "saturn", "genesis", "vita"]);

/** Whether the reference names this platform, or another name for it */
export function platformSupported(platform: string, context: string): boolean {
  const p = platform.toLowerCase();
  const direct = AMBIGUOUS_PLATFORMS.has(p)
    ? namesPlatform(p[0].toUpperCase() + p.slice(1), context, "")
    : namesPlatform(p, context);
  return direct || (PLATFORM_ALIASES.get(p) ?? []).some((a) => namesPlatform(a, context));
}

// Turns a console's name into its sibling's: "Wii U", "PlayStation 4", "Game Boy Advance"
const SIBLING_SUFFIX = /^[\s-]+(?:U|[2-5]|360|One|Series|Advance|Colou?r|Portable|Vita|Pocket|DSi?|XL|Lite)(?![\p{L}\p{N}])/iu;

/** Named on its own, not just in a sibling's name: "Wii U" doesn't support "the Wii" (review) */
function namesPlatform(name: string, context: string, flags = "i"): boolean {
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, `g${flags}u`);
  for (const m of context.matchAll(re)) {
    if (!SIBLING_SUFFIX.test(context.slice((m.index ?? 0) + m[0].length))) return true;
  }
  return false;
}

// Leading words that make a capitalized run look like a name
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
  // "influenced by Western action movies": a place or people, not a person
  "western", "eastern", "northern", "southern", "british", "irish", "scottish", "italian",
  "spanish", "russian", "chinese", "korean", "asian", "african", "latin", "celtic",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

// Kinds of credit and the words that state each: "Smith directed" doesn't support "Smith wrote the soundtrack" (review)
const ROLES: Array<{ fact: RegExp; source: RegExp; musicOnly?: boolean }> = [
  // "wrote" composes only next to music ("wrote the score"), never "wrote the story"
  { fact: /\b(compos\w*|scored|wr[io]te\s+the\s+(music|score|soundtrack)|written\s+the\s+(music|score|soundtrack)|music\s+(was\s+)?(written|composed)\s+by)\b/i, source: /\b(compos\w*|scored|wr[io]te|written|writer)\b/i, musicOnly: true },
  { fact: /\b(wr[io]te|written|penned|lyrics?)\b/i, source: /\b(wr[io]te|written|writ\w*|lyric\w*|penned|songwrit\w*|compos\w*)\b/i },
  { fact: /\bproduc\w*/i, source: /\bproduc\w*/i },
  { fact: /\bdirect\w*/i, source: /\bdirect\w*/i },
  { fact: /\b(performed|sang|sung|sings|vocals?|recorded)\b/i, source: /\b(perform\w*|sang|sung|sing\w*|vocal\w*|record\w*|band|singer|rapper|musician)\b/i },
  { fact: /\b(designed|developed)\b/i, source: /\b(design\w*|develop\w*)\b/i },
  // Catches "Mizuki illustrated" for "written by Mizuki and illustrated by Aki Tanabe"
  { fact: /\billustrat(?:ed|es|ions?)\b/i, source: /\billustrat\w*/i },
];
// What "wrote" needs nearby to mean composing
const MUSIC_OBJECT = /^(music|musical|score|scores|soundtrack|soundtracks|theme|themes|songs?|melod\w*|tunes?|pieces?|instrumentals?)$/;
// Name right before a credit verb: "Adele composed", "Mia Chen and Toby Fox wrote"
const ACTIVE_NAME = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|originally\s+)?(?:composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|illustrated)\b/gu;
const ROLE_REACH = 6;  // most words between a name and its role word
// Performing is stated loosely ("Coldplay are a British rock band"); a mix-up is harmless
const LOOSE_ROLE = /perform/;
// A name right before one is its subject, not the end of an earlier list
const CREDIT_VERB = /^(composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|arranged|published|illustrated)$/i;
// Nouns crediting whoever follows "by": "music by", "lyrics by"
const BY_NOUN: Array<{ noun: RegExp; means: RegExp }> = [
  { noun: /^(music|score|soundtrack)$/i, means: /compos/ },
  { noun: /^lyrics?$/i, means: /lyric/ },
];
const NAME_PARTICLE = /^(de|van|von|da|del|la|le|and|&|,)$/i;
// Describes who follows "by": "by singer-songwriters", "by the band"
const DESCRIPTOR = /^(?:[\p{L}-]*(?:er|ers|or|ors|ist|ists|ian|ians)|the|band|bands|duo|group|trio|team|his|her|their)$/u;

/**
 * Whether a sentence ties this person to this credit: "Smith directed", "composed by Smith", "composer Chen".
 * Nearness isn't enough ("Smith directed, while Chen composed", final QA #1); ambiguous = no
 */
function statesRole(sentence: string, surname: string, role: { source: RegExp; musicOnly?: boolean }): boolean {
  const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*|[,;]/gu) ?? [];
  const lower = tokens.map((t) => t.toLowerCase().replace(/['’]s$/, "").replace(/\.+$/, ""));
  const isName = (i: number) => /^\p{Lu}/u.test(tokens[i]) && !NAME_STOPWORDS.has(lower[i]);
  // In a list of credited names, any capitalized word counts: "Falcom Sound Team jdk"
  const noCaps = sentence === sentence.toLowerCase(); // lowercased text can't show where a name ends
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
        // Active: rest of a name list, plain words, the verb
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
          // Title: "composer Mia Chen"
          if (/(er|or|ist)$/.test(lower[j]) && span.every((_, n) => isCap(j + 1 + n))) return true;
          continue;
        }
        // Passive: a few plain words, "by", then only names
        const before = span.slice(0, by);
        const list = span.slice(by + 1);
        if (before.length > 3 || before.some((w) => /^[,;]$/.test(w))) continue;
        // A descriptor may come first: "by singer-songwriters Eugene Wilde and Albert Manno"
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

/** Source sentences; a middle initial ends none ("Barry J. Eastmond") */
export const sourceSentences = (context: string) => context.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?])\s+|\n+/u);

// "by Adele", "by Nobuo Uematsu"
const BY_NAME = /\bby\s+((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|de|van|von|da|del|la|le))*)/gu;

// A shared credit: "co-wrote the song with A and B"
const WITH_NAMES =
  /\b(?:co-?)?(?:wr[io]te|written|composed|produced|penned)\b[^.;]*?\b(?:with|alongside)\s+(?:(?:co-)?\p{Ll}[\p{Ll}-]*er\s+)?((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:(?:\s+|\s*,\s*)(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|and|&|de|van|von))*)/gu;

/** Names a fact credits: after "by", before a credit verb, or sharing it "with" */
function creditedNames(fact: string): string[] {
  const names = new Set<string>();
  for (const m of fact.matchAll(BY_NAME)) names.add(m[1].trim().replace(/[.'’-]+$/, ""));
  for (const m of fact.matchAll(ACTIVE_NAME)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length) names.add(words.join(" "));
  }
  // Partners share the credit: "wrote it with L.A. Reid and Daryl Simmons"
  for (const m of fact.matchAll(WITH_NAMES)) {
    for (const n of m[1].split(/\s*,\s*|\s+(?:and|&)\s+/)) if (/^\p{Lu}/u.test(n.trim())) names.add(n.trim().replace(/[.'’-]+$/, ""));
  }
  // Only a credit's own grammar counts: other capitals are usually a game ("music for Chrono Trigger");
  // checking them dropped true facts on most game tracks (October 1 live stream log)
  return [...names];
}

/** Name credited with a role no source sentence gives them, or null */
export function unsupportedCredit(fact: string, context: string): string | null {
  let roles = ROLES.filter((r) => r.fact.test(fact));
  // "wrote the music" composes; the plain writing role would accept "wrote the story"
  if (roles.includes(ROLES[0]) && !/\b(lyric\w*|words)\b/i.test(fact)) roles = roles.filter((r) => r !== ROLES[1]);
  if (!roles.length) return null;
  const sentences = sourceSentences(context);
  for (const name of creditedNames(fact)) {
    const words = name.split(/\s+/);
    const surname = (words.pop() ?? name).toLowerCase();
    // "John Williams" doesn't credit "Paul Williams". Given = the word before the surname ("Narada Michael Walden")
    const given = words.filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()) && !/^\p{Lu}\.$/u.test(w)).pop();
    const stated = sentences.some((sentence) => roles.some((r) => statesRole(sentence, surname, r)) && sameGivenName(sentence, surname, given));
    if (!stated) return name;
  }
  return null;
}

/** Surname with this given name or its initial, or bare (other romanizations), never another given name */
function sameGivenName(sentence: string, surname: string, given: string | undefined): boolean {
  if (!given) return true;
  const g = given.replace(/\.$/, "").toLowerCase();
  // Skips a middle initial: "Barry J. Eastmond"
  const re = new RegExp(`(?:([\\p{L}.'’-]+)\\s+)?(?:\\p{Lu}\\.\\s+)?${escapeRe(surname)}(?![\\p{L}])`, "giu");
  for (const m of sentence.matchAll(re)) {
    const before = (m[1] ?? "").replace(/\.$/, "");
    if (!/^\p{Lu}/u.test(before) || NAME_STOPWORDS.has(before.toLowerCase())) return true;
    const b = before.toLowerCase();
    if (b === g || (b.length === 1 && g.startsWith(b)) || (g.length === 1 && b.startsWith(g))) return true;
  }
  return false;
}

// Name right before winning: "Audrey Hepburn won", "Mancini received"
const WINNER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+)?(?:won|received|earned|was awarded)\b/gu;
const WON = { source: /^(won|wins|winning|awarded|received|earned|winner)$/i };

/**
 * Winner the source doesn't name as one, or null: the song's award isn't its singer's (Moon River and
 * Audrey Hepburn, seen replaying a stream). The article's own work is left to the award checks
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

/** First name not in the source, or null. Whole words: "Koshiro" alone passes, "Ed" inside "played" doesn't */
export function unsupportedName(fact: string, context: string): string | null {
  // One-word names in a credit must be there too: "composed by Adele", "Adele composed"
  for (const m of [...fact.matchAll(BY_NAME), ...fact.matchAll(ACTIVE_NAME)]) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length && !words.every((w) => hasWord(w, context))) return words.join(" ");
  }
  for (const candidate of fact.match(NAME) ?? []) {
    // "Colonel Abrams' track": the possessive isn't part of the name
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, ""));
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    const isName = words.length >= 2 || /^Mc/.test(words[0] ?? "");
    if (!isName || words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    if (words.every((w) => hasWord(w, context))) continue;
    return words.join(" ");
  }
  return null;
}
