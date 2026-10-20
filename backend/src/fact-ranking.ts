/**
 * Which of a song's candidate bubbles to show, and in what order (`rankFacts`).
 *
 * Safety first (the selection policy "S3", measured offline on judged runs):
 *   1. When the work match is unsure, no AI captions at all (`unsure`).
 *   2. An AI caption is held back when its source sentence is risky to retell:
 *      a reporting verb, a quote of four or more words, a body sentence of 30
 *      or more words, a hedge the caption lost, or a body sentence the caption
 *      kept less than half of (`sourceRisk`).
 *   3. Fewer than three left: held-back captions come back, fewest flags first,
 *      until there are three. Never one dropped by step 1.
 * Then fun: what is left is ordered by a small interest score read from the
 * caption and its source (`interest`): a number, an age or a place you can
 * picture and how the music was made rank up; awards, charts and release
 * details rank down; a "first" or an "only" counts only when the source says
 * it. Data facts and lead captions go first among equals, no two bubbles in a
 * row tell the same kind of fact when that can be helped, and a song shows at
 * most four.
 *
 * Every signal is a plain text comparison against the source: no model.
 */

/** Most bubbles a song shows from a source. */
export const MAX_BUBBLES = 4;
/** Held-back captions come back until a song has this many bubbles. */
export const FLOOR = 3;

/** One bubble a song could show. */
export interface Candidate {
  text: string;
  /** "data": a fixed sentence from Wikidata or MusicBrainz. "caption": the AI's retelling of the article. */
  kind: "data" | "caption";
  /** The article sentence the caption retells; "" when none holds half its words. */
  sentence?: string;
  /** Whether that sentence is in the article's lead. */
  lead?: boolean;
}

/** The kind of fact a bubble tells, so a song mixes them. */
export type Hook = "picture" | "making" | "first" | "person" | "award" | "release" | "plain";

export interface Ranked extends Candidate {
  /** Why the source is risky to retell (empty for a data fact or a safe caption). */
  flags: string[];
  /** Whether it is shown only to reach the floor of three. */
  refill: boolean;
  score: number;
  hook: Hook;
  /** What the score is made of, for the log. */
  reasons: string[];
}

// --- Safety: how risky the source sentence is to retell -----------------

/** Common words left out when comparing a caption with its source. */
const STOP = new Set(
  "the a an of and or to in on at by for with from as is was were be been are it its this that these those his her their he she they which who whom also has had have not but into than then over after before during about".split(" ")
);
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)));

/** Someone said, wrote or judged it: the caption has to keep who, and often doesn't. */
const REPORTING =
  /\b(said|says|stated|states|wrote|writes|according to|described|describes|called|calls|noted|notes|claimed|claims|recalled|recalls|explained|explains|commented|remarked|praised|criticized|criticised|felt|considered|believed|argued|told|added|opined|reported|reportedly|revealed|admitted|suggested|thought|cited|declared|referred)\b/i;
/** Words that limit a statement: lost, they widen it. */
const HEDGES =
  /\b(usually|typically|mostly|largely|generally|often|reportedly|allegedly|estimated|approximately|about|around|nearly|almost|roughly|over|more than|under|up to|some|may|might|possibly|probably|likely|believed|considered|according)\b/gi;
const QUOTED = /["“]([^"”]+)["”]/g;
/** Small words a title in Title Case may keep in lower case. */
const TITLE_SMALL = /^(a|an|the|of|in|on|and|or|to|for|at|by|with|from|de|la|le|no)$/;
/** A section name the reference puts before a body sentence ("Development: ..."). */
const SECTION_LABEL = /^[A-Z][^:.!?"]{1,60}: /;
const LONG_BODY_WORDS = 30;

/** A quoted title ("Cutie Mew Mew Magic") rather than someone's words. */
const isTitle = (quote: string) => {
  const ws = quote.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return ws.length > 0 && /^\P{Ll}/u.test(ws[0]) && ws.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w) || TITLE_SMALL.test(w.toLowerCase()));
};

/**
 * Why a caption's source sentence is risky to retell (S3, step 2), or [] when
 * it isn't. With no sentence that holds half the caption, the caption retells
 * nothing whole, which counts as heavy compression.
 */
export function sourceRisk(caption: string, sentence: string, isLead: boolean): string[] {
  const source = sentence.replace(SECTION_LABEL, "").trim();
  const flags: string[] = [];
  if (REPORTING.test(source)) flags.push("reporting verb");
  if ([...source.matchAll(QUOTED)].some(([, q]) => q.trim().split(/\s+/).length >= 4 && !isTitle(q))) flags.push("quote of 4+ words");
  if (!isLead && source.split(/\s+/).filter(Boolean).length >= LONG_BODY_WORDS) flags.push("body sentence of 30+ words");
  const hedges = (s: string) => new Set((s.match(HEDGES) ?? []).map((h) => h.toLowerCase()));
  const kept = hedges(caption);
  if ([...hedges(source)].some((h) => !kept.has(h))) flags.push("hedge dropped");
  if (!isLead) {
    const have = words(source);
    const shared = [...words(caption)].filter((w) => have.has(w)).length;
    if (shared / Math.max(1, have.size) < 0.5) flags.push("compressed under half");
  }
  return flags;
}

