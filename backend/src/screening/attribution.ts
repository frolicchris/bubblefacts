import { escapeRe } from "../text";
import { hasWord, NAME, NAME_STOPWORDS, YEAR } from "./names";
import { contentTokens, plainQuotes } from "./similarity";
import { bodySentences, CONNECTIVES, hasNumber, MONTHS, NAME_RUN, numbersIn, retoldSentences, share } from "./sentences";

// Who said or did it: swapped subjects, unattributed views, misattributed words, cited doer, dropped days and years

// Doer by noun alone: "the band", "the company"
const AGENT = /^the (band|group|company|label|singer|duo|trio|orchestra|studio|developer|publisher|network|magazine|website|choir|producer|composer)\b/i;
// Name before a word of saying: "Spinwheel said", "Chen recalled"
const SPEAKER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s*,?\s+(?:who\s+)?(?:also\s+|later\s+|once\s+)?(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/gu;

// Word of saying; the first name before it (not after "with", "to", "by"...) is the speaker
const SAYS = /\b(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked)\b/;

/** "Tolland, in an interview for the BBC, stated", but not "an interview with Tolland" */
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

/** Caption's subject when the retold sentence has another: "The band had" for "The company had", a speaker only in "an interview with" */
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

/** Describer of a view told as fact ("as a compromise" for "Reyes described the cue as a compromise"), or null */
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

// In a caption: "Vela described", "Ruvo said"
const SAID_BY =
  /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|once\s+)?(?:described|said|says|stated|recalled|explained|claimed|admitted|noted|commented|remarked|revealed|insisted|joked|praised|likened|characteri[sz]ed|acknowledged|recounted)\b/u;
