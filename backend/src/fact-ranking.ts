// Which bubbles a song shows, in what order: risky sources held back, most interesting first, no model
// (ARCHITECTURE.md: Which bubbles a song shows)

export const MAX_BUBBLES = 4;    // bubbles per song from a source
export const FLOOR = 3;          // held-back captions come back up to this many
export const MAX_OFF_MUSIC = 2;  // captions about the game, film or show, not the music (#189)

export interface Candidate {
  text: string;
  /** "data": fixed sentence from Wikidata or MusicBrainz; "caption": the AI's retelling */
  kind: "data" | "caption";
  /** Article sentence it retells; "" when none holds half its words */
  sentence?: string;
    lead?: boolean;
}

/** Kind of fact, so a song mixes them */
export type Hook = "picture" | "making" | "first" | "person" | "good" | "award" | "release" | "plain";

export interface Ranked extends Candidate {
  /** Why the source is risky to retell; empty when safe */
  flags: string[];
  /** Shown only to reach FLOOR */
  refill: boolean;
  score: number;
  /** About another quoted song, on the artist's article */
  other?: boolean;
  /** About the game, film or show, not the music */
  offMusic?: boolean;
  hook: Hook;
  /** Score breakdown, for the log */
  reasons: string[];
}

// --- Safety: how risky the source sentence is ---

const STOP = new Set(
  "the a an of and or to in on at by for with from as is was were be been are it its this that these those his her their he she they which who whom also has had have not but into than then over after before during about".split(" ")
);
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)));

// Someone said or judged it: the caption must keep who, and often doesn't
const REPORTING =
  /\b(said|says|stated|states|wrote|writes|according to|described|describes|called|calls|noted|notes|claimed|claims|recalled|recalls|explained|explains|commented|remarked|praised|criticized|criticised|felt|considered|believed|argued|told|added|opined|reported|reportedly|revealed|admitted|suggested|thought|cited|declared|referred)\b/i;
// Words that limit a statement: lost, they widen it
const HEDGES =
  /\b(usually|typically|mostly|largely|generally|often|reportedly|allegedly|estimated|approximately|about|around|nearly|almost|roughly|over|more than|under|up to|some|may|might|possibly|probably|likely|believed|considered|according)\b/gi;
const QUOTED = /["“]([^"”]+)["”]/g;
// Lower-case words a Title Case title may keep
const TITLE_SMALL = /^(a|an|the|of|in|on|and|or|to|for|at|by|with|from|de|la|le|no)$/;
// Section name before a body sentence ("Development: ...")
const SECTION_LABEL = /^[A-Z][^:.!?"]{1,60}: /;
const LONG_BODY_WORDS = 30;  // words: a body sentence this long is risky

// A quoted title ("Cutie Mew Mew Magic") rather than someone's words
const isTitle = (quote: string) => {
  const ws = quote.trim().split(/\s+/).filter((w) => /\p{L}/u.test(w));
  return ws.length > 0 && /^\P{Ll}/u.test(ws[0]) && ws.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w) || TITLE_SMALL.test(w.toLowerCase()));
};

/** Why a caption's source is risky to retell, or []. No sentence holding half the caption = heavy compression */
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

// --- Fun: what kind of fact it is ---

const COUNT = String.raw`(?:\d{1,3}(?:,\d{3})*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a hundred|hundreds of|a dozen|dozens of|a thousand|thousands of)`;
const UNIT = String.raw`(?:seconds?|minutes?|hours?|days?|nights?|weeks?|months?|years?|takes?|times|feet|foot|inches|metres?|meters?|miles?|kilometres?|kilometers?|musicians?|players?|people|singers?|voices?|instruments?|strings?|keys|notes|chords|bars|members?|verses|languages|countries|cities|studios|guitars?|pianos?|drums|microphones?|tapes?|tracks?|songs?|demos?|drafts?|versions?)`;
// Something to picture: "in one afternoon", "at 16", "in a stairwell"
const PICTURE = [
  new RegExp(String.raw`\b${COUNT}\s+(?:[\p{L}-]+\s+)?${UNIT}\b`, "iu"),
  /\b(?:in|over|during|within) (?:one|a single|a|an) (?:afternoon|morning|evening|night|day|weekend|take|session|sitting|hour)\b|\bovernight\b/i,
  /\b(?:recorded|written|wrote|composed|performed|played|sung|sang|premiered|mixed|made|filmed|sketched|finished)\b[^.;]{0,40}?\b(?:in|at|inside) (?:a |an |the |his |her |their )?(?:\p{Lu}|(?:stairwell|kitchen|bathroom|bedroom|garage|basement|barn|farm|church|cathedral|castle|cave|hotel|car|van|bus|train|boat|attic|warehouse|tent)\b)/iu,
];
// How it was made: a recording, a sound, a borrowed object, an accident, an inspiration
const MAKING =
  /\b(?:record(?:ed|ing)? (?:in|at|with|on|live|using)|demos?|one take|first take|sampl(?:e|ed|es|ing)|improvis\w+|hummed|whistl\w+|borrow\w+|accident\w*|by mistake|built (?:from|around|on)|reused|re-used|inspired by|inspiration|named after|based on|originally (?:written|composed|intended) for|written for|composed for|tribute|dedicated to|homage|instruments?|synthesi[sz]ers?|piano|guitar|organ|drum machine|choir|orchestra|strings|banjo|violin|cello|flute|saxophone|harmonica|ukulele|music box|theremin|kazoo|four-track|tape)\b/i;
