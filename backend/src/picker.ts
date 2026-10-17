import { MAX_FACT_CHARS, lineSentences } from "./fact-verifier";
import { pickSentences, SourceSentence } from "./per-sentence";

/**
 * Picker mode (PICKER=on, off by default; experiment for #172): the small
 * model picks, code writes.
 *
 * The model writes no caption text. For each source sentence, code builds the
 * choices from the source only, and the model answers short multiple-choice
 * questions, each answer forced by a grammar to one listed option:
 *  Q1 is the sentence about the song playing (or its game, album, artist)?
 *  Q2 which of its clauses states the fact (only with more than one);
 *  Q3 what a referring phrase in that clause ("it", "these titles", "he")
 *     refers to, among the titles and names around it, or NONE;
 *  Q4 who holds the view, when the clause has an opinion cue or a verb of
 *     saying, among the names nearby, or NONE.
 * Code then assembles the caption: "According to <holder>, " when there is
 * one, the clause verbatim with the referring phrase replaced by what it
 * refers to, and a final period. A clause that would run past a bubble is
 * never cut; the next-best clause is tried, or the sentence is skipped.
 */
export const picker = () => process.env.PICKER === "on";

/** Asks the model one question; `grammar` (GBNF) forces the answer to one listed option. */
export type Ask = (prompt: string, grammar: string) => Promise<string>;

// --- Clauses -----------------------------------------------------------

