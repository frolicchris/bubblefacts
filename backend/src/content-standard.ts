import { escapeRe } from "./text";

// The content standard (#242): "About the music. Safe for any stream."
// Word lists only, whole words or phrases, any case: no AI decides, nothing asks the streamer to check
// (ARCHITECTURE.md: The content standard)

// One topic: its label, and its words and phrases
interface TopicList {
  label: string;
  words: string[];
}

const LISTS: TopicList[] = [
  {
    // Twitch Harassment (unproven accusations about real people), YouTube harassment,
    // Kick harassment and false claims
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
      // Not bare "controversy": often a band's name or a soundtrack's reception (the section still goes)
      "infringement", "infringed", "scandal", "scandals", "feud", "feuds",
    ],
  },
  {
    // Twitch Harassment and Violent Threats, YouTube threats and harassment, Kick harassment.
    // "A threatening bass line" goes too: a miss is worse
    label: "threats or stalking",
    words: [
      "threat", "threats", "threaten", "threatens", "threatened", "threatening", "death threat",
      "death threats", "stalker", "stalkers", "stalking", "stalked",
    ],
  },
  {
    // Twitch Self-Destructive Behavior (drugs and intoxication label), YouTube harmful
    // or dangerous content, Kick illegal and regulated goods
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
    // Twitch Sexual Content, YouTube nudity and sexual content, Kick sexual content; no exceptions
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
    // Twitch Harassment (no sharing private information), Kick privacy rules, chat etiquette: no gossip
    label: "private life",
    words: [
      // Not a bare spouse ("with his wife Anne, he set the poem to music"): often how the music was made.
      // Not bare "divorced": "divorced from the film, the score still works"
      "married", "remarried", "divorce", "divorces", "divorcing", "divorced in", "divorced his", "divorced her",
      "was divorced", "were divorced", "got divorced", "and divorced", "later divorced", "they divorced",
      "couple divorced", "separated from his wife",
      "separated from her husband", "separating from his wife", "separating from her husband", "his late wife",
      "her late husband", "ex-wife", "ex-husband", "widow", "widower", "girlfriend",
      "girlfriends", "boyfriend", "boyfriends", "fiancée", "fiancee", "fiancé", "fiance", "engaged to",
      "began dating", "started dating", "was dating", "were dating", "been dating", "romantic relationship",
      "romantically", "love affair", "affair with", "extramarital",
      "infidelity", "pregnant", "pregnancy", "gave birth", "miscarriage", "custody", "estranged",
      "came out as gay", "came out as lesbian", "came out as bisexual", "came out as transgender",
      "came out as trans", "came out as queer", "came out as non-binary", "came out as nonbinary",
      "his son", "her son", "their son", "his sons", "her sons", "their sons", "his daughter", "her daughter", "their daughter", "his daughters", "her daughters",
      "their daughters", "his child", "her child", "their child", "his children", "her children",
      "their children",
    ],
  },
  {
    // Twitch Self-Destructive Behavior, YouTube self-harm and medical content, chat etiquette: health is private
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
    // Twitch's ban on exploiting tragedy and deaths, chat etiquette. A plain "died in 2004" stays
    label: "how someone died",
    words: [
      "died of", "died from", "died after", "died following", "died as a result", "died in a",
      "died in an", "died while", "died by", "death by", "cause of death", "causes of death", "killed in",
      "was killed", "were killed", "killed himself", "killed herself", "suicide", "suicidal",
      "took his own life", "took her own life", "took their own life", "fatal", "fatally", "car crash",
      "plane crash", "car accident", "traffic accident", "autopsy", "coroner", "shot dead",
      "found dead", "gunshot", "drowned", "stabbed", "strangled", "death of his", "death of her",
      "death of their",
    ],
  },
  {
    // Chat etiquette: a bubble celebrates the music, so a failure isn't trivia.
    // Bare "panned" is a sound moving left or right; "mixed reviews" stays
    label: "put-downs",
    words: [
      "failed to chart", "failed to make the", "failed to make it", "failed to make any", "failed to reach",
      "failed to enter", "failed to crack", "failed to break", "failed to sell", "failed to gain",
      "failing to chart", "failing to reach", "failing to make", "failure to chart", "did not chart",
      "didn't chart", "never charted", "did not make the", "didn't make the", "did not reach",
      "didn't reach", "missed the Hot 100", "missed the Billboard", "missed the charts", "missed the Top",
      "commercial failure", "commercial flop", "commercial disappointment", "commercially unsuccessful",
      "critical failure", "box office bomb", "box-office bomb", "flop", "flops", "flopped", "bombed",
      "poorly received", "poorly reviewed", "poor reviews", "bad reviews", "negative reviews", "scathing",
      "panned by", "critics panned", "critically panned", "widely panned", "universally panned", "was panned",
      "were panned", "sold poorly", "poor sales", "disappointing sales", "low sales", "underperformed",
      "least successful", "lowest-charting", "lowest charting", "worst album", "worst albums", "worst song",
      "worst songs", "worst single", "worst singles", "Razzie", "Razzies",
    ],
  },
  {
    // #262: never who a person is. Twitch Hateful Conduct (race, ethnicity, national origin, religion,
    // sexual orientation, gender identity), YouTube hate speech, Kick community guidelines.
    // Only the person can say who they are; an article's word for it is someone else's.
    // Category words only: a people's name is also a song, a game's tribe or a band, and no list is complete
    label: "identity",
    words: [
      // Ethnicity, ancestry, Indigenous nations ("of ... descent" and the like: identityPhrases)
      "ethnic", "ethnicity", "ethnicities", "ethnically", "heritage", "ancestry", "Indigenous", "Aboriginal",
      "First Nation", "First Nations", "Métis", "Metis", "Inuit", "Inuk", "Native American", "Native Americans",
      "Native Hawaiian", "Alaska Native", "Torres Strait Islander", "tribe", "tribes", "tribal", "Latino", "Latina",
      "Latinos", "Latinas", "Latinx", "Hispanic", "Chicano", "Chicana", "Afro-Latino", "Afro-Latina",
      "Afro-Caribbean",
      // Race: phrases only, since bare "race" is racing and "black", "white" are colors and albums
      "racial", "racially", "biracial", "multiracial", "mixed-race", "mixed race", "people of color",
      "person of color", "woman of color", "women of color", "artists of color", "musicians of color",
      "Black woman", "Black women", "Black man", "Black men", "Black people", "Black person", "Black artist",
      "Black artists", "Black musician", "Black musicians", "Black singer", "Black singers", "Black composer",
      "Black composers", "Black community", "Black Americans", "white woman", "white women", "white man",
      "white men", "white people", "white musicians", "white artists",
      // Religion
      "religion", "religions", "religious", "devout", "atheist", "atheists", "atheism", "agnostic",
      "born-again", "evangelical", "converted to", "Christian", "Christians", "Christianity", "Muslim",
      "Muslims", "Islam", "Islamic", "Jewish", "Jew", "Jews", "Judaism", "Hindu", "Hindus", "Hinduism",
      "Buddhist", "Buddhists", "Buddhism", "Sikh", "Sikhs", "Sikhism", "Catholic", "Catholics",
      "Catholicism", "Protestant", "Protestants", "Mormon", "Mormons", "Latter-day Saint", "Latter-day Saints",
      "Jehovah's Witness", "Jehovah's Witnesses", "Quaker", "Quakers", "Baptist", "Methodist", "Pentecostal",
      "Lutheran", "Anglican", "Rastafarian", "Rastafari",
      // Sexuality ("sexuality", "sexual orientation": on the sexual content list)
      "gay", "lesbian", "lesbians", "bisexual", "queer", "homosexual", "homosexuality", "heterosexual",
      "asexual", "pansexual", "LGBT", "LGBTQ", "LGBTQ+", "LGBTQIA", "LGBTQIA+", "LGBTQ2S+",
      // Gender identity
      "transgender", "trans woman", "trans women", "trans man", "trans men", "trans person", "trans people",
      "non-binary", "nonbinary", "genderqueer", "genderfluid", "gender-fluid", "gender identity",
      "gender nonconforming", "gender-nonconforming", "two-spirit", "cisgender", "agender", "intersex",
      "pronouns",
    ],
  },
];

