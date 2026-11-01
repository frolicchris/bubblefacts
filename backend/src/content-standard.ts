import { escapeRe } from "./text";

/**
 * The content standard: "About the music. Safe for any stream." (issue #242)
 *
 * A bubble never says what a polite chatter couldn't post in a
 * family-friendly music stream. Twitch holds streamers responsible for
 * everything on their stream, and YouTube and Kick have the same rules, so
 * an article's sentences about crime, lawsuits, threats, stalking, drugs, sex,
 * private relationships, health, how someone died and put-downs of the music never reach the model, and a
 * caption or data fact that still says such a thing is dropped. Nor does
 * anything saying who a person is (issue #262), unless in their own words.
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
      // "Controversy" alone is too often about music: a band's name, a soundtrack's reception.
      // A "Controversies" section is still left out whole.
      "infringement", "infringed", "scandal", "scandals", "feud", "feuds",
    ],
  },
  {
    // Twitch Harassment and Violent Threats, YouTube threats and harassment of
    // identifiable people, Kick harassment. A threat or a stalker is never trivia.
    // Figures of speech ("a threatening bass line") go with them: a miss is worse.
    label: "threats or stalking",
    words: [
      "threat", "threats", "threaten", "threatens", "threatened", "threatening", "death threat",
      "death threats", "stalker", "stalkers", "stalking", "stalked",
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
      // A spouse alone ("with his wife Anne, he set the poem to music") is often how the music was made;
      // getting married, divorced or separated is private life.
      // "Divorced from the film, the score still works" is a critic's figure of speech.
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
      "plane crash", "car accident", "traffic accident", "autopsy", "coroner", "shot dead",
      "found dead", "gunshot", "drowned", "stabbed", "strangled", "death of his", "death of her",
      "death of their",
    ],
  },
  {
    // Chat etiquette: a bubble celebrates the music, so a song's or an artist's
    // failure isn't trivia. "Failed to make the top 100" is a fact
    // nobody needed. "Panned" alone is a sound moving left or right; "mixed reviews" stays.
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
    // Issue #262: a bubble never states who a person is. Twitch's Hateful Conduct policy
    // protects race, ethnicity, national origin, religion, sexual orientation and gender
    // identity, YouTube's hate speech policy and Kick's community guidelines the same, and
    // only the person can say who they are: an article's word for it is someone else's.
    // So no ethnicity or Indigenous nation, race, religion, sexuality or gender identity, for
    // anyone. Where someone is from ("a Canadian singer", "born in Oslo") and anything about
    // the music ("Christian rock", "Inuit throat singing", a hymn) stay: see IDENTITY_MUSIC.
    // Category words only, never a list of peoples: a people's name is also a song, a game's
    // tribe or a band, and no list of them would be complete. The artist's own words about
    // themselves are the one exception (`selfDescribes`).
    label: "identity",
    words: [
      // Ethnicity, ancestry and Indigenous nations. "Member of the ... Nation", "of ... descent"
      // and "<people> American" are read in `identityPhrases`.
      "ethnic", "ethnicity", "ethnicities", "ethnically", "heritage", "ancestry", "Indigenous", "Aboriginal",
      "First Nation", "First Nations", "Métis", "Metis", "Inuit", "Inuk", "Native American", "Native Americans",
      "Native Hawaiian", "Alaska Native", "Torres Strait Islander", "tribe", "tribes", "tribal", "Latino", "Latina",
      "Latinos", "Latinas", "Latinx", "Hispanic", "Chicano", "Chicana", "Afro-Latino", "Afro-Latina",
      "Afro-Caribbean",
      // Race. Bare "race" is racing, and bare "black" and "white" are colors and albums, so only phrases.
      "racial", "racially", "biracial", "multiracial", "mixed-race", "mixed race", "people of color",
      "person of color", "woman of color", "women of color", "artists of color", "musicians of color",
      "Black woman", "Black women", "Black man", "Black men", "Black people", "Black person", "Black artist",
      "Black artists", "Black musician", "Black musicians", "Black singer", "Black singers", "Black composer",
      "Black composers", "Black community", "Black Americans", "white woman", "white women", "white man",
      "white men", "white people", "white musicians", "white artists",
      // Religion.
      "religion", "religions", "religious", "devout", "atheist", "atheists", "atheism", "agnostic",
      "born-again", "evangelical", "converted to", "Christian", "Christians", "Christianity", "Muslim",
      "Muslims", "Islam", "Islamic", "Jewish", "Jew", "Jews", "Judaism", "Hindu", "Hindus", "Hinduism",
      "Buddhist", "Buddhists", "Buddhism", "Sikh", "Sikhs", "Sikhism", "Catholic", "Catholics",
      "Catholicism", "Protestant", "Protestants", "Mormon", "Mormons", "Latter-day Saint", "Latter-day Saints",
      "Jehovah's Witness", "Jehovah's Witnesses", "Quaker", "Quakers", "Baptist", "Methodist", "Pentecostal",
      "Lutheran", "Anglican", "Rastafarian", "Rastafari",
      // Sexuality ("sexuality" and "sexual orientation" are on the sexual content list already).
      "gay", "lesbian", "lesbians", "bisexual", "queer", "homosexual", "homosexuality", "heterosexual",
      "asexual", "pansexual", "LGBT", "LGBTQ", "LGBTQ+", "LGBTQIA", "LGBTQIA+", "LGBTQ2S+",
      // Gender identity.
      "transgender", "trans woman", "trans women", "trans man", "trans men", "trans person", "trans people",
      "non-binary", "nonbinary", "genderqueer", "genderfluid", "gender-fluid", "gender identity",
      "gender nonconforming", "gender-nonconforming", "two-spirit", "cisgender", "agender", "intersex",
      "pronouns",
    ],
  },
];

const IDENTITY = "identity";

/** A list's words as one pattern: whole words, any case, any spacing inside a phrase. */
const compiled = LISTS.map(({ label, words }) => ({
  label,
  re: new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
    "giu"
  ),
}));

