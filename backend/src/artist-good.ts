import { articleText, MAX_FACT_CHARS, wikiExtract } from "./fact-verifier";
import { namesIdentity, sentencesOf, standardBreach } from "./content-standard";
import { neutralBreach } from "./neutral-wording";
import { escapeRe } from "./text";
import { setCapped } from "./capped-map";
import { artistGoodFromEntity, artistGoodLabels, sureArtist } from "./wikidata";

/**
 * The good an artist has done, from their own Wikipedia article (`KINDS`): charity and benefit
 * shows, movements, musicians' rights, the environment, preserving music, open sharing, teaching,
 * mentoring, community work, roles for a cause and honors. "Who they inspired" is left out:
 * untold by whom, it is an opinion (neutral-wording.ts).
 *
 * No AI writes these. A sentence is shown as the article wrote it, only with a leading
 * "He", "She", "They" or "The band" replaced by the artist's name, so it reads on its own
 * and can't say more than its source. Only a sentence in a section about that good, whose
 * subject is plainly the artist and whose verb is a thing they did, is taken. A thing named for
 * them ("A statue of her ...") counts in a section about honors.
 */

/**
 * The kinds of good, one row each. `headings`: sections about it. `words`: what a sentence must
 * name when its verb alone says nothing ("supported the album"). `anywhere`: the words are plain
 * enough to count in any section; the others only in a section about that good. `deedVerbsOnly`:
 * words that a verb of making music can sit beside by chance ("recorded at a college").
 */
const KINDS: Array<{ kind: string; headings: string; words: string; anywhere?: boolean; deedVerbsOnly?: boolean }> = [
  { kind: "charity", anywhere: true, headings: String.raw`philanthrop\w*|charit\w*|humanitarian\w*|benefits?|fundrais\w*|relief|causes?|foundations?|activis\w*|advocacy`, words: String.raw`charit\w+|foundations?|relief|humanitarian|non-?profits?|benefit (?:concerts?|shows?|albums?|singles?)|telethons?|fundrais\w+|Live Aid|Live 8|Farm Aid|hunger|famine|poverty|homeless\w*|refugees?|disaster|hurricane|earthquake|tsunami|UNICEF|UNHCR|Red Cross|Amnesty International|War Child|human rights|civil rights|peace` },
  { kind: "movement", anywhere: true, headings: String.raw`movements?|activis\w*`, words: String.raw`movements?` },
  { kind: "rights", anywhere: true, headings: String.raw`musicians' rights|artists' rights|royalt\w+|copyright`, words: String.raw`musicians' rights|artists' rights|fair pay|fair (?:royalt\w+|compensation)|royalt\w+ for|(?:own|ownership of) (?:his|her|their) (?:masters|master recordings|music|songs)|streaming (?:pay\w*|rates)` },
  { kind: "environment", anywhere: true, headings: String.raw`environment\w*|sustainab\w*|conservation`, words: String.raw`environment\w*|conservation|climate|wildlife|sustainab\w+|carbon|green(?:er)? tour\w*|rainforests?|reforest\w+|oceans?` },
  { kind: "preserving", anywhere: true, headings: String.raw`preserv\w*|archiv\w*|folk revival`, words: String.raw`traditional (?:songs?|music|tunes?)|folk songs|field recordings|endangered languages?|archives?|archival|restor\w+ recordings|preserv\w+ (?:the |of )?\w* ?(?:music|songs?|language|recordings?|tradition\w*)` },
  { kind: "sharing", anywhere: true, headings: String.raw`free releases?|open`, words: String.raw`free downloads?|for free|pay-what-you-want|Creative Commons|open[- ]licen[sc]\w+|stems|tape (?:their|his|her) (?:concerts|shows)|taping` },
  { kind: "teaching", deedVerbsOnly: true, headings: String.raw`teaching|education|masterclass\w*|residenc\w*|academic`, words: String.raw`education\w*|schools?|conservator\w+|academ\w+|universit\w+|colleges?|students|masterclass\w*|residenc\w+|scholarships?|literacy|instruments for` },
  { kind: "mentoring", headings: String.raw`mentor\w*|protég\w*|record labels?|studios?`, words: String.raw`young (?:musicians|artists|people|composers)|emerging (?:musicians|artists)|new artists|up-and-coming|newer artists|record labels?|recording studios?|imprint` },
  { kind: "community", headings: String.raw`community|social work|youth|outreach`, words: String.raw`youth|community|hometown|festivals?|music therapy|children's hospitals?|hospitals|USO|troops` },
  { kind: "roles", anywhere: true, headings: String.raw`ambassador\w*|boards?`, words: String.raw`ambassador|goodwill|musicians' (?:union|association)|Musicians' Union|Federation of Musicians|Songwriters Guild|Recording Academy|trustee|board of` },
  { kind: "honors", headings: String.raw`legacy|influence|impact|honou?rs?|awards?|accolades?|achievements?|tributes?|recognition|commemorat\w*`, words: "" },
];
const alternatives = (pick: (k: (typeof KINDS)[number]) => string) => KINDS.map(pick).filter(Boolean).join("|");
const GOOD_HEADING = new RegExp(String.raw`\b(?:${alternatives((k) => k.headings)})\b`, "i");
/** Sections about politics: left out with their subsections, whatever else the heading says. */
const POLITICS_HEADING = /\b(politic\w*|elections?|views|beliefs|opinions|campaigns?)\b/i;
const CAUSE = new RegExp(String.raw`\b(?:${alternatives((k) => k.words)})\b`, "i");
const PLAIN_CAUSE = new RegExp(String.raw`\b(?:${alternatives((k) => (k.anywhere ? k.words : ""))})\b`, "i");
const WITH_MUSIC_VERB = new RegExp(String.raw`\b(?:${alternatives((k) => (k.deedVerbsOnly ? "" : k.words))})\b`, "i");
const HONOR_WORD = /\b(Hall of Fame|Medal|Order of|Knight\w*|Dame|Kennedy Center|Prize|Award|Honou?rs?|honorary|Doctorate|Fellow|Laureate|Legion)\b/;

