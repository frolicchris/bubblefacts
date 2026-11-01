import { namesBlanked } from "./content-standard";
import { escapeRe } from "./text";

/**
 * Neutral wording for facts about what artists do in public. Every rule is here, on purpose, so
 * the line can be read and reviewed in one place: the rule, the prompt, the word lists.
 *
 * THE RULE. State the public act someone can check, not its merit: what the artist did and for
 * whom. "Performed at a benefit for X", "co-founded Y", "named a goodwill ambassador". Never
 * whether a cause is right, never why they did it unless they said so and the fact says who said
 * it.
 *
 * WHAT STAYS OUT, whatever the wording:
 *   1. Elections, candidates, parties and endorsements (`ELECTIONS`).
 *   2. Anything that reads as taking a side in a contested fight (`CONTESTED`), and acts that
 *      only state a side (`SIDE_ACTS`): naming a letter or a petition still spreads the side.
 *   3. Judging or heated words (`LOADED`), characterizations (`CHARACTERIZING`), motives
 *      (`MOTIVE`) and hedges (`HEDGES`).
 *   4. For someone living: money figures, and an undated present-tense role.
 * The content standard (content-standard.ts) comes first and is never loosened by this file.
 *
 * These lists sit on top of an allow-list: an article sentence must first have the shape of a
 * checkable act (`ACTS` in artist-good.ts). Word lists only, as in the content standard: no AI
 * decides, and a miss keeps the fact off the stream.
 */

/** Added to the prompt when the reference is an artist's article. */
export const NEUTRAL_PROMPT =
  " When a statement is about what the artist does in public, say what they did and for whom, as plain news would. Do not judge it, do not say why they did it, and do not write about elections, parties or candidates.";

const ELECTIONS = [
  "election", "elections", "electoral", "re-election", "reelection", "candidate", "candidates", "candidacy", "ballot",
  "ballots", "voter", "voters", "referendum", "referendums", "inauguration", "inaugural", "endorse", "endorsed",
  "endorses", "endorsing", "endorsement", "endorsements", "presidential", "senator", "senators", "congressman",
  "congresswoman", "campaign trail", "politician", "politicians", "politics", "political", "politically", "partisan",
  "Democrat", "Democrats", "Democratic Party", "Republican", "Republicans", "Republican Party", "Labour Party",
  "Conservative Party", "Tory", "Tories", "Liberal Party", "Green Party", "Communist Party", "Socialist Party",
  "political party", "left-wing", "right-wing", "far-right", "far-left", "communism", "communist", "communists",
  "socialism", "socialist", "socialists", "fascism", "fascist", "fascists", "antifa", "nationalism", "nationalist",
  "nationalists", "Marxism", "Marxist", "anarchism", "anarchist", "anarchists", "capitalism", "Stalin", "Lenin", "Mao",
];

/** Fights where naming the subject at all reads as taking a side. Short, and open to review. */
const CONTESTED = [
  "abortion", "pro-choice", "pro-life", "gun control", "gun rights", "immigration", "Brexit", "secession",
  "independence movement", "Israel", "Israeli", "Palestine", "Palestinian", "Palestinians", "Zionist", "Zionism",
  "Black Lives Matter", "regime", "dictator", "dictatorship", "coup", "impeach", "impeachment", "Gaza", "West Bank",
  "Hamas", "Hezbollah", "Tibet", "Taiwan", "Hong Kong", "climate change", "same-sex marriage", "marriage equality",
  "minimum wage", "fracking", "Iraq War", "Vietnam War", "Occupy", "National Rifle Association", "NRA", "culling",
  "repeal", "ban on",
];
/** "Against" alone is too wide: "a concert against hunger", Rage Against the Machine. */
const AGAINST_STATE = /\bagainst\s+the\s+(?:[\p{L}-]+\s+)?(?:government|war|law|regime|policy)\b/iu;