// Firsts, onlys, records: count only when the source says the same word
const FIRST =
  /\b(?:first|only|oldest|youngest|longest|shortest|largest|biggest|fastest|earliest|the most|never before|(?:world|all-time) record|record-breaking|set a record|broke (?:a|the) record)\b/gi;
// Relatable: an age, a hometown, a first job, self-taught
const PERSON =
  /\b(?:grew up|hometown|born in|childhood|as a (?:child|kid|teenager|teen|boy|girl|student)|in high school|at school|self-taught|taught (?:himself|herself|themselves)|first (?:job|band|guitar|piano|song|instrument)|day job|worked as an?|\d{1,2}-year-old|at (?:the )?age (?:of )?\d{1,2}|aged \d{1,2}|when (?:he|she|they) (?:was|were) \d{1,2})\b/i;
// Awards, charts, sales: dull and easy to get wrong
const AWARD =
  /\b(?:chart(?:ed|s)?|peaked|number (?:one|\d+)|no\. ?\d+|top (?:\d+|ten|forty)|billboard|hot 100|certified|platinum|gold|awards?|awarded|nominat\w+|grammys?|won|sold|sales|copies|ranked|ranking)\b|#\d+/i;
// What an artist gave: charity, teaching, a founding, an honor, a thing named for them
const GOOD =
  /\b(?:charit(?:y|ies|able)|philanthrop\w+|humanitarian|ambassador|benefit concerts?|telethon|raised (?:over|more than|\$)|donat(?:ed|ions?)|scholarships?|masterclass\w*|mentor(?:ed|s)?|(?:co-?)?founded (?:the|an?)|Hall of Fame|Medal of|movement|royalties|conservation|preserv\w+|Creative Commons|free downloads?|statue|named (?:after|for)|asteroid)\b/i;
const RELEASE = /\b(?:released (?:on|in|as|by|through|via)|re-?released|reissued|record label|label|catalog(?:ue)? number|b-side|vinyl|cassette|digital download)\b/i;

/** How much a viewer may enjoy a fact, and its kind. A first the source doesn't state counts against it */
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
  if (GOOD.test(text)) add("good", 2, "what the artist gave");
  if (AWARD.test(text)) add("award", -1, "awards, charts or sales");
  if (RELEASE.test(text)) add("release", -1, "release details");
  const order: Hook[] = ["picture", "making", "first", "person", "good", "award", "release"];
  const hook = order.find((h) => kinds.includes(h)) ?? "plain";
  return { score, hook, reasons };
}

// --- About the music, or the work around it ---

const MUSIC_WORDS =
  /\b(?:music\w*|songs?|soundtracks?|score[sd]?|scoring|compos\w+|themes?|melod\w+|tunes?|tracks?|lyric\w*|sing\w*|sang|sung|singers?|vocal\w*|bands?|albums?|chords?|rhythm\w*|tempo|beats?|arrang\w+|orchestra\w*|instrument\w*|record(?:ed|ing|ings)?|sounds?|audio|chiptune|synth\w*|piano|guitar\w*|drums?|bass|strings|choir|concerts?|perform\w*|played|plays)\b/i;
// The game, film or show's business: cast, story, ports, series
const WORK_TRIVIA =
  /\b(?:voice(?:d| acting| actors?| actress(?:es)?| cast)|voiced by|dub(?:bed|bing|s)?|locali[sz](?:ation|ations|ed)|translat(?:ion|ions|ed)|ported|ports?|design documents?|gameplay|characters?|protagonists?|antagonists?|villains?|storyline|plot|sequels?|prequels?|spin-?offs?|remaster(?:s|ed)?|remakes?|franchise|series|developers?|developed|publishers?|published|directors?|directed|programmers?|levels?|bosses|playable|consoles?|cartridges?|games?|episodes?|seasons?|films?|movies?|screenplay|box office)\b/i;

/** False only for work trivia (cast, ports, plot) with nothing about music (#189) */
export function aboutTheMusic(text: string): boolean {
  return MUSIC_WORDS.test(text) || MAKING.test(text) || !WORK_TRIVIA.test(text);
}

// --- Another song named in a caption ---

