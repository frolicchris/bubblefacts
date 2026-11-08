import { escapeRe } from "../text";
import { IDENTITY_REASON, selfDescribedIdentity, standardBreach } from "../content-standard";
import { MAX_FACT_CHARS } from "../fact-limits";
import { mentionsName, normalizeTitle } from "../grounding/titles";
import { significantTokens, withoutQualifier } from "../grounding/relevance";
import { ABOUT_MUSIC, CRITIC_NAMES, OPINION } from "../grounding/wikipedia";
import { ABOUT_THE_VIDEO, hasWord, META_PATTERNS, NOT_FOR_STREAM, PLATFORM_PATTERN, platformSupported, RISKY_PATTERNS, unsupportedCredit, unsupportedName, unsupportedWinner, YEAR } from "./names";
import { alteredQuote, stripPrefix, tooSimilar } from "./similarity";
import { lostQualifier, referenceSentences, retoldSentences, setCiting, share, support, unsupportedConnective, unsupportedRelation } from "./sentences";
import { citedMismatch, droppedYear, misattributedWords, otherDoer, swappedSubject, unattributedView, unsupportedDay } from "./attribution";
import { droppedFrame, droppedLimit, leftBehindReferent, movedChartDetail, namesSomeone, unnamedChart, unnamedReference } from "./frames";
import { droppedHedge, mergedClauses, misplacedYear, otherRecordingSection, reversedRole, suppliedException, turnedRound, wrongOwner } from "./wording";

// Screening's entry point: screenClaims drops captions the source doesn't support

/** Names the track, small words aside: "Through the Fire and Flames" for "...and the Flames" */
export function namesTrack(text: string, track: string): boolean {
  const want = significantTokens(normalizeTitle(track));
  const have = new Set(normalizeTitle(text).split(" "));
  return mentionsName(normalizeTitle(text), [normalizeTitle(track)]) || (want.length > 0 && want.every((t) => have.has(t)));
}

// Works "The song" or "This theme" can stand for
const WORK_KINDS = "song|track|piece|tune|musical|show|collection|album|single|EP|record|suite|composition|work|theme|symphony|opera|concerto|sonata|overture";
// A work the caption doesn't name
const UNNAMED_WORK = new RegExp(`^(?:The|This|That) (${WORK_KINDS})\\b(?!\\s*["“'‘]|\\s+\\p{Lu})`, "u");

// Several works: never the one requested
const WORKS_KINDS = "songs|tracks|pieces|tunes|albums|singles|records|suites|compositions|works|themes|symphonies|operas|concertos|concerti|sonatas|quartets|overtures|ballets";
// "The symphonies are ...": unnamed works
const UNNAMED_WORKS = new RegExp(`^(?:The|These|Those) (${WORKS_KINDS})\\b(?!\\s*["“'‘]|\\s+\\p{Lu})`, "u");

// "This was loosely based on", "That year": nothing named (a kind of work is UNNAMED_WORK's)
const BARE_DEMONSTRATIVE = new RegExp(`^(This|That|These|Those)\\b(?![’'])(?!\\s*["“'‘]|\\s+\\p{Lu})(?!\\s+(?:${WORK_KINDS}|${WORKS_KINDS})\\b)`, "u");

// Who a "his" or "her" can stand for unnamed: "the song's narrator ... his"
const PERSON_NOUN =
  /\b(?:singer|composer|songwriter|lyricist|narrator|protagonist|character|frontman|frontwoman|vocalist|guitarist|drummer|bassist|pianist|violinist|producer|conductor|artist|musician|rapper|author|writer|director|actor|actress|father|mother|wife|husband|son|daughter|brother|sister|boy|girl|man|woman|king|queen|prince|princess|hero|heroine|villain|player|friend|teacher|child)s?\b/i;

