import { mentionsName, normalizeTitle } from "./titles";
import { OPINION, withoutVideoSections } from "./wikipedia";
import { contentTokens } from "../screening/similarity";
import { scopeSentences } from "../screening/repair";
import { namesTrack } from "../screening/screen";

// Which part of an article the reference uses: section-aware selection and tiered sentences

// --- Section-aware selection ---

// Switches (ARCHITECTURE.md: The life of one song): narrative sections err far more than the lead
export const sectionSelection = { on: process.env.SECTION_SELECT !== "off" };
export const receptionFilter = { on: process.env.RECEPTION_FILTER !== "off" }; // off: verdict sections unfiltered
export const seriesFilter = { on: process.env.SERIES_SCOPE !== "off" };         // off: series music articles read whole

// Who did what before or around the work, or a game's story
const NARRATIVE_HEADING =
  /\b(background|antecedents?|influences?|development|history|conception|creation|production|early (?:life|years)|plot|gameplay|synopsis|story(?: ?line)?|premise)\b/i;
// "Release history", "Chart history": dates and peaks, not a story
const DATA_HISTORY = /\b(release|chart|sales|publication|broadcast) history\b/gi;
// Checkable things: how it's built, released, charted, awarded, performed or covered
const DATA_HEADING =
  /\b(composition|music and lyrics|lyrics|lyrical content|releases?|charts?|commercial|performances?|sales|certifications?|accolades?|awards?|honou?rs|live|cover versions?|covers|versions|track ?listings?)\b/i;
// The music's style and sound
const STYLE_HEADING = /\b(music|musical|style|sound|soundtracks?|score|audio|genre|instrumentation|arrangements?|structure)\b/i;
// Nothing to write from
export const SKIP_HEADING = /^(references|notes|footnotes|citations|sources|external links|see also|further reading|bibliography)$/i;
// Keeps a narrative section's sentence about the music
const MUSIC_WORD = /\b(compos\w*|scor(?:e|es|ed|ing)|soundtracks?|themes?|songs?|tracks?|melod(?:y|ies|ic))\b/i;

// Others' verdicts: only chart, sales and certification numbers kept
const RECEPTION_HEADING = /\b(reception|reviews?|critical|critics|response|reaction|retrospective|appraisal)\b/i;
// Opinions among facts (legacy, accolades, release): opinions left out
const LEGACY_HEADING = /\b(legacy|impact|influence|aftermath)\b/i;
const ACCOLADE_HEADING = /\b(accolades?|awards?|honou?rs|rankings?|lists?)\b/i;
const RELEASE_HEADING = /\b(releases?|promotion|singles?)\b/i;
// Chart peak, sales or certification: checkable even in reception
const CHART_WORD =
  /\b(charts?|charted|peak(?:ed|ing)?|Billboard|Hot 100|Oricon|top (?:ten|forty|\d+)|number (?:one|\d+)|No\. ?\d+|sold|sales|copies|units|shipped|certified|certifications?|gold|platinum|diamond)\b/i;
// A ranking on someone's list is a verdict, not a chart
const LIST_RANKING = /\b(ranked|ranking|lists?|greatest|best|favou?rite)\b/i;
// A critic or publication judging the work
const REVIEW_CUE =
  /\b(critics?|critical(?:ly)?|reviewers?|reviews?|reviewed|praised|praise|acclaim(?:ed)?|hailed|lauded|panned|called (?:it|the (?:song|track|single|album|game|record))|described (?:it|the (?:song|track|single|album|game|record)) as|wrote that|opined|felt (?:that|it)|rated|ranked|listed|gave (?:it|the)|out of (?:five|ten|\d+)|stars|magazine|Cash Box|Record World|Melody Maker|AllMusic|Pitchfork|Rolling Stone|NME|Stereogum|IGN|GameSpot|GamesRadar\+?|Famitsu|Nintendo Power|Game Informer|Eurogamer|Kotaku|Polygon|Destructoid|RPGFan)(?![\p{L}])/iu;
// An award won or a nomination: an accolades section's checkable part
const AWARD_FACT = /\b(won|wins|winning|nominated|nominations?|awarded|inducted|received (?:an?|the) [^.]*\b(?:award|prize|honou?r))\b/i;

/** Whether a sentence has a chart peak, sales or certification, with a number */
export function isChartFact(s: string): boolean {
  if (!CHART_WORD.test(s) || LIST_RANKING.test(s)) return false;
  return /\d|\bnumber one\b|\bcertified (?:gold|platinum|diamond)\b/i.test(s);
}

// By a critic or in a critic's words
const opinionated = (s: string) => REVIEW_CUE.test(s) || OPINION.test(s);

