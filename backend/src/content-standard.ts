import { escapeRe } from "./text";

/**
 * The content standard: "About the music. Safe for any stream." (issue #242)
 *
 * A bubble never says what a polite chatter couldn't post in a
 * family-friendly music stream. Twitch holds streamers responsible for
 * everything on their stream, and YouTube and Kick have the same rules, so
 * an article's sentences about crime, lawsuits, drugs, sex, private
 * relationships, health and how someone died never reach the model, and a
 * caption or data fact that still says such a thing is dropped.
 *
 * Word lists only: whole words or phrases, any case. No AI decides what is
 * safe, and nothing asks the streamer to check.
 */

/** One list: the platform rules it maps to, and its words and phrases. */
interface TopicList {
  label: string;
  words: string[];
}

const LISTS: TopicList[] = [
  {
    // Twitch Harassment (unproven accusations about identifiable people), YouTube
    // harassment of identifiable people, Kick harassment and false claims.
    // "Charged" retold as "convicted" can't reach a caption: neither word does.
    label: "crime or lawsuits",
    words: [
      "arrest", "arrests", "arrested", "arresting", "charged with", "criminal charge", "criminal charges",
      "charges against", "indicted", "indictment", "convicted", "conviction", "convictions", "sentenced",
      "prison", "imprisoned", "imprisonment", "jail", "jailed", "incarcerated", "probation", "parole",
      "pleaded guilty", "pleaded not guilty", "pled guilty", "found guilty", "acquitted", "lawsuit",
      "lawsuits", "sued", "suing", "litigation", "plaintiff", "plaintiffs", "defendant", "defendants",
      "court case", "in court", "out of court", "allegation", "allegations", "accused", "accusation",
      "accusations", "crime", "crimes", "criminal", "felony", "misdemeanor", "misdemeanour", "fraud",
      "theft", "robbery", "burglary", "assaulted", "homicide", "murder", "murdered", "murders",
      "manslaughter", "extortion", "embezzlement", "domestic violence", "restraining order",
      "drunk driving", "DUI", "plagiarism", "plagiarized", "plagiarised", "copyright infringement",
      "infringement", "infringed", "scandal", "scandals", "controversy", "controversies", "feud", "feuds",
    ],
  },
  {
    // Twitch Self-Destructive Behavior and its drugs and intoxication content
    // label, YouTube harmful or dangerous content, Kick illegal and regulated goods.
    label: "drugs or addiction",
    words: [
      "drug", "drugs", "narcotic", "narcotics", "heroin", "cocaine", "methamphetamine", "amphetamine",
      "amphetamines", "marijuana", "cannabis", "opioid", "opioids", "opiate", "opiates", "fentanyl", "LSD",
      "overdose", "overdosed", "overdoses", "addiction", "addictions", "addicted", "addict", "addicts",
      "alcoholism", "alcoholic", "alcoholics", "rehab", "substance abuse", "sobriety", "sober",
      "intoxicated", "drunk", "drunken", "hallucinogen", "hallucinogens", "hallucinogenic",
    ],
  },
  {
    // Twitch Sexual Content, YouTube nudity and sexual content, Kick sexual
    // content. No exceptions.
    label: "sexual content",
    words: [
      "sex", "sexual", "sexually", "sexuality", "nude", "nudity", "naked", "porn", "porno", "pornography",
      "pornographic", "erotic", "erotica", "orgasm", "prostitute", "prostitutes", "prostitution", "rape",
      "raped", "rapist", "molest", "molested", "molestation", "incest", "pedophile", "pedophilia",
      "paedophile", "child abuse", "masturbation", "masturbate", "intercourse", "stripper", "strip club",
      "brothel", "fetish", "lewd", "obscene", "obscenity", "adultery", "adulterous",
    ],
  },
  {
    // Twitch Harassment and its ban on sharing private information, Kick
    // privacy rules, and chat etiquette: no gossip about anyone's private life.
    label: "private life",
    words: [
      "married", "remarried", "divorce", "divorced", "divorces", "divorcing", "spouse", "spouses", "wife",
      "wives", "husband", "husbands", "ex-wife", "ex-husband", "widow", "widower", "girlfriend",
      "girlfriends", "boyfriend", "boyfriends", "fiancée", "fiancee", "fiancé", "fiance", "engaged to",
      "began dating", "started dating", "was dating", "were dating", "been dating", "romantic relationship",
      "romantically", "love affair", "affair with", "extramarital",
      "infidelity", "pregnant", "pregnancy", "gave birth", "miscarriage", "custody", "estranged",
      "came out as", "his son", "her son", "their son", "his sons", "her sons", "their sons",
      "his daughter", "her daughter", "their daughter", "his daughters", "her daughters",
      "their daughters", "his child", "her child", "their child", "his children", "her children",
      "their children",
    ],
  },
  {
    // Twitch Self-Destructive Behavior, YouTube self-harm and medical content,
    // and chat etiquette: someone's health is their own business.
    label: "health",
    words: [
      "cancer", "tumor", "tumour", "leukemia", "leukaemia", "lymphoma", "diagnosed", "diagnosis",
      "illness", "illnesses", "ill health", "terminally", "disease", "diseases", "heart attack",
      "heart failure", "cardiac arrest", "suffered a stroke", "had a stroke", "surgery", "surgeries",
      "hospitalized", "hospitalised", "hospitalization", "hospitalisation", "in hospital", "mental health",
      "mental illness", "clinical depression", "suffered from depression", "struggled with depression",
      "nervous breakdown", "bipolar", "schizophrenia", "eating disorder", "anorexia", "bulimia", "HIV",
      "dementia", "Alzheimer", "seizure", "seizures", "epilepsy", "epileptic", "coma", "injured", "injury",
      "injuries", "paralyzed", "paralysed", "chemotherapy", "transplant", "self-harm", "panic attacks",
    ],
  },
  {
    // Twitch's ban on exploiting tragedy and deaths, and chat etiquette: no
    // surprises about how someone died. "Died in 2004", a plain year, stays.
    label: "how someone died",
    words: [
      "died of", "died from", "died after", "died following", "died as a result", "died in a",
      "died in an", "died while", "died by", "death by", "cause of death", "causes of death", "killed in",
      "was killed", "were killed", "killed himself", "killed herself", "suicide", "suicidal",
      "took his own life", "took her own life", "took their own life", "fatal", "fatally", "car crash",
      "plane crash", "car accident", "traffic accident", "funeral", "autopsy", "coroner", "shot dead",
      "found dead", "gunshot", "drowned", "stabbed", "strangled", "death of his", "death of her",
      "death of their",
    ],
  },
];

