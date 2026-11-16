import { escapeRe } from "../text";
import { mentionsName, normalizeTitle } from "../grounding/titles";
import { ABOUT_THE_VIDEO, hasWord, NAME_STOPWORDS, sourceSentences, YEAR } from "./names";
import { bodySentences, lineSentences, MONTHS, retoldSentences, share } from "./sentences";
import { speakers } from "./attribution";
import { capitalsOf } from "./frames";

// Wording a caption turns round: merged clauses, dropped hedges, misplaced years, wrong owners, reversed roles

/**
 * Doer turned round, or the name: "Vale compared" for "compared Vale's vocals"; "worked on by Rob Lane"
 * for "Rob Lane confirmed it is worked on"; "at the Brit Awards" for "at the Mercury Prize"
 */
export function turnedRound(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(\p{Ll}+ed)\b/u.exec(fact);
  if (lead) {
    const name = lead[1].split(/\s+/).pop() as string;
    // "was developed by Rare" = "Rare developed"
    const passive = new RegExp(`\\b(?:was|were|is|are|been|being|be)\\s+(?:\\p{Ll}+\\s+)?${escapeRe(lead[2])}\\b|\\b${escapeRe(lead[2])}\\s+by\\b`, "u");
    const after = new RegExp(`\\b${escapeRe(lead[2])}\\b[^,;]*\\b${escapeRe(name)}['’]s?\\s`, "u");
    const before = new RegExp(`\\b${escapeRe(name)}\\b[^,;]*\\b${escapeRe(lead[2])}\\b`, "u");
    if (retold.every((s) => after.test(s) && !before.test(s) && !passive.test(s))) return name;
  }
  // Both events may be in the article, but only one in this sentence
  const at = /\bat the ((?:\p{Lu}[\p{L}'’-]*\s?){1,4})/u.exec(fact);
  const sAt = retold.map((s) => /\bat the ((?:\p{Lu}[\p{L}'’-]*\s?){1,4})/u.exec(s));
  if (at && sAt.every(Boolean) && !capitalsOf(at[1]).some((w) => retold.some((s) => hasWord(w, s)))) return at[1].trim();
  const by = /\bby ((?:\p{Lu}[\p{L}'’.-]*\s*){1,4})\.?$/u.exec(fact);
  if (by) {
    const name = (by[1].trim().split(/\s+/).pop() as string).replace(/\.$/, "");
    if (retold.every((s) => speakers(s).includes(name) && !new RegExp(`\\bby (?:\\p{Lu}[\\p{L}'’.-]*\\s+)*${escapeRe(name)}\\b`, "u").test(s))) return name;
  }
  return null;
}

// Where one statement of a sentence ends and another starts
const CLAUSE_BREAK = /,\s+(?=(?:who|whom|whose|which|while|whereas|but|although|though|after|before)\b)|;\s+/;

/**
 * Year or name joined on from another clause, or null: "formed a songwriting team in 1976" from
 * "It was formed in 1976 by Ann and Bo, who formed a songwriting team"
 */
export function mergedClauses(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (retold.length !== 1) return null;
  const clauses = retold[0].split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const years = fact.match(YEAR) ?? [];
  // Only "with" names: a caption's subject is usually the sentence's
  const names = [...fact.matchAll(/\bwith ((?:\p{Lu}[\p{L}'’-]+\s?)+)/gu)].flatMap((m) => m[1].trim().split(/\s+/)).filter((n) => hasWord(n, retold[0]));
  const anchors = [...years, ...names];
  if (!anchors.length) return null;
  const rest = fact.replace(YEAR, " ").replace(/\b\p{Lu}[\p{L}'’-]+/gu, " ");
  const scored = clauses.map((c, i) => ({ c, i, share: share(rest, c) })).sort((a, b) => b.share - a.share);
  if (scored[0].share < 0.5 || scored[0].share - scored[1].share < 0.2) return null;
  const main = scored[0];
  for (const a of anchors) {
    if (hasWord(a, main.c)) continue;
    const at = clauses.findIndex((c) => hasWord(a, c));
    // An earlier clause's name is usually the later one's subject; a year never is
    if (at >= 0 && (/^\d{4}$/.test(a) || at > main.i)) return a;
  }
  return null;
}

// Section about another recording: another performer's version, B-sides
const OTHER_RECORDING_HEADING = /^(?:[^:\n]{2,40}\s(?:version|cover|rendition|remix)|cover versions?|other versions?|b-sides?|remixes)$/i;

/** Heading of another recording's section the caption retells unsaid ("It was..." under "Nightjar version"), or null */
export function otherRecordingSection(fact: string, context: string, artists: string[] = []): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const seen: string[] = [];
  for (const line of context.split("\n").slice(1)) {
    const heading = /^([^:\n]{2,60}): /.exec(line)?.[1];
    if (!heading || !OTHER_RECORDING_HEADING.test(heading) || mentionsName(normalizeTitle(heading), artists)) continue;
    const leans = (s: string) => /^b-side/i.test(heading) || /^(?:It|Its|They|Their)\b/.test(s.replace(`${heading}: `, ""));
    if (lineSentences(line).some((s) => retold.includes(s) && leans(s)) && !hasWord(heading.replace(/\s\S+$/, ""), fact)) seen.push(heading);
  }
  return seen[0] ?? null;
}

const HEDGE =
  /\b(?:may|might|could) have\b|\b(?:possibly|arguably|reportedly|allegedly|apparently|supposedly|purportedly|reputedly|rumou?red|probably|perhaps|presumably|unconfirmed|disputed)\b|\b(?:is|are|was|were) (?:said|believed|thought|reported|rumou?red|claimed) to\b|\bit is (?:said|believed|thought|claimed)\b|\b(?:legend|tradition) has it\b|\b(?:is|are|was|were) credited with\b|\bin part\b|\b(?:partly|partially)\b/i;

/** Hedge in every retold sentence that the caption drops ("Ardent suggested" for "may have been suggested by Ardent"), or null */
export function droppedHedge(fact: string, context: string): string | null {
  if (HEDGE.test(fact) || /\baccording to\b/i.test(fact)) return null;
  const retold = retoldSentences(fact, context);
  // A hedge inside a quote is the speaker's ("called it "perhaps the first masterpiece"")
  const unquoted = retold.map((s) => s.replace(/["“][^"”]*["”]/g, ""));
  if (!unquoted.length || !unquoted.every((s) => HEDGE.test(s))) return null;
  return HEDGE.exec(unquoted[0])?.[0] ?? null;
}

/**
 * Year not in the retold sentence (its clause, if split by a semicolon), a related one, or the one
 * before or after, or null: "at the 1990 halftime show" for "at that year's ceremony", 2000 before
 */
export function misplacedYear(fact: string, context: string): string | null {
  const years = fact.match(YEAR) ?? [];
  if (!years.length) return null;
  const sentences = bodySentences(context);
  const scored = sentences.map((s, i) => ({ s, i, share: share(fact, s) }));
  const best = Math.max(0, ...scored.map((x) => x.share));
  if (best < 0.25) return null;
  const retold = scored.filter((x) => x.share >= best - 0.1);
  const related = scored.filter((x) => x.share >= 0.3).map((x) => x.s);
  const before = retold.flatMap((x) => [sentences[x.i - 1] ?? "", sentences[x.i + 1] ?? ""]);
  const withoutYears = fact.replace(YEAR, "");
  for (const y of years) {
    if (![...retold.map((x) => x.s), ...related, ...before].some((s) => hasWord(y, s))) return y;
    // "In 2011, its biggest hit since 1985; the song gained airplay": the years are the other clause's
    const holders = retold.filter((x) => hasWord(y, x.s));
    if (holders.length && holders.every((x) => {
      const clauses = x.s.replace(/\s*\([^)]*;[^)]*\)/g, "").split(/;\s*/);
      if (clauses.length < 2) return false;
      const main = clauses.reduce((a, c) => (share(withoutYears, c) > share(withoutYears, a) ? c : a));
      return !hasWord(y, main);
    })) return y;
  }
  return null;
}

/** Whose detail it really is, or null: the video's told of the song, the single's sales of the album, a radio date as a peak's */
export function wrongOwner(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  // Video as the retold sentence's subject: "The music video for X was...", "Its video was shot"
  const videoFirst = /^(?:[^,]{0,40},\s*)?(?:the|its|their|his|her|an?)\s+(?:(?:official|music|lyric|accompanying|original)\s+)*videos?\b(?!\s*games?\b)/i;
  if (retold.length && !ABOUT_THE_VIDEO.test(fact) && retold.every((s) => videoFirst.test(s))) return "the music video";
  const figure = /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s+million\b/.exec(fact);
  if (figure) {
    const kinds = [{ name: "single", re: /\b(?:single|song|track)s?\b/i }, { name: "album", re: /\b(?:album|EP|LP)s?\b/i }];
    const own = kinds.map((k) => ({ ...k, at: fact.search(k.re) })).filter((k) => k.at >= 0).sort((a, b) => a.at - b.at)[0];
    const other = kinds.find((k) => k !== kinds.find((x) => x.name === own?.name));
    const holders = sourceSentences(context).filter((s) => s.includes(figure[0]));
    if (own && other && holders.length && holders.every((s) => !own.re.test(s) && other.re.test(s))) return `the ${other.name}`;
  }
  const month = new RegExp(`\\b(${MONTHS})\\b`).exec(fact);
  if (month && /\b(?:charted|peaked|reached|debuted|topped|climbed|entered)\b/i.test(fact) && !/\b(?:released|issued|radio|out)\b/i.test(fact)) {
    const releasedThen = new RegExp(`\\b(?:released|issued|serviced|sent|radio)\\b[^.;]{0,30}\\b${month[1]}\\b`, "i");
    const withMonth = retold.filter((s) => hasWord(month[1], s));
    if (withMonth.length && withMonth.every((s) => releasedThen.test(s))) return "the release, not the chart peak";
  }
  return null;
}

/** "An exception to X" with no "exception to" in the source: the caption supplied X, and small models get it backwards */
export function suppliedException(fact: string, context: string): boolean {
  return /\bexception to\b/i.test(fact) && !retoldSentences(fact, context).some((s) => /\bexception to\b/i.test(s));
}

/** Role turned round, or null: "Kai Moreno's voice actor" for "Juno's voice actor Kai Moreno" */
export function reversedRole(fact: string, context: string): string | null {
  for (const m of fact.matchAll(/((?:Mc)?\p{Lu}[\p{L}.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}.-]*){0,3})['’]s?\s+((?:voice actor|voice actress|producer|manager|singer|drummer|guitarist|bassist|keyboardist|pianist|composer|lyricist|wife|husband|brother|sister|son|daughter|father|mother))\b/gu)) {
    const who = m[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).join("\\s+");
    if (who && new RegExp(`\\b${m[2]}\\s+${who}\\b`, "u").test(context)) return m[2];
  }
  return null;
}
