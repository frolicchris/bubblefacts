import { escapeRe } from "../text";
import { MAX_FACT_CHARS } from "../fact-limits";
import { normalizeTitle } from "../grounding/titles";
import { contentTokens } from "./similarity";
import { REGION_NAMES, REGIONS } from "./frames";

/**
 * Repairs for scope words and qualifiers a 3B model drops, put back from the
 * source sentence instead of dropping the caption.
 */

// --- Scope words a 3B drops ---------------------------------------------

/** SCOPE_REPAIR=off shows captions as written, without putting back a dropped "in Japan" or "the arcade version". */
export const scopeRepair = { on: process.env.SCOPE_REPAIR !== "off" };
const REGION_PHRASE = new RegExp(String.raw`\b(?:[Ii]n|[Aa]cross|[Tt]hroughout) (?:the )?(${REGION_NAMES})(?: alone)?\b`, "g");
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
export function scopeSentences(context: string): Array<{ text: string; before: string }> {
  const out: Array<{ text: string; before: string }> = [];
  for (const para of context.split("\n").slice(1)) {
    let before = "";
    for (const [i, raw] of para.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u).entries()) {
      const text = (i === 0 ? raw.replace(/^(?:About this piece|From the article "[^"\n]+"|[^:.!?"“]{1,80}): (?=["“]?\p{Lu})/u, "") : raw).trim();
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
  if (regions.length === 1 && new Set([...sentence.matchAll(ANY_REGION)].map((m) => m[0])).size === 1 && ((regions[0].index === 0 && sentence[regions[0][0].length] === ",") || sameClause(sentence, regions[0].index ?? 0, capNums))) {
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