/**
 * After an identity word, these make it about the music, not a person: "Christian rock",
 * "Indigenous instruments", "Inuit throat singing", "Jewish liturgical music". A person
 * noun ("singer", "band") is not here, so "a Christian singer" is still dropped.
 */
const IDENTITY_MUSIC = new Set([
  "music", "musical", "musics", "song", "songs", "hymn", "hymns", "hymnal", "hymnody", "chant", "chants",
  "chanting", "rock", "pop", "metal", "rap", "punk", "folk", "gospel", "jazz", "choir", "choirs", "choral",
  "liturgy", "liturgical", "worship", "mass", "album", "albums", "record", "records", "label", "chart", "charts",
  "festival", "festivals", "radio", "flute", "flutes", "drum", "drums", "drumming", "instrument", "instruments",
  "dance", "dances", "style", "styles", "scale", "scales", "mode", "modes", "melody", "melodies", "rhythm",
  "rhythms", "singing", "throat", "harp", "harps", "repertoire", "canticle", "canticles", "psalm", "psalms",
]);
/** Before "heritage" or "ancestry": "the band's musical heritage" is about the music. */
const IDENTITY_MUSIC_BEFORE = new Set(["music", "musical"]);
/** A word for a people or a country, as it's written before "American": "Korean", "Irish", "Japanese", "Haitian". */
const looksLikeDemonym = (w: string) => w.length >= 4 && /(?:an|ish|ese|i)$/i.test(w);
/** Peoples whose word before "American" doesn't end like a demonym. */
const BEFORE_AMERICAN = new Set(["arab", "filipino", "filipina", "black", "afro", "native"]);
/** "Jew's harp" is an instrument. */
const IDENTITY_NOT = /\bjew['’]s\s+harps?\b/giu;
/** "He threatened to leave Square" is a career move, not a threat to anyone. */
const THREAT_NOT = /\bthreat(?:en|ened|ens|ening)\s+to\s+(?:leave|quit|resign|walk\s+out|walk\s+away|disband|break\s+up|split\s+up|withdraw|pull\s+out|cancel)\b/giu;

/**
 * Section headings whose whole section is left out, subsections and all:
 * "Personal life", "Legal issues", "Controversies", "Health problems". Same
 * rules as the lists above. A game's "Health, lives, and power-ups" is
 * gameplay, so health counts only as a person's.
 */
const PRIVATE_HEADING =
  /(?<![\p{L}])(?:personal (?:life|history|relationships?|matters|issues|problems)|private life|family|relationships?|marriages?|legal|lawsuits?|litigation|court cases?|arrests?|criminal|crimes?|controvers(?:y|ies)|allegations?|accusations?|scandals?|health (?:problems|issues|decline)|ill health|illness(?:es)?|addiction|substance abuse|drug use|sexual|abuse)(?![\p{L}])/iu;
/**
 * A heading about someone's death is made only of these words: "Death",
 * "Illness and death", "Death and legacy". "Death Mountain" and "Death Egg"
 * are places in games, and stay.
 */
const DEATH_HEADING_WORDS = new Set([
  "death", "deaths", "illness", "health", "later", "last", "final", "life", "years", "and", "legacy", "funeral",
  "aftermath", "tributes", "burial", "his", "her", "their", "the", "early", "posthumous", "memorial",
  "memorials", "of",
]);

/**
 * A heading for a whole private section. A period of a career ("2011–2018:
 * The Idler Wheel, tour, and legal troubles") is kept, sentence by sentence.
 */
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

/** `names` (titles, the artist) blanked out, so their words are read as names: "Velvet Felony". */
function withoutNames(text: string, names: string[]): string {
  let plain = text;
  for (const name of names) {
    if (name.trim().length < 2) continue;
    plain = plain.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, "giu"), (m) => "x".repeat(m.length));
  }
  return plain.replace(IDENTITY_NOT, (m) => "x".repeat(m.length)).replace(THREAT_NOT, (m) => "x".repeat(m.length));
}

