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
 * The fun screen (`funScreen`) then leaves out dry data facts and captions
 * scoring DRY_INTEREST or lower, keeping one when nothing else is left.
 * A caption about the game, film or show around the song rather than its music (voice casting,
 * ports, the series, the plot: `aboutTheMusic`) goes below the music captions, and at most
 * MAX_OFF_MUSIC are shown: enough to say what the song is from, and fewer bubbles rather than
 * trivia when the article says little about the music (issue #189).
 * When the article is the artist's, a caption about another song of theirs
 * ("Paper Kites" while "Velvet Harbor" plays) goes below the facts about the artist and
 * at most one is shown (`namesOtherSong`).
 *
 * Every signal is a plain text comparison against the source: no model.
 */

/** Most bubbles a song shows from a source. */
export const MAX_BUBBLES = 4;
/** Held-back captions come back until a song has this many bubbles. */
export const FLOOR = 3;
/** Most captions a song shows about the game, film or show around it rather than its music. */
export const MAX_OFF_MUSIC = 2;

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
export type Hook = "picture" | "making" | "first" | "person" | "good" | "award" | "release" | "plain";

export interface Ranked extends Candidate {
  /** Why the source is risky to retell (empty for a data fact or a safe caption). */
  flags: string[];
  /** Whether it is shown only to reach the floor of three. */
  refill: boolean;
  score: number;
  /** Whether the caption is about another quoted song, on the artist's article. */
  other?: boolean;
  /** Whether the caption is about the game, film or show around the song, not its music. */
  offMusic?: boolean;
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
/** What an artist gave: charity, teaching, a founding, a movement, a lifetime honor, a thing named for them. */
const GOOD =
  /\b(?:charit(?:y|ies|able)|philanthrop\w+|humanitarian|ambassador|benefit concerts?|telethon|raised (?:over|more than|\$)|donat(?:ed|ions?)|scholarships?|masterclass\w*|mentor(?:ed|s)?|(?:co-?)?founded (?:the|an?)|Hall of Fame|Medal of|movement|royalties|conservation|preserv\w+|Creative Commons|free downloads?|statue|named (?:after|for)|asteroid)\b/i;
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
  if (GOOD.test(text)) add("good", 2, "what the artist gave");
  if (AWARD.test(text)) add("award", -1, "awards, charts or sales");
  if (RELEASE.test(text)) add("release", -1, "release details");
  const order: Hook[] = ["picture", "making", "first", "person", "good", "award", "release"];
  const hook = order.find((h) => kinds.includes(h)) ?? "plain";
  return { score, hook, reasons };
}

// --- About the music, or the work around it -----------------------------

/** The music itself: who wrote or played it, how it sounds, how it was recorded. */
const MUSIC_WORDS =
  /\b(?:music\w*|songs?|soundtracks?|score[sd]?|scoring|compos\w+|themes?|melod\w+|tunes?|tracks?|lyric\w*|sing\w*|sang|sung|singers?|vocal\w*|bands?|albums?|chords?|rhythm\w*|tempo|beats?|arrang\w+|orchestra\w*|instrument\w*|record(?:ed|ing|ings)?|sounds?|audio|chiptune|synth\w*|piano|guitar\w*|drums?|bass|strings|choir|concerts?|perform\w*|played|plays)\b/i;
/** The game, film or show around a song: its cast, story, ports and series. */
const WORK_TRIVIA =
  /\b(?:voice(?:d| acting| actors?| actress(?:es)?| cast)|voiced by|dub(?:bed|bing|s)?|locali[sz](?:ation|ations|ed)|translat(?:ion|ions|ed)|ported|ports?|design documents?|gameplay|characters?|protagonists?|antagonists?|villains?|storyline|plot|sequels?|prequels?|spin-?offs?|remaster(?:s|ed)?|remakes?|franchise|series|developers?|developed|publishers?|published|directors?|directed|programmers?|levels?|bosses|playable|consoles?|cartridges?|games?|episodes?|seasons?|films?|movies?|screenplay|box office)\b/i;

/**
 * Whether a caption is about the music rather than the work around it. False only for a caption
 * that names the game, film or show's own business (cast, ports, series, plot) and says nothing
 * about music: "The English voice cast was chosen in 1998" (issue #189).
 */
export function aboutTheMusic(text: string): boolean {
  return MUSIC_WORDS.test(text) || MAKING.test(text) || !WORK_TRIVIA.test(text);
}

// --- Another song named in a caption ------------------------------------

const DOUBLE_QUOTED = /["“]([^"”]+)["”]/g;
const SINGLE_QUOTED = /(?<![\p{L}\p{N}])['‘]([^'’]+)['’](?![\p{L}\p{N}])/gu;
const squash = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

/**
 * Whether a caption names a quoted title that isn't the song playing: the
 * subject may be another song ("Paper Kites" while "Velvet Harbor" plays). A title that
 * holds the playing title, or is held by it, counts as the song itself. With no
 * title to compare, or no quoted title, false.
 */
export function namesOtherSong(caption: string, title: string): boolean {
  const own = squash(title);
  if (!own) return false;
  const quotes = [...caption.matchAll(DOUBLE_QUOTED), ...caption.matchAll(SINGLE_QUOTED)].map((m) => m[1]);
  const titles = quotes.filter(isTitle).map(squash).filter(Boolean);
  if (!titles.length) return false;
  return !titles.some((t) => t === own || ` ${t} `.includes(` ${own} `) || ` ${own} `.includes(` ${t} `));
}

// --- Choosing and ordering ----------------------------------------------

/**
 * The bubbles to show, in order. `candidates` come in their own order: data
 * facts, then captions as the writer wrote them. `unsure`: the article may be
 * about another work, so no caption is shown. `dataFirst`: the data facts are
 * about the song and the article is its artist's or game's, so they lead
 * whatever their interest ("describe the song, then tell about it"). `artistArticle`
 * with the playing `title`: the article is the artist's, so a caption about another
 * quoted song ranks below the rest and only the first is kept. `log` gets one line
 * per caption held back or left out.
 */
export function rankFacts(
  candidates: Candidate[],
  opts: { max?: number; floor?: number; unsure?: boolean; dataFirst?: boolean; artistArticle?: boolean; title?: string; fun?: boolean; log?: (line: string) => void } = {}
): Ranked[] {
  const max = Math.max(0, opts.max ?? MAX_BUBBLES);
  const floor = Math.min(opts.floor ?? FLOOR, max);
  const log = opts.log ?? (() => undefined);
  const all = candidates.flatMap((c, order) => {
    if (c.kind === "caption" && opts.unsure) {
      // Never the caption's words, only why (issue #262): logs go into problem reports.
      log("[Screen] DROP (work match unsure)");
      return [];
    }
    const flags = c.kind === "caption" ? sourceRisk(c.text, c.sentence ?? "", Boolean(c.lead)) : [];
    const other = c.kind === "caption" && Boolean(opts.artistArticle) && namesOtherSong(c.text, opts.title ?? "");
    const offMusic = c.kind === "caption" && !aboutTheMusic(c.text);
    return [{ ...c, flags, refill: false, order, other, offMusic, ...interest(c.text, c.sentence || c.text) }];
  });
  // On an artist's article, at most one caption about another song: the first the writer wrote.
  const firstOther = all.find((c) => c.other)?.order;
  // At most MAX_OFF_MUSIC about the work around the song: the first the writer wrote.
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
  // Too few safe ones: the least risky held-back captions come back, a body sentence counting half a flag more.
  const risk = (c: (typeof all)[number]) => c.flags.length + (c.lead ? 0 : 0.5);
  const back = held
    .slice()
    .sort((a, b) => risk(a) - risk(b) || a.order - b.order)
    .slice(0, Math.max(0, floor - safe.length))
    .map((c) => ({ ...c, refill: true }));
  for (const c of held) if (!back.some((b) => b.order === c.order)) log(`[Screen] DROP (risky source: ${c.flags.join(", ")})`);
  // Most interesting first; among equals, data facts and lead captions, then the writer's order.
  const tier = (c: (typeof all)[number]) => (c.kind === "data" || c.lead ? 0 : 1);
  const group = (c: (typeof all)[number]) => (c.refill ? 2 : opts.dataFirst && c.kind === "data" ? 0 : 1);
  const ranked = funScreen([...safe, ...back], opts.fun !== false, log).sort((a, b) => group(a) - group(b) || Number(a.other) - Number(b.other) || Number(a.offMusic) - Number(b.offMusic) || b.score - a.score || tier(a) - tier(b) || a.order - b.order);
  for (const c of ranked.slice(max)) log(`[Rank] not shown (${max} at most, interest ${c.score})`);
  const kept = ranked.slice(0, max);
  // Kinds take turns within each group: leading data facts, the rest, then any captions brought back.
  return [0, 1, 2].flatMap((g) => rotate(kept.filter((c) => group(c) === g)));
}

// --- Fun screen: fewer, better bubbles ------------------------------------

/** Data facts chat finds dry, by why (judged on test lists: these were dry nine times in ten or more). */
const DRY_DATA: Array<[string, RegExp]> = [
  ["release date", /\bcame out in\b/i],
  ["album", /\b(?:is on the album|appears on)\b/i],
  ["genres", /\bgenres\b.*?\binclude\b/i],
  ["birth", /\b(?:was born|formed) in\b/i],
  ["came after", /\b(?:came after|was followed by) the single\b/i],
  ["record label", /\b(?:was released on|record labels include)\b/i],
];

/** Why a data fact is dry ("release date", "album"), or null when it isn't one of the dry kinds. */
export function dryData(text: string): string | null {
  return DRY_DATA.find(([, re]) => re.test(text))?.[0] ?? null;
}

/** Captions whose interest is this or lower (charts, awards, release details) are dry. */
export const DRY_INTEREST = -1;

/**
 * The fun screen: dry data facts and captions scoring DRY_INTEREST or lower leave the list.
 * A song left with nothing keeps one, the best of those dropped. It runs after the floor of
 * three is met, and a dry fact still counts toward that floor, so the screen never brings a
 * risky caption back: a song shows fewer bubbles instead. Logs say why, never the fact's words.
 */
function funScreen<T extends Ranked & { order: number }>(list: T[], on: boolean, log: (line: string) => void): T[] {
  if (!on) return list;
  const why = (c: T) => (c.kind === "data" ? dryData(c.text) : c.score <= DRY_INTEREST ? `interest ${c.score}` : null);
  const kept = list.filter((c) => !why(c));
  const dropped = list.filter((c) => why(c));
  if (!kept.length && dropped.length) {
    // The best of the dropped: the highest score, a safe one before one brought back, a data fact before a caption.
    const best = dropped.slice().sort((a, b) => b.score - a.score || Number(a.refill) - Number(b.refill) || Number(b.kind === "data") - Number(a.kind === "data") || a.order - b.order)[0];
    for (const c of dropped) if (c !== best) log(`[Fun] DROP (dry: ${why(c)})`);
    log(`[Fun] KEEP one dry fact (nothing else left: ${why(best)})`);
    return [best];
  }
  for (const c of dropped) log(`[Fun] DROP (dry: ${why(c)})`);
  return kept;
}

// --- Gather: the article's most fun sentences ---------------------------

/** A link to other music or famous people: what it is based on, who it was meant for, where it went later. */
const CONNECTION =
  /\b(?:influenced by|inspired by|based on|after (?:hearing|listening to|seeing|watching|reading)|originally (?:intended|planned|meant|written|recorded|composed)|intended for|meant for|later (?:used|reused|re-used|worked on|appeared|became)|interpolat\w+|sampl(?:ed|es)|covered by|cover version|duet with|named after|theme song|reference to|tribute to|parody|borrowed|modeled on|modelled on)\b/i;
/** What the makers wanted or did, as an action rather than a quote. */
const INTENT = /\b(?:wanted|aimed|hoped|decided|chose|conceived|came up with|pitched|remembered|imagined|visuali[sz]ed|joked|insisted|refused|taught (?:himself|herself|themselves))\b/i;
/** A twist: what was planned and wasn't, what is unlike the rest. */
const TWIST = /\b(?:unlike|in contrast|instead of|never|unable|did not|didn't|was not|despite|scrapped|abandoned|cancell?ed|rejected|almost|nearly became|by accident|accidentally)\b/i;
/** A bare count big enough to picture: "220,000 submissions", "74 artists". */
const BIG_COUNT = /\b\d{1,3}(?:,\d{3})+\b|\b\d{2,}\s+(?!(?:BPM|bpm)\b)[a-z]+s\b/;
/** The lead's definition: "X is a 1985 song by ...", "X (born 1949) is an American composer". */
const DEFINITION = /^(?:["“][^"”]+["”]|[^.,;]{1,80}?)(?: \([^)]*\))? (?:is|was) (?:a|an|the) (?:[\p{L}\d-]+ ){0,6}(?:song|single|track|album|EP|video game|game|composer|singer|band|rapper|musician|duo|group|soundtrack|film)\b/iu;
/** Music theory read out: a key, a time signature, a tempo. */
const THEORY = /\b(?:key of|time signature|beats per minute|BPM|tempo of|vocal range|common time)\b/i;
/** The size of a release or a sale: "48 tracks", "two discs", "38,000 units". */
const RELEASE_SIZE = /\b(?:\d[\d,]*|two|three|four|five|six|ten) (?:tracks|discs|CDs|units|copies)\b/i;
/** Who wrote and produced it: most viewers find a plain credit list dry. */
const CREDIT_LIST = /^(?:["“][^"”]+["”]|It|The song|The track) (?:was )?(?:written|composed|produced|co-written)(?: and (?:produced|composed|written))? by\b/i;

/**
 * How fun a sentence of the article is to retell, from its words alone: `interest`, plus a link to
 * other music or famous people, what the makers wanted or did, a twist, a big count to picture;
 * less for the lead's definition, music theory read out, the size of a release and a bare credit list. Calibrated on judged
 * test lists (evidence sentences against the judge's interest score), never on the lists it is checked on.
 */
export function sentenceFun(sentence: string): number {
  const s = sentence.replace(SECTION_LABEL, "").trim();
  let score = interest(s, s).score;
  if (CONNECTION.test(s)) score += 2;
  if (INTENT.test(s)) score += 1;
  if (TWIST.test(s)) score += 1;
  if (BIG_COUNT.test(s) && !AWARD.test(s)) score += 1;
  if (RELEASE_SIZE.test(s)) score -= 2;
  if (DEFINITION.test(s)) score -= 2;
  if (THEORY.test(s)) score -= 2;
  if (CREDIT_LIST.test(s)) score -= 1;
  return score;
}

/** A sentence must score this much to be named as one of the most fun. */
export const FUN_SENTENCE_MIN = 2;

/**
 * The `n` most fun sentences of a reference's sentences (`sentenceFun`), best first, the article's
 * order among equals. Only sentences that are safe to retell whole: none the safety screen would
 * hold back (`sourceRisk` on the sentence itself), none under 8 words or over the long-body limit.
 */
export function funSentences(sentences: string[], n = 3): string[] {
  return sentences
    .map((s, i) => ({ s, i, score: sentenceFun(s) }))
    .filter(({ s, score }) => {
      const len = s.split(/\s+/).filter(Boolean).length;
      return score >= FUN_SENTENCE_MIN && len >= 8 && !sourceRisk(s, s, false).filter((f) => f !== "compressed under half").length;
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, Math.max(0, n))
    .map(({ s }) => s);
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
  return /^About this piece:/.test(first) || !(SECTION_LABEL.test(first) || /^(?:From the people who made it|How the music is built|How it was received|From the article "[^"\n]+"): /.test(first));
}