// --- Fun: what kind of fact it is ---------------------------------------

const COUNT = String.raw`(?:\d{1,3}(?:,\d{3})*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a hundred|hundreds of|a dozen|dozens of|a thousand|thousands of)`;
const UNIT = String.raw`(?:seconds?|minutes?|hours?|days?|nights?|weeks?|months?|years?|takes?|times|feet|foot|inches|metres?|meters?|miles?|kilometres?|kilometers?|musicians?|players?|people|singers?|voices?|instruments?|strings?|keys|notes|chords|bars|members?|verses|languages|countries|cities|studios|guitars?|pianos?|drums|microphones?|tapes?|tracks?|songs?|demos?|drafts?|versions?)`;
/** A number, a duration, an age or a place you can picture: "in one afternoon", "at 16", "in a stairwell". */
const PICTURE = [
  new RegExp(String.raw`\b${COUNT}\s+(?:[\p{L}-]+\s+)?${UNIT}\b`, "iu"),
  /\b(?:in|over|during|within) (?:one|a single|a|an) (?:afternoon|morning|evening|night|day|weekend|take|session|sitting|hour)\b|\bovernight\b/i,
  /\b(?:recorded|written|wrote|composed|performed|played|sung|sang|premiered|mixed|made|filmed|sketched|finished)\b[^.;]{0,40}?\b(?:in|at|inside) (?:a |an |the |his |her |their )?(?:\p{Lu}|(?:stairwell|kitchen|bathroom|bedroom|garage|basement|barn|farm|church|cathedral|castle|cave|hotel|car|van|bus|train|boat|attic|warehouse|tent)\b)/iu,
];
/** How it was made: a recording, a sound, a borrowed object, an accident, what inspired it. */
const MAKING =
  /\b(?:record(?:ed|ing)? (?:in|at|with|on|live|using)|demos?|one take|first take|sampl(?:e|ed|es|ing)|improvis\w+|hummed|whistl\w+|borrow\w+|accident\w*|by mistake|built (?:from|around|on)|reused|re-used|inspired by|inspiration|named after|based on|originally (?:written|composed|intended) for|written for|composed for|tribute|dedicated to|homage|instruments?|synthesi[sz]ers?|piano|guitar|organ|drum machine|choir|orchestra|strings|banjo|violin|cello|flute|saxophone|harmonica|ukulele|music box|theremin|kazoo|four-track|tape)\b/i;
/** Firsts, onlys and records: counted only when the source says the same word. */
const FIRST =
  /\b(?:first|only|oldest|youngest|longest|shortest|largest|biggest|fastest|earliest|the most|never before|(?:world|all-time) record|record-breaking|set a record|broke (?:a|the) record)\b/gi;
/** The person as relatable: an age, a hometown, a first job, teaching themselves. */
const PERSON =
  /\b(?:grew up|hometown|born in|childhood|as a (?:child|kid|teenager|teen|boy|girl|student)|in high school|at school|self-taught|taught (?:himself|herself|themselves)|first (?:job|band|guitar|piano|song|instrument)|day job|worked as an?|\d{1,2}-year-old|at (?:the )?age (?:of )?\d{1,2}|aged \d{1,2}|when (?:he|she|they) (?:was|were) \d{1,2})\b/i;
/** Awards, charts and sales: dull to most viewers and easy to get wrong. */
const AWARD =
  /\b(?:chart(?:ed|s)?|peaked|number (?:one|\d+)|no\. ?\d+|top (?:\d+|ten|forty)|billboard|hot 100|certified|platinum|gold|awards?|awarded|nominat\w+|grammys?|won|sold|sales|copies|ranked|ranking)\b|#\d+/i;
/** Release dates, labels and formats. */
const RELEASE = /\b(?:released (?:on|in|as|by|through|via)|re-?released|reissued|record label|label|catalog(?:ue)? number|b-side|vinyl|cassette|digital download)\b/i;

/**
 * How much a viewer is likely to enjoy a fact, from its words alone, and the
 * kind of fact it is. A first or an only the source doesn't state counts
 * against it: a caption never upgrades a claim.
 */
