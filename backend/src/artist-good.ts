import { articleText, MAX_FACT_CHARS, wikiExtract } from "./fact-verifier";
import { namesIdentity, sentencesOf, standardBreach } from "./content-standard";
import { neutralBreach } from "./neutral-wording";
import { escapeRe } from "./text";
import { setCapped } from "./capped-map";
import { artistGoodFromEntity, artistGoodLabels, diedOf, sureArtist } from "./wikidata";

/**
 * The good an artist has done, from their own Wikipedia article: charity and benefit shows,
 * teaching, mentoring, preserving and sharing music, roles for a cause, honors.
 *
 * No AI writes these. A sentence is shown only if it has the shape of a checkable act (`ACTS`):
 * an allow-list, because block-lists leak ("X supported Y" names a side on any subject). It is
 * shown as the article wrote it, only with a leading "He", "She", "They" or "The band" replaced by
 * the artist's name. A thing named for them ("A statue of her ...") counts in an honors section.
 * A movement counts by its name and the artist's part in it, or from Wikidata's statement: an
 * article's description of one is a characterization. `neutral-wording.ts` applies its lists on top.
 */

/** A verb only counts in the shape of a checkable act: a verb, then what the sentence must also name. */
const ORG = /\b(foundations?|funds?|charit\w+|trusts?|non-?profits?|scholarships?|schools?|academ\w+|institutes?|programs?|record labels?|labels?|studios?|festivals?|organi[sz]ations?|cent(?:er|re)s?|camps?|archives?|librar\w+|unions?|guilds?|associations?)\b/i;
const BENEFIT = /\b(charit\w+|benefit|telethons?|fundrais\w+|relief|Live Aid|Live 8|Farm Aid|Red Cross|UNICEF)\b/i;
const ROLE = /\b(ambassador|patron|envoy|trustee|board member|chair(?:man|woman|person)?|(?:president|treasurer|secretary) of .*\b(?:union|guild|federation|association|society))\b/i;
const HONOR = /\b(Hall of Fame|Medal|Order of|Knight\w*|Dame|Kennedy Center|Prize|Awards?|Honou?rs?|honorary|Doctorate|Fellow|Laureate|Legion)\b/;
const SCHOOL = /\b(conservator\w+|universit\w+|colleges?|schools?|academ\w+)\b/i;
const PRESERVED = /\b(traditional (?:songs?|music|tunes?)|folk songs|field recordings|endangered languages?|archives?|archival|recordings)\b/i;
const NEW_ARTISTS = /\b(young|emerging|new|newer|up-and-coming) (?:musicians|artists|composers|bands)\b/i;
/**
 * A movement in music or the arts, by its name: "Tropica, a musical movement", "the Tropica art movement".
 * Never a description ("a consciousness movement"), and never a movement in general: "took part in"
 * a political one states a side, and no list can name them all.
 */
const NAMED_MOVEMENT = /(?<![\p{L}\p{N}])\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*(?:,\s+an?(?:\s+[\p{L}-]+){0,2})?\s+(?:music|musical|art|artistic|cultural|literary|dance|film)\s+movement\b/u;
const SHARED = /\b(free downloads?|for free|pay-what-you-want|Creative Commons|open[- ]licen[sc]\w+|stems)\b/i;

/**
 * Every act a sentence may tell (`inSection`: only in a section about such things, where a
 * concert or an honor is one of them). The rest fails by not matching: "supported", "opposed",
 * "backed", "lobbied", "campaigned", "is involved in" say where someone stands, not what they did.
 */
