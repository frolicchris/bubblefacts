import { escapeRe } from "../text";
import { withoutQualifier } from "../grounding/relevance";
import { hasWord, NAME_STOPWORDS, sourceSentences } from "./names";
import { contentTokens } from "./similarity";

// The source's sentences and which one a caption retells (support); numbers, connectives, relations, lost qualifiers

// Labels a reference puts before sentences it lifts (orderExtract)
const REFERENCE_LABEL = /^(About this piece|From the people who made it|How the music is built|How it was received|From the article "[^"\n]+"): /;
// Sentence break: only before a capital, never after a middle initial ("Barry J. Eastmond")
const SENTENCE_BREAK = /(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u;

/** A reference line's sentences, without its label */
export const lineSentences = (line: string) =>
  line.replace(REFERENCE_LABEL, "").split(SENTENCE_BREAK).map((s) => s.trim()).filter((s) => s && !/^==/.test(s));

/** Every sentence after the title line, as numbered for citing: sentence N is [N - 1] */
export function referenceSentences(context: string): string[] {
  return context.split("\n").slice(1).flatMap(lineSentences);
}

/** The reference for citing: title line, labels on their own lines, sentences numbered "[3] ..." */
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

/** The reference's sentences without labels, for matching a caption to the one it retells */
export function bodySentences(context: string): string[] {
  return referenceSentences(context).filter((s) => s.length >= 20);
}

// The sentence cited for the caption being screened: while set, it is the retold one, no guessing
let citing: { fact: string; sentence: string } | null = null;

/** screenClaims sets this around each caption */
export function setCiting(next: { fact: string; sentence: string } | null): void {
  citing = next;
}

/** Share of a caption's content words a sentence holds */
export function share(fact: string, sentence: string): number {
  const want = contentTokens(fact.replace(/\s*\([^)]*\)/g, ""));
  if (!want.size) return 0;
  const have = contentTokens(sentence);
  let shared = 0;
  for (const t of want) if (have.has(t)) shared++;
  return shared / want.size;
}

