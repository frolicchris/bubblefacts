import { escapeRe } from "../text";
import { hasWord, NAME, NAME_STOPWORDS, YEAR } from "./names";
import { contentTokens, plainQuotes } from "./similarity";
import { bodySentences, CONNECTIVES, hasNumber, MONTHS, NAME_RUN, numbersIn, retoldSentences, share } from "./sentences";

/**
 * Who said or did it: swapped subjects, unattributed views, misattributed
 * words, the cited sentence's doer, and dropped days and years.
 */

/** Who a caption or a source sentence says did something, by the noun alone: "the band", "the company". */
const AGENT = /^the (band|group|company|label|singer|duo|trio|orchestra|studio|developer|publisher|network|magazine|website|choir|producer|composer)\b/i;
/** A name right before a word of saying: "Spinwheel said", "Chen recalled". */
const SPEAKER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s*,?\s+(?:who\s+)?(?:also\s+|later\s+|once\s+)?(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/gu;

/** A word of saying, after which whoever was named first (outside "with", "to", "by" ...) is the speaker. */
const SAYS = /\b(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/;

/** "Ray Tolland, in an interview for the BBC, stated": named before the word of saying, and not inside "an interview with Tolland". */
function namedAsSpeaker(sentence: string, surname: string): boolean {
  const verb = SAYS.exec(sentence);
  if (!verb) return false;
  const re = new RegExp(`(\\S+\\s+)?((?:(?:Mc)?\\p{Lu}[\\p{L}'’.-]*\\s+)*)${escapeRe(surname)}(?![\\p{L}])`, "gu");
  for (const m of sentence.slice(0, verb.index).matchAll(re)) {
    if (!/^(?:with|to|by|of|from|for|about|on|and)\s*$/i.test((m[1] ?? "").trim())) return true;
  }
  return false;
}

export const speakers = (s: string): string[] =>
  [...s.matchAll(SPEAKER)].map((m) => m[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? "").filter(Boolean);

/**
 * The statement told with someone else as its subject, which no single word
 * gives away but the sentence it retells does:
 *
 *   "The band had a top 20 downloads section" retelling "The company had ...".
 *   "Ruvo said Spinwheel made a mistake" retelling "According to an interview
 *   with Ruvo, Spinwheel said ...": the source's speaker is someone else.
 *
 * Returns the caption's subject, or null.
 */
export function swappedSubject(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const agent = AGENT.exec(fact);
  if (agent) {
    const others = retold.map((s) => AGENT.exec(s)?.[1].toLowerCase()).filter((a): a is string => Boolean(a) && a !== agent[1].toLowerCase());
    if (others.length && !retold.some((s) => hasWord(agent[1], s))) return `the ${agent[1].toLowerCase()}`;
  }
  const factSpeakers = [...speakers(fact), ...[SAID_BY.exec(fact)?.[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? ""].filter(Boolean)];
  for (const said of new Set(factSpeakers)) {
    const theirs = retold.flatMap(speakers);
    const own = retold.some((s) => theirs.some((t) => t.toLowerCase() === said.toLowerCase()) || namedAsSpeaker(s, said) || new RegExp(`according to ${escapeRe(said)}\\b`, "i").test(s) || new RegExp(`\\b${escapeRe(said)}['’]s?\\s+(?:words|account|interview)`, "i").test(s));
    if (theirs.length && !own) return said;
  }
  return null;
}

/**
 * Someone's reading of the music told as fact: "A theme was written for the
 * villains as a compromise between X and Y" retelling "Music author Dana
 * Reyes described the cue as a compromise between X and Y". The caption takes
 * a word only from a sentence where someone describes the music, and names
 * neither the describer nor the describing. Returns the describer, or null.
 */
export function unattributedView(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  for (const s of retold) {
    const by = /((?:Mc)?\p{Lu}[\p{L}'’.-]*)\s+(?:described|called|deemed|likened|characterized|characterised|considered)\b/u.exec(s);
    if (!by || NAME_STOPWORDS.has(by[1].toLowerCase()) || hasWord(by[1], fact) || /\b(describ|call|deem|liken|characteri[sz]|consider)\w*/i.test(fact)) continue;
    const others = retold.filter((o) => o !== s).map(contentTokens);
    const own = contentTokens(s);
    const only = [...contentTokens(fact)].filter((t) => own.has(t) && !others.some((o) => o.has(t)));
    if (only.length && others.length) return by[1];
  }
  return null;
}

/** A name right before a word of saying in a caption: "Vela described", "Ruvo said", "Okafor recalled". */
const SAID_BY =
  /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|once\s+)?(?:described|said|says|stated|recalled|explained|claimed|admitted|noted|commented|remarked|revealed|insisted|joked|praised|likened|characteri[sz]ed|acknowledged|recounted)\b/u;
/** Any word a source uses to give someone's words or view: "comments that", "defined by", "according to", "in an interview". */
export const ATTRIBUTION =
  /\b(?:said|says|say|stat(?:ed|es|ing)|recall\w*|explain\w*|claim\w*|admit\w*|told|tell\w*|not(?:ed|es|ing)|comment\w*|remark\w*|reveal\w*|confirm\w*|insist\w*|jok\w*|describ\w*|call(?:ed|s|ing)|prais\w*|liken\w*|characteri[sz]\w*|acknowledg\w*|recount\w*|defin\w*|summari[sz]\w*|wr(?:ote|ites?|iting) that|interview\w*|according|quot\w*|felt|feel\w*|believ\w*|consider\w*|deem\w*|refer\w*|compar\w*|express\w*|reflect\w*|label\w*|dubb\w*|thought|argu\w*|observ\w*|asked|answer\w*|speak\w*|spoke|mention\w*|announc\w*|cit(?:ed|es|ing)|credit\w*|views?|opinion|marked by)\b|:\s*["“]/i;

/** "he has acknowledged", "She said": a pronoun giving its own words. */
const PRONOUN_SAYS =
  /\b(?:he|she|they)\s+(?:has\s+|have\s+|had\s+|also\s+|later\s+|once\s+)*(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked|described|called|praised|acknowledged|recounted|felt|believed|considered|wrote)\b/i;

/**
 * Words put in someone's mouth. A small model turns a credit into a quote:
 * "Dana Vale described the song as a 'very tender' ballad" when the source
 * only lists Vale as a co-writer, or "Ruvo described the mistake" when Ruvo
 * only gave the interview. A caption saying someone said, described or
 * recalled something needs:
 *
 *   - a source sentence giving that person's words or view at all;
 *   - the person's words in the sentence it retells or another it draws on,
 *     or the one before (a quote often runs on from its attribution);
 *   - every quoted word in the source, in a sentence that gives that person's
 *     words (a quoted title is left to the name checks).
 *
 * Returns the person, or null.
 */
export function misattributedWords(fact: string, context: string): string | null {
  const m = SAID_BY.exec(fact);
  if (!m) return null;
  const names = m[1].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
  const name = names[names.length - 1];
  if (!name) return null;
  const sentences = bodySentences(context);
  // "Chen" or "Zhiyi" for "Chen Zhiyi": a source often uses one part of a name.
  // Outside quotation marks: a name inside someone's quote isn't the one speaking.
  const mentions = (s: string | undefined) => Boolean(s) && names.some((w) => hasWord(w, (s as string).replace(/["“][^"”]*["”]/g, "")));
  const gives = sentences.map((s, i) =>
    ATTRIBUTION.test(s) &&
    (mentions(s) ||
      // "He stated he would retire", with the name in the sentence or two before.
      (PRONOUN_SAYS.test(s) && (mentions(sentences[i - 1]) || mentions(sentences[i - 2]))) ||
      // "marked by the composer as", in the article about the composer's work.
      (/\b(?:by|to) the (?:composer|songwriter|singer|artist|author|band)\b/i.test(s) && mentions(sentences[0]))));
  // A quote running on from the sentence before has no speaker of its own.
  const near = (i: number) => gives[i] || (i > 0 && gives[i - 1] && !ATTRIBUTION.test(sentences[i].replace(/["“][^"”]*["”]/g, "")));
  if (!gives.some(Boolean)) return name;
  for (const q of fact.replace(/[“”]/g, '"').matchAll(/"([^"]+)"/g)) {
    const quoted = q[1].replace(/[.,!?;:]+$/, "").trim();
    // "Lose My Breath": a title, which the speaker needn't have said.
    if (!quoted || quoted.split(/\s+/).every((w) => /^(?:\p{Lu}|\d)/u.test(w) || /^(?:a|an|the|of|in|on|to|and|for|at|by|or)$/.test(w))) continue;
    const words = plainQuotes(quoted);
    const at = sentences.flatMap((s, i) => (plainQuotes(s).includes(words) ? [i] : []));
    if (!at.length || !at.some(near)) return name;
  }
  const scored = sentences.map((s, i) => ({ i, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  if (best < 0.25) return null;
  // The sentence it retells, or another it draws on: "is a Brazilian tango by Nazareth" and "marked by the composer as a "Brazilian tango"".
  const drawn = scored.filter((x) => x.share >= best - 0.1 || x.share >= 0.3).map((x) => x.i);
  return drawn.some(near) ? null : name;
}

/**
 * A caption opening on a person the sentence it retells gives to someone
 * else: "Dale Ortiz pitched the story in 2003" retelling "Mara Quill, the
 * effects supervisor, pitched the story in 2003". The retold sentence never
 * names the caption's person and opens on another name. Returns that name, or null.
 */
export function otherDoer(fact: string, context: string): string | null {
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s+\p{Ll})/u.exec(fact);
  // "Nadia's album": the subject is the album, not Nadia.
  if (!lead || /['’]s?$/.test(lead[1])) return null;
  const words = lead[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
  // A full name: a single word is as often a game, a band or a place.
  if (words.length < 2 || NAME_STOPWORDS.has(lead[1].split(/\s+/)[0].toLowerCase())) return null;
  const retold = retoldSentences(fact, context);
  if (!retold.length || retold.some((s) => words.some((w) => hasWord(w, s)))) return null;
  const subjects = retold.map((s) => {
    // "In 1933, Ada Pell recorded": a time or place first is not the subject.
    const body = s.replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While)\b[^,]{0,80},\s*)+/i, "");
    const m = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s*,|\s+\p{Ll})/u.exec(body);
    const who = (m?.[1] ?? "").split(/\s+/).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    // "Released in 2021, ...": a verb, not a name.
    if (who.length === 1 && /(?:ed|ing|ly)$/.test(who[0])) return "";
    // "Forest of Ash, the fourth album, ...": a subject the caption also names is no one else.
    return m && !/['’]s?$/.test(m[1]) && !NAME_STOPWORDS.has(m[1].split(/\s+/)[0].toLowerCase()) && !who.some((w) => hasWord(w, fact)) ? who.join(" ") : "";
  });
  return subjects.every(Boolean) ? subjects[0] : null;
}

/** Words before a name that make it not the one doing anything: "with Ada Pell", "according to Pell", "feat. Pell". */
const NOT_THE_DOER = /(?:\b(?:with|to|by|of|from|for|about|on|than|and|or|as|featuring|feat\.|ft\.|including|like|according to|over|against|versus|vs\.?)|['’]s?|,)\s*$/i;
/** Small words after a name that make it no subject: "Pell and Ruiz", "Pell as an influence". */
const NOT_A_VERB = /^(?:and|or|as|in|on|at|of|for|with|to|from|by|the|a|an|nor|but)$/i;

/** A single capitalized word at the start of a sentence that is a verb or an adverb, not a name: "Released", "Recording", "Notably". */
const leadingVerb = (word: string) => /(?:ed|ing|ly)$/.test(word);

/**
 * The first person or group a sentence names, as the words of the name: "In
 * 1933, Paul Whiteman recorded" gives Paul Whiteman. Not the work it is about
 * (words of the reference's title), and not a time, a place word or "The".
 */
function firstNamed(sentence: string, title: string, reference = ""): string[] {
  // "Recording and production: The band ...": a section's heading, not a name.
  const body = sentence
    .replace(/^\p{Lu}[\p{L}'’-]*(?:\s+[\p{L}'’-]+){0,3}:\s+/u, (heading) => (SAYS.test(heading) ? heading : ""))
    .replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While|Since|As|Although|Though|Because|Until|With|Without|Following|Despite)\b[^,]{0,80},\s*)+/i, "");
  for (const m of body.matchAll(NAME_RUN)) {
    const words = m[0].split(/\s+/).map((w) => w.replace(/['’]s?$|[.,:;!?]+$/g, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    if (words.every((w) => hasWord(w, title))) continue;
    // "Written in 1909, ...", "Further, ...": a word capitalized only because it starts the sentence.
    // A name is capitalized in the middle of a sentence somewhere too.
    if (m.index === 0 && words.length === 1 && (leadingVerb(words[0]) || !new RegExp(`(?<![.!?:]["”]?\\s*)(?<=\\S\\s+)${escapeRe(words[0])}(?![\\p{L}])`, "u").test(reference))) continue;
    return words;
  }
  return [];
}

/** Whether a sentence has the name as one doing something: followed by a verb, and not after "with", "to", "by" or a possessive. */
function namedAsDoer(sentence: string, name: string): boolean {
  const last = name.split(/\s+/).pop() ?? name;
  for (const m of sentence.matchAll(new RegExp(`(?<![\\p{L}])${escapeRe(last)}(?![\\p{L}])`, "gu"))) {
    // Back to the start of the name, so "with Ada Pell" is read before "Ada".
    const before = sentence.slice(0, m.index).replace(/(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*\s+)*$/u, "");
    const next = /^\s+(\p{Ll}[\p{L}-]*)/u.exec(sentence.slice((m.index ?? 0) + m[0].length));
    if (next && !NOT_A_VERB.test(next[1]) && !NOT_THE_DOER.test(before)) return true;
  }
  return false;
}

/**
 * A caption checked against the one sentence it cites (`numberedReference`):
 *
 *   names    every name in it is in that sentence, the two before it (a
 *            "he" there names someone earlier), the reference's title or the
 *            request's artist (for "the band");
 *   numbers  every count is in that sentence, and every year in it or the one
 *            before or after;
 *   first    "first" only when that sentence has a word of firsts;
 *   words    someone "said", "recalled" or "described" only when that sentence
 *            (or the one before) gives that person's words;
 *   doer     a caption opening on a person other than the one the sentence
 *            names first is dropped, unless the sentence has that person doing
 *            something too, or the caption has the first one doing it ("Gioeli,
 *            who was paid $3,000, said he followed Senoue's demos" is no fee
 *            for Senoue);
 *   overlap  the caption shares at least a quarter of its words with it.
 *
 * `sentences` are `referenceSentences(context)` and `at` the cited one's index.
 * Returns why it doesn't match, or null.
 */
export function citedMismatch(fact: string, sentences: string[], at: number, title: string, artists: string[] = []): string | null {
  const own = sentences[at];
  if (share(fact, own) < 0.25) return "doesn't retell the sentence it cites";
  const near = [sentences[at - 2], sentences[at - 1], own, title, ...artists].filter(Boolean).join("\n");
  const unquoted = fact.replace(/["“][^"”]*["”]/g, " ");
  const names = [
    ...(unquoted.match(NAME) ?? []),
    // A single capitalized word after the first: "Mansfield", "Gioeli".
    ...[...unquoted.matchAll(/(?<=\S\s+)(?<![\p{L}'’])(?:Mc)?\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*/gu)].map((m) => m[0]),
  ];
  const reference = sentences.join(" ");
  for (const candidate of names) {
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    const missing = words.find((w) => !hasWord(w, near));
    // "Nobuo Uematsu" for a sentence's "Uematsu", when the reference gives him in full elsewhere.
    const fullElsewhere = words.length > 1 && hasWord(words[words.length - 1], near) && hasWord(words.join(" "), reference);
    if (missing && !fullElsewhere) return `"${missing}" isn't in the sentence it cites`;
  }
  const number = numbersIn(fact).find((n) => !hasNumber(n, own));
  if (number) return `"${number}" isn't in the sentence it cites`;
  const year = (fact.match(YEAR) ?? []).find((y) => ![sentences[at - 1], own, sentences[at + 1]].some((s) => s && hasWord(y, s)));
  if (year) return `${year} isn't in the sentence it cites`;
  const first = CONNECTIVES.find((c) => c.label === "a first" && c.fact.source === "\\bfirst\\b");
  if (first && first.fact.test(fact) && !first.source.test(own)) return `"first" isn't in the sentence it cites`;
  const said = SAID_BY.exec(fact);
  if (said) {
    const who = said[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).pop() ?? "";
    const gives = (s: string | undefined) => Boolean(s) && ATTRIBUTION.test(s as string) && (hasWord(who, s as string) || PRONOUN_SAYS.test(s as string));
    if (who && !(gives(own) && [own, sentences[at - 1]].some((s) => s && hasWord(who, s)))) return `the sentence it cites doesn't give ${who}'s words`;
  }
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s+\p{Ll})/u.exec(fact);
  if (lead && !/['’]s?$/.test(lead[1])) {
    const words = lead[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    const agent = firstNamed(own, title, sentences.join(" "));
    const isWork = words.every((w) => hasWord(w, title));
    if (words.length && !isWork && agent.length && !namedAsDoer(fact, agent.join(" ")) && !namedAsDoer(own, words.join(" "))) return `the sentence it cites is about ${agent.join(" ")}`;
  }
  return null;
}

const MONTH_DAY = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b`, "g");
/** The days a text names, as "November 22", whichever way round it writes them. */
/** Several days of one month: "3 and 5 June", "June 3, 4 and 5". A comma alone isn't a list: "On July 4, 10,000 fans". */
const DAY_LIST = String.raw`((?:\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,\s*)*\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,?\s*(?:and|&|to|–|-)\s*\d{1,2}(?!\d)(?:st|nd|rd|th)?)`;
const DAYS_MONTH = new RegExp(`\\b${DAY_LIST}\\s+(?:of\\s+)?(${MONTHS})\\b`, "g");
const MONTH_DAYS = new RegExp(`\\b(${MONTHS})\\s+${DAY_LIST}`, "g");
const daysOf = (list: string, month: string) => (list.match(/\d{1,2}/g) ?? []).map((d) => `${month} ${Number(d)}`);
const daysIn = (text: string) => [
  ...[...text.matchAll(MONTH_DAY)].map((m) => `${m[1]} ${Number(m[2])}`),
  ...[...text.matchAll(DAY_MONTH)].map((m) => `${m[2]} ${Number(m[1])}`),
  ...[...text.matchAll(DAYS_MONTH)].flatMap((m) => daysOf(m[1], m[2])),
  ...[...text.matchAll(MONTH_DAYS)].flatMap((m) => daysOf(m[2], m[1])),
];

/**
 * A day or month the source doesn't give: years are checked on their own, so
 * "released on November 22, 1994" passed whenever 1994 was in the source.
 * A month counts only next to a number ("May 1990"), never the word "may".
 * Returns the date, or null.
 */
export function unsupportedDay(fact: string, context: string): string | null {
  const known = new Set(daysIn(context));
  const day = daysIn(fact).find((d) => !known.has(d));
  if (day) return day;
  return [...fact.matchAll(new RegExp(`\\b(${MONTHS})(?=,?\\s+\\d)`, "g"))].map((m) => m[1]).find((month) => !hasWord(month, context, "")) ?? null;
}

/** A month with its year, as a text writes it: "January 2010", "January 22, 2025", "22 January 2025". */
const MONTH_YEAR = new RegExp(
  `\\b(${MONTHS})(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,|\\s+of)?\\s+(1\\d{3}|20\\d{2})\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS}),?\\s+(1\\d{3}|20\\d{2})\\b`,
  "g"
);

/**
 * A month told without the year the source gives it with: "In January 2010, the
 * duo regrouped" retold as "The duo regrouped in January", which reads as cut off.
 * The month must come with a year in every retold sentence that has it, and the
 * caption must give no such year. A month the source gives alone is left alone.
 * Returns the month and its year, or null.
 */
export function droppedYear(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  const given = [...fact.matchAll(MONTH_YEAR)];
  const factYears: string[] = fact.match(YEAR) ?? [];
  for (const month of new Set([...fact.matchAll(new RegExp(`\\b(${MONTHS})\\b`, "g"))].map((m) => m[1]))) {
    if (given.some((m) => (m[1] ?? m[3]) === month)) continue;
    const holders = retold.filter((s) => new RegExp(`\\b${month}\\b`).test(s));
    const years = holders.flatMap((s) => [...s.matchAll(MONTH_YEAR)].filter((m) => (m[1] ?? m[3]) === month).map((m) => m[2] ?? m[4]));
    if (!holders.length || !holders.every((s) => [...s.matchAll(MONTH_YEAR)].some((m) => (m[1] ?? m[3]) === month))) continue;
    if (years.some((y) => factYears.includes(y))) continue;
    return `${month} ${years[0]}`;
  }
  return null;
}
