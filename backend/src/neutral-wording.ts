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
 *   3. Judging or heated words (`LOADED`), and motives (`MOTIVE`).
 * The content standard (content-standard.ts) comes first and is never loosened by this file.
 *
 * Advocacy passes when it is told as an act: a benefit, a donation, a role. Word lists only, as
 * in the content standard: no AI decides, and a miss keeps the fact off the stream.
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
  "Black Lives Matter", "regime", "dictator", "dictatorship", "coup", "impeach", "impeachment", "against",
];

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
  { reason: "loaded wording", re: pattern(LOADED) },
  { reason: "a motive", re: pattern(MOTIVE) },
];
const SIDE_ACT = pattern(SIDE_ACTS);
const LOADED_RE = OUT[2].re;

/**
 * Why a fact about an artist's public life can't be shown (see THE RULE), or null when it can.
 * `names` (the artist, titles) are read as names, not words.
 */
export function neutralBreach(text: string, names: string[] = []): string | null {
  const plain = namesBlanked(text, names).replace(HONOR_NAMES, "");
  const out = OUT.find(({ re }) => re.test(plain));
  if (out) return out.reason;
  return SIDE_ACT.test(plain) && !OWN_TRADE.test(plain) ? "an act that states a side" : null;
}

/** Whether an AI caption judges rather than tells. A caption on any subject is held to this. */
export function loadedCaption(text: string, names: string[] = []): boolean {
  return LOADED_RE.test(namesBlanked(text, names));
}
