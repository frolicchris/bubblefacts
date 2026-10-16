/**
 * The source cleaner: fixes the reference text before the writer reads it,
 * so the small model has less to get wrong. Deterministic, high-precision
 * rules only; a sentence the rules can't make safe is left out.
 *
 * - Unnamed subjects (`decontextualize`): a sentence opening with "It",
 *   "Its", "The song", "The game" or "The album" names its subject when the
 *   subject is certain: the article's own subject in its lead or in a section
 *   about the song itself, or the track a section's heading names. Facts
 *   from a section about another named thing ("Kirby 64", "With duo
 *   Wildlight") say so: "About Kirby 64: ...". A lifted sentence ("How it
 *   was received") whose subject can't be named is left out.
 * - Opinions (`attributeOpinions`): a view ("praised", "regarded",
 *   "described as", a review section) is kept only when it names who holds
 *   it, and a statement of theirs reads "According to <holder>, ...".
 *
 * Reference layout (`orderExtract`): the article title, then blocks parted by
 * a blank line, each opening with its label ("From the people who made it: ",
 * "Development: "), and the lead last, unlabeled.
 */

/** Switches for measuring each step on its own. Both on in the app. */
export const sourceCleaning = { decontextualize: true, attributeOpinions: true };

const LIFTED = /^(About this piece|From the people who made it|How the music is built|How it was received): /;
const HEADING = /^([^:\n.!?"“]{1,80}): /;
/** A sentence break: not after a middle initial, and only before a capital. */
const SENTENCE_BREAK = /(?<!(?:^|[^\p{L}])\p{Lu}\.)(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})/u;

type Kind = "song" | "album" | "game" | "other";
interface Subject { name: string; kind: Kind; certain: boolean }

/** What the article is about, and what kind of thing it is. */
function subjectOf(title: string, lead: string): Subject {
  const qualifier = /\(([^)]*)\)\s*$/.exec(title)?.[1] ?? "";
  const name = title.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const says = `${qualifier} ${/\b(?:is|was|are)\b[^.]{0,120}/.exec(lead)?.[0] ?? ""}`;
  const kind: Kind = /\b(?:song|single|track|theme|anthem|ballad|tune)\b/i.test(qualifier || says) && !/\balbum\b/i.test(qualifier)
    ? "song"
    : /\b(?:album|EP|soundtrack)\b/i.test(qualifier || says) ? "album"
    : /\bgame\b/i.test(qualifier || says) ? "game" : "other";
  // The lead's formula, "<Title> is a song by ...", makes the subject certain.
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const certain = new RegExp(`^["“]?${esc}["”]?(?:,[^,]{0,80},)?\\s+(?:is|was|are|were)\\s+(?:an?|the)\\b`, "i").test(lead.trim());
  return { name, kind, certain };
}

/** How a sentence names the subject in place of "It". */
function named(s: Subject): string {
  if (s.kind === "song") return `"${s.name}"`;
  if (s.kind === "album") return `The album ${s.name}`;
  return s.name;
}

const quoted = (track: string) => `"${track}"`;
const normal = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mentions = (text: string, name: string) => Boolean(name) && ` ${normal(text)} `.includes(` ${normal(name)} `);

/** "It is said that", "It took two years": an "it" that stands for no one. */
const EMPTY_IT =
  /^It (?:is|was|has been|had been|seems|seemed|appears|appeared|remains|remained|would be) (?:\w+ ){0,2}?(?:reported|said|believed|thought|claimed|rumou?red|unclear|known|unknown|possible|impossible|likely|unlikely|estimated|alleged|speculated|noted|clear|evident|hard|difficult|easy|important|true|notable|common|rare|uncommon)\b|^It took\b/;