const IDENTITY = "identity";

// Each list as one pattern: whole words, any case, any spacing inside a phrase
const compiled = LISTS.map(({ label, words }) => ({
  label,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
    "giu"
  ),
}));

// Words after an identity word that make it about the music ("Christian rock"); "a Christian singer" still drops
const IDENTITY_MUSIC = new Set([
  "music", "musical", "musics", "song", "songs", "hymn", "hymns", "hymnal", "hymnody", "chant", "chants",
  "chanting", "rock", "pop", "metal", "rap", "punk", "folk", "gospel", "jazz", "choir", "choirs", "choral",
  "liturgy", "liturgical", "worship", "mass", "album", "albums", "record", "records", "label", "chart", "charts",
  "festival", "festivals", "radio", "flute", "flutes", "drum", "drums", "drumming", "instrument", "instruments",
  "dance", "dances", "style", "styles", "scale", "scales", "mode", "modes", "melody", "melodies", "rhythm",
  "rhythms", "singing", "throat", "harp", "harps", "repertoire", "canticle", "canticles", "psalm", "psalms",
]);
// Before "heritage" or "ancestry": "the band's musical heritage"
const IDENTITY_MUSIC_BEFORE = new Set(["music", "musical"]);
// A people's or country's word before "American": "Korean", "Irish", "Japanese", "Haitian"
const looksLikeDemonym = (w: string) => w.length >= 4 && /(?:an|ish|ese|i)$/i.test(w);
// Peoples whose word before "American" doesn't end like one
const BEFORE_AMERICAN = new Set(["arab", "filipino", "filipina", "black", "afro", "native"]);
// "Jew's harp" is an instrument
const IDENTITY_NOT = /\bjew['’]s\s+harps?\b/giu;
// "Threatened to leave Square": a career move, not a threat
const THREAT_NOT = /\bthreat(?:en|ened|ens|ening)\s+to\s+(?:leave|quit|resign|walk\s+out|walk\s+away|disband|break\s+up|split\s+up|withdraw|pull\s+out|cancel)\b/giu;

// Headings whose section goes whole, subsections too; health only a person's, not a game's "Health, lives"
const PRIVATE_HEADING =
  /(?<![\p{L}])(?:personal (?:life|history|relationships?|matters|issues|problems)|private life|family|relationships?|marriages?|legal|lawsuits?|litigation|court cases?|arrests?|criminal|crimes?|controvers(?:y|ies)|allegations?|accusations?|scandals?|health (?:problems|issues|decline)|ill health|illness(?:es)?|addiction|substance abuse|drug use|sexual|abuse)(?![\p{L}])/iu;
// A death heading is only these words ("Illness and death"), so "Death Mountain", "Death Egg" stay
const DEATH_HEADING_WORDS = new Set([
  "death", "deaths", "illness", "health", "later", "last", "final", "life", "years", "and", "legacy", "funeral",
  "aftermath", "tributes", "burial", "his", "her", "their", "the", "early", "posthumous", "memorial",
  "memorials", "of",
]);

/** Whether a heading's whole section is private; a dated career period ("2011–2018: ...") isn't */
export function isPrivateHeading(heading: string): boolean {
  if (/\b(?:1\d{3}|20\d{2})\b/.test(heading)) return false;
  if (PRIVATE_HEADING.test(heading)) return true;
  const words = heading.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 1 && words[0] === "health") return true;
  if (words.some((w) => w === "death" || w === "deaths") && words.every((w) => DEATH_HEADING_WORDS.has(w))) return true;
  return breach(heading) !== null;
}