export function interest(text: string, sentence = text): { score: number; hook: Hook; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const kinds: Hook[] = [];
  const add = (hook: Hook, points: number, why: string) => {
    score += points;
    reasons.push(`${points > 0 ? "+" : ""}${points} ${why}`);
    kinds.push(hook);
  };
  if (PICTURE.some((re) => re.test(text))) add("picture", 2, "a number, age or place to picture");
  if (MAKING.test(text)) add("making", 2, "how it was made");
  const firsts = (s: string) => new Set((s.match(FIRST) ?? []).map((w) => w.toLowerCase()));
  const claimed = firsts(text);
  if (claimed.size) {
    const said = firsts(sentence);
    if ([...claimed].every((w) => said.has(w))) add("first", 1, "a first or a record the source states");
    else add("plain", -2, "a first or a record the source doesn't state");
  }
  if (PERSON.test(text)) add("person", 1, "a relatable fact about a person");
  if (AWARD.test(text)) add("award", -1, "awards, charts or sales");
  if (RELEASE.test(text)) add("release", -1, "release details");
  const order: Hook[] = ["picture", "making", "first", "person", "award", "release"];
  const hook = order.find((h) => kinds.includes(h)) ?? "plain";
  return { score, hook, reasons };
}

// --- Choosing and ordering ----------------------------------------------

/**
 * The bubbles to show, in order. `candidates` come in their own order: data
 * facts, then captions as the writer wrote them. `unsure`: the article may be
 * about another work, so no caption is shown. `dataFirst`: the data facts are
 * about the song and the article is its artist's or game's, so they lead
 * whatever their interest ("describe the song, then tell about it"). `log` gets
 * one line per caption held back or left out.
 */
export function rankFacts(
  candidates: Candidate[],
  opts: { max?: number; floor?: number; unsure?: boolean; dataFirst?: boolean; log?: (line: string) => void } = {}
): Ranked[] {
  const max = Math.max(0, opts.max ?? MAX_BUBBLES);
  const floor = Math.min(opts.floor ?? FLOOR, max);
  const log = opts.log ?? (() => undefined);
  const all = candidates.flatMap((c, order) => {
    if (c.kind === "caption" && opts.unsure) {
      log(`[Screen] DROP (work match unsure): ${c.text.slice(0, 90)}`);
      return [];
    }
    const flags = c.kind === "caption" ? sourceRisk(c.text, c.sentence ?? "", Boolean(c.lead)) : [];
    return [{ ...c, flags, refill: false, order, ...interest(c.text, c.sentence || c.text) }];
  });
  const safe = all.filter((c) => !c.flags.length);
  const held = all.filter((c) => c.flags.length);
  // Too few safe ones: the least risky held-back captions come back, a body sentence counting half a flag more.
  const risk = (c: (typeof all)[number]) => c.flags.length + (c.lead ? 0 : 0.5);
  const back = held
    .slice()
    .sort((a, b) => risk(a) - risk(b) || a.order - b.order)
    .slice(0, Math.max(0, floor - safe.length))
    .map((c) => ({ ...c, refill: true }));
  for (const c of held) if (!back.some((b) => b.order === c.order)) log(`[Screen] DROP (risky source: ${c.flags.join(", ")}): ${c.text.slice(0, 90)}`);
  // Most interesting first; among equals, data facts and lead captions, then the writer's order.
  const tier = (c: (typeof all)[number]) => (c.kind === "data" || c.lead ? 0 : 1);
  const group = (c: (typeof all)[number]) => (c.refill ? 2 : opts.dataFirst && c.kind === "data" ? 0 : 1);
  const ranked = [...safe, ...back].sort((a, b) => group(a) - group(b) || b.score - a.score || tier(a) - tier(b) || a.order - b.order);
  for (const c of ranked.slice(max)) log(`[Rank] not shown (${max} at most, interest ${c.score}): ${c.text.slice(0, 90)}`);
  const kept = ranked.slice(0, max);
  // Kinds take turns within each group: leading data facts, the rest, then any captions brought back.
  return [0, 1, 2].flatMap((g) => rotate(kept.filter((c) => group(c) === g)));
}

/** The same order, except that a fact of the kind just shown waits for one of another kind when there is one. */
function rotate<T extends { hook: Hook }>(list: T[]): T[] {
  const left = list.slice();
  const out: T[] = [];
  while (left.length) {
    const last = out[out.length - 1]?.hook;
    const i = last && last !== "plain" ? left.findIndex((c) => c.hook !== last) : 0;
    out.push(...left.splice(Math.max(0, i), 1));
  }
  return out;
}

/**
 * Whether a source sentence is in the article's lead. With the whole article,
 * the lead is the text before its first heading; without it, a paragraph of the
 * reference that has no section name in front ("Development: ...") is the lead.
 */
export function isLeadSentence(sentence: string, context: string, full = ""): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = flat(sentence.replace(SECTION_LABEL, ""));
  if (!want) return false;
  if (full) return flat(full.split(/\n==/)[0]).includes(want);
  const blocks = context.split("\n").slice(1).join("\n").split(/\n\s*\n/);
  const block = blocks.find((b) => flat(b).includes(want));
  if (!block) return false;
  const first = block.trim();
  return /^About this piece:/.test(first) || !(SECTION_LABEL.test(first) || /^(From the people who made it|How the music is built|How it was received): /.test(first));
}