/** The openers that lean on a subject named elsewhere. */
const OPENER = /^(["“]?)(It|Its|The song|The track|The game|The album|These|This|The project)\b/;

/**
 * A heading that names a different thing than the article's subject: a
 * capitalized word past the first ("With duo Wildlight", "Pink Floyd") or a
 * number in a title ("Kirby 64"), and no mention of the subject or track.
 */
function namesOther(heading: string, subject: Subject, track: string): boolean {
  const bare = heading.replace(/\s*\([^)]*\)?\s*$/, "").trim();
  if (mentions(bare, subject.name) || mentions(bare, track)) return false;
  const words = bare.split(/\s+/);
  if (words.length > 8) return false;
  return words.slice(1).some((w) => /^\p{Lu}/u.test(w)) || words.slice(1).some((w) => /^\d{1,3}$/.test(w));
}

/** Names the subject a sentence leans on, or null when it can't be sure. */
function resolve(sentence: string, about: Subject | null): string | null {
  const m = OPENER.exec(sentence);
  if (!m || !about) return null;
  const [whole, q, opener] = m;
  const rest = sentence.slice(whole.length);
  if (opener === "It") return EMPTY_IT.test(sentence.slice(q.length)) ? null : `${q}${named(about)}${rest}`;
  if (opener === "Its") return `${q}${named(about)}'s${rest}`;
  const want: Record<string, Kind[]> = { "The song": ["song"], "The track": ["song"], "The game": ["game"], "The album": ["album"] };
  if (want[opener]?.includes(about.kind)) return `${q}${about.kind === "album" ? named(about) : about.kind === "song" ? quoted(about.name) : about.name}${rest}`;
  return null;
}

/* ---------- opinions ---------- */

/** A view, not a fact: the cue words of the plan plus their close kin. */
const OPINION_CUE =
  /\b(?:praised|praising|acclaimed|acclaim|applauded|lauded|commended|hailed|regarded|described as|has been described|have been described|iconic|masterpiece|called (?:it|them|him|her|this|the (?:song|track|album|game|record|score|soundtrack|band|piece))\b|considered (?:to be|one of|among|as|by)\b|(?:is|are|was|were|been|widely|often|generally|commonly|largely) considered (?:a|an|the|his|her|their|its)\b|(?:one of|among) the (?:\w+ )?(?:best|greatest)\b|the (?:best|greatest) (?:\w+ )?(?:songs?|albums?|games?|tracks?|singles?|soundtracks?|scores?|records?|bands?|acts?|artists?|musicians?|guitarists?|composers?|singers?)\b)/;
/**
 * Puffery and unsupported attribution from Wikipedia's Manual of Style
 * "Words to watch", which its editors apply consistently. Lowercase only:
 * "Best Original Score" is an award, "Great Britain" a place.
 */
const PUFFERY =
  /\b(?:legendary|great(?![- ](?:deal|grand|uncle|aunt|many))|visionary|outstanding|celebrated|award-winning|landmark|cutting-edge|innovative|revolutionary|extraordinary|brilliant|famous|renowned|remarkable|prestigious|world-class|respected|virtuoso|unique|pioneering|phenomenal|prominent)\b|\bbest\b(?![- ](?:selling|known|friend|of\b|man\b))/;
/** Words that are opinion only without a number beside them: a "hit" or a "leading" act on a chart is a fact. */
const PUFFERY_UNLESS_COUNTED = /\b(?:hit|popular|leading|notable)\b/;
const UNSUPPORTED =
  /\bit is (?:often |widely |generally |commonly )?(?:believed|regarded|considered|said|reported)\b|\b(?:widely|generally) regarded\b|\bmany consider\b|\bsome critics\b/i;
const PUFF_WORDS = "legendary|great|visionary|outstanding|celebrated|award-winning|landmark|cutting-edge|innovative|revolutionary|extraordinary|brilliant|famous|renowned|remarkable|prestigious|world-class|respected|virtuoso|unique|pioneering|phenomenal|prominent";

/**
 * A puff word used as an adjective comes out: "a renowned harpist" reads
 * "a harpist", "popular 1996 games" reads "1996 games" (unless a number
 * backs "popular" or "leading"). What's left is still the source's
 * statement, minus the praise. "Best" and "hit" stay: "nominated for best
 * female artist" and "a hit" lose their meaning without them.
 */
export function withoutPuffery(sentence: string): string {
  const words = COUNTABLE.test(sentence) ? PUFF_WORDS : `${PUFF_WORDS}|popular|leading|notable`;
  // Only an adjective before its noun: not "most popular" (a ranking), not "notable for" (a claim).
  const puff = new RegExp(`(?<!\\b(?:most|more|less|least) )\\b(?:very |highly |widely |internationally |critically |once )?(?:${words})(?:,? and (?:${words}))?(?:, and |, | and | )(?!(?:for|as|in|to|of|at|with|among|on|by|and|than)\\b)(?=[\\p{L}\\d"“])`, "gu");
  // Never inside a quotation: those are someone's own words.
  const out = sentence.split(/(["“][^"”]*["”])/).map((part, i) => (i % 2 ? part : part.replace(puff, ""))).join("");
  if (out === sentence) return sentence;
  // "an innovative design" lost its adjective: "a design".
  return out.replace(/\b([Aa])n (?=[^aeiouAEIOU\s"“])/g, "$1 ").replace(/\b([Aa]) (?=[aeiouAEIOU])/g, "$1n ");
}

/** Sections of plain data: never an opinion. */
const DATA_HEADING = /^(?:charts?|weekly charts|year-end charts|certifications?(?: and sales)?|track ?listings?|personnel|credits|release history)$/i;
/** Sections that are other people's opinions. */
const OPINION_HEADING = /reception|critic|review|legacy|reaction|response|impact|accolade|reputation|assessment/i;
/** What can be counted isn't an opinion: charts, sales, awards. */
const COUNTABLE = /\b(?:number[- ]one|number \d+|No\. ?\d+|top (?:ten|five|forty|\d+)|topped|peaked|charted|charts?|won|awards?|awarded|prizes?|nominat\w+|shortlist\w*|recogni[sz]ed|honou?red|inducted|certified|platinum|gold|sold|sales|copies|million|units|streams)\b/i;

const SAYS = "said|says|stated|states|wrote|writes|noted|notes|argued|argues|felt|feels|thought|thinks|opined|commented|remarked|observed|claimed|believed|believes|declared|added|concluded|asserted|insisted|explained|admitted|confirmed|denied|speculated";
const VIEWS = "considered|considers|described|describes|called|calls|praised|praises|applauded|lauded|hailed|acclaimed|named|ranked|listed|deemed|regarded|regards|likened|compared|commended|highlighted|gave|rated|included|placed|cited|singled out";
const VERB = new RegExp(`\\b(${SAYS}|${VIEWS})\\b`, "g");
const SAYS_VERB = new RegExp(`^(?:${SAYS})$`);
/** Words between a holder and the verb: "also", "has". "Was" makes it passive. */
const BETWEEN = /(?:\s+(?:also|later|once|then|ultimately|retrospectively|has|have|had|both|each|first|famously|similarly))*\s*$/;
const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+$/;
/** Capitalized words that aren't anyone. */
const NOT_A_HOLDER = new Set(
  "the a an it its he she they we i you this these that those critics critic reviewers reviewer many some most several fans others players listeners music journalists writers publications retrospective contemporary in on at after upon while when although however his her their both all other various numerous one there".split(" ")
);
/** A capitalized run, with "of", "the", "to", "and" inside: "The A to X of Alternative Music", "AllMusic's Stephen Thomas Erlewine". */
const NAME_RUN = /((?:(?:Mc)?\p{Lu}[\p{L}\p{N}'’.&-]*)(?:\s+(?:(?:of|the|to|for|and|de|van|von|du|la|le)\s+)*(?:Mc)?\p{Lu}[\p{L}\p{N}'’.&-]*)*)$/u;

function asHolder(run: string): string | null {
  const words = run.split(/\s+/).filter(Boolean);
  while (words.length && NOT_A_HOLDER.has(words[0].toLowerCase()) && !(words[0] === "The" && words.length > 1)) words.shift();
  if (!words.length || words.every((w) => NOT_A_HOLDER.has(w.toLowerCase()))) return null;
  return words.join(" ");
}

interface Holder { name: string; start: number; verb: string; after: number }

/** Who holds the view: "according to X", a name right before a verb of saying or judging, or "by X" after a passive one. */
export function holderOf(sentence: string): Holder | null {
  const acc = /\baccording to ((?:\p{Lu}[\p{L}\p{N}'’.&-]*)(?:\s+(?:(?:of|the|and)\s+)*\p{Lu}[\p{L}\p{N}'’.&-]*)*)/u.exec(sentence);
  if (acc && asHolder(acc[1])) return { name: asHolder(acc[1]) as string, start: -1, verb: "according to", after: -1 };
  for (const v of sentence.matchAll(VERB)) {
    const before = sentence.slice(0, v.index);
    if (PASSIVE.test(before)) {
      const by = /^[^.;]*?\bby ((?:\p{Lu}[\p{L}\p{N}'’.&-]*)(?:\s+(?:(?:of|the|and)\s+)*\p{Lu}[\p{L}\p{N}'’.&-]*)*)/u.exec(sentence.slice((v.index ?? 0) + v[0].length));
      const name = by ? asHolder(by[1]) : null;
      if (name) return { name, start: -1, verb: v[1], after: -1 };
      continue;
    }
    const lead = before.replace(BETWEEN, "");
    const run = NAME_RUN.exec(lead.replace(/\s+$/, ""));
    const name = run ? asHolder(run[1]) : null;
    if (name) return { name, start: lead.length - run![1].length + run![1].indexOf(name), verb: v[1], after: (v.index ?? 0) + v[0].length };
  }
  // "Brightline gave it 8 out of 10, calling it ...": the sentence's subject holds the view.
  if (/\b(?:calling|describing|praising|saying|noting|writing|deeming|hailing|naming|ranking)\b/.test(sentence)) {
    const run = /^((?:\p{Lu}[\p{L}\p{N}'’.&-]*)(?:\s+(?:(?:of|the|and)\s+)*\p{Lu}[\p{L}\p{N}'’.&-]*)*)/u.exec(sentence);
    const name = run ? asHolder(run[1]) : null;
    if (name && !/^(?:saying|calling)\b/.test(sentence.slice(run![1].length).trim())) {
      const said = /^\s+(?:said|says|stated|wrote|writes|noted|commented|remarked)\b/.test(sentence.slice(run![1].length));
      if (!said) return { name, start: -1, verb: "participle", after: -1 };
    }
  }
  return null;
}

/** Whether a sentence states someone's view. */
export function isOpinion(sentence: string, heading: string): boolean {
  if (DATA_HEADING.test(heading.trim())) return false;
  if (OPINION_CUE.test(sentence) || PUFFERY.test(sentence) || UNSUPPORTED.test(sentence)) return true;
  if (PUFFERY_UNLESS_COUNTED.test(sentence) && !COUNTABLE.test(sentence)) return true;
  return OPINION_HEADING.test(heading) && !COUNTABLE.test(sentence);
}

/**
 * A view with its holder up front: "Ana Ruiz wrote that the chorus is
 * the band's best" reads "According to Ana Ruiz, the chorus is the band's
 * best"; "Brightline praised the album, saying, "..."" reads "According to
 * Brightline, "..."". A sentence already shaped "X praised Y" stays as it is.
 */
export function attributed(sentence: string, h: Holder): string {
  if (h.verb === "according to" || h.start < 0) return sentence;
  const atStart = sentence.slice(0, h.start).trim() === "" || /^[\p{Lu}][^,]{0,40},\s*$/u.test(sentence.slice(0, h.start));
  if (!atStart) return sentence;
  const rest = sentence.slice(h.after);
  const saying = /^[^"“]*?,?\s+saying,?\s+(["“].*)$/u.exec(rest);
  if (saying) return `According to ${h.name}, ${saying[1]}`;
  if (!SAYS_VERB.test(h.verb)) return sentence;
  // "stated in 2001 that ...": the time stays with the holder.
  const that = /^,?\s+((?:in|on|during|at|later|also|once)\b[^,"“]{0,40}?\s+)?that\s+(.+)$/s.exec(rest);
  if (that) return `According to ${h.name}${that[1] ? ` ${that[1].trim()}` : ""}, ${that[2]}`;
  const clause = rest.replace(/^,?\s+/, "");
  // "said: ..." or anything else: keep the sentence whole.
  if (!clause || /^[:"“]/.test(clause) || /^(?:in|on|during|at|to|with|of|about|for|by)\b/i.test(clause)) return sentence;
  return `According to ${h.name}, ${clause}`;
}

/* ---------- the pass ---------- */

export interface CleanStats { resolved: number; marked: number; softened: number; attributed: number; dropped: number }

/**
 * The reference, cleaned. `track` is the requested track when the article is
 * a whole game's or album's; `ownSong` is whether the article is about the
 * request itself (then its sections are about the song itself too).
 */
export function cleanSource(context: string, opts: { track?: string; ownSong: boolean }, stats: CleanStats = { resolved: 0, marked: 0, softened: 0, attributed: 0, dropped: 0 }): string {
  const { decontextualize, attributeOpinions } = sourceCleaning;
  if (!context || (!decontextualize && !attributeOpinions)) return context;
  const [title, ...restLines] = context.split("\n");
  const blocks = restLines.join("\n").split(/\n{2,}/);
  const subject = subjectOf(title, blocks[blocks.length - 1] ?? "");
  const track = opts.track ?? "";
  const out = blocks.map((block, bi) => {
    const isLead = bi === blocks.length - 1 && !LIFTED.test(block);
    const lifted = LIFTED.exec(block)?.[1] ?? "";
    const heading = lifted ? "" : isLead ? "" : HEADING.exec(block)?.[1] ?? "";
    const other = Boolean(heading) && namesOther(heading, subject, track);
    const namesTrack = Boolean(heading && track) && mentions(heading, track);
    // Whose "it" this is: the track a heading names, the article's subject in its lead or in the song's own sections.
    const about: Subject | null = namesTrack || (lifted === "About this piece" && track) ? { name: track, kind: "song", certain: true } : other || !subject.certain ? null : isLead || lifted === "How it was received" || opts.ownSong ? subject : null;
    const label = lifted || heading;
    return block.split("\n").map((line, li) => {
      const own = li === 0 && label && line.startsWith(`${label}: `);
      const body = own ? line.slice(label.length + 2) : line;
      const sentences = body.split(SENTENCE_BREAK).map((s) => s.trim()).filter(Boolean);
      const kept: string[] = [];
      sentences.forEach((s, si) => {
        let text = s;
        if (decontextualize && OPENER.test(text)) {
          const fixed = resolve(text, about);
          if (fixed) {
            text = fixed;
            stats.resolved++;
          } else if (lifted || (si === 0 && li === 0 && /^["“]?(?:These|This|The project)\b/.test(text))) {
            // Nothing before it in the reference to say what it means.
            stats.dropped++;
            return;
          }
        }
        // A view with a holder keeps its words; one without loses its praise.
        if (attributeOpinions && !DATA_HEADING.test((heading || lifted).trim()) && !holderOf(text)) {
          const plain = withoutPuffery(text);
          if (plain !== text) stats.softened++;
          text = plain;
        }
        if (attributeOpinions && isOpinion(text, heading || lifted)) {
          const h = holderOf(text);
          if (!h) {
            stats.dropped++;
            return;
          }
          const shaped = attributed(text, h);
          if (shaped !== text) stats.attributed++;
          text = shaped;
        }
        kept.push(text);
      });
      if (!kept.length) return "";
      const joined = kept.join(" ");
      if (decontextualize && other) {
        stats.marked++;
        return `About ${heading}: ${joined}`;
      }
      return own ? `${label}: ${joined}` : joined;
    }).filter(Boolean).join("\n");
  }).filter(Boolean);
  return [title, out.join("\n\n")].join("\n");
}