/** A list's words as one pattern: whole words, any case, any spacing inside a phrase. */
const compiled = LISTS.map(({ label, words }) => ({
  label,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
    "giu"
  ),
}));

/**
 * Section headings whose whole section is left out, subsections and all:
 * "Personal life", "Legal issues", "Controversies", "Health". Same rules as
 * the lists above.
 */
const PRIVATE_HEADING =
  /(?<![\p{L}])(?:personal (?:life|history|relationships?|matters|issues|problems)|private life|family|relationships?|marriages?|legal|lawsuits?|litigation|court cases?|arrests?|criminal|crimes?|controvers(?:y|ies)|allegations?|accusations?|scandals?|health|illness(?:es)?|addiction|substance abuse|drug use|sexual|abuse)(?![\p{L}])/iu;
/**
 * A heading about someone's death is made only of these words: "Death",
 * "Illness and death", "Death and legacy". "Death Mountain" and "Death Egg"
 * are places in games, and stay.
 */
const DEATH_HEADING_WORDS = new Set([
  "death", "deaths", "illness", "later", "last", "final", "life", "years", "and", "legacy", "funeral",
  "aftermath", "tributes", "burial", "his", "her", "their", "the", "early", "posthumous", "memorial",
  "memorials", "of",
]);

export function isPrivateHeading(heading: string): boolean {
  if (PRIVATE_HEADING.test(heading)) return true;
  const words = heading.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.some((w) => w === "death" || w === "deaths") && words.every((w) => DEATH_HEADING_WORDS.has(w))) return true;
  return breach(heading) !== null;
}

const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
const QUOTES = new Set(['"', "“", "”", "'", "‘", "’", "«", "»"]);