/** Acts that do nothing but state a side. The rights of musicians themselves are the exception (`OWN_TRADE`). */
const SIDE_ACTS = [
  "open letter", "public letter", "signed a letter", "signed letters", "petition", "petitions", "boycott", "boycotts",
  "boycotted", "protest", "protests", "protested", "protesters", "demonstration", "demonstrations", "rally", "rallies",
  "marched", "sanctions",
];
const OWN_TRADE = /\b(?:musicians'|artists'|songwriters') rights\b|\broyalt(?:y|ies)\b|\bfair pay\b/i;

/** A judgment of the act rather than the act. */
const LOADED = [
  "champion of", "champions of", "fought against", "fought for", "fighting for", "stood up to", "stood up for",
  "standing up to", "controversial", "activist hero", "hero of", "heroic", "heroically", "tireless", "tirelessly",
  "courageous", "courageously", "brave stand", "bravely", "outspoken", "fierce", "fiercely", "staunch", "staunchly",
  "vocal critic", "vocal supporter", "noble", "selfless", "selflessly", "generous", "generously", "generosity",
  "notorious", "infamous", "radical", "extremist", "extremists", "so-called", "oppressive", "oppressed", "oppression",
  "injustice", "injustices", "unjust", "shameful", "landmark", "visionary", "legendary", "iconic", "leading figure",
  "pioneering", "tremendous", "remarkable", "inspiring",
];

/**
 * Fine in a sentence about a song, so captions aren't held to these; in a fact about an artist's
 * public life they characterize rather than tell.
 */
const CHARACTERIZING = [
  "activism", "activist", "activists", "advocate", "advocates", "advocacy", "social justice", "human rights",
  "civil rights", "consciousness", "causes",
];

const HEDGES = ["reportedly", "allegedly"];

/** Why they did it: only the artist can say, and then the fact must say who said it. */
const MOTIVE = [
  "because", "out of concern", "motivated by", "driven by", "passionate", "passion for", "believes", "believing",
  "commitment to", "committed to", "dedicated to", "dedication to", "devoted to", "in protest", "in solidarity",
  "deeply", "cares about",
];

/** Names of honors and charities that hold a listed word. */
const HONOR_NAMES = /\bPresidential Medal of (?:Freedom|Arts)\b|\bPresidential Citation\b|\bWar Child\b/giu;

const pattern = (words: string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => escapeRe(w).replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`, "iu");
const OUT: Array<{ reason: string; re: RegExp }> = [
  { reason: "elections or parties", re: pattern(ELECTIONS) },
  { reason: "a contested fight", re: pattern(CONTESTED) },
  { reason: "a contested fight", re: AGAINST_STATE },
  { reason: "loaded wording", re: pattern([...LOADED, ...CHARACTERIZING]) },
  { reason: "a motive", re: pattern(MOTIVE) },
  { reason: "a hedge", re: pattern(HEDGES) },
];
const SIDE_ACT = pattern(SIDE_ACTS);
const LOADED_RE = pattern(LOADED);
const MOTIVE_RE = pattern(MOTIVE);
/** A sum a living person gave is theirs to tell. */
const MONEY = /[$£€]\s?\d|\b\d+(?:\.\d+)?\s+(?:million|billion)\s+(?:dollars|pounds|euros)\b/i;
/** "Is a patron of ...": no date to check it by. "Became a patron in 1999" is an act. */
const PRESENT_ROLE = /\b(?:is|are)\s+(?:(?:a|an|the)\s+)?(?:[\p{L}'’-]+\s+){0,3}?(?:patron|supporter|ambassador|trustee|spokes(?:person|man|woman))\b/iu;

/**
 * Why a fact about an artist's public life can't be shown (see THE RULE), or null when it can.
 * `names` (the artist, titles) are read as names, not words. `living`: whether they are alive.
 */
export function neutralBreach(text: string, names: string[] = [], living = true): string | null {
  const plain = namesBlanked(text, names).replace(HONOR_NAMES, "");
  const out = OUT.find(({ re }) => re.test(plain));
  if (out) return out.reason;
  if (living && MONEY.test(plain)) return "a living person's money";
  if (PRESENT_ROLE.test(plain) && !/\b(?:1[89]|20)\d\d\b/.test(plain)) return "an undated role";
  return SIDE_ACT.test(plain) && !OWN_TRADE.test(plain) ? "an act that states a side" : null;
}

/**
 * Whether an AI caption judges rather than tells. Every caption is held to `LOADED`. One written
 * from an artist's article (`artistArticle`) is about their life, so it is held to `MOTIVE` too;
 * on a song's article "because" and "dedicated to" are how the music came about.
 */
export function loadedCaption(text: string, names: string[] = [], artistArticle = false): boolean {
  const plain = namesBlanked(text, names);
  return LOADED_RE.test(plain) || (artistArticle && MOTIVE_RE.test(plain));
}