/**
 * Whether a text has an identity word anywhere, even in a name or beside music: stricter than
 * `identityTerms`, for facts about a cause (a fund named for a faith ties the cause to it).
 */
export function namesIdentity(text: string, names: string[] = []): boolean {
  const { re } = compiled.find((c) => c.label === IDENTITY)!;
  re.lastIndex = 0;
  return re.test(withoutNames(text, names));
}

/** The text with `names` read as names, for other word lists. */
export const namesBlanked = withoutNames;

/** Small words that open a sentence with a capital: "In" in "In Christian tradition" is no first name. */
const NOT_A_NAME = new Set(["the", "a", "an", "in", "as", "his", "her", "their", "its", "for", "on", "at", "by", "with", "from", "of", "and", "but", "to", "both", "many", "some", "most", "other", "this", "that", "while", "after", "before"]);

/**
 * An identity word that is about the music or part of a name, not a person: "Christian rock",
 * "the band's musical heritage", a quoted "Cherokee", "Christian Varga" or "Yusuf Islam". A word
 * for a people next to it isn't a name: "Jewish American", "Swedish Christian".
 */
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

/** Words, as written, for the phrases below: "Mexican-American" is two. */
const WORD = /[\p{L}\p{N}'’]+/gu;

/**
 * Identity told in a phrase rather than one word: "a Korean American singer", "of Irish
 * descent", "a member of the Example Nation". Where someone lives or comes from ("born in
 * the Example Nation", "an American singer") isn't one.
 */
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
      // "of Irish descent", "of Irish and Cuban descent", "of mixed descent"; not "a descent into".
      const of = lower.slice(Math.max(0, i - 4), i).lastIndexOf("of");
      const between = of >= 0 ? words.slice(Math.max(0, i - 4) + of + 1, i) : [];
      if (between.some((b) => isUpper(b[0]) || b.toLowerCase() === "mixed")) found.push("descent");
    } else if ((w === "nation" || w === "tribe") && isUpper(words[i][0])) {
      // "member of the Example Nation", "citizen of the Example River Tribe".
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

/**
 * Religion words that can name a song's own theme: "The song's lyrics ask listeners to imagine a
 * world without religion." Words for a believer or an act of belief ("Catholic", "devout",
 * "converted to") are never here.
 */
const THEME_RELIGION = new Set([
  "religion", "religions", "religious", "atheism", "christianity", "islam", "judaism", "hinduism",
  "buddhism", "sikhism", "catholicism",
]);
/** A sentence whose subject is the song, its lyrics or its theme. */
const SONG_SUBJECT =
  /^["“‘']?(?:(?:the|this)\s+(?:song|track|lyrics|theme)(?:['’]s\s+(?:lyrics|theme|chorus|verses?|refrain|message))?|its\s+(?:lyrics|theme|chorus|verses?|refrain|message))(?![\p{L}\p{N}'’])/iu;
/** Anything that makes a person a subject or an object of the sentence. When unsure, this blocks. */
const PERSON_CUE =
  /(?<![\p{L}\p{N}])(?:he|she|him|his|her|hers|himself|herself|they|them|their|theirs|who|whom|whose|man|men|woman|women|boy|girl|singer|songwriter|writer|composer|artist|band|musician|vocalist|lyricist|poet|author|member|members|priest|pastor|preacher|monk|nun|born|raised|devout|convert|converts|converted|converting|conversion|believer|believers|follower|followers|practicing|practising|faithful)(?![\p{L}\p{N}])/iu;

/** Whether a sentence is about the song's theme with no person in it: a capital letter past the first word reads as a name. */
function themeSentence(sentence: string): boolean {
  const s = sentence.trim();
  if (!SONG_SUBJECT.test(s) || PERSON_CUE.test(s)) return false;
  return ![...s.matchAll(WORD)].slice(1).some((m) => isUpper(m[0][0]) && !THEME_RELIGION.has(m[0].toLowerCase()));
}

/** Start and end of each sentence of `text`, in order. */
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

/** The identity words and phrases a text uses about a person, lowercased: [] when none. */
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
    // Only a theme word, in a sentence about the song itself (never in one about a person).
    if (THEME_RELIGION.has(m[0].toLowerCase()) && themed.some(([a, b]) => at >= a && at < b)) continue;
    found.push(m[0].toLowerCase().replace(/\s+/g, " "));
  }
  return [...found, ...identityPhrases(plain)];
}