/** The word before `at` in `text` (skipping spaces), or "". */
function wordBefore(text: string, at: number): string {
  let end = at;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let start = end;
  while (start > 0 && /[\p{L}\p{N}'’.-]/u.test(text[start - 1])) start--;
  return text.slice(start, end);
}

/** The word after `at` in `text` (skipping spaces), or "". */
function wordAfter(text: string, at: number): string {
  let start = at;
  while (start < text.length && /\s/.test(text[start])) start++;
  let end = start;
  while (end < text.length && /[\p{L}\p{N}'’-]/u.test(text[end])) end++;
  return text.slice(start, end);
}

/**
 * A capitalized match that is part of a name or a title, not the word itself:
 * "Smooth Criminal", "Sex Pistols", "the Great Depression", "Death Egg", a
 * quoted "Cocaine". An all-capitals word ("LSD", "HIV") is the word itself.
 */
function inAName(text: string, index: number, match: string): boolean {
  if (!isUpper(match[0]) || match === match.toUpperCase()) return false;
  const before = text[index - 1];
  if (before && QUOTES.has(before)) return true;
  if (isUpper(wordAfter(text, index + match.length)[0])) return true;
  const prev = wordBefore(text, index);
  return isUpper(prev[0]) && !/[.!?]$/.test(prev);
}

/** Which list a text breaks, or null. `names` (titles, the artist) are read as names, not words. */
function breach(text: string, names: string[] = []): string | null {
  let plain = text;
  for (const name of names) {
    if (name.trim().length < 2) continue;
    plain = plain.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, "giu"), (m) => "x".repeat(m.length));
  }
  for (const { label, re } of compiled) {
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) {
      if (!inAName(plain, m.index ?? 0, m[0])) return label;
    }
  }
  return null;
}

/**
 * Why a caption or a data fact can't be shown under the content standard, or
 * null when it can. `names`: the song's and the article's titles and the
 * artist, which are names wherever their words appear ("Smooth Criminal").
 */
export function standardBreach(text: string, names: string[] = []): string | null {
  const label = breach(text, names);
  return label ? `content standard: ${label}` : null;
}

/** A reason `standardBreach` gave: its caption is logged without its text, so logs can't spread it. */
export const isStandardReason = (reason: string): boolean => reason.startsWith("content standard:");

/** Sentences of one paragraph. A capital letter and a period ("J. S. Bach") don't end one. */
export function sentencesOf(paragraph: string): string[] {
  return paragraph.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”’)]?)\s+/u).filter((s) => s.trim());
}

/** A section heading line ("== Personal life =="): its level and words, or null. No regex, so no backtracking. */
function headingOf(line: string): { level: number; heading: string } | null {
  const t = line.trim();
  if (!t.startsWith("==") || !t.endsWith("==") || t.length < 5) return null;
  let level = 0;
  while (t[level] === "=") level++;
  let end = t.length;
  while (end > level && t[end - 1] === "=") end--;
  const heading = t.slice(level, end).trim();
  return heading ? { level, heading } : null;
}

export interface StandardText {
  text: string;
  /** Sentences in the article, and how many were left out (in left-out sections too). */
  sentences: number;
  dropped: number;
  /** Sections left out whole. */
  sections: number;
}

/**
 * An article as the model may read it: private sections left out whole, and
 * every other sentence that breaks the standard. `page`: the article's
 * title, read as a name ("Smooth Criminal" stays in its own article).
 */
export function withinStandard(full: string, page = ""): StandardText {
  // "Bad Habit (song)" is "Bad Habit" in its own text.
  const open = page.endsWith(")") ? page.lastIndexOf(" (") : -1;
  const title = (open > 0 ? page.slice(0, open) : page).trim();
  const names = title ? [title] : [];
  const out: string[] = [];
  let sentences = 0;
  let dropped = 0;
  let sections = 0;
  let skipBelow = 0;
  for (const line of full.split("\n")) {
    const head = headingOf(line);
    if (head) {
      if (skipBelow && head.level > skipBelow) continue;
      skipBelow = 0;
      if (isPrivateHeading(head.heading)) {
        skipBelow = head.level;
        sections++;
        continue;
      }
      out.push(line);
      continue;
    }
    const parts = sentencesOf(line);
    sentences += parts.length;
    if (skipBelow) {
      dropped += parts.length;
      continue;
    }
    const kept = parts.filter((s) => breach(s, names) === null);
    dropped += parts.length - kept.length;
    if (kept.length || !line.trim()) out.push(kept.length === parts.length ? line : kept.join(" "));
  }
  return { text: out.join("\n").trimEnd(), sentences, dropped, sections };
}