/** A "he" or "her" with no one named for it ("across his whole life"), or null; quoted words aside */
export function unresolvedPronoun(fact: string): string | null {
  if (namesSomeone(fact)) return null;
  const words = fact.replace(/["“][^"”]*["”]/g, " ");
  const m = /\b(he|him|his|himself|she|her|hers|herself)\b/i.exec(words);
  if (!m) return null;
  return PERSON_NOUN.test(words.slice(0, m.index)) ? null : m[1].toLowerCase();
}

// "signed a five-year deal with", "an agreement with"
const COMPANY_DEAL = /\b(?:signed|struck|reached|inked)\b[^.;]{0,40}\b(?:deal|contract|agreement)\b|\b(?:deal|contract|agreement) with\b/i;
// Bought or merged: "purchased Brightwater Studios", "acquired the rights"
const COMPANY_BOUGHT = /\b(?:acquired|purchased|bought(?: out)?|took over)\s+(?:the\s+)?(?:rights\b|\p{Lu})|\b(?:merged with|[Mm]erger|[Aa]cquisition|[Tt]akeover|[Bb]uyout|[Ss]ubsidiary)\b/u;
// A company, by kind or its name's last word
const COMPANY_NOUN =
  /\b(?:[Cc]ompan(?:y|ies)|[Ss]tudios?|[Dd]evelopers?|[Pp]ublishers?|[Ff]irms?|[Ss]ubsidiar(?:y|ies)|[Cc]orporations?|Inc|Ltd|LLC|Corp|Entertainment|Interactive|Software|Games|Productions|Pictures)\b/;
// "The next-generation console was announced to be the Orbis"
const CONSOLE_NEWS = /\b(?:console|hardware)\b[^.;]{0,40}\bannounced\b|\bannounced\b[^.;]{0,40}\b(?:console|hardware)\b|\bnext[- ]generation (?:console|platform|system|hardware)\b/i;
// Led by the work: "The game was announced", "It was renamed"
const WORK_LED = /^(?:The|This) (?:game|song|track|piece|album|film|series|soundtrack)\b|^It\b/;

/** A company's business, not the music: deals, buyouts, a company renamed, console news unless led by the work (`titles`) */
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
  /** With `cited`: the sentence each kept caption cites */
  sources?: Map<string, string>;
}

// "4 | caption" or "[4] caption"
const CITATION = /^\s*(?:[-*•]\s*)?(?:\d{1,2}\.\s+(?=\[?\d{1,3}\]?\s*\|))?(?:\[(\d{1,3})\]\s*[|:.)-]?|(\d{1,3})\s*[|｜:)\]-])\s*(.*)$/u;

/** A cited line's sentence number (0 when none) and caption */
export function parseCitation(line: string): { at: number; text: string } {
  const m = CITATION.exec(line);
  return m ? { at: Number(m[1] ?? m[2]), text: m[3].trim() } : { at: 0, text: line.trim() };
}