/** Sentences a caption likely retells: the best match and any nearly as good; none under a quarter */
export function retoldSentences(fact: string, context: string): string[] {
  if (citing?.fact === fact) return [citing.sentence];
  const scored = bodySentences(context).map((s) => ({ s, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  return best < 0.25 ? [] : scored.filter((x) => x.share >= best - 0.1).map((x) => x.s);
}

/** Share of a caption's words in its cited sentence, else the best-matching one */
export const support = (fact: string, context: string, cited?: string) =>
  cited !== undefined ? share(fact, cited) : Math.max(0, ...bodySentences(context).map((s) => share(fact, s)));

// Counts and ordinals as words (DIGIT_OF)
const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "hundred", "dozen"];
const ORDINALS = ["second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

// Joining words (cause, order, intention, count) a small model adds between two true statements;
// kept only when the retold sentence has one of the same kind
export const CONNECTIVES: Array<{ label: string; fact: RegExp; source: RegExp }> = [
  { label: "including", fact: /\bincluding\b/i, source: /\b(?:includ|among|such as|especially|notably)/i },
  { label: "a cause", fact: /\b(due to|because|owing to|thanks to|as a result)\b/i, source: /\b(due to|because|owing to|thanks to|as a result|since|so|as (?:he|she|they|it|the|a|his|her|their))\b/i },
  { label: "a consequence", fact: /\b(led to|leading to|lead to|resulted in|prompted|caused)\b/i, source: /\b(led|lead|leading|result\w*|prompt\w*|caus\w*)\b/i },
  { label: "an order", fact: /\bafter\b/i, source: /\b(after|following|afterwards?|previously|when|once|upon|then|subsequently)\b/i },
  { label: "an order", fact: /\bbefore\b/i, source: /\b(before|prior|earlier|previously|until|first|originally)\b/i },
  { label: "a first", fact: /\b(?:for )?the first time\b|\bfirst[- ]ever\b/i, source: /\bfirst\b|\bdebut/i },
  { label: "the only one", fact: /\bthe only\b/i, source: /\b(?:only|sole|solely|alone|exclusive\w*|unique\w*)\b/i },
  { label: "an intention", fact: /\boriginally (?:intended|meant|planned|supposed)|\b(?:was|were) (?:intended|meant|supposed|planned|going) to\b/i, source: /\b(originally|intend\w*|meant|plann?\w*|suppos\w*|initially)\b/i },
  { label: "a count", fact: /\b(twice|thrice|again|\w+ times)\b/i, source: /\b(twice|thrice|again|\w+ times|re-\w+|re(?:issued|released|recorded|turned|appeared|entered))\b/i },
  // "originally titled X" when the source just names X; "originally a cover" when it was covered later
  { label: "a former title", fact: /\boriginally (?:titled|called|named|known)\b|\bgoing to be (?:titled|called|named)\b/i, source: /^(?=.*\b(?:original\w*|initial\w*|intend\w*|meant|plann?\w*|working title|formerly|previously|renam\w*|retitl\w*)\b)(?=.*\b(?:titl\w*|call\w*|nam\w*|known)\b)/is },
  // "originally from", "originally formed in" only say where someone comes from
  { label: "an origin", fact: /\boriginally\b(?!\s+(?:from|formed|based|born|hails?|titled|called|named|known|intended|meant|planned|supposed|going)\b)/i, source: /\b(original\w*|initial\w*|first|earlier|early|previously|formerly|began|before|pre-\w+|at the time)\b/i },
  // "inspiring Y to write Z" when the source only says Z resembles X's piece
  { label: "a prompt", fact: /\binspir(?:ed|ing|es)\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*\s+){1,3}to\b/u, source: /\b(inspir\w*|prompt\w*|led|motivat\w*|encourag\w*|persuad\w*|convinc\w*|urged)\b/i },
  // "inspired by X" when the source says it resembles X
  { label: "an influence", fact: /\b(inspir\w*|influenc\w*)\b/i, source: /\b(inspir\w*|influenc\w*|based on|model\w*|drew|draws?|drawn|borrow\w*|deriv\w*|homage|tribute|took reference|references?)\b/i },
  // "born on 17 December" for a baptism date
  { label: "a birth", fact: /\bborn\b/i, source: /\b(born|birth\w*)\b/i },
  // "after its first performance" for "after a performance in Leipzig"
  { label: "a first", fact: /\bfirst\b/i, source: /\b(first|1st|debut\w*|premiere\w*|original\w*|initial\w*|earliest|began|begin\w*|start\w*|introduc\w*|launch\w*|new)\b/i },
];
const DIGIT_OF: Record<string, string> = Object.fromEntries([...NUMBER_WORDS.slice(0, 19).map((w, i) => [w, String(i + 2)]), ["thirty", "30"], ["forty", "40"], ["fifty", "50"], ...ORDINALS.map((w, i) => [w, `${i + 2}`])]);

/** Titles blanked, so "After Burner" or "Because of You" isn't a joining word: the article's, the song's, or a capitalized run in the source */
function withoutTitles(fact: string, context: string, titles: string[]): string {
  // Two words or more: a one-word title ("Because") would blank every capitalized use
  const own = [withoutQualifier(context.split("\n")[0]), ...titles].map((t) => t.trim()).filter((t) => t.length >= 3 && /\s/.test(t));
  // A run is a name only where the source has it mid-sentence
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

/** Joining word or number (not a year) the retold sentence lacks, or null: "twice", "three pieces" when it has five */
export function unsupportedConnective(fact: string, context: string, titles: string[] = []): string | null {
  const retold = retoldSentences(fact, context);
  const worded = withoutTitles(fact, context, titles);
  // "first" is too common to drop when nothing is retold; other checks judge that
  const used = CONNECTIVES.filter((c) => c.fact.test(worded) && (c.label !== "a first" || retold.length > 0));
  const numbers = numbersIn(fact);
  if (!used.length && !numbers.length) return null;
  if (!retold.length) return used[0]?.fact.exec(worded)?.[0] ?? numbers[0];
  // A number or "first" may be in any sentence drawn on: "their third film together"
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

/** Counts and ordinals, not years or part of a name ("Expedition 33", "Hot 100", "No. 3") */
export function numbersIn(fact: string): string[] {
  return [
    // Lowercase only: "Two Worlds" is a title
    ...(fact.match(new RegExp(`\\b(${[...NUMBER_WORDS, ...ORDINALS].join("|")})\\b`, "g")) ?? []),
    ...[...fact.matchAll(/(?<![\p{L}\d.,$])\d{1,3}(?:,\d{3})*(?![\d\p{L}])/gu)]
      .filter((m) => !/(?:\p{Lu}[\p{L}.'’-]*|No\.|Op\.|K\.)\s+$/u.test(fact.slice(0, m.index)) && !/^\s+\p{Lu}/u.test(fact.slice((m.index ?? 0) + m[0].length)))
      .map((m) => m[0]),
  ];
}

/** This number in any form: "second" = "2nd", "1,000" = "1000" */
export function hasNumber(n: string, s: string): boolean {
  const forms = [n, DIGIT_OF[n], ...Object.entries(DIGIT_OF).filter(([, d]) => d === n).map(([w]) => w)].filter(Boolean) as string[];
  return forms.some((f) => hasWord(f, s) || hasWord(f.replace(/,/g, ""), s.replace(/(\d),(\d)/g, "$1$2")) || (/^\d+$/.test(f) && hasWord(`${f}${f === "2" ? "nd" : f === "3" ? "rd" : "th"}`, s)));
}

/** Split at "after": its clause (to the next comma) and the rest */
function splitAtAfter(s: string, word = /\bafter\b/i): { after: string; rest: string } | null {
  const m = word.exec(s);
  if (!m) return null;
  const from = m.index + m[0].length;
  const comma = s.slice(from).search(/[,;]/);
  const to = comma < 0 ? s.length : from + comma;
  return { after: s.slice(from, to), rest: `${s.slice(0, m.index)} ${s.slice(to)}` };
}

/** "A after B" for a source's "after A, B" or "B when A": the caption's main clause matches the source's "after" clause better */
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
 * "A after B" from two nearby sentences, B first: the article's order is the story's ("threatened to
 * leave. Sakaguchi suggested..."). Not when B comes later, or one sentence says otherwise
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

// How people are related or what they play: small models invent these ("older brother", "guitarist X").
// Needs a source sentence with the word, the caption's subject and the person next to the word
const RELATION =
  /(?<![\p{L}-])(brothers?|sisters?|siblings?|sons?|daughters?|father|mother|parents?|wife|husband|spouse|married|girlfriend|boyfriend|fianc[eé]e?|cousins?|uncle|aunt|nephew|niece|grand(?:son|daughter|father|mother)|partners?|self-titled|eponymous|guitarist|keyboardist|keyboard player|drummer|bassist|pianist|violinist|saxophonist|trumpeter|voice actress|voice actor)\b/gu;
export const NAME_RUN = /(?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*)*/gu;

export function unsupportedRelation(fact: string, context: string): string | null {
  const sentences = sourceSentences(context);
  const runs = [...fact.matchAll(NAME_RUN)]
    .map((m) => ({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, words: m[0].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase())) }))
    .filter((r) => r.words.length);
  for (const m of fact.matchAll(RELATION)) {
    const word = m[0].toLowerCase();
    const at = m.index ?? 0;
    const root = word.replace(/s$/, "").replace(/^(fianc)[eé]e?$/, "$1");
    // The subject and the name nearest the word: "[Leon Ware] is [T-Boy Ross]'s older brother"
    const nearest = [...runs].sort((a, b) => Math.min(Math.abs(a.end - at), Math.abs(a.at - at - word.length)) - Math.min(Math.abs(b.end - at), Math.abs(b.at - at - word.length)))[0];
    // Not next to anyone ("a new drummer position"): describes no one
    const gap = nearest ? fact.slice(Math.min(nearest.end, at + word.length), Math.max(nearest.at, at)).trim().split(/\s+/).filter(Boolean).length : Infinity;
    if (runs.length && gap > 3) continue;
    const people = [...new Set([runs[0], nearest].filter(Boolean))];
    const stated = sentences.some((s) => new RegExp(`\\b${escapeRe(root)}`, "i").test(s) && people.every((p) => p.words.some((w) => hasWord(w, s))));
    if (!stated) return m[0];
  }
  return null;
}

export const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const RELEASE_ORDINAL = `(?:first|lead|debut|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\\d+(?:st|nd|rd|th))`;
// An album named only as a source: "from their self-titled debut album", "off her third album"
const FROM_AN_ALBUM = /\b(?:from|off|of|on)\s+(?:(?:the|their|his|her|its|a|an)\s+)?(?:[\p{L}'’-]+\s+){0,5}(?:album|EP|LP)s?\b/giu;

/** What a kept detail lost, so it lands on something else, or null: two charts' peaks on one, "her second single", a single's date as the album's */
export function lostQualifier(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  // "jazz musicians" from "jazz and pop musicians"
  for (const [, first, noun] of fact.matchAll(/\b(\p{Ll}{3,}) (?=(\p{Ll}{4,})\b)/gu)) {
    const pair = new RegExp(`\\b${escapeRe(first)} and (\\p{L}+) ${escapeRe(noun)}\\b`, "iu").exec(retold.join(" "));
    if (pair && !hasWord(pair[1], fact)) return `"${first} ${noun}", without "${pair[1]}"`;
  }
  // Another edition's: "published Orbit" from "published this version", "Orbit" for "Orbit[st]"
  const edition = /\bthis (version|edition|release|port|remake|remaster)\b/i.exec(retold.length === 1 ? retold[0] : "");
  if (edition && !hasWord(edition[1], fact)) return `doesn't say which ${edition[1].toLowerCase()}`;
  const cut = (fact.match(/\p{Lu}[\p{L}\d:'’-]+/gu) ?? []).find((w) => retold.length > 0 && retold.every((s) => s.includes(`${w}[`)));
  if (cut) return `"${cut}" cuts another edition's name short`;
  // "at number one for 13 years" from "longer than any record for 13 years"
  if (retold.length && retold.every((s) => /\bthan any\b/i.test(s)) && !/\bthan\b/i.test(fact)) return "drops what it's compared with";
  // The sentence closes a quote it never opened: someone's words, no speaker
  if (retold.length === 1 && /^[^"“]*["”](?:\s|$)/.test(retold[0]) && !/["“]/.test(fact)) return "someone's words, without who said them";
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
  // The album as subject (before the dating verb) or object ("released her debut EP on 10 May")
  const dated = /\b(album|EP|LP)\b[^.]*?\b(?:was\s+|were\s+)?(?:released|issued|came out|out)\b/i.exec(fact) ?? /\b(?:released|issued)\s+(?:[\p{L}'’-]+\s+){0,3}?(album|EP|LP)\b/iu.exec(fact);
  const day = new RegExp(`\\b(?:(${MONTHS})\\s+(\\d{1,2})|(\\d{1,2})\\s+(${MONTHS}))\\b`).exec(fact);
  // Full dates only: too many releases share a year
  if (dated && day) {
    const when = new RegExp(`\\b(?:${day[1] ?? day[4]}\\s+${day[2] ?? day[3]}|${day[2] ?? day[3]}\\s+${day[1] ?? day[4]})\\b`);
    const noun = new RegExp(`\\b${dated[1]}s?\\b`, "i");
    const withDate = sourceSentences(context).filter((s) => when.test(s) && noun.test(s));
    if (withDate.length && withDate.every((s) => !noun.test(s.replace(FROM_AN_ALBUM, "")))) return `a date the source gives another release, not the ${dated[1]}`;
  }
  return null;
}