const DOUBLE_QUOTED = /["“]([^"”]+)["”]/g;
const SINGLE_QUOTED = /(?<![\p{L}\p{N}])['‘]([^'’]+)['’](?![\p{L}\p{N}])/gu;
const squash = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/** Quotes a title not the playing one ("Paper Kites" during "Velvet Harbor"); one containing or contained by it counts as it */
export function namesOtherSong(caption: string, title: string): boolean {
  const own = squash(title);
  if (!own) return false;
  const quotes = [...caption.matchAll(DOUBLE_QUOTED), ...caption.matchAll(SINGLE_QUOTED)].map((m) => m[1]);
  const titles = quotes.filter(isTitle).map(squash).filter(Boolean);
  if (!titles.length) return false;
  return !titles.some((t) => t === own || ` ${t} `.includes(` ${own} `) || ` ${own} `.includes(` ${t} `));
}

// --- Choosing and ordering ---

/**
 * Bubbles to show, in order. `unsure`: maybe another work, no captions. `dataFirst`: artist's or game's
 * article, song data facts lead. `artistArticle` + `title`: one caption at most about another song
 */
export function rankFacts(
  candidates: Candidate[],
  opts: { max?: number; floor?: number; unsure?: boolean; dataFirst?: boolean; artistArticle?: boolean; title?: string; log?: (line: string) => void } = {}
): Ranked[] {
  const max = Math.max(0, opts.max ?? MAX_BUBBLES);
  const floor = Math.min(opts.floor ?? FLOOR, max);
  const log = opts.log ?? (() => undefined);
  const all = candidates.flatMap((c, order) => {
    if (c.kind === "caption" && opts.unsure) {
      // Reason only, never the caption: logs go into problem reports (#262)
      log("[Screen] DROP (work match unsure)");
      return [];
    }
    const flags = c.kind === "caption" ? sourceRisk(c.text, c.sentence ?? "", Boolean(c.lead)) : [];
    const other = c.kind === "caption" && Boolean(opts.artistArticle) && namesOtherSong(c.text, opts.title ?? "");
    const offMusic = c.kind === "caption" && !aboutTheMusic(c.text);
    return [{ ...c, flags, refill: false, order, other, offMusic, ...interest(c.text, c.sentence || c.text) }];
  });
  // The writer's first ones are kept
  const firstOther = all.find((c) => c.other)?.order;
  let offMusic = 0;
  const pool = all.filter((c) => {
    if (c.other && c.order !== firstOther) {
      log("[Rank] not shown (another song of the artist, one at most)");
      return false;
    }
    if (c.offMusic && ++offMusic > MAX_OFF_MUSIC) {
      log(`[Rank] not shown (not about the music, ${MAX_OFF_MUSIC} at most)`);
      return false;
    }
    return true;
  });
  const safe = pool.filter((c) => !c.flags.length);
  const held = pool.filter((c) => c.flags.length);
  // Too few safe: least risky held-back come back; a body sentence counts half a flag more
  const risk = (c: (typeof all)[number]) => c.flags.length + (c.lead ? 0 : 0.5);
  const back = held
    .slice()
    .sort((a, b) => risk(a) - risk(b) || a.order - b.order)
    .slice(0, Math.max(0, floor - safe.length))
    .map((c) => ({ ...c, refill: true }));
  for (const c of held) if (!back.some((b) => b.order === c.order)) log(`[Screen] DROP (risky source: ${c.flags.join(", ")})`);
  // Among equals: data facts and lead captions, then the writer's order
  const tier = (c: (typeof all)[number]) => (c.kind === "data" || c.lead ? 0 : 1);
  const group = (c: (typeof all)[number]) => (c.refill ? 2 : opts.dataFirst && c.kind === "data" ? 0 : 1);
  const ranked = [...safe, ...back].sort((a, b) => group(a) - group(b) || Number(a.other) - Number(b.other) || Number(a.offMusic) - Number(b.offMusic) || b.score - a.score || tier(a) - tier(b) || a.order - b.order);
  for (const c of ranked.slice(max)) log(`[Rank] not shown (${max} at most, interest ${c.score})`);
  const kept = ranked.slice(0, max);
  // Kinds take turns within each group: leading data, the rest, brought-back captions
  return [0, 1, 2].flatMap((g) => rotate(kept.filter((c) => group(c) === g)));
}

/** Same order, but no two of a kind in a row when another kind is left */
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

/** In the lead: before the first heading, or (reference only) in a paragraph with no section name in front */
export function isLeadSentence(sentence: string, context: string, full = ""): boolean {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = flat(sentence.replace(SECTION_LABEL, ""));
  if (!want) return false;
  if (full) return flat(full.split(/\n==/)[0]).includes(want);
  const blocks = context.split("\n").slice(1).join("\n").split(/\n\s*\n/);
  const block = blocks.find((b) => flat(b).includes(want));
  if (!block) return false;
  const first = block.trim();
  return /^About this piece:/.test(first) || !(SECTION_LABEL.test(first) || /^(?:From the people who made it|How the music is built|How it was received|From the article "[^"\n]+"): /.test(first));
}