/** The first kind a sentence fits, so an artist's facts can take turns across kinds. */
function kindOf(text: string): string {
  return KINDS.find((k) => k.words && new RegExp(String.raw`\b(?:${k.words})\b`, "i").test(text))?.kind ?? "honors";
}

const AUX = String.raw`(?:(?:also|later|then|has|have|had|was|were|is|are|been|being|subsequently|publicly|long|actively|regularly|frequently|notably|personally|since|helped(?: to)?)\s+)*`;
/** Verbs that are a deed by themselves: "donated", "raised over $1 million". */
const DEED = new RegExp(String.raw`^${AUX}(?:donat(?:ed|es)|pledged|mentor(?:ed|s)|raised\s+(?:over|more than|about|nearly|US\$|\$|£|€|money|funds|millions|thousands))\b`, "i");
/** Verbs that need a cause in the sentence: "founded the Example Fund", not "joined the tour". */
const WITH_CAUSE = new RegExp(
  String.raw`^${AUX}(?:(?:co-?)?found(?:ed|s)?|establish(?:ed|es)?|launch(?:ed|es)?|start(?:ed|s)?|creat(?:ed|es)|set\s+up|support(?:ed|s)?|advocat(?:ed|es?)|campaign(?:ed|s)?\s+for|work(?:ed|s)?\s+(?:with|for)|partner(?:ed|s)\s+with|join(?:ed|s)?|lead|led|teach(?:es)?|taught|gave|gives|held|hold|host(?:ed|s)?|organi[sz](?:ed|es)|co-organi[sz]ed|curat(?:ed|es)|headlin(?:ed|es)|offer(?:ed|s)|allow(?:ed|s)|encourag(?:ed|es)|shar(?:ed|es)|discover(?:ed|s)|nurtur(?:ed|es)|preserv(?:ed|es)|revi(?:ved|ves)|restor(?:ed|es)|archiv(?:ed|es)|collect(?:ed|s)|document(?:ed|s)|planted|committed|visit(?:ed|s)|participat(?:ed|es)\s+in|t(?:ook|akes)\s+part\s+in|part\s+of|involved\s+in|(?:(?:became|serves?\s+as|served\s+as|acted\s+as|appointed|named)\s+)?(?:(?:a|an|the)\s+)?(?:[\p{L}'’-]+\s+){0,3}?(?:patron|ambassador|spokes(?:person|man|woman)|supporter|advocate|trustee|president|board\s+member|co-?founder|founder|leader|mentor|teacher|professor|envoy))\b`,
  "iu"
);
/** Making music: a deed only beside a cause that can't be there by chance. */
const MUSIC_VERB = new RegExp(String.raw`^${AUX}(?:perform(?:ed|s)\s+(?:at|in|for)|play(?:ed|s)\s+(?:at|in|for)|appear(?:ed|s)\s+(?:at|on)|sang\s+(?:at|on)|record(?:ed|s)|releas(?:ed|es)|produc(?:ed|es)|sign(?:ed|s))\b`, "i");
const HONORED = new RegExp(String.raw`^${AUX}(?:induct(?:ed)|award(?:ed)|receiv(?:ed|es)|nam(?:ed)|honou?red|knighted|present(?:ed)\s+with|given)\b`, "i");

/**
 * What keeps a sentence out: someone's report or plan rather than a deed, a nomination, a vague
 * line, and words pointing at a sentence around it. A partisan or contested subject is
 * `partisanBreach`, in the content standard.
 */