const ACTS: Array<{ verb: string; needs: RegExp; inSection?: boolean }> = [
  { verb: String.raw`(?:co-?)?found(?:ed|s)|establish(?:ed|es)|set up|launch(?:ed|es)|start(?:ed|s)|creat(?:ed|es)`, needs: ORG },
  { verb: String.raw`(?:co-?)?found(?:ed|s)|helped\s+(?:to\s+)?(?:found|lead|start|develop|create)|led|leads|t(?:ook|akes)\s+part\s+in|an?\s+(?:co-?)?founder\s+of`, needs: NAMED_MOVEMENT },
  { verb: String.raw`donat(?:ed|es)`, needs: /\b(?:to|for)\b/ },
  { verb: String.raw`raised\s+(?:money|funds|over|more than|about|nearly|millions|thousands|US\$|\$|£|€)`, needs: /\b(?:to|for)\b/ },
  { verb: String.raw`(?:produced and )?(?:perform(?:ed|s)|play(?:ed|s)|appear(?:ed|s)|sang)\s+(?:at|in|on|for)|headlin(?:ed|es)|(?:co-)?organi[sz](?:ed|es)|host(?:ed|s)|record(?:ed|s)|releas(?:ed|es)`, needs: BENEFIT },
  { verb: String.raw`perform(?:ed|s)\s+at|play(?:ed|s)\s+at|headlin(?:ed|es)|(?:co-)?organi[sz](?:ed|es)|host(?:ed|s)`, needs: /\b(?:concerts?|festivals?)\b/i, inSection: true },
  { verb: String.raw`named|appointed|became|serve[sd]\s+as`, needs: ROLE },
  { verb: String.raw`taught|teach(?:es)?`, needs: SCHOOL },
  { verb: String.raw`gave|held|holds`, needs: /\b(?:masterclass\w*|residenc\w+)\b/i },
  { verb: String.raw`induct(?:ed)|award(?:ed)|receiv(?:ed|es)|nam(?:ed)|honou?red|knighted|presented\s+with|given`, needs: HONOR, inSection: true },
  { verb: String.raw`preserv(?:ed|es)|revi(?:ved|ves)|restor(?:ed|es)|archiv(?:ed|es)|collect(?:ed|s)|document(?:ed|s)|record(?:ed|s)`, needs: PRESERVED },
  { verb: String.raw`mentor(?:ed|s)`, needs: /\s/ },
  { verb: String.raw`sign(?:ed|s)|produc(?:ed|es)|discover(?:ed|s)`, needs: NEW_ARTISTS },
  { verb: String.raw`releas(?:ed|es)|offer(?:ed|s)`, needs: SHARED },
  { verb: String.raw`planted`, needs: /\b(?:trees|forests?)\b/i },
];
const AUX = String.raw`(?:(?:also|later|then|has|have|had|was|were|been|subsequently)\s+)*`;
const ACT_RES = ACTS.map((a) => ({ ...a, re: new RegExp(String.raw`^${AUX}(?:${a.verb})\b`, "i") }));
/** Sections where a plain concert or an honor is part of the good. */
const GOOD_HEADING = /\b(philanthrop\w*|charit\w*|humanitarian\w*|benefits?|fundrais\w*|relief|foundations?|community|youth|outreach|legacy|impact|honou?rs?|awards?|accolades?|achievements?|tributes?|recognition|commemorat\w*)\b/i;
/** Sections about politics: left out with their subsections, whatever else the heading says. */
const POLITICS_HEADING = /\b(politic\w*|elections?|views|beliefs|opinions|campaigns?)\b/i;

/**
 * What keeps a sentence out: someone's report or plan rather than an act, a nomination, a vague
 * line, and words pointing at a sentence around it. What may not be said at all is `neutralBreach`.
 */