const MIN_CLAUSE_WORDS = 5;
const MAX_OPTIONS = 6;
const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Conjunctions a clause can open with; split before them. */
const CONJUNCTION = /^(?:and|but|while|whereas|although|though|yet)\s+/i;
/** The ones dropped from a clause's start ("and he wrote" is a clause; "although only in Japan" stays with the one before). */
const COORDINATOR = /^(?:and|but|yet)\s+/i;
/** First words of a piece that can't stand on its own: it modifies the piece before or after it. */
const DEPENDENT_START =
  /^["“(]|^(?:which|who|whom|whose|where|when|that|including|with|without|in|on|at|for|from|as|to|of|by|after|before|during|since|until|featuring|such|than|despite|via|into|through|among|between|both|either|neither|or|nor|not|only|also|then|respectively|especially|particularly|mainly|while|whereas|although|though|unlike|like|following|is|are|was|were|has|have|had|did|does|became|would|could|will|can)\b|^titled\b/i;
/** A lowercase participle or adverb first: "released in 1998", "originally". */
const DEPENDENT_WORD = /^\p{Ll}+(?:ing|ed|ly)\b/u;
/** A finite verb, roughly: an auxiliary, a common past or present form, or a past tense in -ed. */
const LISTED_VERB =
  /\b(?:called|is|are|was|were|has|have|had|does|did|do|can|could|will|would|may|might|must|should|became|becomes|made|makes|wrote|writes|said|says|took|takes|gave|gives|came|comes|went|goes|began|begins|sang|sings|won|wins|got|gets|felt|feels|found|finds|kept|keeps|left|leaves|led|leads|met|meets|ran|runs|saw|sees|sold|sells|sent|told|tells|thought|knew|grew|drew|chose|rose|fell|held|holds|brought|built|bought|heard|let|put|set|spent|stood|taught|wore|lost|meant|paid|uses|includes|features|remains|appears|contains|calls|plays|returns|serves|consists|represents|describes|follows|reads|lasts)\b/u;
/** Where an overlong clause may end early without changing what it claims: before a participle, "and", "which"... */
const CUT_BEFORE = /^(?:and\s|which\b|who\b|including\b|with\b|as well as\b|\p{Ll}+ing\b)/u;

interface Piece {
  text: string; // the piece as written, without its separator
  sep: string; // the separator before it ("" for the first)
}

/** The sentence cut at "; ", ", " and before a conjunction, never inside quotes or brackets. */
function pieces(sentence: string): Piece[] {
  const out: Piece[] = [];
  let depth = 0;
  let inQuote = false;
  let inDash = false;
  let start = 0;
  let sep = "";
  const push = (end: number, nextSep: string, next: number) => {
    out.push({ text: sentence.slice(start, end), sep });
    sep = nextSep;
    start = next;
  };
  for (let i = 0; i < sentence.length; i++) {
    const c = sentence[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "“") inQuote = true;
    else if (c === "”") inQuote = false;
    else if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    else if (c === "—") inDash = !inDash;
    if (inQuote || depth > 0 || inDash) continue;
    if ((c === ";" || c === ",") && sentence[i + 1] === " ") push(i, `${c} `, i + 2);
    else if (c === " " && i > start && CONJUNCTION.test(sentence.slice(i + 1))) push(i, " ", i + 1);
  }
  out.push({ text: sentence.slice(start), sep });
  return out.filter((p) => p.text.trim());
}

const stripConjunction = (s: string) => s.replace(COORDINATOR, "");
/** A past tense in -ed counts only within the first four words ("Park recorded it"), not "North America in March 2017 followed by". */
const EARLY_ED = /^(?:\S+\s+){0,3}\p{Ll}{2,}ed\b/u;
const standsAlone = (p: Piece) => {
  const core = stripConjunction(p.text.trim());
  if (DEPENDENT_START.test(core) || DEPENDENT_WORD.test(core)) return false;
  // Split at a bare "and": only with a listed verb, or "Europe and North America" would come apart.
  return LISTED_VERB.test(core) || (p.sep !== " " && EARLY_ED.test(core));
};

/** A clause option: its text as written in the sentence, without a leading conjunction. */
const asClause = (parts: Piece[]) => stripConjunction(parts.map((p, i) => (i ? p.sep : "") + p.text).join("").trim());

/**
 * The clauses a caption can be made of, each verbatim from the sentence:
 * pieces that can stand on their own, with the pieces that only modify them
 * kept attached (a lead-in like "In 2004," goes with the clause after it).
 * A clause that runs past a bubble ends early at a safe point (before a
 * participle, "and", "which") when one leaves it whole; otherwise it is left
 * out. Clauses under five words are left out.
 */
export function clauseOptions(sentence: string, limit = MAX_FACT_CHARS): string[] {
  // Each unit keeps where its main piece is: an early end never cuts that off.
  const units: { parts: Piece[]; main: number }[] = [];
  let pending: Piece[] = [];
  for (const p of pieces(sentence)) {
    if (standsAlone(p)) {
      units.push({ parts: [...pending, p], main: pending.length });
      pending = [];
    } else if (units.length) units[units.length - 1].parts.push(p);
    else pending.push(p);
  }
  // No piece stands alone: only the whole sentence, never a part of it.
  if (pending.length) units.push({ parts: pending, main: pending.length - 1 });
  const options: string[] = [];
  for (const { parts: unit, main } of units) {
    // The whole clause, then shorter versions ending at a safe point, longest first.
    for (let end = unit.length; end > main; end--) {
      // Only at a comma or semicolon: "a long and very cold winter" is one phrase.
      if (end < unit.length && (unit[end].sep === " " || !CUT_BEFORE.test(unit[end].text.trim()))) continue;
      const text = asClause(unit.slice(0, end)).replace(/[,;:]+$/, "");
      if (wordCount(text) < MIN_CLAUSE_WORDS) break;
      if (text.length + 1 <= limit) {
        options.push(text);
        break;
      }
    }
  }
  return [...new Set(options)].slice(0, MAX_OPTIONS);
}

// --- Referring phrases and names ----------------------------------------

/** A phrase in a clause that names nothing itself: "it", "these titles", "the game". */
export interface Referent {
  text: string;
  index: number;
  possessive: boolean; // "its": the name gets "'s"
}

const NOT_A_THING = new Set("time times year years day days week weeks month months point period era way decade season moment stage case".split(" "));
const REFERRING = /\b(?:the (?:song|track|game|album|project|series|band)|(?:this|these|that|those)(?: [a-z-]+)?|its|it|he|she|they)\b/gi;
/** Singular nouns that end in s. */
const SINGULAR_S = new Set("series process class chorus bonus status focus campus genius virus canvas axis analysis thesis basis bus".split(" "));
/** Words after "this" or "that" that make it a pronoun, not a determiner: "this is", "that the". */
const NOT_A_NOUN = new Set(
  "is was are were be been has had have and or but in on at of to for with by as from the a an it its he she they his her their was would could will can may might did does do also not only".split(" ")
);
/** "it" that refers to nothing: "it is said", "it took two years to", "made it to number one". */
const EMPTY_IT = /^it (?:is|was|has been|had been) (?:\w+ )?(?:said|believed|reported|rumou?red|thought|known|claimed|not until|possible|difficult|hard|easy|common|unclear|the first)\b|^it (?:takes|took) |^it seems\b/i;

/** The referring phrases in a clause, in order, one per kind. "that" counts only where it opens the clause. */
export function referents(clause: string): Referent[] {
  const out: Referent[] = [];
  for (const m of clause.matchAll(REFERRING)) {
    let text = m[0];
    const index = m.index ?? 0;
    let [first, noun] = text.toLowerCase().split(" ");
    // "This allows", "these included": a pronoun and its verb, not "this track".
    const verbLike = noun && (/ed$/.test(noun) || (/^(?:this|that)$/.test(first) && /[^s]s$/.test(noun) && !SINGULAR_S.has(noun)));
    if (noun && /^(?:this|these|that|those)$/.test(first) && (NOT_A_NOUN.has(noun) || verbLike)) {
      text = text.split(" ")[0];
      noun = "";
    }
    const lower = text.toLowerCase();
    if (first === "that" && index > 0) continue; // "said that", "the song that": not a referent
    if (first === "that" || first === "those" || first === "this" || first === "these") {
      if (noun && NOT_A_THING.has(noun)) continue;
      if (!noun && index > 0 && first === "that") continue;
    }
    if (lower === "it" && EMPTY_IT.test(clause.slice(index))) continue;
    // "the album Charley's Tenth", "the song \"Night Harbor\"": already named right after.
    if (noun && /^\s+(?:["“]|\p{Lu})/u.test(clause.slice(index + text.length))) continue;
    if (/^made$/i.test(clause.slice(0, index).trim().split(/\s+/).pop() ?? "") && lower === "it") continue;
    if (out.some((r) => r.text.toLowerCase() === lower || (["it", "its"].includes(lower) && ["it", "its"].includes(r.text.toLowerCase())))) continue;
    out.push({ text, index, possessive: lower === "its" });
  }
  return out;
}

/** Words that open a run of capitals without being part of a name. */
const NOT_NAME = new Set(
  "The A An In On At After Before During When While Although However As It Its His Her Their This These That Those He She They We I You Both Some Many Most Several Each Other According Unlike Like Since Following From With For By Of To Despite Also Instead Meanwhile Upon Through Throughout Under Over Originally Later Early One Two Three First Second Third Unlike Because If Then There Here Although Though Yet And But Or Nor So Such Only Even Still Today Initially Eventually Finally Once Additionally Furthermore Moreover".split(
    " "
  )
);
const CALENDAR = /^(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/;
const CAP_WORD = String.raw`\p{Lu}[\p{L}\p{N}'’.&-]*`;
const NAME_RUN = new RegExp(String.raw`${CAP_WORD}(?:\s+(?:(?:of|the|de|van|von|du|la|&)\s+)*(?:${CAP_WORD}|\d+(?=[\s,.;:!?]|$)))*`, "gu");

/** Capitalized names in a text, as written: "Tsunekazu Ishihara", "ABC News", "The Open Door". */
export function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NAME_RUN)) {
    const words = m[0].replace(/['’]s$/, "").replace(/[.,]+$/, "").split(/\s+/);
    // "The Open Door" keeps its "The"; "In Japan" and "During Pokémon Gold" lose their first word.
    const connector = /^(?:of|the|de|van|von|du|la|&)$/;
    while (words.length && (connector.test(words[0]) || (NOT_NAME.has(words[0]) && !(words[0] === "The" && words.length > 1 && /^\p{Lu}/u.test(words[1]))))) words.shift();
    while (words.length && connector.test(words[words.length - 1])) words.pop();
    const name = words.join(" ").replace(/['’]$/, "");
    // A capital only because it starts a sentence ("Frame rate was..."), unless the word is capitalized elsewhere too.
    const atStart = (m.index ?? 0) === 0 || /[.!?]["”)]?\s+$/.test(text.slice(0, m.index));
    if (atStart && words.length === 1 && m[0].split(/\s+/).length === 1 && !new RegExp(String.raw`[^.!?\s]\s+${name}\b`, "u").test(text)) continue;
    if (words.length === 1 && DEMONYM.test(name)) continue;
    if (name.length < 2 || !/^\p{Lu}/u.test(name) || /^I['’]/.test(name) || NOT_NAME.has(name) || CALENDAR.test(words[0] ?? "")) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const DEMONYM = /^(?:\p{Lu}\p{Ll}+(?:ese|ish)|American|British|European|Canadian|Australian|Italian|German|French|Korean|Russian|Brazilian|Mexican|Swedish|Norwegian|Indian|African|Asian|Western|Eastern|Northern|Southern)$/u;

/** Section headings that name a part of an article, not a thing a phrase could refer to. */
const GENERIC_HEADING_WORDS = new Set(
  "introduction development production reception release releases background composition music legacy gameplay plot synopsis recording writing lyrics overview history accolades chart charts personnel critical commercial performance video live performances track listing cover versions soundtrack from the people who made it about this piece how is built was received and of in other media design concept themes style influences".split(
    " "
  )
);
const namesAThing = (heading: string) =>
  // Headings are in sentence case: "Frame rate" names no thing, "Gold and Silver" does.
  heading.split(/\s+/).slice(1).some((w) => /^\p{Lu}/u.test(w)) && heading.toLowerCase().split(/\s+/).some((w) => !GENERIC_HEADING_WORDS.has(w));

/** "Lithium (Evanescence song)" reads as "Lithium". */
const bare = (title: string) => title.replace(/\s*\([^)]*\)\s*$/, "").trim();

// --- Opinions -----------------------------------------------------------

/**
 * Opinion cues: the plan's cue words and Wikipedia's "Words to watch"
 * (puffery and unsupported attribution), lowercase so an award ("Best
 * Original Score") or a place ("Great Britain") doesn't count.
 */
const OPINION_CUE =
  /\b(?:praised|praising|acclaimed|acclaim|applauded|lauded|commended|hailed|regarded|described as|iconic|masterpiece|beloved|critics?|critically|considered (?:to be|one of|among|as|by|a|an|the|his|her|their|its)\b|(?:one of|among|some of) the (?:\w+ )?(?:best|greatest|finest|most)\b|legendary|great(?![- ](?:deal|grand|uncle|aunt|many))|visionary|outstanding|celebrated|award-winning|landmark|cutting-edge|innovative|revolutionary|extraordinary|brilliant|famous|renowned|remarkable|prestigious|world-class|respected|virtuoso|unique|pioneering|phenomenal|prominent|instantly recognizable)\b|\bbest\b(?![- ](?:selling|known|friend|of\b|man\b))|\bit is (?:often |widely |generally |commonly )?(?:believed|regarded|considered|said|reported)\b|\bmany consider\b/;
/** Verbs of saying, writing or judging: whoever does them holds the view. */
const SPEECH =
  /\b(?:said|says|say|stated|states|wrote|writes|called|calls|described|describes|noted|notes|recalled|recalls|explained|explains|claimed|claims|remarked|commented|argued|added|declared|told|felt|feels|believed|believes|thought|deemed|ranked|listed|named|according to|in an interview)\b|["“]/i;

export const needsHolder = (clause: string) => !/^According to /.test(clause) && (OPINION_CUE.test(clause) || SPEECH.test(clause));

// --- Assembly ----------------------------------------------------------

const LOWER_FIRST = new Set("The A An It Its This These That Those His Her Their Some Many Both One Each In On At After Before During".split(" "));
const upperFirst = (s: string) => s.replace(/^(["“(]?)(\p{Ll})/u, (_, q: string, c: string) => q + c.toUpperCase());
const surname = (name: string) => name.split(/\s+/).pop()!.toLowerCase();

/**
 * The caption from a picked clause: each referring phrase replaced by what it
 * refers to (left as is when that name already comes earlier in the clause),
 * "According to <holder>, " first when the clause doesn't name the holder
 * already, and a final period. Undefined when it would be longer than a bubble:
 * nothing is ever cut.
 */
export function assembleCaption(
  clause: string,
  { resolved = [], holder, names, limit = MAX_FACT_CHARS }: { resolved?: { ref: Referent; name: string }[]; holder?: string; names?: string[]; limit?: number }
): string | undefined {
  let text = clause.trim();
  // Right to left, so earlier indexes stay valid.
  for (const { ref, name } of [...resolved].sort((a, b) => b.ref.index - a.ref.index)) {
    if (text.slice(0, ref.index).toLowerCase().includes(name.toLowerCase())) continue;
    text = text.slice(0, ref.index) + name + (ref.possessive ? "'s" : "") + text.slice(ref.index + ref.text.length);
  }
  text = upperFirst(text);
  if (holder && !text.toLowerCase().includes(surname(holder))) {
    // After "According to X, " the clause's first word keeps its capital only when it starts a name.
    const first = text.split(/\s+/, 1)[0].replace(/^["“(]/, "");
    const proper = names ? first === "I" || names.some((n) => n.split(/\s+/)[0] === first) : !LOWER_FIRST.has(first);
    text = `According to ${holder}, ${proper ? text : text.replace(/^(["“(]?)(\p{Lu})/u, (_, q: string, c: string) => q + c.toLowerCase())}`;
  }
  text = text.replace(/[\s,;:–—-]+$/, "").replace(/,(["”])$/, ".$1");
  if (!/[.!?]["”)]?$/.test(text)) text += ".";
  return text.length <= limit ? text : undefined;
}

// --- Questions ---------------------------------------------------------

const literal = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** The grammar that forces an answer to exactly one of `options`. */
export const choiceGrammar = (options: string[]) => `root ::= ${options.map(literal).join(" | ")}`;
const NONE = "NONE";

/** The song playing, as the request names it. */
export interface Playing {
  title: string;
  artist: string;
}

/**
 * Q1. It names the request's artist field as well: to a model this small,
 * "about the song" means the song alone, and it said no to most sentences
 * about the song's own game or artist (40% of DEV's sentences, first run).
 */
const aboutQuestion = ({ title, artist }: Playing) =>
  artist
    ? `The request is "${title}" (artist field: ${artist}). Is this sentence about that song, or about ${artist} (the song's game, album, film or performer), or the people who made them? Answer no only if it is about a different song, game, album, film or person.`
    : `Is this sentence about "${title}", or the game, album, film or performer it comes from, or the people who made them? Answer no only if it is about a different song, game, album, film or person.`;

/** The two sentences before each sentence of the reference, in the same paragraph block. */
function sentencesBefore(context: string): Map<string, string[]> {
  const before = new Map<string, string[]>();
  let seen: string[] = [];
  for (const line of context.split("\n").slice(1)) {
    if (!line.trim()) {
      seen = [];
      continue;
    }
    for (const s of lineSentences(line.replace(/^(\p{Lu}[^:.!?\n"“]{1,60}): (?=\S)/u, ""))) {
      if (!before.has(s)) before.set(s, seen.slice(-2));
      seen.push(s);
    }
  }
  return before;
}

/** The shared start of every question about one sentence, so the model's cache reuses it from one question to the next. */
function sentenceFrame(song: Playing, article: string, source: SourceSentence, before: string[]): string {
  return `You answer short questions about ONE sentence from a Wikipedia article, for captions on a live music stream. Reply with exactly one of the listed answers and nothing else.

Song playing: "${song.title}"${song.artist ? ` (request's artist field: ${song.artist})` : ""}
Article: ${article}
Section: ${source.heading}
Sentences before it: ${before.length ? before.join(" ") : "(none)"}
Sentence: ${source.sentence}

`;
}

/** The option the model answered, or undefined. Exact under a grammar; a contained option for providers that ignore it. */
function chosen(answer: string, options: string[]): string | undefined {
  const a = answer.trim().replace(/^["']|["'.]$/g, "");
  return options.find((o) => o === a) ?? options.find((o) => a.includes(o));
}

export interface PickLog {
  sentence: string;
  outcome: string;
}

/**
 * Picked captions from the reference, at most `n`, plus a log line per
 * sentence. Sentences come in the per-sentence writer's order; more are tried
 * than captions wanted, since some are skipped.
 */
export async function pickCaptions(context: string, song: Playing, n: number, ask: Ask, limit = MAX_FACT_CHARS): Promise<{ captions: string[]; log: PickLog[] }> {
  const article = context.split("\n")[0];
  const before = sentencesBefore(context);
  const captions: string[] = [];
  const log: PickLog[] = [];
  for (const source of pickSentences(context, n * 2)) {
    if (captions.length >= n) break;
    const prev = before.get(source.sentence) ?? [];
    const note = (outcome: string) => log.push({ sentence: source.sentence, outcome });
    let options = clauseOptions(source.sentence, limit);
    if (!options.length) {
      note("skip: no clause fits");
      continue;
    }
    const frame = sentenceFrame(song, article, source, prev);
    const q1 = await ask(
      `${frame}Question: ${aboutQuestion(song)}\nAnswers: yes, no`,
      choiceGrammar(["yes", "no"])
    );
    if (chosen(q1, ["yes", "no"]) !== "yes") {
      note("skip: not about the song");
      continue;
    }
    let caption: string | undefined;
    for (let attempt = 0; attempt < 2 && options.length && !caption; attempt++) {
      let clause = options[0];
      if (options.length > 1) {
        const numbers = options.map((_, i) => String(i + 1));
        const q2 = await ask(`${frame}Question: Which part of the sentence states its fact best, complete on its own?\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\nAnswers: ${numbers.join(", ")}`, choiceGrammar(numbers));
        clause = options[Number(chosen(q2, numbers) ?? 1) - 1];
      }
      options = options.filter((o) => o !== clause);
      // Q3: what each referring phrase refers to.
      const candidates = [
        ...new Set(
          [bare(article), song.title, ...(namesAThing(source.heading) ? [source.heading] : []), ...namesIn(prev.join(" ")), ...namesIn(source.sentence.slice(0, source.sentence.indexOf(clause)))].filter(
            (c) => c && c.length >= 2
          )
        ),
      ]
        // "Look" goes when "Look on the Floor" is there: the longer name says which.
        .filter((c, _, all) => !all.some((o) => o !== c && ` ${o} `.includes(` ${c} `)))
        .slice(0, 8);
      const resolved: { ref: Referent; name: string }[] = [];
      let unresolved = "";
      for (const ref of referents(clause).slice(0, 2)) {
        const answers = [...candidates, ...namesIn(clause.slice(0, ref.index)).filter((c) => !candidates.includes(c)), NONE];
        // Where each answer comes from, so "It" at a sentence's start can be told from a name in the sentence before.
        const from = (a: string) =>
          a === NONE ? "none of these" : a === bare(article) ? "this article's subject" : a === song.title ? "the song playing" : a === source.heading ? "this section's heading" : "named nearby";
        const q3 = await ask(
          `${frame}Question: In the part "${clause}", what does "${ref.text}" refer to?\n${answers.map((a) => `- ${a} (${from(a)})`).join("\n")}\nAnswers: ${answers.join("; ")}`,
          choiceGrammar(answers)
        );
        const name = chosen(q3, answers);
        if (!name || name === NONE) {
          unresolved = ref.text;
          break;
        }
        resolved.push({ ref, name: name === song.title && name !== bare(article) ? `"${name}"` : name });
      }
      if (unresolved) {
        note(`skip: "${unresolved}" refers to nothing listed`);
        caption = undefined;
        break;
      }
      // Q4: who holds the view.
      let holder: string | undefined;
      if (needsHolder(clause)) {
        const holders = [...new Set([...namesIn(prev.slice(-1).join(" ")), ...namesIn(source.sentence)])].filter((h) => h !== bare(article) && h !== song.title).slice(0, 8);
        if (holders.length) {
          const answers = [...holders, NONE];
          const q4 = await ask(`${frame}Question: Whose view or words does the part "${clause}" give? Answer NONE if the article states it as plain fact.\nAnswers: ${answers.join("; ")}`, choiceGrammar(answers));
          const who = chosen(q4, answers);
          holder = who && who !== NONE ? who : undefined;
        }
      }
      caption = assembleCaption(clause, { resolved, holder, names: [...candidates, ...namesIn(source.sentence)], limit });
      if (!caption) note(`too long: ${clause.slice(0, 60)}`);
    }
    if (caption) {
      captions.push(caption);
      note(`caption: ${caption}`);
    } else if (!log.some((l) => l.sentence === source.sentence && l.outcome.startsWith("skip"))) note("skip: no clause fits after assembly");
  }
  return { captions, log };
}