/** Every list a text breaks, in list order. `names` (titles, the artist) are read as names, not words. */
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

/** Which list a text breaks, or null. `names` (titles, the artist) are read as names, not words. */
function breach(text: string, names: string[] = []): string | null {
  return breaches(text, names)[0] ?? null;
}

/**
 * The artist's own words about who they are: "has described herself as", "calls himself",
 * "said she identifies as". Someone else's word for it ("was identified as", "is considered")
 * is not.
 */
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
 * The one exception to the identity rule (issue #262): a caption that keeps the artist's own
 * words about themselves. It must say they described themselves ("has described herself as"),
 * break no list but this one, and every identity word in it must come from a sentence of the
 * reference where someone describes themselves. Whether it keeps the artist's name is checked
 * where the artist is known (`captionReason` in fact-verifier.ts).
 */
export function selfDescribedIdentity(caption: string, reference: string, names: string[] = []): boolean {
  const labels = breaches(caption, names);
  if (labels.length !== 1 || labels[0] !== IDENTITY || !selfDescribes(caption)) return false;
  const own = reference.split("\n").flatMap(sentencesOf).filter(selfDescribes).map((s) => identityTerms(s, names));
  return identityTerms(caption, names).every((t) => own.some((terms) => terms.includes(t)));
}

/** The reason `standardBreach` gives for a statement of who someone is. */
export const IDENTITY_REASON = `content standard: ${IDENTITY}`;

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
    // The artist's own words about who they are stay for the model (`selfDescribedIdentity`).
    const kept = parts.filter((s) => {
      const labels = breaches(s, names);
      return !labels.length || (labels.length === 1 && labels[0] === IDENTITY && selfDescribes(s));
    });
    dropped += parts.length - kept.length;
    if (kept.length || !line.trim()) out.push(kept.length === parts.length ? line : kept.join(" "));
  }
  return { text: out.join("\n").trimEnd(), sentences, dropped, sections };
}
