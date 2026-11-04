import { escapeRe } from "../text";
import { mentionsName, normalizeTitle } from "../grounding/titles";
import { ABOUT_THE_VIDEO, hasWord, NAME_STOPWORDS, sourceSentences, YEAR } from "./names";
import { bodySentences, lineSentences, MONTHS, retoldSentences, share } from "./sentences";
import { speakers } from "./attribution";
import { capitalsOf } from "./frames";

/**
 * Wording a caption turns round: merged clauses, dropped hedges, misplaced
 * years, wrong owners and reversed roles.
 */

/**
 * Who did something told the wrong way round: "Bruno Vale compared his vocals to Sam
 * Ortiz" retelling "He compared Vale's vocals to Sam Ortiz", and "the sequel is
 * being worked on by Rob Lane" retelling "Rob Lane confirmed the sequel is being
 * worked on", and an event swapped for the one the sentence has: "at the Brit Awards"
 * retelling "at the Mercury Prize". Returns the name, or null.
 */
export function turnedRound(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (!retold.length) return null;
  const lead = /^((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(\p{Ll}+ed)\b/u.exec(fact);
  if (lead) {
    const name = lead[1].split(/\s+/).pop() as string;
    // "was developed by Rare" and "Rare developed" say the same.
    const passive = new RegExp(`\\b(?:was|were|is|are|been|being|be)\\s+(?:\\p{Ll}+\\s+)?${escapeRe(lead[2])}\\b|\\b${escapeRe(lead[2])}\\s+by\\b`, "u");
    const after = new RegExp(`\\b${escapeRe(lead[2])}\\b[^,;]*\\b${escapeRe(name)}['’]s?\\s`, "u");
    const before = new RegExp(`\\b${escapeRe(name)}\\b[^,;]*\\b${escapeRe(lead[2])}\\b`, "u");
    if (retold.every((s) => after.test(s) && !before.test(s) && !passive.test(s))) return name;
  }
  // "at the Brit Awards" retelling "at the Mercury Prize": both are in the article, but only one here.
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

/** Where a sentence stops one statement and starts another. */
const CLAUSE_BREAK = /,\s+(?=(?:who|whom|whose|which|while|whereas|but|although|though|after|before)\b)|;\s+/;

/**
 * Two statements of one sentence told as one, where every word is in the source: "formed
 * a songwriting team in 1976" from "It was formed in 1976 by Ann and Bo, who formed a
 * songwriting team". The caption's words sit mostly in one clause, and a year or a name it
 * joins to them sits only in another.
 * Returns the stray year or name, or null.
 */
export function mergedClauses(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  if (retold.length !== 1) return null;
  const clauses = retold[0].split(CLAUSE_BREAK).map((c) => c.trim()).filter(Boolean);
  if (clauses.length < 2) return null;
  const years = fact.match(YEAR) ?? [];
  // Names joined on with "with": the subject of a caption is usually who the sentence is about.
  const names = [...fact.matchAll(/\bwith ((?:\p{Lu}[\p{L}'’-]+\s?)+)/gu)].flatMap((m) => m[1].trim().split(/\s+/)).filter((n) => hasWord(n, retold[0]));
  const anchors = [...years, ...names];
  if (!anchors.length) return null;
  // What the caption says of them, without its names and years.
  const rest = fact.replace(YEAR, " ").replace(/\b\p{Lu}[\p{L}'’-]+/gu, " ");
  const scored = clauses.map((c, i) => ({ c, i, share: share(rest, c) })).sort((a, b) => b.share - a.share);
  if (scored[0].share < 0.5 || scored[0].share - scored[1].share < 0.2) return null;
  const main = scored[0];
  for (const a of anchors) {
    if (hasWord(a, main.c)) continue;
    const at = clauses.findIndex((c) => hasWord(a, c));
    // A name in an earlier clause is usually who the later one is about; a year never is.
    if (at >= 0 && (/^\d{4}$/.test(a) || at > main.i)) return a;
  }
  return null;
}

/** A heading for what isn't this recording: another performer's version, the single's B-sides. */
const OTHER_RECORDING_HEADING = /^(?:[^:\n]{2,40}\s(?:version|cover|rendition|remix)|cover versions?|other versions?|b-sides?|remixes)$/i;

/**
 * A caption from a section about another recording: `"Allemande" was played live` under
 * "B-sides", or "It was the second single from their LP" under "Nightjar version". The
 * sentence's "it" is that other recording, and the caption doesn't say so. Returns the heading, or null.
 */
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

/** Words that keep a statement uncertain. */
const HEDGE =
  /\b(?:may|might|could) have\b|\b(?:possibly|arguably|reportedly|allegedly|apparently|supposedly|purportedly|reputedly|rumou?red|probably|perhaps|presumably|unconfirmed|disputed)\b|\b(?:is|are|was|were) (?:said|believed|thought|reported|rumou?red|claimed) to\b|\bit is (?:said|believed|thought|claimed)\b|\b(?:legend|tradition) has it\b|\b(?:is|are|was|were) credited with\b|\bin part\b|\b(?:partly|partially)\b/i;

/**
 * A hedge the caption drops: "General Ardent suggested the symphony" when the
 * source says it "may have been suggested by General Ardent", or "The song is
 * inspired by a bus driver" for "was reportedly inspired". Every sentence the
 * caption retells hedges, and the caption doesn't. Returns the hedge, or null.
 */
export function droppedHedge(fact: string, context: string): string | null {
  if (HEDGE.test(fact) || /\baccording to\b/i.test(fact)) return null;
  const retold = retoldSentences(fact, context);
  // "Rowe called it "perhaps the first masterpiece"": a hedge inside a quote is the speaker's.
  const unquoted = retold.map((s) => s.replace(/["“][^"”]*["”]/g, ""));
  if (!unquoted.length || !unquoted.every((s) => HEDGE.test(s))) return null;
  return HEDGE.exec(unquoted[0])?.[0] ?? null;
}

/**
 * A year the sentence the caption retells doesn't place there: "demanded an
 * encore a week after its premiere in 1805" retelling "In 1807, after a
 * concert in Leipzig, the public demanded it again", or "performed it at the
 * 1990 halftime show" retelling "He performed it at that year's ceremony and
 * the halftime show", with 2000 in the sentence before. The year must be in
 * the retold sentence (in the clause the caption retells, when a semicolon
 * splits it), in another sentence the caption draws on, or in the one just
 * before or after. Returns the year, or null.
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
  // The sentence before ("In 2000, ... at that year's ceremony") or after ("... by Nazareth. Written in 1909, ...").
  const before = retold.flatMap((x) => [sentences[x.i - 1] ?? "", sentences[x.i + 1] ?? ""]);
  const withoutYears = fact.replace(YEAR, "");
  for (const y of years) {
    if (![...retold.map((x) => x.s), ...related, ...before].some((s) => hasWord(y, s))) return y;
    // "In 2011, it was the biggest hit since 1985; the song gained airplay": the year is the other clause's.
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

/**
 * A detail the source gives the song's video, single or album, told of
 * another of the three:
 *
 *   video   "The song was inspired by X" retelling "The music video was inspired by X".
 *   sales   "Her debut album sold over 500,000 copies" when every sentence with
 *           500,000 is about the single.
 *   radio   "charted at number 12 in August 2003" retelling "released to radio
 *           on August 12, 2003 and charted at number 12".
 *
 * Returns what the detail belongs to, or null.
 */
export function wrongOwner(fact: string, context: string): string | null {
  const retold = retoldSentences(fact, context);
  // The video is the retold sentence's subject: "The music video for X was inspired by", "Its video was shot".
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

/**
 * "an exception to his love of atmospheric music" when the source says only
 * "He noted that the series was an exception", after a sentence about what
 * he dislikes: the caption supplies what the exception is to, and a small
 * model gets it backwards. Kept when a retold sentence says "exception to".
 */
export function suppliedException(fact: string, context: string): boolean {
  return /\bexception to\b/i.test(fact) && !retoldSentences(fact, context).some((s) => /\bexception to\b/i.test(s));
}

/**
 * "Kai Moreno's voice actor" when the source says "Juno's voice actor Kai
 * Moreno": the role word followed by the caption's possessor makes that
 * person the one in the role. Returns the role, or null.
 */
export function reversedRole(fact: string, context: string): string | null {
  for (const m of fact.matchAll(/((?:Mc)?\p{Lu}[\p{L}.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}.-]*){0,3})['’]s?\s+((?:voice actor|voice actress|producer|manager|singer|drummer|guitarist|bassist|keyboardist|pianist|composer|lyricist|wife|husband|brother|sister|son|daughter|father|mother))\b/gu)) {
    const who = m[1].split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase())).join("\\s+");
    if (who && new RegExp(`\\b${m[2]}\\s+${who}\\b`, "u").test(context)) return m[2];
  }
  return null;
}