const NOT_A_PLAIN_DEED =
  /\b(said|says|stated|according|rumou?red|would|will|plans?|planned|planning|announced|intends?|hopes?|this|these|those|that year|same year|following year|next year|previous year|the album|the song|the tour|the single|the film|which|former|failed|unsuccessful|despite|however|critics?|criticized|criticised|nominat\w+|various|as well|the (?:project|fee|program|programme|event|organi[sz]ation|charity|foundation)|(?:his|her|their) efforts)\b|["“”:;]|\.\.\./i;

/** Something named for or showing the artist: "A statue of her stands in ...", "Asteroid 1234 was named after him". */
const NAMED_THING =
  String.raw`(?:statues?|bronze|monument|street|road|avenue|boulevard|square|plaza|park|bridge|asteroid|minor planet|crater|species|genus|postage stamps?|stamps?|mural|plaque)`;
const TRIBUTE = String.raw`(?:named (?:after|for|in honou?r of)|in honou?r of|honou?ring|of|depicting|commemorating|featuring)`;

/** A date in front of the subject: "In 2005, ", "Since the 1990s, ". */
const DATED = String.raw`(?:(?:In|Since|By|During|From)\s+(?:the\s+)?(?:(?:early|mid|late)\s+)?\d{4}s?,?\s+)?`;

/** A heading line: its level and words. */
function heading(line: string): { level: number; text: string } | null {
  const m = /^(==+)\s*(.+?)\s*==+\s*$/.exec(line.trim());
  return m ? { level: m[1].length, text: m[2] } : null;
}

/** A sentence too long for a bubble, without a closing clause that only adds to it. Dropping one can't overstate the act. */
function shortened(text: string): string {
  if (text.length <= MAX_FACT_CHARS) return text;
  const cut = /^(.{30,}?)(?:,\s(?:originally|which|who|including|with|as part of|in order to|to)|\s(?:that|which))\s/.exec(text);
  return cut && cut[1].length < MAX_FACT_CHARS ? `${cut[1]}.` : text;
}

/** A sentence whose subject is a thing named for the artist, with its pronoun made the name. */
function tribute(sentence: string, name: string, pronounOk: boolean): string | null {
  const who = String.raw`(?:(${escapeRe(name)})|(him|her|them))`;
  const m = new RegExp(String.raw`^(?:${DATED})(?:A|An|The|Asteroid|Minor planet)?\b.{0,70}?\b${NAMED_THING}\b.{0,50}?\b${TRIBUTE}\s+${who}\b`, "isu").exec(sentence.trim());
  if (!m || (m[2] && !pronounOk) || NOT_A_PLAIN_DEED.test(sentence)) return null;
  const text = m[2] ? sentence.trim().replace(new RegExp(String.raw`\b${m[2]}\b`), name) : sentence.trim();
  return text.length <= MAX_FACT_CHARS ? text : null;
}

/** The sentence with its subject as the artist's name, or null when it isn't plainly about the artist doing good. */
function deed(sentence: string, name: string, pronounOk: boolean, surname: string, inSection: boolean): string | null {
  const named = [name, surname].filter(Boolean).map(escapeRe).join("|");
  const m = new RegExp(String.raw`^(${DATED})(?:(${named})|(He|She|They|The band|The group|The duo|The trio))(\s.*)$`, "isu").exec(sentence.trim());
  if (!m) return inSection ? tribute(sentence, name, pronounOk) : null;
  const [, date, , pronoun, rest] = m;
  if (pronoun && !pronounOk) return null;
  const tail = rest.trimStart();
  // "Some Name Archives holds ...": a name, not the artist doing something.
  if (!/^\p{Ll}/u.test(tail)) return null;
  if (!ACT_RES.some((a) => a.re.test(tail) && a.needs.test(tail) && (inSection || !a.inSection))) return null;
  if (NOT_A_PLAIN_DEED.test(sentence)) return null;
  const text = shortened(`${date}${name} ${tail.replace(/\b(?:also|subsequently)\s+/i, "")}`.replace(/\s+/g, " ").trim());
  return text.length >= 30 && text.length <= MAX_FACT_CHARS ? text : null;
}

/**
 * Sentences of an artist's article (as `wikiExtract` gives it, already within the content standard)
 * telling the good they did, in article order. `name`: what the article calls them. A pronoun
 * counts only at the start of a paragraph or right after a sentence about the artist: anyone else
 * could be its "he" further on.
 */
export function goodSentences(full: string, name: string): string[] {
  const parts = name.trim().split(/\s+/);
  const surname = parts.length > 1 && !/^the$/i.test(parts[0]) ? (parts[parts.length - 1] as string) : "";
  const about = new RegExp(String.raw`^${DATED}(?:${escapeRe(name)}|${surname ? `${escapeRe(surname)}|` : ""}He|She|They|The band|The group)\s`, "iu");
  const out: string[] = [];
  const open: Array<{ level: number; good: boolean; politics: boolean }> = [];
  // The article's first sentence is about its subject, however fully it spells their name.
  let opening = true;
  for (const line of full.split("\n")) {
    const h = heading(line);
    if (h) {
      while (open.length && open[open.length - 1].level >= h.level) open.pop();
      const parent = open[open.length - 1];
      open.push({ level: h.level, good: GOOD_HEADING.test(h.text) || Boolean(parent?.good), politics: POLITICS_HEADING.test(h.text) || Boolean(parent?.politics) });
      continue;
    }
    const here = open[open.length - 1];
    if (here?.politics) continue;
    let aboutArtist = true;
    for (const s of sentencesOf(line)) {
      const found = deed(s, name, aboutArtist, surname, Boolean(here?.good));
      if (found && !out.includes(found)) out.push(found);
      aboutArtist = opening || about.test(s.trim());
      opening = false;
    }
  }
  return out;
}

const HONOR_FACT = /\b(inducted|received|awarded|honou?red|made an?|presented with|given)\b/;

/** Acts first, then at most `maxHonors` honors: halls of fame run long, and the rest of what an artist did gets its turn. */
export function actsFirst<T extends { text: string }>(facts: T[], maxHonors: number): T[] {
  return [...facts.filter((f) => !HONOR_FACT.test(f.text)), ...facts.filter((f) => HONOR_FACT.test(f.text)).slice(0, maxHonors)];
}

/** One fact, and the English article it comes from ("" for Wikidata). */
export interface GoodFact {
  text: string;
  page: string;
}

const NEGATIVE_TTL_MS = 30 * 60 * 1000;
const MAX_ARTISTS = 200;
/** Enough to take turns over a stream without one artist's list growing long. */
const MAX_FACTS = 10;
const MAX_HONORS = 3;
const goodCache = new Map<string, { facts: GoodFact[]; at: number }>();

export function clearArtistGoodCache(): void {
  goodCache.clear();
}

/**
 * The facts about the good a surely matched artist did: from their article's sections first,
 * then Wikidata, all within the content standard and away from partisan politics. `page`: the
 * surely matched article; `names`: the request's artist. [] when the artist isn't sure. Never throws.
 */
export async function artistGoodFacts(page: string, names: string[]): Promise<GoodFact[]> {
  try {
    const artist = await sureArtist(page, names);
    if (!artist) return [];
    const hit = goodCache.get(artist.page);
    if (hit && (hit.facts.length || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.facts;
    const name = artist.entity.labels?.en?.value ?? artist.entity.labels?.mul?.value ?? "";
    const full = articleText(artist.page) || (await wikiExtract(artist.page)) || "";
    const fromWikidata = artistGoodFromEntity(artist.entity, await artistGoodLabels(artist.entity));
    // A cause named after a people or a faith counts too, even where its capitals read as a name.
    const safe = (text: string) => !standardBreach(text, [name, ...names]) && !namesIdentity(text, [name, ...names]) && !neutralBreach(text, [name, ...names], !diedOf(artist.entity));
    const sentences = goodSentences(full, name).filter(safe);
    // A statement a sentence already tells, with its date, is left to the sentence.
    const told = (text: string) => sentences.some((s) => s.includes(text.replace(/^.*? (?:the|an?) (?=\p{Lu})/u, "").replace(/\.$/, "")));
    const statements = fromWikidata.filter((text) => safe(text) && !told(text));
    const facts = actsFirst([...sentences.map((text) => ({ text, page: artist.page })), ...statements.map((text) => ({ text, page: "" }))], MAX_HONORS).slice(0, MAX_FACTS);
    console.log(`[ArtistGood] "${artist.page}": ${facts.length} facts`);
    setCapped(goodCache, artist.page, { facts, at: Date.now() }, MAX_ARTISTS);
    return facts;
  } catch (err) {
    console.warn(`[ArtistGood] Lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
