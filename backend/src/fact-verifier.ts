import { SSLSong } from "./types";
import { topic } from "./topic";
import { escapeRe, hasNoArtist } from "./text";
import { IDENTITY_REASON, selfDescribedIdentity, standardBreach } from "./content-standard";
import { ABOUT_MUSIC, contentTokens, CRITIC_NAMES, mentionsName, namesTrack, normalizeTitle, OPINION, reportedSentences, REPORTING, resolveGameAndTrack, withoutQualifier } from "./grounding";

/**
 * Screening.
 *
 * Grounding (grounding.ts) fetches the song's Wikipedia article so the model
 * restates a source instead of recalling from memory. Screening then drops any
 * sentence whose names, years or platforms the source does not contain. Every
 * check is a string comparison: no second model, no added latency.
 */

// Article lookup moved to grounding.ts (#226). Its exports stay reachable from here.
export {
  articleMisfit, articleText, artistNames, clearGroundingCache, composerNames, coverScope, creatorSentences,
  describedKind, dropVersionTags, editDistance, editionNotInTitle, fetchGrounding, foldSymbols,
  gameInsteadOfScreen, gameTrackText, isChartFact, isCleanSentence, isConcertFilm, isCoverOf, isDisambiguation,
  isInitials, isMusicArticleFor, isNonMusicWork, isPerformerArticle, isPieceArticle, isPlaceholderRequest,
  isRelevantArticle, isRespelling, isSameWorkRedirect, isScreenPage, isSeriesWide, isWorkArticle,
  italicSentences, leadNamesPerformer, loadWikitext, looksLikeArtistName, lookupForm, MAX_CONTEXT_CHARS,
  mentionsName, MIN_CONTEXT_CHARS, movementSection, namesLoosely, namesOneWork, namesPiece, namesThisGame,
  nameWords, normalizeKeys, normalizeTitle, notForAPiece, numeralStyleDiffers, oneOfSeveral, openingSays,
  opensAboutMusicOrWork, orderExtract, originalsRecord, otherParts, otherWorkSentences, ownArticleExtract,
  pageSummary, parseClassicalTitle, performerPages, pickWork, pieceSection, qualifierNamesAnotherArtist,
  readings, receptionFilter, receptionSentences, rememberArticle, requestedWork, requestNames,
  resolveGameAndTrack, sectionExtract, sectionSelection, selectedText, selectSections, seriesFilter, seriesScope,
  soundtrackPart, splitGameAndTrack, STABLE_AGE_MS, summaryGate, summaryMismatch, theorySentences, tieredExtract,
  tieredSelection, trackSentences, USER_AGENT, wikiExtract, wikitextOf, withoutSentences, withoutVideoSections,
  workFits, workMatchConfidence, workOfPage, workQueries, workScope
} from "./grounding";
export type { ClassicalTitle, DescribedKind, GameArticles, ItalicSentence, PageSummary, Reading, WorkFit, WorkMatch } from "./grounding";

/** Longest fact that fits a bubble. */
export const MAX_FACT_CHARS = 160;
/** A caption that kept a reporting verb (any tense) or quote marks. */
const KEEPS_REPORTING = /\b(?:say|says|said|write|writes|wrote|written|according|tell|tells|told|describe[sd]?|call(?:s|ed)?|state[sd]?|note[sd]?|claim(?:s|ed)?|recall(?:s|ed)?|explain(?:s|ed)?)\b|["“”]/i;

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