// Which sentences a verdict section keeps; null: all; undefined: heading doesn't say (follow the parent)
function verdictFilter(heading: string): ((s: string) => boolean) | null | undefined {
  const h = heading.replace(DATA_HISTORY, "$1");
  const release = RELEASE_HEADING.test(h);
  if (RECEPTION_HEADING.test(h)) {
    // "Release and reception": the release half is facts
    return release ? (s) => isChartFact(s) || !opinionated(s) : isChartFact;
  }
  if (ACCOLADE_HEADING.test(h)) return (s) => isChartFact(s) || (AWARD_FACT.test(s) && !opinionated(s));
  if (LEGACY_HEADING.test(h) || release) return (s) => isChartFact(s) || !opinionated(s);
  return headingRank(heading) === null ? undefined : null;
}

// Order of sections; narrative ones only for what names the song or its composer
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

/** Who wrote the music ("composed by Ann Example and Bo Sample", "composer Cy Person"): full names and surnames, normalized */
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

/** Whole sentences to write from, not list items or table rows */
export function sectionSentences(body: string): string[] {
  return body
    .split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && /[.!?]["”)]?$/.test(s));
}

// The same, each with whether it opens its paragraph (paragraphs are lines)
function sectionSentencesWithOpens(body: string): Array<{ text: string; opens: boolean }> {
  return body.split(/\n+/).flatMap((para) =>
    para
      .split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u)
      .map((s, i) => ({ text: s.trim(), opens: i === 0 }))
      .filter((s) => s.text.length >= 25 && /[.!?]["”)]?$/.test(s.text))
  );
}

/** Sections in reading order (RANK) with the sentences kept; a subsection without a telling heading follows its parent */
export function selectSections(full: string, names: string[] = []): Array<{ heading: string; rank: number; sentences: string[]; opens: Set<string> }> {
  full = withoutVideoSections(full);
  const song = names[0] ? normalizeTitle(names[0]) : "";
  const makers = composerNames(full);
  const namesIt = (s: string) => mentionsName(normalizeTitle(s), [...(song ? [song] : []), ...makers]);
  const opensOf = (body: string) => new Set(sectionSentencesWithOpens(body).filter((x) => x.opens).map((x) => x.text));
  const leadText = full.split(/\n==/)[0];
  // Another work's sentences (a sequel, a remake) or a cover's original's record: left out (`withoutSentences`)
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
    // Verdicts read as facts on stream (#21): a 3B drops the "a reviewer called it"
    if (receptionFilter.on && keep) sentences = sentences.filter(keep);
    if (sentences.length) out.push({ heading, rank, sentences, opens: opensOf(body) });
  }
  // Stable sort: article order within a rank
  return out.sort((a, b) => a.rank - b.rank);
}

// Long enough for a caption
const usableSentences = (sentences: string[]) => sentences.filter((s) => s.length >= 40).length;

/** Up to `budget` chars in `selectSections` order, "Heading: " first, minus `skip`; "" under 2 usable (then `orderExtract`) */
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

// --- Tiered source selection ---

// TIERED_SELECTION=off: by section only
export const tieredSelection = { on: process.env.TIERED_SELECTION !== "off" };

// Someone reported as saying or judging: a 3B retells it without who said it
const REPORTING = /\b(?:said|says|wrote|writes|according to|told|described|called|stated|noted|claimed|recalled|explained)\b/i;
// A caption that kept a reporting verb (any tense) or quote marks
const KEEPS_REPORTING = /\b(?:say|says|said|write|writes|wrote|written|according|tell|tells|told|describe[sd]?|call(?:s|ed)?|state[sd]?|note[sd]?|claim(?:s|ed)?|recall(?:s|ed)?|explain(?:s|ed)?)\b|["“”]/i;
const TIER_ENOUGH = 8; // clean sentences, else tier 4 too: 5 captions plus 3 spares are asked for
// Tier-4 sentences reporting speech: a caption from one must keep who said it
const reportedSentences = new Set<string>();

/** A body sentence a small model retells safely: under 30 words, no 4+ word quote (a title is fine), no reporting verb */
export function isCleanSentence(s: string): boolean {
  if (s.split(/\s+/).length >= 30 || REPORTING.test(s)) return false;
  return ![...s.matchAll(/["“]([^"”]{1,400})["”]/g)].some((m) => m[1].trim().split(/\s+/).length >= 4);
}

/** The reference in tiers, safest to retell first (ARCHITECTURE.md: `tieredExtract`); "" under 2 usable */
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

// Capitalized words that never name a speaker
const NOT_A_SPEAKER = new Set("The A An In On It At By For As When While After Before During This That These Those His Her Their He She They However Also Its According".split(" "));

/** False when a caption retells a tier-4 reported sentence but drops the speaker, or both verb and quotes (erred 45.6%; kept, 12.6%) */
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

// Left out of the reference being built (set around one synchronous build). `trackSaves`: one naming the track stays
let activeDrop: { drop: Set<string>; trackSaves: boolean } | null = null;

/** Builds `fn`'s reference without the sentences in `drop` */
export function withoutSentences<T>(drop: Set<string> | null, trackSaves: boolean, fn: () => T): T {
  if (!drop?.size) return fn();
  activeDrop = { drop, trackSaves };
  try {
    return fn();
  } finally {
    activeDrop = null;
  }
}