// Any way a source gives someone's words or view: "comments that", "defined by", "in an interview"
export const ATTRIBUTION =
  /\b(?:said|says|say|stat(?:ed|es|ing)|recall\w*|explain\w*|claim\w*|admit\w*|told|tell\w*|not(?:ed|es|ing)|comment\w*|remark\w*|reveal\w*|confirm\w*|insist\w*|jok\w*|describ\w*|call(?:ed|s|ing)|prais\w*|liken\w*|characteri[sz]\w*|acknowledg\w*|recount\w*|defin\w*|summari[sz]\w*|wr(?:ote|ites?|iting) that|interview\w*|according|quot\w*|felt|feel\w*|believ\w*|consider\w*|deem\w*|refer\w*|compar\w*|express\w*|reflect\w*|label\w*|dubb\w*|thought|argu\w*|observ\w*|asked|answer\w*|speak\w*|spoke|mention\w*|announc\w*|cit(?:ed|es|ing)|credit\w*|views?|opinion|marked by)\b|:\s*["“]/i;

// "he has acknowledged", "She said"
const PRONOUN_SAYS =
  /\b(?:he|she|they)\s+(?:has\s+|have\s+|had\s+|also\s+|later\s+|once\s+)*(?:said|says|stated|recalled|explained|claimed|admitted|told|noted|commented|remarked|revealed|confirmed|insisted|joked|described|called|praised|acknowledged|recounted|felt|believed|considered|wrote)\b/i;

/**
 * Person given words they didn't say, or null (a co-writer credit turned into "Vale described it as..."). Their
 * words must be in the retold sentence, one it draws on, or the one before (quotes run on); titles left to name checks
 */
export function misattributedWords(fact: string, context: string): string | null {
  const m = SAID_BY.exec(fact);
  if (!m) return null;
  const names = m[1].split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
  const name = names[names.length - 1];
  if (!name) return null;
  const sentences = bodySentences(context);
  // Any part of the name ("Chen" for "Chen Zhiyi"); not inside a quote, where it isn't the speaker
  const mentions = (s: string | undefined) => Boolean(s) && names.some((w) => hasWord(w, (s as string).replace(/["“][^"”]*["”]/g, "")));
  const gives = sentences.map((s, i) =>
    ATTRIBUTION.test(s) &&
    (mentions(s) ||
      // "He stated...", the name in one of the two sentences before
      (PRONOUN_SAYS.test(s) && (mentions(sentences[i - 1]) || mentions(sentences[i - 2]))) ||
      // "marked by the composer as", in an article about the composer's work
      (/\b(?:by|to) the (?:composer|songwriter|singer|artist|author|band)\b/i.test(s) && mentions(sentences[0]))));
  // A quote running on from the sentence before has no speaker of its own
  const near = (i: number) => gives[i] || (i > 0 && gives[i - 1] && !ATTRIBUTION.test(sentences[i].replace(/["“][^"”]*["”]/g, "")));
  if (!gives.some(Boolean)) return name;
  for (const q of fact.replace(/[“”]/g, '"').matchAll(/"([^"]+)"/g)) {
    const quoted = q[1].replace(/[.,!?;:]+$/, "").trim();
    // A title ("Lose My Breath"): the speaker needn't have said it
    if (!quoted || quoted.split(/\s+/).every((w) => /^(?:\p{Lu}|\d)/u.test(w) || /^(?:a|an|the|of|in|on|to|and|for|at|by|or)$/.test(w))) continue;
    const words = plainQuotes(quoted);
    const at = sentences.flatMap((s, i) => (plainQuotes(s).includes(words) ? [i] : []));
    if (!at.length || !at.some(near)) return name;
  }
  const scored = sentences.map((s, i) => ({ i, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  if (best < 0.25) return null;
  // Retold or drawn on: "a Brazilian tango by Nazareth" + "marked by the composer as a "Brazilian tango""
  const drawn = scored.filter((x) => x.share >= best - 0.1 || x.share >= 0.3).map((x) => x.i);
  return drawn.some(near) ? null : name;
}

/** Real doer when the caption opens on someone the retold sentence never names ("Dale Ortiz pitched" for "Mara Quill... pitched"), or null */
export function otherDoer(fact: string, context: string): string | null {
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s+\p{Ll})/u.exec(fact);
  // "Nadia's album": the album is the subject
  if (!lead || /['’]s?$/.test(lead[1])) return null;
  const words = lead[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
  // Full names only: one word is as often a game, band or place
  if (words.length < 2 || NAME_STOPWORDS.has(lead[1].split(/\s+/)[0].toLowerCase())) return null;
  const retold = retoldSentences(fact, context);
  if (!retold.length || retold.some((s) => words.some((w) => hasWord(w, s)))) return null;
  const subjects = retold.map((s) => {
    // Skip a leading time or place: "In 1933, Ada Pell recorded"
    const body = s.replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While)\b[^,]{0,80},\s*)+/i, "");
    const m = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})(?=\s*,|\s+\p{Ll})/u.exec(body);
    const who = (m?.[1] ?? "").split(/\s+/).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    // "Released in 2021, ...": a verb, not a name
    if (who.length === 1 && /(?:ed|ing|ly)$/.test(who[0])) return "";
    // A subject the caption also names is no one else ("Forest of Ash, the fourth album")
    return m && !/['’]s?$/.test(m[1]) && !NAME_STOPWORDS.has(m[1].split(/\s+/)[0].toLowerCase()) && !who.some((w) => hasWord(w, fact)) ? who.join(" ") : "";
  });
  return subjects.every(Boolean) ? subjects[0] : null;
}

// Before a name, makes it no doer: "with Ada Pell", "according to Pell", "feat. Pell"
const NOT_THE_DOER = /(?:\b(?:with|to|by|of|from|for|about|on|than|and|or|as|featuring|feat\.|ft\.|including|like|according to|over|against|versus|vs\.?)|['’]s?|,)\s*$/i;
// After a name, makes it no subject: "Pell and Ruiz", "Pell as an influence"
const NOT_A_VERB = /^(?:and|or|as|in|on|at|of|for|with|to|from|by|the|a|an|nor|but)$/i;

// A sentence's first word that is a verb or adverb, not a name: "Released", "Recording", "Notably"
const leadingVerb = (word: string) => /(?:ed|ing|ly)$/.test(word);

/** First person or group a sentence names ("In 1933, Paul Whiteman recorded"); not the title's work, a time or "The" */
function firstNamed(sentence: string, title: string, reference = ""): string[] {
  // "Recording and production: The band ...": a heading, not a name
  const body = sentence
    .replace(/^\p{Lu}[\p{L}'’-]*(?:\s+[\p{L}'’-]+){0,3}:\s+/u, (heading) => (SAYS.test(heading) ? heading : ""))
    .replace(/^(?:(?:In|On|By|During|After|Before|Later|From|At|When|While|Since|As|Although|Though|Because|Until|With|Without|Following|Despite)\b[^,]{0,80},\s*)+/i, "");
  for (const m of body.matchAll(NAME_RUN)) {
    const words = m[0].split(/\s+/).map((w) => w.replace(/['’]s?$|[.,:;!?]+$/g, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    if (words.every((w) => hasWord(w, title))) continue;
    // Capitalized only as first word ("Written", "Further"): a real name is capitalized mid-sentence somewhere
    if (m.index === 0 && words.length === 1 && (leadingVerb(words[0]) || !new RegExp(`(?<![.!?:]["”]?\\s*)(?<=\\S\\s+)${escapeRe(words[0])}(?![\\p{L}])`, "u").test(reference))) continue;
    return words;
  }
  return [];
}

/** Name followed by a verb, and not after "with", "to", "by" or a possessive */
function namedAsDoer(sentence: string, name: string): boolean {
  const last = name.split(/\s+/).pop() ?? name;
  for (const m of sentence.matchAll(new RegExp(`(?<![\\p{L}])${escapeRe(last)}(?![\\p{L}])`, "gu"))) {
    // From the name's start, so "with Ada Pell" is read before "Ada"
    const before = sentence.slice(0, m.index).replace(/(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*\s+)*$/u, "");
    const next = /^\s+(\p{Ll}[\p{L}-]*)/u.exec(sentence.slice((m.index ?? 0) + m[0].length));
    if (next && !NOT_A_VERB.test(next[1]) && !NOT_THE_DOER.test(before)) return true;
  }
  return false;
}

/** Why a caption doesn't match the sentence it cites (`at` in referenceSentences), or null (ARCHITECTURE.md: Screen, Cite the sentence) */
export function citedMismatch(fact: string, sentences: string[], at: number, title: string, artists: string[] = []): string | null {
  const own = sentences[at];
  if (share(fact, own) < 0.25) return "doesn't retell the sentence it cites";
  const near = [sentences[at - 2], sentences[at - 1], own, title, ...artists].filter(Boolean).join("\n");
  const unquoted = fact.replace(/["“][^"”]*["”]/g, " ");
  const names = [
    ...(unquoted.match(NAME) ?? []),
    // Single capitalized words after the first: "Mansfield", "Gioeli"
    ...[...unquoted.matchAll(/(?<=\S\s+)(?<![\p{L}'’])(?:Mc)?\p{Lu}[\p{Ll}'’-]+(?:\p{Lu}[\p{Ll}'’-]+)*/gu)].map((m) => m[0]),
  ];
  const reference = sentences.join(" ");
  for (const candidate of names) {
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    const missing = words.find((w) => !hasWord(w, near));
    // "Nobuo Uematsu" for the sentence's "Uematsu", if given in full elsewhere
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
// Days of one month: "3 and 5 June", "June 3, 4 and 5". A comma alone isn't a list: "On July 4, 10,000 fans"
const DAY_LIST = String.raw`((?:\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,\s*)*\d{1,2}(?!\d)(?:st|nd|rd|th)?\s*,?\s*(?:and|&|to|–|-)\s*\d{1,2}(?!\d)(?:st|nd|rd|th)?)`;
const DAYS_MONTH = new RegExp(`\\b${DAY_LIST}\\s+(?:of\\s+)?(${MONTHS})\\b`, "g");
const MONTH_DAYS = new RegExp(`\\b(${MONTHS})\\s+${DAY_LIST}`, "g");
const daysOf = (list: string, month: string) => (list.match(/\d{1,2}/g) ?? []).map((d) => `${month} ${Number(d)}`);
// Days a text names, as "November 22", either way round
const daysIn = (text: string) => [
  ...[...text.matchAll(MONTH_DAY)].map((m) => `${m[1]} ${Number(m[2])}`),
  ...[...text.matchAll(DAY_MONTH)].map((m) => `${m[2]} ${Number(m[1])}`),
  ...[...text.matchAll(DAYS_MONTH)].flatMap((m) => daysOf(m[1], m[2])),
  ...[...text.matchAll(MONTH_DAYS)].flatMap((m) => daysOf(m[2], m[1])),
];

/** Day or month not in the source, or null (a year check alone passed "November 22, 1994"). Months only next to a number, never "may" */
export function unsupportedDay(fact: string, context: string): string | null {
  const known = new Set(daysIn(context));
  const day = daysIn(fact).find((d) => !known.has(d));
  if (day) return day;
  return [...fact.matchAll(new RegExp(`\\b(${MONTHS})(?=,?\\s+\\d)`, "g"))].map((m) => m[1]).find((month) => !hasWord(month, context, "")) ?? null;
}

// "January 2010", "January 22, 2025", "22 January 2025"
const MONTH_YEAR = new RegExp(
  `\\b(${MONTHS})(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?(?:,|\\s+of)?\\s+(1\\d{3}|20\\d{2})\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS}),?\\s+(1\\d{3}|20\\d{2})\\b`,
  "g"
);

/** Month and year when every retold sentence gives the year but the caption drops it ("regrouped in January" reads cut off), or null */
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
