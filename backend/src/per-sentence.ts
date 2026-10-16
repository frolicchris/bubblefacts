import { LEANS_BACK, MAX_FACT_CHARS, lineSentences } from "./fact-verifier";

/**
 * Per-sentence writing (PER_SENTENCE=on, off by default; experiment for #172).
 *
 * Instead of one generation for the whole reference, the writer gets ONE
 * sentence at a time, with the article title and section heading, and writes
 * one caption from it. It can't merge or borrow across sentences it never sees
 * together. For the built-in model, a GBNF grammar forces what a 3B model drops
 * most: "According to X, " when the sentence says plainly who holds the view,
 * and the sentence's hedge ("reportedly", "is said to"). The grammar is
 * otherwise free text: one line, no longer than a bubble allows.
 *
 * Holder rules are deliberately narrow. A broad "name near a verb" guess broke
 * every correct caption it touched in the algo loop; only these two held:
 *  1. the sentence says "According to X," itself;
 *  2. the sentence quotes someone it introduces as "<Name> <speech verb> ... “quote”"
 *     (the name right before the verb, the verb at most four words before the quote).
 */
export const perSentence = () => process.env.PER_SENTENCE === "on";

/** Turns a sentence's holder into "According to X, " only for these first words, never "The", "It", "In"... */
const NOT_A_HOLDER = new Set(
  "The It This These He She They In On At After Before When While Although However As Its His Her Their A An Both Some Many".split(" ")
);
const NAME = String.raw`(\p{Lu}[\p{L}\p{N}_'’.&-]+(?:\s+(?:of|the|de|van|von|\p{Lu}[\p{L}\p{N}_'’.&-]+)){0,5})`;
const SPEECH_VERB = String.raw`(?:said|says|wrote|writes|called|calls|described|describes|praised|noted|stated|considered|felt|observed|claimed|remarked|commented|opined|argued|added|recalled|explained|declared|hailed|named|ranked|listed|deemed)`;
const ACCORDING_TO = new RegExp(String.raw`According to ${NAME},`, "u");
/** "<Name> <speech verb>" and at most four words before the quote opens, anchored at the quote. */
const INTRODUCES_QUOTE = new RegExp(String.raw`${NAME}\s+(?:also\s+|later\s+)?${SPEECH_VERB}\b(?:[^\p{L}\p{N}_]+[\p{L}\p{N}_]+){0,4}[^\p{L}\p{N}_]*$`, "u");
const QUOTE = /["“]([^"”]{6,})["”]?/gu;

const usableHolder = (holder: string | undefined): string | undefined => {
  const name = holder?.trim();
  return name && name.length >= 3 && !NOT_A_HOLDER.has(name.split(/\s+/)[0]) ? name : undefined;
};

/** Who the speech verb right before `at` in `text` names, if the precise rule finds one. */
function speakerBefore(text: string, at: number): string | undefined {
  return usableHolder(INTRODUCES_QUOTE.exec(text.slice(Math.max(0, at - 120), at))?.[1]);
}

/** The holder of a sentence's claim by the precise rules, before anything is written. */
export function holderOf(sentence: string): string | undefined {
  const said = usableHolder(ACCORDING_TO.exec(sentence)?.[1]);
  if (said) return said;
  for (const q of sentence.matchAll(QUOTE)) {
    const who = speakerBefore(sentence, q.index ?? 0);
    if (who) return who;
  }
  return undefined;
}

/**
 * Hedge cues the caption must keep. Only the sure ones: a word like "may" or
 * "likely" changes too much grammar around it to force it into a free sentence.
 */
const HEDGE_CUE = /\b(?:reportedly|allegedly|supposedly|purportedly|rumou?red|(?:is|was) said to|(?:is|was) believed|apparently|has been described as)\b/i;
export function hedgeOf(sentence: string): string | undefined {
  return HEDGE_CUE.exec(sentence)?.[0].toLowerCase();
}

/** A GBNF string literal. */
const literal = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A cue that may open the sentence: its first letter in either case. */
const cueRule = (cue: string) => {
  const first = cue[0];
  const head = first.toUpperCase() === first.toLowerCase() ? literal(first) : `(${literal(first.toUpperCase())} | ${literal(first.toLowerCase())})`;
  return cue.length > 1 ? `${head} ${literal(cue.slice(1))}` : head;
};

/**
 * The grammar for one caption: free text on one line, at most `limit`
 * characters, opening with "According to <holder>, " and containing `cue`
 * when they're given. GBNF can't count across rules, so with a cue each side
 * of it is held to the room left; the bubble-length screen still drops the
 * rare line that ends up longer.
 */
export function captionGrammar({ holder, cue, limit = MAX_FACT_CHARS }: { holder?: string; cue?: string; limit?: number }): string {
  const prefix = holder ? `According to ${holder}, ` : "";
  const room = Math.max(1, limit - prefix.length);
  const rules = [`root ::= ${prefix ? `${literal(prefix)} ` : ""}body`];
  if (cue) {
    const side = Math.max(0, room - cue.length);
    rules.push(`body ::= [^\\r\\n]{0,${side}} cue [^\\r\\n]{0,${side}}`, `cue ::= ${cueRule(cue)}`);
  } else rules.push(`body ::= [^\\r\\n]{1,${room}}`);
  return rules.join("\n");
}

/** One sentence to write from, with what the writer is told about where it sits. */
export interface SourceSentence {
  sentence: string;
  heading: string;
}

/** "Development: Gold and Silver were..." from the reference: the section heading the extract kept. */
const SECTION_LABEL = /^(\p{Lu}[^:.!?\n"“]{1,60}): (?=\S)/u;
const MIN_SENTENCE_CHARS = 40;

/**
 * The sentences to write from, out of the reference the pipeline already built
 * (the makers' block first, then how the music is built, how it was received,
 * the music sections and the lead). Its blocks take turns, so one long section
 * doesn't take every slot, and sentences that lean on the one before ("He
 * explained", "These titles") wait until the others run out, as they do when
 * the extract lifts sentences (`creatorSentences`).
 */
export function pickSentences(context: string, n: number): SourceSentence[] {
  const blocks: SourceSentence[][] = [];
  let heading = "";
  let block: SourceSentence[] | null = null;
  for (const line of context.split("\n").slice(1)) {
    if (!line.trim()) {
      block = null;
      continue;
    }
    const label = SECTION_LABEL.exec(line)?.[1];
    if (!block) {
      block = [];
      blocks.push(block);
      heading = label ?? "Introduction";
    } else if (label) heading = label;
    for (const s of lineSentences(line.replace(SECTION_LABEL, ""))) {
      if (s.length >= MIN_SENTENCE_CHARS) block.push({ sentence: s, heading });
    }
  }
  const turns = (keep: (s: SourceSentence) => boolean) => {
    const queues = blocks.map((b) => b.filter(keep));
    const out: SourceSentence[] = [];
    for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) out.push(q[i]);
    return out;
  };
  const leans = (s: SourceSentence) => LEANS_BACK.test(s.sentence);
  return [...turns((s) => !leans(s)), ...turns(leans)].slice(0, n);
}

/**
 * Worked examples with made-up names: a quote retold with its speaker, and a
 * long sentence shortened with its hedge kept. One or two at most: a long
 * prompt hurts a model this small.
 */
export const SENTENCE_EXAMPLES = `Made-up examples (never use these names or facts):
Article: Night Harbor
Section: Production
Sentence: In 2004, Dana Reyes said, "We wanted the chorus to sound like a storm."
Caption: According to Dana Reyes, the band wanted the chorus to sound like a storm.

Article: Night Harbor
Section: Release
Sentence: Originally planned for 2003, Night Harbor was reportedly delayed to May 2004 after the band's drummer, Lee Park, broke his wrist.
Caption: Night Harbor was reportedly delayed to May 2004 after drummer Lee Park broke his wrist.`;

/** The example lines a caption could copy, for `copiesExample`. */
export const SENTENCE_EXAMPLE_LINES = SENTENCE_EXAMPLES.split("\n")
  .filter((l) => /^(Sentence|Caption): /.test(l))
  .map((l) => l.replace(/^\w+: /, ""));

/** The fixed part comes first, so the model can reuse it from one sentence to the next. */
export function sentencePrompt(article: string, { sentence, heading }: SourceSentence): string {
  return `You turn ONE sentence from a Wikipedia article into ONE caption for a live music stream. Use only that sentence. Keep who said, wrote or thought it, keep words like "reportedly", and keep names, numbers, places and charts as written. Name the subject instead of "it" or "they". The caption is one sentence under 120 characters, in plain words.

${SENTENCE_EXAMPLES}

Now the real sentence. Reply with its caption only: no greeting, no label, nothing before or after it.
Article: ${article}
Section: ${heading}
Sentence: ${sentence}`;
}

/** The model's caption, on one line, without a label or wrapping quotes it may add. */
export function cleanCaption(text: string): string {
  const line = text.trim().split("\n")[0].trim().replace(/^Caption:\s*/i, "");
  return /^"[^"]*"$/.test(line) ? line.slice(1, -1).trim() : line;
}

const LOWER_FIRST = new Set("The A An It Its This These That Those His Her Their Some Many Both One Each In On At After Before During".split(" "));
const lowerFirst = (caption: string) => (LOWER_FIRST.has(caption.split(" ", 1)[0]) ? caption[0].toLowerCase() + caption.slice(1) : caption);

/**
 * The fallback for a caption the grammar didn't attribute: when it quotes words
 * that its sentence introduces as "<Name> <speech verb> ... “quote”", or its
 * sentence says "According to X,", it gets "According to X, ". Nothing else
 * is changed, and a caption that already names X is left alone.
 */
export function attributeCaption(caption: string, sentence: string): string {
  if (/^according to /i.test(caption)) return caption;
  let holder = usableHolder(ACCORDING_TO.exec(sentence)?.[1]);
  if (!holder) {
    const quoted = /["“]([^"”]{6,})["”]/u.exec(caption)?.[1];
    const at = quoted ? sentence.indexOf(quoted.slice(0, 20)) : -1;
    if (at >= 0) holder = speakerBefore(sentence, at);
  }
  if (!holder) return caption;
  const surname = holder.split(/\s+/).pop()!.toLowerCase().replace(/['’]s$/, "");
  return caption.toLowerCase().includes(surname) ? caption : `According to ${holder}, ${lowerFirst(caption)}`;
}