const isUpper = (c: string | undefined) => !!c && c !== c.toLowerCase() && c === c.toUpperCase();
const QUOTES = new Set(['"', "“", "”", "'", "‘", "’", "«", "»"]);

/** The word before `at`, skipping spaces, or "" */
function wordBefore(text: string, at: number): string {
  let end = at;
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  let start = end;
  while (start > 0 && /[\p{L}\p{N}'’.-]/u.test(text[start - 1])) start--;
  return text.slice(start, end);
}

/** The word after `at`, skipping spaces, or "" */
function wordAfter(text: string, at: number): string {
  let start = at;
  while (start < text.length && /\s/.test(text[start])) start++;
  let end = start;
  while (end < text.length && /[\p{L}\p{N}'’-]/u.test(text[end])) end++;
  return text.slice(start, end);
}

/** Part of a name or title ("Sex Pistols", "the Great Depression", a quoted "Cocaine"); all-caps "LSD" isn't */
function inAName(text: string, index: number, match: string): boolean {
  if (!isUpper(match[0]) || match === match.toUpperCase()) return false;
  const before = text[index - 1];
  if (before && QUOTES.has(before)) return true;
  if (isUpper(wordAfter(text, index + match.length)[0])) return true;
  const prev = wordBefore(text, index);
  return isUpper(prev[0]) && !/[.!?]$/.test(prev);
}

/** `names` (titles, the artist) blanked out, so their words read as names: "Velvet Felony" */
function withoutNames(text: string, names: string[]): string {
  let plain = text;
  for (const name of names) {
    if (name.trim().length < 2) continue;
    plain = plain.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, "giu"), (m) => "x".repeat(m.length));
  }
  return plain.replace(IDENTITY_NOT, (m) => "x".repeat(m.length)).replace(THREAT_NOT, (m) => "x".repeat(m.length));
}

/** Any identity word, even in a name or beside music: for cause facts (a fund named for a faith) */
export function namesIdentity(text: string, names: string[] = []): boolean {
  const { re } = compiled.find((c) => c.label === IDENTITY)!;
  re.lastIndex = 0;
  return re.test(withoutNames(text, names));
}

/** The text with `names` read as names, for other word lists */
export const namesBlanked = withoutNames;

// Small words that open a sentence capitalized: "In Christian tradition" names no one
const NOT_A_NAME = new Set(["the", "a", "an", "in", "as", "his", "her", "their", "its", "for", "on", "at", "by", "with", "from", "of", "and", "but", "to", "both", "many", "some", "most", "other", "this", "that", "while", "after", "before"]);

/** About the music or in a name ("Christian rock", "Yusuf Islam"); "Jewish American" isn't a name */
function identityExempt(text: string, index: number, match: string): boolean {
  if (index > 0 && QUOTES.has(text[index - 1])) return true;
  const next = wordAfter(text, index + match.length);
  if (IDENTITY_MUSIC.has(next.toLowerCase())) return true;
  const prev = wordBefore(text, index);
  if (IDENTITY_MUSIC_BEFORE.has(prev.toLowerCase())) return true;
  if (!isUpper(match[0]) || match === match.toUpperCase()) return false;
  if (isUpper(next[0]) && !looksLikeDemonym(next) && next !== next.toUpperCase()) return true;
  return isUpper(prev[0]) && !/[.!?]$/.test(prev) && !looksLikeDemonym(prev) && !NOT_A_NAME.has(prev.toLowerCase());
}

// Words as written: "Mexican-American" is two
const WORD = /[\p{L}\p{N}'’]+/gu;

/** Identity told in a phrase ("of Irish descent", "member of the Example Nation"), not where someone is from */
function identityPhrases(text: string): string[] {
  const words = [...text.matchAll(WORD)].map((m) => m[0]);
  const lower = words.map((w) => w.toLowerCase());
  const found: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = lower[i];
    if ((w === "american" || w === "americans") && !IDENTITY_MUSIC.has(lower[i + 1] ?? "")) {
      const p = words[i - 1];
      if ((isUpper(p[0]) && looksLikeDemonym(p)) || BEFORE_AMERICAN.has(lower[i - 1])) found.push(`${lower[i - 1]} ${w}`);
    } else if (w === "descent") {
      // "of Irish and Cuban descent", "of mixed descent"; not "a descent into"
      const of = lower.slice(Math.max(0, i - 4), i).lastIndexOf("of");
      const between = of >= 0 ? words.slice(Math.max(0, i - 4) + of + 1, i) : [];
      if (between.some((b) => isUpper(b[0]) || b.toLowerCase() === "mixed")) found.push("descent");
    } else if ((w === "nation" || w === "tribe") && isUpper(words[i][0])) {
      // "member of the Example Nation", "citizen of the Example River Tribe"
      for (let j = i - 1; j >= Math.max(2, i - 5); j--) {
        if (lower[j] === "the" && lower[j - 1] === "of" && /^(?:member|members|citizen|citizens|enrolled)$/.test(lower[j - 2] ?? "")) {
          found.push(w);
          break;
        }
      }
    }
  }
  return found;
}

// Can be a song's theme ("imagine a world without religion"); never a believer or an act ("devout")
const THEME_RELIGION = new Set([
  "religion", "religions", "religious", "atheism", "christianity", "islam", "judaism", "hinduism",
  "buddhism", "sikhism", "catholicism",
]);
// Subject is the song, its lyrics or its theme
const SONG_SUBJECT =
  /^["“‘']?(?:(?:the|this)\s+(?:song|track|lyrics|theme)(?:['’]s\s+(?:lyrics|theme|chorus|verses?|refrain|message))?|its\s+(?:lyrics|theme|chorus|verses?|refrain|message))(?![\p{L}\p{N}'’])/iu;
// Anything that puts a person in the sentence; when unsure, blocks
const PERSON_CUE =
  /(?<![\p{L}\p{N}])(?:he|she|him|his|her|hers|himself|herself|they|them|their|theirs|who|whom|whose|man|men|woman|women|boy|girl|singer|songwriter|writer|composer|artist|band|musician|vocalist|lyricist|poet|author|member|members|priest|pastor|preacher|monk|nun|born|raised|devout|convert|converts|converted|converting|conversion|believer|believers|follower|followers|practicing|practising|faithful)(?![\p{L}\p{N}])/iu;

/** About the song's theme with no person; a capital past the first word reads as a name */
function themeSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!SONG_SUBJECT.test(s) || PERSON_CUE.test(s)) return false;
  return ![...s.matchAll(WORD)].slice(1).some((m) => isUpper(m[0][0]) && !THEME_RELIGION.has(m[0].toLowerCase()));
}

/** Start and end of each sentence, in order */
function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let from = 0;
  for (const line of text.split("\n")) {
    let at = from;
    for (const s of sentencesOf(line)) {
      const start = text.indexOf(s, at);
      if (start < 0) continue;
      spans.push([start, start + s.length]);
      at = start + s.length;
    }
    from += line.length + 1;
  }
  return spans;
}