const NOT_A_PLAIN_DEED =
  /\b(said|says|stated|according|reportedly|allegedly|rumou?red|would|will|plans?|planned|planning|announced|intends?|hopes?|this|these|those|that year|same year|following year|next year|previous year|the album|the song|the tour|the single|the film|which|former|failed|unsuccessful|despite|however|critics?|criticized|criticised|nominat\w+|various|as well|the (?:project|fee|program|programme|event|organi[sz]ation|charity|foundation)|(?:his|her|their) efforts)\b|["“”:;]|\.\.\./i;

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
  const cut = /^(.{30,}?),\s(?:originally|which|who|including|with|as part of|in order to|to)\s/.exec(text);
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
  const honored = inSection && HONORED.test(tail) && HONOR_WORD.test(tail);
  const cause = inSection ? CAUSE.test(tail) : PLAIN_CAUSE.test(tail);
  const making = MUSIC_VERB.test(tail) && cause && WITH_MUSIC_VERB.test(tail);
  if (!(DEED.test(tail) && (inSection || cause)) && !(WITH_CAUSE.test(tail) && cause) && !making && !honored) return null;
  if (NOT_A_PLAIN_DEED.test(sentence)) return null;
  const text = shortened(`${date}${name} ${tail.replace(/\b(?:also|subsequently)\s+/i, "")}`.replace(/\s+/g, " ").trim());
  return text.length >= 30 && text.length <= MAX_FACT_CHARS ? text : null;
}

/**
 * Sentences of an artist's article (as `wikiExtract` gives it, already within the content standard)
 * telling the good they did, in article order: in a section about that good, or anywhere for the
 * plainest kinds. `name`: what the article calls them. A pronoun
 * counts only at the start of a paragraph or right after a sentence about the artist: anyone else
 * could be its "he" further on.
 */
export function goodSentences(full: string, name: string): string[] {
  const parts = name.trim().split(/\s+/);
  const surname = parts.length > 1 && !/^the$/i.test(parts[0]) ? (parts[parts.length - 1] as string) : "";
  const about = new RegExp(String.raw`^${DATED}(?:${escapeRe(name)}|${surname ? `${escapeRe(surname)}|` : ""}He|She|They|The band|The group)\s`, "iu");
  const out: string[] = [];
  const open: Array<{ level: number; good: boolean; politics: boolean }> = [];
  for (const line of full.split("\n")) {
    const h = heading(line);
    if (h) {
      while (open.length && open[open.length - 1].level >= h.level) open.pop();
      const parent = open[open.length - 1];
      open.push({ level: h.level, good: GOOD_HEADING.test(h.text) || Boolean(parent?.good), politics: POLITICS_HEADING.test(h.text) || Boolean(parent?.politics) });
      continue;
    }
    const here = open[open.length - 1];
    if (!here || here.politics) continue;
    let aboutArtist = true;
    for (const s of sentencesOf(line)) {
      const found = deed(s, name, aboutArtist, surname, here.good);
      if (found && !out.includes(found)) out.push(found);
      aboutArtist = about.test(s.trim());
    }
  }
  return out;
}

/** One fact of each kind before a second of any, in order, so a stream hears more than one side of the artist. */
export function takingTurns<T extends { text: string }>(facts: T[]): T[] {
  const rounds = new Map<string, number>();
  return facts
    .map((f, i) => {
      const kind = kindOf(f.text);
      const round = rounds.get(kind) ?? 0;
      rounds.set(kind, round + 1);
      return { f, i, round };
    })
    .sort((a, b) => a.round - b.round || a.i - b.i)
    .map((x) => x.f);
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
/** Halls of fame run long: this many, so the rest of what an artist did gets its turn. */
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
    const safe = (text: string) => !standardBreach(text, [name, ...names]) && !namesIdentity(text, [name, ...names]) && !neutralBreach(text, [name, ...names]);
    const sentences = goodSentences(full, name).filter(safe);
    // A statement a sentence already tells, with its date, is left to the sentence.
    const told = (text: string) => sentences.some((s) => s.includes(text.replace(/^.*? (?:the|an?) (?=\p{Lu})/u, "").replace(/\.$/, "")));
    const statements = fromWikidata.filter((text) => safe(text) && !told(text));
    const all = takingTurns([...sentences.map((text) => ({ text, page: artist.page })), ...statements.map((text) => ({ text, page: "" }))]);
    const facts = all.filter((f) => kindOf(f.text) !== "honors" || all.filter((o) => kindOf(o.text) === "honors").indexOf(f) < MAX_HONORS).slice(0, MAX_FACTS);
    console.log(`[ArtistGood] "${artist.page}": ${facts.length} facts`);
    setCapped(goodCache, artist.page, { facts, at: Date.now() }, MAX_ARTISTS);
    return facts;
  } catch (err) {
    console.warn(`[ArtistGood] Lookup failed for "${page}": ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
