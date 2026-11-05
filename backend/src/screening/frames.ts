import { escapeRe } from "../text";
import { mentionsName, normalizeTitle } from "../grounding/titles";
import { hasWord, NAME_STOPWORDS, sourceSentences, YEAR } from "./names";
import { MONTHS, retoldSentences } from "./sentences";
import { ATTRIBUTION } from "./attribution";

/**
 * Frames a caption drops: unnamed references, left-behind referents, the
 * sentence's frame or limit, and chart details.
 */

/** A sentence that gives a recording's own success, not just that it exists. */
export const CHART_RECORD = /\b(?:charts?|charted|peak(?:ed|s)?|number(?:-| )(?:one|\d+)|No\. ?\d+|top (?:\d+|ten|forty)|Hot 100|Billboard|certifi\w+|platinum|gold|sold|sales|copies)\b/i;

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

/** Periods told as "these three weeks": the count belongs to a sentence that isn't on screen. */
const TIME_UNIT = "(?:days?|weeks?|months?|years?|decades?|nights?|shows?|dates?|tracks?|songs?|singles?|albums?)";
const DANGLING_SPAN = new RegExp(`\\b(?:these|those)\\s+(?:[\\p{L}\\d-]+\\s+)?${TIME_UNIT}\\b|\\bthe (?:next|following) (?:two|three|four|five|six|seven|eight|nine|ten|\\d+)(?:\\s+${TIME_UNIT})?\\b`, "iu");
/** "The 1937 recording", with no one named: on a song with many versions a viewer takes it for the one playing. */
const BARE_RECORDING = /^The (?:\d{4}|original|first|later|studio|live) (?:recording|version|performance|rendition)\b/i;
/** A film or book nobody names: on a song's bubble it reads as a film of the song. */
const BARE_OTHER_WORK = /\b[Tt]he (film|movie|documentary|novel|book|play)\b(?!\s+["“\p{Lu}])/u;
/** Something that happened, told as if already named: "after the incident". */
const BARE_EVENT = /\b[Tt]he (incident|controversy|dispute|scandal|accident|affair|lawsuit|ordeal)\b(?!\s+["“\p{Lu}])(?!\s+(?:of|over|with|about|between)\b)/u;
/** A set counted with nothing named: "All three faces", "All songs". */
const BARE_ALL = /^All (?:(?:two|three|four|five|six|seven|eight|nine|ten|\d+) )?(?:the )?(\p{Ll}+)\b/u;
/** "the same arrangement": the same as what? */
const BARE_SAME = /\b[Tt]he same (arrangement|recording|version|melody|tune|lyrics|session|lineup|line-up|band|musicians)\b(?! as\b)/;
/** A sales total with no product: whose? */
const BARE_TOTAL = /\b(?:total|worldwide|global|overall|combined) sales\b/i;

/**
 * A caption that leans on something the source sentence had around it: "for the first of
 * these three weeks", "for the next two weeks", "The 1937 recording lasted...", "The film
 * was shot at Bard College", "By 2017, total sales reached 1.36 million". Returns what is
 * left unnamed, or null. `titles` and `artists` are what a viewer already knows the bubble
 * is about: a film named in the request is no mystery.
 */
export function leftBehindReferent(fact: string, titles: string[], artists: string[] = [], context = ""): string | null {
  const span = DANGLING_SPAN.exec(fact);
  if (span) return span[0];
  const same = BARE_SAME.exec(fact);
  if (same) return same[0];
  const event = BARE_EVENT.exec(fact);
  if (event) return `the ${event[1]}`;
  const all = BARE_ALL.exec(fact);
  if (all && (!namesSomeone(fact) || (/^(?:songs|tracks)$/.test(all[1]) && !/["“]/.test(fact)))) return all[0];
  const namesWork = titles.some((t) => t && hasWord(t, fact)) || /["“]/.test(fact);
  const recording = BARE_RECORDING.exec(fact);
  if (recording && !namesWork && !fact.slice(recording[0].length).match(/\p{Lu}/u)) return recording[0];
  const total = BARE_TOTAL.exec(fact);
  if (total && !namesWork) return total[0];
  const other = BARE_OTHER_WORK.exec(fact);
  const known = [...titles, ...artists].map(normalizeTitle);
  // A film the request or the article names, when the article is that film's: a bandleader's name on the bandleader's article is no film.
  const leadSaysIt = !context || new RegExp(`\\b${other?.[1] ?? ""}\\b`, "i").test(context.split("\n").slice(0, 2).join(" ").slice(0, 300));
  const namesOther = /["“]/.test(fact) || (leadSaysIt && (namesWork || known.some((a, i) => i > 0 && a && known[0].includes(a))));
  if (other && !namesOther) return `the ${other[1].toLowerCase()}`;
  return null;
}

/** The kinds of work an opening "In the film," can stand for. */
const FRAME_WORK = "film|movie|show|series|sequel|prequel|remake|reboot|novel|musical|episode|book|play|documentary|adaptation|version|recording";
/** Opens on someone's account, with that someone: "According to Dana Reyes, ...". */
const OPENS_ON_ACCOUNT = /^According to ([^,]{2,60}),/i;
/** Ends on someone's account: "..., according to Dana Reyes." */
const ENDS_ON_ACCOUNT = /,\s*according to ([^,.]{2,60})\.?$/i;
/** Opens on one work: "In Night Harbor Returns, ...", "In the 2019 film adaptation, ...". */
const OPENS_ON_WORK = new RegExp(`^(?:In|On|For) ((?:the |this |that )?(?:\\p{Lu}[\\p{L}\\d'’:-]*|\\d{4}\\b)[^,]{0,60}|(?:the|this|that) (?:[\\p{L}\\d'’-]+ ){0,3}(?:${FRAME_WORK}))(?:,|\\s+\\(\\d{4}\\),)`, "u");
/** Opens on a moment the sentence before set: "By this era", "At that point", "By then". */
const OPENS_ON_MOMENT = /^(?:By|At|Around|During|Since|From) (?:(?:this|that|these|those) (?:era|time|point|stage|period|years?|days)|then)\b|^At the time\b/i;
/** A limit that points back at what the text was already talking about: "on the format", "on his recording". */
const POINTS_BACK = /\b(?:on|in) (?:the format|(?:this|that|his|her|their) (?:chart|list|format|recording|version|tour|show|film))\b/gi;
/** A later work the statement belongs to. */
const LATER_WORK = /\b(?:(?:film|stage|musical|television|TV) adaptation|remake|reboot)\b/gi;
/** A contest or a pairing the claim holds for: "between Ana Bell and Rui Costa". */
const BETWEEN_NAMES = /\bbetween (\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)* and \p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)*)/u;
/** Someone else's recording: "a 2001 version recorded by Ana Bell". */
const ANOTHERS_VERSION = /\b(?:version|cover|rendition)s? (?:recorded |performed |sung )?by (\p{Lu}[\p{L}'’.-]+(?: \p{Lu}[\p{L}'’.-]+)*)/u;
/** "the 1990s", or the like: a decade a ranking holds for. */
const DECADE = /\b(?:1[89]|20)\d0s\b/;
/** A ranking, which holds only where the source says it does. */
const RANKING = /\b(?:(?:second|third|fourth|fifth)[- ])?most[- ](?:played|performed|streamed|watched|viewed|recorded|covered|broadcast)\b|\btop \d+ (?:most|best|highest)\b|\bbest[- ]selling\b|\bhighest[- ](?:charting|selling|grossing)\b/i;
/** A claim about a chart: nothing means anything without which chart. */
const CHART_CLAIM = /\b(?:reached|hit|peaked at|debuted at|climbed to|rose to) (?:number|No\.?|#)\s?(?:one|\d+)\b|\btop new entry\b|\bnew entry\b/i;
/** Enough to tell which chart: a chart's name, a word for a chart, or a place. */
const chartNamed = () => new RegExp(`\\b(?:charts?|Hot 100|Billboard|Oricon|Top 40|Top 100|Global 200|Official|ARIA|RPM|Cash Box|Gaon|Tracklist|countdown)\\b|\\b(?:${REGION_NAMES})\\b`, "i");
/** A number of weeks, days or months: how long something took or lasted. */
const SPAN = /\b(?:within|in|after|for) (?:only |just |about )?(?:\d+|two|three|four|five|six|seven|eight|nine|ten|\w+teen|twenty) (?:weeks?|days?|months?|years?)\b/gi;

/** A sentence without the section heading it opens on: "Later appearances: By this era ...". */
const withoutHeading = (s: string) => s.replace(/^[^:.!?"“]{2,50}:\s+/, "");
/** The capitalized words of a phrase, the small ones aside. */
export const capitalsOf = (phrase: string) => (phrase.match(/\p{Lu}[\p{L}\d'’-]+/gu) ?? []).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));

/**
 * What the sentence a caption retells says at its start or end about whose
 * account it is, or which work and moment it belongs to, gone from the caption:
 *
 *   account  "According to Dale Hart, the song came from a family quarrel" told
 *            as "Dale Hart wrote the song after a family quarrel".
 *   work     "In Night Harbor Returns, the ghost appears as a face" told as
 *            "The ghost appears as a face". A work the viewer already knows
 *            (`titles`) needs no naming.
 *   moment   "By this era the band used four singers" told as "The band used
 *            four singers".
 *
 * Every sentence the caption retells must set the same kind of limit. Returns
 * what was lost, or null.
 */
export function droppedFrame(fact: string, context: string, titles: string[] = []): string | null {
  const retold = retoldSentences(fact, context).map(withoutHeading);
  if (!retold.length) return null;
  const known = titles.map(normalizeTitle).filter(Boolean);
  const account = retold.map((s) => OPENS_ON_ACCOUNT.exec(s) ?? ENDS_ON_ACCOUNT.exec(s));
  if (account.every(Boolean) && !ATTRIBUTION.test(fact)) return `according to ${(account[0] as RegExpExecArray)[1]}`;
  const works = retold.map((s) => OPENS_ON_WORK.exec(s));
  if (works.every(Boolean)) {
    const frame = (works[0] as RegExpExecArray)[1];
    const names = capitalsOf(frame);
    const isPlace = new RegExp(`^(?:the )?(?:${REGION_NAMES})\\b`, "i").test(frame) || new RegExp(`^(?:the )?(?:${MONTHS})\\b`).test(frame) || /^\d{4}$/.test(frame);
    const kind = new RegExp(`\\b(?:${FRAME_WORK})\\b`, "i");
    const isWork = names.length > 0 ? names.length >= 2 || kind.test(frame) : kind.test(frame);
    const named = names.some((w) => hasWord(w, fact)) || kind.exec(frame)?.some((w) => hasWord(w, fact)) || known.some((t) => t && normalizeTitle(frame).includes(t));
    if (isWork && !isPlace && !named) return frame;
  }
  // "This arrangement is on a 1950 tape" told as "The arrangement is on a 1950 tape": which one?
  const pointed = retold.map((s) => /^(?:This|That)(?: same)? (\p{Ll}+)\b/u.exec(s));
  if (pointed.every(Boolean)) {
    const noun = (pointed[0] as RegExpExecArray)[1];
    if (new RegExp(`^The ${escapeRe(noun)}\\b`).test(fact)) return (pointed[0] as RegExpExecArray)[0];
  }
  const moments = retold.map((s) => OPENS_ON_MOMENT.exec(s));
  if (moments.every(Boolean) && !(fact.match(YEAR) ?? []).length) return (moments[0] as RegExpExecArray)[0];
  return null;
}

/**
 * A limit in the sentence a caption retells that goes missing, and a claim that
 * reads wider without it:
 *
 *   pointer   "the second most played song of the decade on the format".
 *   later     "featured in the 2021 remake, sung by Ana Bell" told as "sung by Ana Bell".
 *   ranking   "the most played song by ASCAP members in the 2000s": a ranking with
 *             its decade or its body gone.
 *   pairing   "A and B reached platinum and gold respectively": a caption
 *             that keeps both names has to keep the pairing.
 *
 * Returns what was lost, or null.
 */
export function droppedLimit(fact: string, context: string, artists: string[] = []): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const unquoted = retold.map((s) => s.replace(/["“][^"”]*["”]/g, ""));
  const lacks = (phrase: string) => !phrase.toLowerCase().split(/\s+/).some((w) => w.length > 3 && hasWord(w, fact, ""));
  const every = (re: RegExp) => unquoted.map((s) => [...s.matchAll(re)].map((m) => m[0]));
  const pointer = every(POINTS_BACK);
  if (pointer.every((p) => p.length) && lacks(pointer[0][0].replace(/^\S+ \S+ /, ""))) return pointer[0][0];
  const pairing = unquoted.map((s) => BETWEEN_NAMES.exec(s));
  if (pairing.every(Boolean) && lacks((pairing[0] as RegExpExecArray)[1])) return (pairing[0] as RegExpExecArray)[0];
  const version = unquoted.map((s) => ANOTHERS_VERSION.exec(s));
  if (version.every(Boolean)) {
    const by = (version[0] as RegExpExecArray)[1];
    if (lacks(by) && !mentionsName(normalizeTitle(by), artists.map(normalizeTitle).filter(Boolean))) return (version[0] as RegExpExecArray)[0];
  }
  const later = every(LATER_WORK);
  if (later.every((l) => l.length) && lacks(later[0][0])) return later[0][0];
  const ranked = RANKING.test(fact);
  if (ranked && unquoted.every((s) => RANKING.test(s))) {
    const decade = DECADE.exec(unquoted[0]);
    if (decade && !hasWord(decade[0], fact, "")) return decade[0];
    const by = /\bby ((?:\p{Lu}[\p{L}\d'’-]*\s*){1,4})/u.exec(unquoted[0]);
    if (by && lacks(by[1])) return by[0].trim();
  }
  if (/\p{Lu}\S* and \p{Lu}/u.test(fact) && !/\brespectively\b/i.test(fact) && unquoted.every((s) => /\brespectively\b/i.test(s) && CHART_RECORD.test(s))) return "respectively";
  return null;
}

/**
 * A detail moved onto another chart of a run: "reached number one on the Hot 100,
 * topped the Soul chart within three weeks" told as "reached number one on the
 * Hot 100 within three weeks". The sentence names two charts, and the caption
 * keeps one chart and a span of time the sentence gives only the other.
 * Returns the span, or null.
 */
export function movedChartDetail(fact: string, context: string): string | null {
  const charts = [...fact.matchAll(/\b(?:Hot 100|Billboard 200|[\p{Lu}][\p{L}\d&'’-]*(?: [\p{Lu}\d][\p{L}\d&'’-]*){0,4} (?:chart|Chart|Charts))\b/gu)].map((m) => m[0]);
  if (charts.length !== 1) return null;
  // "Hot" and "Singles" are in the names of many charts: what's left tells this one.
  const chartWords = charts[0].split(" ").filter((w) => !/^(?:Billboard|Hot|Singles|Songs|Top|Chart|Charts|chart)$/.test(w));
  for (const m of fact.matchAll(SPAN)) {
    for (const s of retoldSentences(fact, context)) {
      if (!new RegExp(`\\b${escapeRe(m[0])}\\b`, "i").test(s)) continue;
      const parts = s.split(/,\s+(?:and\s+)?|;\s+/);
      const own = parts.find((p) => p.toLowerCase().includes(m[0].toLowerCase())) ?? "";
      if (parts.length >= 2 && !chartWords.some((w) => hasWord(w, own)) && parts.some((p) => chartWords.some((w) => hasWord(w, p)))) return m[0];
    }
  }
  return null;
}

/**
 * A chart claim that says nothing of which chart: "was the top new entry for the
 * week", "reached number one". The reference sets the scope, and repairScope puts it
 * back when it can; left without one, the claim reads as the biggest chart there
 * is. Returns the claim, or null.
 */
export function unnamedChart(fact: string): string | null {
  const claim = CHART_CLAIM.exec(fact);
  return claim && !chartNamed().test(fact) ? claim[0] : null;
}

/** Countries and regions, with the words a caption may already use for them. */
export const REGIONS: Array<[string, string[]]> = [
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
export const REGION_NAMES = REGIONS.map(([r]) => r.replace(/^the /, "")).sort((a, b) => b.length - a.length).join("|");

/** Words a caption may open with that aren't a name: "The", "In 1966", "After". */
const OPENING_WORD = /^(?:The|A|An|This|That|These|Those|It|Its|In|On|At|By|For|After|Before|During|When|While|With|As|From|Of|Some|Many|Most|Both|All|Each|One|Two|Three|Several|Over|Under|Since|Until|Despite|Although|Though|His|Her|Their|He|She|They)\b/;

/** A name in the caption: a capitalized word ("Ada", "ZUN") or a quoted title past its opening word. */
export function namesSomeone(fact: string): boolean {
  const rest = fact.replace(OPENING_WORD, "");
  return /["“][^"”]*\p{Lu}/u.test(rest) || /(?<![\p{L}\p{N}'’])\p{Lu}(?:\p{Ll}|\p{Lu})/u.test(rest);
}