/** Identity words and phrases used about a person, lowercased */
export function identityTerms(text: string, names: string[] = []): string[] {
  const plain = withoutNames(text, names);
  const { re } = compiled.find((c) => c.label === IDENTITY)!;
  re.lastIndex = 0;
  const found: string[] = [];
  const themed = [...plain.matchAll(re)].some((m) => THEME_RELIGION.has(m[0].toLowerCase()))
    ? sentenceSpans(plain).filter(([a, b]) => themeSentence(plain.slice(a, b)))
    : [];
  for (const m of plain.matchAll(re)) {
    const at = m.index ?? 0;
    if (identityExempt(plain, at, m[0])) continue;
    // A theme word, only in a sentence about the song itself
    if (THEME_RELIGION.has(m[0].toLowerCase()) && themed.some(([a, b]) => at >= a && at < b)) continue;
    found.push(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return [...found, ...identityPhrases(plain)];
}

/** Every list a text breaks, in order; `names` (titles, the artist) read as names */
function breaches(text: string, names: string[] = []): string[] {
  const plain = withoutNames(text, names);
  const out: string[] = [];
  for (const { label, re } of compiled) {
    if (label === IDENTITY) continue;
    re.lastIndex = 0;
    for (const m of plain.matchAll(re)) {
      if (!inAName(plain, m.index ?? 0, m[0])) {
        out.push(label);
        break;
      }
    }
  }
  if (identityTerms(text, names).length) out.push(IDENTITY);
  return out;
}

/** The first list a text breaks, or null */
function breach(text: string, names: string[] = []): string | null {
  return breaches(text, names)[0] ?? null;
}

// The artist's own words ("has described herself as", "she identifies as"), not others' ("was identified as")
const SELF_REFLEXIVE =
  /\b(?:describe[sd]?|describing|call(?:s|ed|ing)?|consider(?:s|ed|ing)?|refer(?:s|red|ring)? to|define[sd]?|defining|sees?|saw|regard(?:s|ed)?|label(?:s|ed|led)?|identif(?:y|ies|ied|ying))\s+(?:himself|herself|themselves|themself|itself)\b/i;
const IDENTIFIES_AS = /\b([\p{L}'’]+)\s+identif(?:y|ies|ied|ying)\s+as\b/iu;
const PASSIVE = new Set(["was", "were", "been", "being", "be", "is", "are"]);

export function selfDescribes(text: string): boolean {
  if (SELF_REFLEXIVE.test(text)) return true;
  const m = IDENTIFIES_AS.exec(text);
  return Boolean(m && !PASSIVE.has(m[1].toLowerCase()));
}

/**
 * The identity exception (#262): self-describing, breaks no other list, each identity word from a
 * self-describing reference sentence; the artist's name is checked in screening/screen.ts `captionReason`
 */
export function selfDescribedIdentity(caption: string, reference: string, names: string[] = []): boolean {
  const labels = breaches(caption, names);
  if (labels.length !== 1 || labels[0] !== IDENTITY || !selfDescribes(caption)) return false;
  const own = reference.split("\n").flatMap(sentencesOf).filter(selfDescribes).map((s) => identityTerms(s, names));
  return identityTerms(caption, names).every((t) => own.some((terms) => terms.includes(t)));
}

/** standardBreach's reason for a statement of who someone is */
export const IDENTITY_REASON = `content standard: ${IDENTITY}`;

/** Why a caption or data fact breaks the standard, or null; `names` (titles, the artist) read as names */
export function standardBreach(text: string, names: string[] = []): string | null {
  const label = breach(text, names);
  return label ? `content standard: ${label}` : null;
}

/** A standardBreach reason: its caption is logged without its text, so logs can't spread it */
export const isStandardReason = (reason: string): boolean => reason.startsWith("content standard:");

/** A paragraph's sentences; "J. S. Bach" doesn't end one */
export function sentencesOf(paragraph: string): string[] {
  return paragraph.split(/(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”’)]?)\s+/u).filter((s) => s.trim());
}

/** A heading line ("== Personal life =="): level and words, or null; no regex, so no backtracking */
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
  /** Article's sentences, and how many were left out (in left-out sections too) */
  sentences: number;
  dropped: number;
  /** Sections left out whole */
  sections: number;
}

/** The article as the model may read it: private sections and breaking sentences out; `page` read as a name */
export function withinStandard(full: string, page = ""): StandardText {
  // "Bad Habit (song)" is "Bad Habit" in its own text
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
    // The artist's own words about who they are stay for the model (selfDescribedIdentity)
    const kept = parts.filter((s) => {
      const labels = breaches(s, names);
      return !labels.length || (labels.length === 1 && labels[0] === IDENTITY && selfDescribes(s));
    });
    dropped += parts.length - kept.length;
    if (kept.length || !line.trim()) out.push(kept.length === parts.length ? line : kept.join(" "));
  }
  return { text: out.join("\n").trimEnd(), sentences, dropped, sections };
}