// Openers the screens look for; a one-word title can't stand in for them
const OPENER_WORD = /^(?:I(?:['’](?:m|ve|d|ll))?|We|My|Our|He|She|They|His|Her|Their|It|This|That|These|Those|The)$/iu;

/**
 * Opens with the song's or article's title, so the who/what checks don't apply. One-word titles match as
 * written, never as an opener: for a song titled "I", "I wrote it in a night" still names nobody (#230)
 */
function opensWithTitle(fact: string, titles: string[]): boolean {
  return titles.some((raw) => {
    const t = raw?.trim();
    if (!t) return false;
    const oneWord = !/\s/.test(t);
    if (oneWord && OPENER_WORD.test(t)) return false;
    // A caption opens with a capital whatever the list wrote: "hurt" as "Hurt"
    const want = oneWord ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    return new RegExp(`^${escapeRe(want)}(?![\\p{L}\\p{N}])`, oneWord ? "u" : "iu").test(fact);
  });
}

/** Why a caption can't go on screen whatever the reference says, or null. `titles`, `names` (the artist) are read as names */
function captionReason(fact: string, titles: string[], otherParts: string[], names: string[] = [], context = ""): string | null {
  const unsafe = NOT_FOR_STREAM.find(({ re }) => re.test(fact));
  if (unsafe) return unsafe.label;
  // Whatever the reference says: a retelling can add what it didn't ("charged" told as "convicted")
  const offStandard = standardBreach(fact, [...titles, ...names]);
  // Who someone is: only in the artist's own words, named ("Jane Doe has described herself as") (#262)
  const ownWords = offStandard === IDENTITY_REASON && mentionsName(normalizeTitle(fact), names.map(normalizeTitle).filter(Boolean)) && selfDescribedIdentity(fact, context, [...titles, ...names]);
  if (offStandard && !ownWords) return offStandard;
  if (META_PATTERNS.some((re) => re.test(fact))) return "meta-commentary";
  if (fact.length < 20) return "too short";
  if (OPINION.test(fact)) return "opinion";
  // A review outlet's verdict is an opinion too: "GameSpy called the music incredible"
  if (CRITIC_NAMES.test(fact) && /\b(called|wrote|said|described|praised|named|ranked|listed|rated|felt|thought|noted)\b/i.test(fact)) return "a critic's view";
  if (/^(He|She|They|His|Her|Their)\b/.test(fact)) return "doesn't say who";
  // Unnamed "I" reads as the streamer, unless it's the title: "My future was released as a single"
  const isTitle = opensWithTitle(fact, titles);
  if (/^(?:I(?:['’](?:m|ve|d|ll))?|We|My|Our)\s+\p{Ll}/u.test(fact) && !isTitle) return "doesn't say who is speaking";
  // A bubble stands alone: "This was..." leans on a sentence not on screen
  const bare = BARE_DEMONSTRATIVE.exec(fact);
  if (bare && !isTitle) return `doesn't say what "${bare[1].toLowerCase()}" is`;
  const works = UNNAMED_WORKS.exec(fact);
  if (works && !isTitle && !namesSomeone(fact)) return `doesn't say whose ${works[1]}`;
  const pronoun = unresolvedPronoun(fact);
  if (pronoun) return `doesn't say who "${pronoun}" is`;
  const leftBehind = leftBehindReferent(fact, titles, names, context);
  if (leftBehind) return `doesn't say what "${leftBehind}" is`;
  if (companyHistory(fact, titles)) return "a company's business, not the music";
  if (ABOUT_THE_VIDEO.test(fact)) return "about the music video";
  // True, but about another part of the soundtrack (a Mondstadt fact under a Liyue track)
  const other = otherParts.find((p) => hasWord(p, fact, ""));
  if (other) return `about another part of the soundtrack ("${other}")`;
  return null;
}

/** Why the reference doesn't back a caption (risky claim, name, date, credit, quote, joining word), or null */
function sourceReason(fact: string, context: string, track: string | undefined, titles: string[] = [], artists: string[] = []): string | null {
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
  const merged = mergedClauses(fact, context);
  if (merged) return `joins two statements: "${merged}" belongs to another clause`;
  const hedge = droppedHedge(fact, context);
  if (hedge) return `drops the source's "${hedge}"`;
  const frame = droppedFrame(fact, context, titles);
  if (frame) return `drops what the source opens with: "${frame}"`;
  const limit = droppedLimit(fact, context, artists);
  if (limit) return `drops the source's limit: "${limit}"`;
  const moved = movedChartDetail(fact, context);
  if (moved) return `"${moved}" belongs to another chart`;
  const round = turnedRound(fact, context);
  if (round) return `the source doesn't have ${round} doing this`;
  const chart = unnamedChart(fact);
  if (chart) return `doesn't say which chart: "${chart}"`;
  const placed = misplacedYear(fact, context);
  if (placed) return `${placed} isn't the year of the sentence it retells`;
  const cutOff = droppedYear(fact, context);
  if (cutOff) return `says the month but not the year the source gives it with (${cutOff})`;
  if (suppliedException(fact, context)) return "says what the exception is to; the source doesn't";
  const unnamedOne = unnamedReference(fact, context);
  if (unnamedOne) return `doesn't say who or what "${unnamedOne}" is`;
  const view = unattributedView(fact, context);
  if (view) return `a view the source gives to ${view}`;
  // "The musical won..." from an artist's article reads as the song playing
  const unnamed = UNNAMED_WORK.exec(fact);
  if (unnamed && track && !namesTrack(context.split("\n")[0], track) && !retoldSentences(fact, context).some((s) => namesTrack(s, track)))
    return `doesn't say which ${unnamed[1].toLowerCase()}`;
  return null;
}

/**
 * Captions the reference supports, and why the rest were dropped; with no reference, only the source checks
 * are skipped. `otherParts`: the soundtrack's other parts. `track`: the article isn't the track's own.
 * `cited`: lines start with a sentence number. `artists`: may stand for "the band" in a cited caption
 */
export function screenClaims(facts: string[], rawContext: string, opts: { otherParts?: string[]; track?: string; cited?: boolean; artists?: string[] } = {}): ScreenResult {
  const result: ScreenResult = { kept: [], rejected: [], ...(opts.cited ? { sources: new Map<string, string>() } : {}) };
  // Unicode hyphens (U+2010) made plain: the name checks compare "-"
  const plainHyphens = (t: string) => t.replace(/[\u2010\u2011\u2012]/g, "-");
  const context = plainHyphens(rawContext);

  const titles = [withoutQualifier(context.split("\n")[0]), opts.track ?? ""].filter(Boolean);
  const reasonToDrop = (fact: string): string | null =>
    captionReason(fact, titles, opts.otherParts ?? [], opts.artists, context) ??
    sourceReason(fact, context, opts.track, titles, opts.artists) ??
    (context && otherRecordingSection(fact, context, opts.artists) ? "from a section about another recording" : null) ??
    (fact.length > MAX_FACT_CHARS ? `too long (${fact.length} chars)` : null);

  // Cited: that sentence replaces the guess by shared words, and the caption must match it
  const sentences = opts.cited ? referenceSentences(context) : [];
  const title = context.split("\n")[0];
  const citedReason = (fact: string, at: number): string | null => {
    if (!at) return "doesn't say which sentence it retells";
    if (at > sentences.length) return `cites sentence ${at}, which the reference doesn't have`;
    return citedMismatch(fact, sentences, at - 1, title, opts.artists);
  };
  const sourceOf = (fact: string) => result.sources?.get(fact);
  // Once a small model joins two sentences, every later citation is one short: a caption that clearly
  // retells the sentence next to the one it cites cites that one
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
    setCiting(sentence !== undefined ? { fact, sentence } : null);
    let reason: string | null;
    try {
      reason = (opts.cited ? citedReason(fact, line.at) : null) ?? reasonToDrop(fact);
    } finally {
      setCiting(null);
    }
    if (reason) {
      result.rejected.push({ text: fact, reason });
      continue;
    }
    // Of near-duplicates, the closer to its source stays: "resembles" over "was inspired by"
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
