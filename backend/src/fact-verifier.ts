import { config } from "./config";
import { SSLSong } from "./types";
import { blockedArticles } from "./wrong-facts";
import { topic } from "./topic";
import { escapeRe } from "./text";

/**
 * Grounding and screening.
 *
 * Grounding fetches the song's Wikipedia article so the model restates a
 * source instead of recalling from memory. Screening then drops any sentence
 * whose names, years or platforms the source does not contain. Every check
 * is a string comparison: no second model, no added latency.
 */

const WIKI_API = "https://en.wikipedia.org/w/api.php";
export const USER_AGENT =
  `bubblefacts/1.0 (${process.env.WIKIPEDIA_CONTACT || "https://github.com/frolicchris/bubblefacts"})`;

const MAX_CONTEXT_CHARS = 3000;
/** Shorter extracts are stubs; the entry's own data beats restating one. */
const MIN_CONTEXT_CHARS = 600;
/** Longest fact that fits a bubble. */
const MAX_FACT_CHARS = 160;
/** How long "no article" is trusted before the lookup is retried. */
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

const STOPWORDS = new Set(["the", "and", "of", "a", "an", "in", "on", "for", "to"]);

/** Wikipedia throttled us: the article may exist, so the miss is never cached. */
class RateLimited extends Error {}

/**
 * Articles found through the game are shared by every track from it;
 * articles found through the track, and misses, belong to that song only.
 */
const groundingCache = new Map<string, { text: string; at: number }>();

// --- Title parsing -----------------------------------------------------

/** A trailing parenthetical that marks a variant rather than naming the game. */
const VARIANT_MARKER =
  /^\s*(arr\b|arr\.|arrange|arranged|arrangement|remix|cover|medley|reprise|remaster|remastered|ost\b|ver\b|ver\.|version|act\s*\d|part\s*\d|\d{4}\b|live\b|acoustic\b|piano\b|vocal\b|instrumental\b)/i;
/** "(Day)" and "(Night)" are variants only on their own; "(Night in the Woods)" is a game. */
const VARIANT_WORD = /^\s*(day|night)\s*$/i;

/** Split "Game: Track", "Game - Track" or "Track (Game)". */
export function splitGameAndTrack(title: string): { game: string; track: string } {
  const clean = title.trim();

  const paren = clean.match(/^(.+?)\s*[([]([^)\]]{2,})[)\]]\s*$/);
  if (paren && !VARIANT_MARKER.test(paren[2]) && !VARIANT_WORD.test(paren[2])) {
    return { game: paren[2].trim(), track: paren[1].trim() };
  }

  const sep = clean.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
  if (sep) return { game: sep[1].trim(), track: sep[2].trim() };

  return { game: clean, track: clean };
}

/**
 * Song lists usually put the game in the artist field and the track in the
 * title. When the title's own "Game:" prefix extends the artist ("Super
 * Mario" -> "Super Mario 64"), the title is more specific and wins.
 */
export function resolveGameAndTrack(song: SSLSong): { game: string; track: string } {
  const artist = song.artist?.trim();
  const title = song.title.trim();

  if (!artist || /^unknown$/i.test(artist) || artist.toLowerCase() === title.toLowerCase()) {
    return splitGameAndTrack(title);
  }

  const split = splitGameAndTrack(title);
  if (split.game !== title) {
    const a = artist.toLowerCase();
    const g = split.game.toLowerCase();
    if (g === a) return { game: artist, track: split.track };
    if (g.startsWith(a + " ")) return split;
  }
  return { game: artist, track: title };
}

/**
 * The names to look for in a credit, whole credit first: "Earth, Wind & Fire"
 * stays whole, and "Lil Nas X, Jack Harlow" also tries its lead, "Lil Nas X".
 * Only commas and "feat." split a credit: "&", "and" and "x" are often part
 * of a name.
 */
export function artistNames(artist: string): string[] {
  const lead = artist.split(/\s*,\s*|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0] ?? "";
  // Two full names joined by "and": an article may name each alone. Only when
  // both sides are full names, so "Simon and Garfunkel" stays one.
  const pair = artist.split(/\s+(?:and|&)\s+/i);
  const people = pair.length === 2 && pair.every((p) => p.trim().split(/\s+/).length >= 2) ? pair : [];
  return [...new Set([artist, lead, ...people].map(normalizeTitle).filter(Boolean))];
}

/** Whether normalized text names one of these as whole words: "Sia" isn't in "Asia". */
export function mentionsName(normalizedText: string, names: string[]): boolean {
  const padded = ` ${normalizedText} `;
  return names.some((n) => padded.includes(` ${n} `));
}

// --- Article relevance -------------------------------------------------

/** Wikipedia disambiguators meaning "a musical work or what it comes from". */
const MUSICAL_QUALIFIER =
  /video game|game\b|series|soundtrack|album|franchise|film|score|song|single|composition|opera|ballet|suite|sonata|symphony|concerto|musical|anime|television|tv series|novel/i;
/** Disambiguators for people and groups: right only when we searched for one. */
const PERFORMER_QUALIFIER = /band|singer|musician|composer|pianist|rapper|duo|group|orchestra/i;
/** Words marking a different kind of work under the same name. */
/** An article's opening that describes a performer or a recording. */
const PERFORMER_LEAD = /\b(band|singer|rapper|musician|group|duo|trio|songwriter|record(ing)? artist|vocalist|album|song|single|DJ|producer)\b/i;
/** Disambiguators that can't be a performer. */
const NOT_A_PERFORMER = /\((?:[^)]*\b)?(video game|game|film|television|tv series|novel|manga|anime)\)\s*$/i;
const MEDIUM_SHIFT = /\b(movie|film|musical|discography|anime|manga|novel|list|awards|tour|concert)\b/i;

const KNOWN_ARTIST =
  /\b(beethoven|mozart|bach|chopin|debussy|liszt|ravel|satie|tchaikovsky|schubert|brahms|rachmaninoff|beatles|queen|abba|elton john|billy joel|radiohead|coldplay|adele|taylor swift|joe hisaishi|ryuichi sakamoto|hans zimmer|john williams|ennio morricone|yiruma|ludovico einaudi)\b/i;

const ROMAN: Record<string, string> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8",
  ix: "9", x: "10", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15",
};

/**
 * Lowercase, strip accents and a trailing "(qualifier)", drop punctuation.
 * "X-2" becomes "x2" so a sequel's number isn't read as a separate token.
 */
export function normalizeTitle(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .toLowerCase()
    .replace(/(\p{L})-(\d)/gu, "$1$2")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content words plus every numeral, roman numerals normalized to arabic. */
function significantTokens(s: string): string[] {
  const words = s.split(" ").filter((t) => t && !STOPWORDS.has(t));
  const kept = words.filter((t) => t.length >= 2 || /\d/.test(t) || t in ROMAN);
  return (kept.length ? kept : words).map((t) => ROMAN[t] ?? t);
}

/** "Firstname Lastname", or a well-known composer or band. */
export function looksLikeArtistName(subject: string): boolean {
  if (!subject) return false;
  if (KNOWN_ARTIST.test(subject)) return true;
  return (
    /^\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+){1,2}$/u.test(subject.trim()) &&
    !/\b(the|of|and|a|an)\b/i.test(subject)
  );
}

/**
 * True when a page's disambiguator names an artist that is not the subject:
 * "Clair de Lune (Flight Facilities song)" when we wanted Debussy.
 */
export function qualifierNamesAnotherArtist(pageTitle: string, subject: string): boolean {
  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (!qualifier) return false;

  const named = qualifier
    .split(/\s+/)
    .filter((w) => !/^(song|single|album|soundtrack|composition|video|game|series|film|instrumental|suite)$/i.test(w))
    .join(" ");
  const qualifierTokens = normalizeTitle(named).split(" ").filter(Boolean);
  const subjectTokens = new Set(normalizeTitle(subject).split(" ").filter(Boolean));
  if (!qualifierTokens.length || !subjectTokens.size) return false;

  return !qualifierTokens.some((t) => subjectTokens.has(t));
}

/**
 * Is this article about the subject we searched for?
 *
 * Wikipedia search always returns a best fuzzy match, never "no result", so
 * this guard is what stops a song with no article from being grounded on
 * something merely similar.
 */
export function isRelevantArticle(subject: string, pageTitle: string, subjectIsArtist = false): boolean {
  const want = normalizeTitle(subject);
  const got = normalizeTitle(pageTitle);
  const wantTokens = significantTokens(want);
  const gotTokens = significantTokens(got);
  if (!want || !got || !wantTokens.length || !gotTokens.length) return false;
  // A leading "The" is part of a band's name: "The Midnight" is not "Midnight
  // Club" or "Wangan Midnight", though dropping "the" would leave only "midnight".
  if (/^the\s/.test(want) && !/^the\s/.test(got)) return false;

  const qualifier = /\(([^)]*)\)\s*$/.exec(pageTitle)?.[1];
  if (qualifier) {
    // A work dated in the future (an announced remake) is not what's on air.
    const year = /\b(20\d{2})\b/.exec(qualifier)?.[1];
    if (year && Number(year) > new Date().getFullYear()) return false;

    // Capitalized disambiguators are attributions ("Clair de Lune (Debussy)");
    // lowercase ones are categories and must be musical.
    const isPerformer = PERFORMER_QUALIFIER.test(qualifier);
    const properNoun = /^\p{Lu}/u.test(qualifier.trim()) && !isPerformer;
    if (!MUSICAL_QUALIFIER.test(qualifier) && !(isPerformer && subjectIsArtist) && !properNoun) return false;
  }

  // Installment numbers decide sequels: "Final Fantasy X" is neither
  // "Final Fantasy" nor "Final Fantasy XII".
  const wantNums = wantTokens.filter((t) => /^\d+$/.test(t));
  const gotNums = gotTokens.filter((t) => /^\d+$/.test(t));
  if (wantNums.length && !wantNums.some((n) => gotNums.includes(n))) return false;

  const wantSeq = wantTokens.join(" ");
  const gotSeq = gotTokens.join(" ");

  // The article extends the subject on a token boundary: "Celeste" -> "Celeste (video game)".
  if (gotSeq.startsWith(wantSeq + " ")) {
    // A possessive names another work: "Michael Jackson's This Is It" isn't about Michael Jackson's songs.
    if (got.startsWith(want + " s ")) return false;
    return !(MEDIUM_SHIFT.test(got) && !MEDIUM_SHIFT.test(want));
  }
  // The article truncates the subject: safe only at a subtitle break ("Ys VIII:
  // Lacrimosa of Dana" -> "Ys VIII") and if no numeral was lost. "Everybody
  // Dance Now" is not "Everybody Dance".
  if (wantSeq.startsWith(gotSeq + " ")) {
    const head = significantTokens(normalizeTitle(subject.split(/:|\s[-–—]\s/)[0])).join(" ");
    // An installment number is a subtitle break too: "Ys II The Final Chapter" -> "Ys II".
    const atBreak = head === gotSeq || /^\d+$/.test(gotTokens[gotTokens.length - 1]);
    return atBreak && wantNums.every((n) => gotNums.includes(n));
  }

  // Longer titles that merely contain the subject are about something else:
  // "Queen" -> "Long Live the Queen (video game)".
  if (got.split(" ").length > want.split(" ").length + 1) return false;
  if (gotSeq === wantSeq) return true;

  const gotSet = new Set(gotTokens);
  const ratio = wantTokens.filter((t) => gotSet.has(t)).length / wantTokens.length;
  if (wantTokens.length >= 3) return ratio >= 0.85;
  // A short subject must be the whole title, in any order: "The Midnight" is
  // not "Wangan Midnight".
  const wantSet = new Set(wantTokens);
  return ratio === 1 && gotTokens.every((t) => wantSet.has(t));
}

// --- Wikipedia lookup --------------------------------------------------

/**
 * Search terms, most likely first. A bare track name ("Overture", "Main
 * Theme") is only worth searching when the subject is a person or band; for
 * a game it finds a generic article.
 */
function searchTerms(game: string, track: string, artist: boolean): string[] {
  const hasTrack = track && track !== game;
  const trackTerms = hasTrack ? [`${track} ${game}`, ...(artist ? [track] : [])] : [];
  const subjectTerms = game ? [...(artist ? [] : [`${game} video game`]), `${game} soundtrack`, game] : [];
  const terms = artist ? [...trackTerms, ...subjectTerms] : [...subjectTerms, ...trackTerms];
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

async function wikiGet<T>(params: string, timeoutMs: number, what: string): Promise<T> {
  const res = await fetch(`${WIKI_API}?${params}&format=json`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": USER_AGENT },
  });
  if (res.status === 429) throw new RateLimited(what);
  if (!res.ok) throw new Error(`${what} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function wikiSearch(term: string): Promise<string[]> {
  const data = await wikiGet<{ query?: { search?: Array<{ title: string }> } }>(
    `action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(term)}`,
    config.groundingTimeoutMs,
    "search"
  );
  return (data.query?.search ?? []).map((h) => h.title);
}

const MUSIC_HEADING = /music|soundtrack|audio|score|style/i;
const BACKGROUND_HEADING = /development|production|career|works|discography/i;

/**
 * Up to `budget` characters of article text: music sections first (with
 * their subsections), then background, then the lead, which holds the
 * release year and platform that screening checks against. The tail of a
 * long context is what a small model reads least carefully.
 */
/** A creator talking about the work: "said", "recalled", "was inspired by". */
const CREATOR_CUE =
  /\b(said|says|stated|recalled|recalls|explained|explains|remembered|described (?:how|the|it|writing|recording)|according to|in an interview|inspired by|inspiration|influenc\w+|based (?:it )?on|modell?ed (?:it )?(?:on|after)|drew (?:on|from)|borrow\w+|homage|tribute to|was written (?:after|while|when|during|in (?:about|just|under))|wrote (?:it|the song|the piece|the track|the music) (?:after|while|when|during|in)|came up with|originally (?:titled|entitled|intended|written|called|planned|composed|named|meant)|intended|wanted|decided|felt that|took (?:only|about|just))\b/i;
/** "Astley told the Los Angeles Times": told, then a name. */
const TOLD_SOMEONE = /\btold (?:the |an? )?\p{Lu}/u;
/** The sentence is about the music, not the business around it. */
const ABOUT_MUSIC = /\b(music|songs?|tracks?|themes?|score|melody|melodies|soundtrack|compos\w+|record\w*|lyrics?|riff|chords?|album|tune|piece|arrang\w+|vocals?|piano|guitar|demo|title)\b/i;
/** Sections where creators' comments about the music live. */
const MAKING_HEADING = /recording|composition|production|development|conception|background|writing|music|creation|origin|inspiration/i;
/** Sections that are other people's opinions, later uses, or lists. */
const NOT_THE_MAKERS_HEADING =
  /reception|review|accolade|chart|certification|track listing|personnel|credits|legacy|impact|music video|cover|version|popular culture|media|usage|use in|adaptation|sampl|reference|see also|external|release|commercial|performance/i;
/** Critics, the press and scholars: their views aren't the makers'. */
const CRITIC_WORDS =
  /\b(critics?|reviewers?|magazine|publication|newspaper|journalist|correspondent|writer|musicologist|scholar|author|biograph\w+|documentary|interpreted|ranked|listed|review(?:ed|s)?|praised|called it|charts?|streamed|copies|sold)\b/i;
const CRITIC_NAMES =
  /\b(IGN|GameSpot|Pitchfork|Rolling Stone|Billboard|NME|Kotaku|Polygon|RPGFan|Eurogamer|Famitsu|Stereogum|MTV|NPR|BBC|USA Today|Variety|Melody Maker|[A-Z]\w+ (?:Times|News|Post|Tribune|Herald|Guardian|Telegraph))\b/;
const CRITIC = { test: (s: string) => CRITIC_WORDS.test(s) || CRITIC_NAMES.test(s) };
/** A sentence that leans on the one before it can't be retold on its own. */
const LEANS_BACK = /^["“]?(?:I|We|He|She|They|It|His|Her|Their|This|These|That|Those|Hence|However|Instead|Meanwhile|Therefore|The same|A similar|Despite|Asked|When asked)\b/;
const MAX_COLOR_SENTENCES = 5;
const MAX_COLOR_CHARS = 900;

/**
 * The article's sentences where the people who made the music say something
 * about it, in article order (issue #48). Articles summarize interviews in
 * their Recording, Composition and Development sections, usually far past
 * the lead, where a character budget never reached them.
 *
 * A sentence needs a cue ("said", "recalled", "inspired by"), to be about the
 * music, and to stand on its own: someone named, no leaning on the sentence
 * before, no quotation cut off by the sentence split. Then it's scored:
 * naming the track or artist and sitting in a section about making the music
 * count for it; reception and later-use sections, critics and the press, and
 * great length count against it. It needs one point in its favor to be kept.
 */
/** Plainly about music: for an article on a whole game or artist, where "title" and "piece" could mean anything. */
const PLAINLY_MUSIC = /\b(music|songs?|tracks?|soundtrack|score|melody|melodies|compos\w+|lyrics?|theme song|main theme)\b/i;

export function creatorSentences(full: string, names: string[] = [], ownArticle = true): string[] {
  const wanted = names.map((n) => normalizeTitle(n)).filter(Boolean);
  const scored: Array<{ text: string; score: number; at: number }> = [];
  let at = 0;
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  for (const [heading, body] of sections) {
    const making = MAKING_HEADING.test(heading);
    const others = NOT_THE_MAKERS_HEADING.test(heading);
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      at++;
      if (text.length < 40 || !(CREATOR_CUE.test(text) || TOLD_SOMEONE.test(text))) continue;
      const namesTrack = wanted.length > 0 && mentionsName(normalizeTitle(text), wanted);
      // In an article about the whole game or artist, only what names the track, or is plainly about the music.
      if (!namesTrack && !(ownArticle ? ABOUT_MUSIC.test(text) : PLAINLY_MUSIC.test(text) && making)) continue;
      // Leaning on the sentence before, or cut by the split: an open quotation, a trailing colon, a stray initial.
      if (cutOff(text)) continue;
      // Someone has to be named.
      if (!/\b\p{Lu}\p{L}+/u.test(text.slice(1))) continue;
      let score = 3;
      if (namesTrack) score += 2;
      if (making) score += 1;
      if (others) score -= 3;
      if (CRITIC.test(text)) score -= 3;
      if (text.length > 300) score -= 2;
      if (score >= 4) scored.push({ text, score, at });
    }
  }
  const best = scored.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, MAX_COLOR_SENTENCES);
  const kept: string[] = [];
  let used = 0;
  for (const s of best.sort((a, b) => a.at - b.at)) {
    if (used + s.text.length > MAX_COLOR_CHARS) continue;
    kept.push(s.text);
    used += s.text.length + 1;
  }
  return kept;
}

/** How the work did, in things that can be counted: charts, awards, certifications, sales. */
const RECEIVED_CUE =
  /\b(number[- ]one|number \d+|No\. ?\d+|top (?:ten|five|\d+)|topped|peaked|reached|charted|won|winning|awarded|nominat\w+|Grammy|Academy Award|Oscar|BAFTA|Golden Globe|certified|platinum|gold|diamond|best[- ]selling|million|billion|inducted|Hall of Fame|National Recording Registry|first (?:video game|song|single|piece)\b.{0,40}\bto)\b/i;
const RECEIVED_HEADING = /reception|commercial|chart|accolade|award|legacy|release|impact/i;
const MAX_RECEIVED_SENTENCES = 3;
const MAX_RECEIVED_CHARS = 450;

/** Whether a split left the sentence unable to stand alone. */
const brokenBySplit = (text: string) =>
  (text.match(/["“”]/g)?.length ?? 0) % 2 === 1 || /[:;,]$/.test(text) || /\b\p{Lu}\.$/u.test(text);
const cutOff = (text: string) => LEANS_BACK.test(text) || brokenBySplit(text);

/**
 * The article's sentences on how the work was received, as things that can be
 * counted: chart peaks, awards, certifications and sales. They sit in the
 * lead and in Reception, Charts and Accolades sections, which the music-first
 * ordering skipped. Critics' opinions are left out: screening drops those.
 */
export function receptionSentences(full: string): string[] {
  const sections = [["", full.split(/\n==/)[0]], ...[...full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)].map((m) => [m[1], m[2]])];
  const kept: string[] = [];
  let used = 0;
  for (const [heading, body] of sections) {
    if (heading && !RECEIVED_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      // "It reached number one" is fine here: in the song's own article, "it" is the song.
      if (text.length < 40 || text.length > 260 || !RECEIVED_CUE.test(text) || OPINION.test(text) || brokenBySplit(text)) continue;
      if (LEANS_BACK.test(text) && !/^It\b/.test(text)) continue;
      if (kept.length >= MAX_RECEIVED_SENTENCES || used + text.length > MAX_RECEIVED_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** How the music is built: key, tempo, meter, harmony, form. */
const THEORY_CUE =
  /\b(key of|[A-G](?:[-♭♯ ](?:flat|sharp))? (?:major|minor)|in (?:a )?(?:major|minor)|tempo|beats per minute|bpm|time signature|\d\/\d time|common time|chord progression|chords?|arpeggi\w+|ostinato|leitmotifs?|modulat\w+|syncopat\w+|counterpoint|riff|scale|Dorian|Phrygian|Lydian|Mixolydian|pentatonic|octaves?|vocal range|spans|bars?\b|measures|verse[- ]chorus|bridge|coda|waltz)\b/i;
const THEORY_HEADING = /composition|music|structure|analysis|style|lyrics|form|theme/i;
const MAX_THEORY_SENTENCES = 3;
const MAX_THEORY_CHARS = 450;

/** The article's sentences on how the music is built, from its Composition or Structure sections. */
export function theorySentences(full: string): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const [, heading, body] of full.matchAll(/\n==+\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    if (!THEORY_HEADING.test(heading) || NOT_THE_MAKERS_HEADING.test(heading)) continue;
    for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
      const text = raw.trim();
      if (text.length < 40 || text.length > 240 || !THEORY_CUE.test(text) || OPINION.test(text) || cutOff(text)) continue;
      if (kept.length >= MAX_THEORY_SENTENCES || used + text.length > MAX_THEORY_CHARS) return kept;
      kept.push(text);
      used += text.length + 1;
    }
  }
  return kept;
}

/** Cut text back to its last whole sentence, so the model never copies half of one. */
function wholeSentences(text: string): string {
  if (/[.!?]["”)]?$/.test(text)) return text;
  const end = Math.max(text.lastIndexOf(". "), text.lastIndexOf('." '), text.lastIndexOf(".\n"));
  // Only when little is lost: text with few sentence breaks is left as it is.
  return end > text.length * 0.7 ? text.slice(0, end + 1) : text;
}

/**
 * `ownArticle` is false when the article is about the whole game or the
 * artist, not this song: then only what's plainly about the music is lifted,
 * and no reception, which would be the game's or the artist's, not the song's.
 */
export function orderExtract(full: string, budget: number, names: string[] = [], ownArticle = true): string {
  // What the makers said goes first: it's the part worth retelling, and a small model reads the top best.
  const color = creatorSentences(full, names, ownArticle);
  const theory = ownArticle ? theorySentences(full).filter((s) => !color.includes(s)) : [];
  const received = ownArticle ? receptionSentences(full).filter((s) => !color.includes(s) && !theory.includes(s)) : [];
  const colorBlock = [
    color.length ? `From the people who made it: ${color.join(" ")}` : "",
    theory.length ? `How the music is built: ${theory.join(" ")}` : "",
    received.length ? `How it was received: ${received.join(" ")}` : "",
  ].filter(Boolean).join("\n\n");
  if (colorBlock) budget = Math.max(0, budget - colorBlock.length - 2);
  const primary: string[] = [];
  const secondary: string[] = [];
  // A subsection inherits the bucket of the section it sits under.
  let parent: { level: number; bucket: string[] | null } = { level: 0, bucket: null };
  for (const [, marks, heading, body] of full.matchAll(/\n(==+)\s*([^=\n]+?)\s*==+\n([\s\S]*?)(?=\n==|$)/g)) {
    const level = marks.length;
    let bucket = MUSIC_HEADING.test(heading) ? primary : BACKGROUND_HEADING.test(heading) ? secondary : null;
    if (level > parent.level && parent.bucket) bucket ??= parent.bucket;
    else parent = { level, bucket };
    if (bucket && body.trim()) bucket.push(`${heading}: ${body.trim()}`);
  }

  const lead = wholeSentences(full.split(/\n==/)[0].trim().slice(0, Math.floor(budget * 0.35)));
  const rest = wholeSentences([...primary, ...secondary].join("\n\n").slice(0, Math.max(0, budget - lead.length - 2)));
  return [colorBlock, rest, lead].filter(Boolean).join("\n\n");
}

/** The article's full plain text, or null for a disambiguation page. */
async function wikiExtract(pageTitle: string): Promise<string | null> {
  // exsectionformat=wiki keeps the "==" headings orderExtract relies on.
  const data = await wikiGet<{ query?: { pages?: Record<string, { extract?: string }> } }>(
    `action=query&prop=extracts&explaintext=1&exsectionformat=wiki&titles=${encodeURIComponent(pageTitle)}`,
    config.groundingExtractTimeoutMs,
    "extract"
  );
  const full = Object.values(data.query?.pages ?? {})[0]?.extract;
  return full && !/may refer to:/i.test(full.slice(0, 200)) ? full : null;
}

/** Reference text for the song, or "" when no relevant article exists. */
/** Game tracks already found to have no article of their own. */
const noOwnArticle = new Set<string>();

export async function fetchGrounding(song: SSLSong): Promise<string> {
  const { game, track } = resolveGameAndTrack(song);
  const gameKey = normalizeTitle(game);
  const songKey = `${gameKey}\0${normalizeTitle(track)}`;

  // A game's tracks share one lookup. An artist's songs never share: each may
  // have its own article. The artist test is a heuristic, and guessing
  // "artist" for a game only costs extra lookups, never wrong facts.
  // A music video's artist counts as one too (issue: "Muse - Starlight" must
  // search for Starlight, not reuse Muse's article cached for another song).
  const artist = looksLikeArtistName(game) || !!song.performer;
  // Articles the streamer marked wrong for this song are never used for it again.
  const blocked = blockedArticles(song);
  const usable = (title: string) => !blocked.has(title);
  // A game's track with an article of its own ("Megalovania", "Baba Yetu") is
  // far richer than the game's article, so it's tried first: one search per
  // track, remembered either way (issue #48).
  if (!artist && track && track !== game && !song.artistUncertain && !noOwnArticle.has(songKey) && !groundingCache.get(songKey)?.text) {
    try {
      const own = (await wikiSearch(`${track} ${game}`)).find(
        (t) => usable(t) && isRelevantArticle(track, t) && !qualifierNamesAnotherArtist(t, game)
      );
      const full = own ? await wikiExtract(own) : null;
      // It has to be an article about a piece of music: "Dragonborn" from Skyrim is also an expansion pack.
      const aboutMusic = full && /\b(song|theme|piece|composition|instrumental|track|single|anthem|aria|soundtrack)\b/i.test(full.slice(0, 400));
      const extract = full && aboutMusic && mentionsName(normalizeTitle(full), artistNames(game)) ? orderExtract(full, MAX_CONTEXT_CHARS - own!.length - 1, [track, game]) : "";
      if (own && extract && extract.length >= MIN_CONTEXT_CHARS) {
        const text = `${own}\n${extract}`;
        console.log(`[Grounding] "${song.title}" -> ${own} (${extract.length} chars, the track's own article)`);
        groundingCache.set(songKey, { text, at: Date.now() });
        return text;
      }
      noOwnArticle.add(songKey);
    } catch {
      // Throttled or unreachable: the game's article below still serves, and this is tried again next time.
    }
  }
  const ownHit = groundingCache.get(songKey);
  if (!artist && ownHit?.text && usable(ownHit.text.split("\n")[0])) return ownHit.text;
  for (const key of artist ? [songKey] : [gameKey, songKey]) {
    const hit = key && groundingCache.get(key);
    if (hit && hit.text && !usable(hit.text.split("\n")[0])) continue;
    if (hit && (hit.text || Date.now() - hit.at < NEGATIVE_TTL_MS)) return hit.text;
  }

  // Which way an article matched decides how widely it may be shared. A
  // track article must not be attributed to another artist, and its text
  // must mention the game or artist: "Overture" alone is a generic article.
  // A music video's artist is a band or singer, never a game or film of the same name.
  // An artist that's only a guess from the uploader's channel is never looked up
  // as the subject: an uploader called "Apollo" isn't the god (issue from review).
  // "Ecco the Dolphin CD" is the game "Ecco the Dolphin": an edition word isn't part of its name.
  const edition = game.replace(/\s+(?:CD|HD|DX|Remastered|Remaster|Deluxe|Definitive Edition|Complete Edition)$/i, "");
  const matchedGame = (title: string) =>
    !song.artistUncertain &&
    (isRelevantArticle(game, title, artist || !!song.performer) || (edition !== game && isRelevantArticle(edition, title, artist || !!song.performer))) &&
    !(song.performer && NOT_A_PERFORMER.test(title));
  // A longer title than the subject: "Final Fantasy" -> "Final Fantasy VII".
  const gameTokens = significantTokens(gameKey).length;
  const extendsGame = (title: string) => significantTokens(normalizeTitle(title)).length > gameTokens;
  const matchedTrack = (title: string) =>
    track !== game && isRelevantArticle(track, title) && !qualifierNamesAnotherArtist(title, game);

  // "Lil Nas X, Jack Harlow": a song's article may name only its lead artist.
  const names = artistNames(game);
  const terms = song.artistUncertain && track !== game
    ? [track]
    : searchTerms(game, track, artist || !!song.performer);
  // A music video's artist may share a name with a game or film; ask for the performer.
  if (song.performer && !looksLikeArtistName(game) && game.trim()) {
    const at = terms.indexOf(game);
    terms.splice(at < 0 ? terms.length : at, 0, `${game} band`);
  }
  let unreachable = "";

  for (const term of terms) {
    try {
      const titles = await wikiSearch(term);
      // For an artist, the song's own article beats the artist's, wherever it ranks:
      // "Industry Baby" over "Lil Nas X".
      // The same for a game's track that has an article of its own: "Megalovania" over "Undertale".
      // Among articles named for the track, the song's beats the album's: "Let It Be (song)" over "Let It Be (album)".
      const ofTrack = titles.filter((t) => usable(t) && matchedTrack(t));
      const page =
        ofTrack.find((t) => /\((?:[^)]*\b)?(song|composition|instrumental|theme)\)$/i.test(t)) ??
        ofTrack.find((t) => !/\((?:[^)]*\b)?(album|EP|soundtrack|film|musical)\)$/i.test(t)) ??
        ofTrack[0] ??
        titles.find((t) => usable(t) && matchedGame(t));
      if (!page) {
        if (titles.length) console.log(`[Grounding] No relevant match among: ${titles.join(", ")}`);
        continue;
      }
      const byGame = matchedGame(page);
      const full = await wikiExtract(page);
      // An installment or spin-off is only right when it's the song's own game: it must name the track.
      const installment = byGame && extendsGame(page) && track !== game;
      if (installment && full && !mentionsName(normalizeTitle(full), [normalizeTitle(track)])) {
        console.log(`[Grounding] "${page}" never mentions "${track}", skipping`);
        continue;
      }
      // A performer's name alone can be an everyday word: "Milestone" is about road markers.
      if (byGame && song.performer && !/\(/.test(page) && full && !PERFORMER_LEAD.test(full.slice(0, 400))) {
        console.log(`[Grounding] "${page}" isn't about a performer, skipping`);
        continue;
      }
      if (!byGame && full && !mentionsName(normalizeTitle(full), names)) {
        console.log(`[Grounding] "${page}" never mentions "${game}", skipping`);
        continue;
      }
      // The song's own article, or one about the whole game or artist?
      const ownArticle = !byGame || track === game || matchedTrack(page);
      const extract = full && orderExtract(full, MAX_CONTEXT_CHARS - page.length - 1, ownArticle ? [track, game] : [track], ownArticle);
      if (!extract || extract.length < MIN_CONTEXT_CHARS) {
        console.log(`[Grounding] "${page}" is too short to write from (${extract?.length ?? 0} chars)`);
        continue;
      }
      const text = `${page}\n${extract}`;
      console.log(`[Grounding] "${song.title}" -> ${page} (${extract.length} chars)`);
      // Shared by the game's tracks, unless this track has blocked articles of its own.
      groundingCache.set(byGame && !artist && !blocked.size && !installment ? gameKey : songKey, { text, at: Date.now() });
      return text;
    } catch (err) {
      unreachable = err instanceof RateLimited ? "rate-limited" : "lookup failed";
      if (!(err instanceof RateLimited)) {
        console.warn(`[Grounding] Lookup failed for "${term}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(
    `[Grounding] No reference for "${song.title}"` +
      (unreachable ? ` (${unreachable}, not cached)` : "") +
      ` — tried: ${terms.join(" | ")}`
  );
  // A miss caused by this song's blocked articles says nothing about the game's other tracks.
  if (!unreachable) groundingCache.set(artist || blocked.size ? songKey : gameKey, { text: "", at: Date.now() });
  return "";
}

export function clearGroundingCache(): void {
  noOwnArticle.clear();
  groundingCache.clear();
}

// --- Screening ---------------------------------------------------------

/** Whole-word, whole-phrase containment. */
const hasWord = (needle: string, haystack: string, flags = "i") =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(needle)}([^\\p{L}\\p{N}]|$)`, flags + "u").test(haystack);

/** Claims that are easy to get wrong and obvious when wrong. */
const RISKY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(won|winner|awarded|nominated)\b/i, label: "award claim" },
  { re: /\b(grammy|bafta|game award|tga)\b/i, label: "award name" },
  { re: /(#\s?\d+\b|\bnumber one\b|\bno\.\s?\d+\b|\btopped the chart|\bbillboard\b)/i, label: "chart position" },
  { re: /\b\d[\d.,]*\s*(million|billion|thousand)\b/i, label: "sales/quantity figure" },
  { re: /\bsold\s+[\d,]+/i, label: "sales figure" },
  { re: /\b(certified\s+(gold|platinum))\b/i, label: "certification claim" },
  { re: /\b(first ever|only game|best-selling|highest-\w+)\b/i, label: "superlative" },
];

/**
 * Dropped even when the source says so. Critics' opinions read as facts on
 * stream and make the real facts harder to trust (issue #21), and the music
 * video's plot or look is what viewers are already watching (issue #20).
 */
const OPINION = /\b(considered (?:one|to be|as|by|a|an|the|among)|regarded|praised|acclaimed|hailed|lauded|critics?|critically|masterpiece|greatest|iconic|beloved|celebrated|described as|one of the (best|finest|most))\b/i;
const ABOUT_THE_VIDEO = /\b(music video|video clip|in the video|the video(?!\s*games?\b))\b/i;

/** The model reasoning about its source instead of stating a fact. */
const META_PATTERNS: RegExp[] = [
  /\b(reference material|the reference|source text|provided (text|reference)|according to the (text|reference))\b/i,
  /\b(I (couldn't|could not|cannot|can't|am not|'m not)\b|I don't (know|have))/i,
  /\b(is|are|was|were) not (credited|mentioned|listed|stated|confirmed)\b/i,
  /\b(does|do|did) not (appear|mention|state|specify)\b/i,
  /\b(unconfirmed|unverified|unclear from|no information)\b/i,
  /^(note|disclaimer|caveat|here are|here is|sure[,!])/i,
];

const YEAR = /\b(1\d{3}|20\d{2})\b/g;
/** Capitalized words, including "McCartney"; two or more, or a single Mc- surname. */
const NAME_WORD = String.raw`(?:Mc\p{Lu}\p{Ll}+|\p{Lu}[\p{Ll}'’-]+)`;
const NAME = new RegExp(String.raw`(?<!\p{L})(?:${NAME_WORD}(?:\s+${NAME_WORD})+|Mc\p{Lu}\p{Ll}+)`, "gu");

const PLATFORM_PATTERN =
  /\b(NES|SNES|Nintendo 64|N64|GameCube|Wii U|Wii|Switch|Game Boy|Nintendo DS|3DS|PlayStation|PSone|PS1|PS2|PS3|PS4|PS5|PSP|Vita|Xbox(?: 360| One| Series [SX])?|Sega Genesis|Mega Drive|Dreamcast|Saturn|Master System|Game Gear|Atari(?: 2600)?|Amiga|Commodore 64|C64|MS-?DOS|TurboGrafx-16|PC Engine|Neo Geo|Steam Deck|arcade|YM2612|SPC700|2A03|Ricoh)\b/gi;

/** Names for the same hardware. Each name corroborates every other in its group. */
const PLATFORM_ALIASES = new Map<string, string[]>();
for (const group of [
  ["nes", "nintendo entertainment system", "famicom"],
  ["snes", "super nintendo", "super famicom", "super nintendo entertainment system"],
  ["n64", "nintendo 64"],
  ["ps1", "psone", "playstation"],
  ["ps2", "playstation 2"],
  ["ps3", "playstation 3"],
  ["ps4", "playstation 4"],
  ["ps5", "playstation 5"],
  ["mega drive", "genesis", "sega genesis"],
  ["game boy", "gameboy"],
  ["c64", "commodore 64"],
  ["pc engine", "turbografx-16", "turbografx"],
]) {
  for (const name of group) PLATFORM_ALIASES.set(name, group.filter((n) => n !== name));
}

/** Console names that are also ordinary words; only the capital tells them apart in the source. */
const AMBIGUOUS_PLATFORMS = new Set(["switch", "saturn", "genesis", "vita"]);

/** Does the reference name this platform, or another name for it? */
export function platformSupported(platform: string, context: string): boolean {
  const p = platform.toLowerCase();
  const direct = AMBIGUOUS_PLATFORMS.has(p)
    ? hasWord(p[0].toUpperCase() + p.slice(1), context, "")
    : hasWord(p, context);
  return direct || (PLATFORM_ALIASES.get(p) ?? []).some((a) => hasWord(a, context));
}

/** Leading words that make a capitalized run look like a name when it isn't one. */
const NAME_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "in", "on",
  "at", "for", "to", "of", "and", "but", "or", "so", "when", "while", "after",
  "before", "during", "although", "however", "both", "each", "every", "many",
  "most", "some", "several", "one", "two", "three", "first", "second", "third",
  "original", "new", "final", "main", "early", "later", "modern", "classic",
  "his", "her", "their", "they", "he", "she", "we", "you", "i",
  "nintendo", "sega", "sony", "microsoft", "capcom", "konami", "square",
  "atlus", "falcom", "bandai", "namco", "enix", "ubisoft", "activision",
  "japanese", "american", "european", "english", "german", "french",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * The first capitalized name in the fact that the reference doesn't contain.
 * Each word must appear as a whole word, which tolerates "Koshiro" alone or a
 * different romanization of the given name, but not "Ed" inside "played".
 */
/**
 * Kinds of credit, and the words that state each. A fact giving someone a
 * credit needs a sentence in the source that names them with the same kind
 * of credit: "John Smith directed the game" doesn't support "John Smith wrote
 * the soundtrack" (issue from review). Writing music counts as composing.
 */
const ROLES: Array<{ fact: RegExp; source: RegExp }> = [
  { fact: /\b(compos\w*|scored|wr[io]te\s+the\s+(music|score|soundtrack)|written\s+the\s+(music|score|soundtrack)|music\s+(was\s+)?(written|composed)\s+by)\b/i, source: /\b(compos\w*|scored|wr[io]te|written|writer)\b/i },
  { fact: /\b(wr[io]te|written|penned|lyrics?)\b/i, source: /\b(wr[io]te|written|writ\w*|lyric\w*|penned|songwrit\w*|compos\w*)\b/i },
  { fact: /\bproduc\w*/i, source: /\bproduc\w*/i },
  { fact: /\bdirect\w*/i, source: /\bdirect\w*/i },
  { fact: /\b(performed|sang|sung|sings|vocals?|recorded)\b/i, source: /\b(perform\w*|sang|sung|sing\w*|vocal\w*|record\w*|band|singer|rapper|musician)\b/i },
  { fact: /\b(designed|developed)\b/i, source: /\b(design\w*|develop\w*)\b/i },
];
/** "Adele composed", "Mia Chen and Toby Fox wrote": a capitalized name right before a credit verb. */
const ACTIVE_NAME = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+|originally\s+)?(?:composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned)\b/gu;
/** Words between a name and its role word, at most, for the source to count as stating that role. */
const ROLE_REACH = 6;
/** The performing family: "Coldplay are a British rock band" is stated loosely, and a mix-up there is harmless. */
const LOOSE_ROLE = /perform/;
/** Any credit verb: a name right before one is that verb's subject, not the end of an earlier list. */
const CREDIT_VERB = /^(composed|wrote|produced|directed|performed|sang|recorded|designed|developed|scored|penned|arranged|published)$/i;
/** "music by", "lyrics by": a noun that credits whoever follows "by". */
const BY_NOUN: Array<{ noun: RegExp; means: RegExp }> = [
  { noun: /^(music|score|soundtrack)$/i, means: /compos/ },
  { noun: /^lyrics?$/i, means: /lyric/ },
];
const NAME_PARTICLE = /^(de|van|von|da|del|la|le|and|&|,)$/i;

/**
 * Whether one source sentence gives this person this kind of credit. Being
 * near a role word isn't enough: "John Smith directed, while Mia Chen
 * composed the music" credits Smith with directing only (final QA #1). The
 * sentence has to tie the two together one of three ways:
 *
 *   active   "Smith [and Chen] directed", "Smith directed the game and composed its music"
 *            (only plain words in between: no comma, no other name, and the verb isn't "... by" someone)
 *   passive  "composed [and arranged] by [Chen and] Smith", "music by Smith"
 *            (Smith isn't the subject of a verb that follows)
 *   title    "composer [Mia] Chen"
 *
 * Anything else is ambiguous, and an ambiguous credit is dropped.
 */
function statesRole(sentence: string, surname: string, role: { source: RegExp }): boolean {
  const tokens = sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*|[,;]/gu) ?? [];
  const lower = tokens.map((t) => t.toLowerCase().replace(/['’]s$/, "").replace(/\.+$/, ""));
  const isName = (i: number) => /^\p{Lu}/u.test(tokens[i]) && !NAME_STOPWORDS.has(lower[i]);
  /** In a list of credited names, any capitalized word counts: "Falcom Sound Team jdk". */
  const noCaps = sentence === sentence.toLowerCase(); // Lowercased text can't show where a name ends.
  const isCap = (i: number) => noCaps || /^\p{Lu}/u.test(tokens[i] ?? "");
  const isRole = (i: number) => role.source.test(lower[i]);
  const at = lower.flatMap((w, i) => (w === surname ? [i] : []));
  if (!at.length) return false;
  if (LOOSE_ROLE.test(role.source.source)) return lower.some((_, j) => isRole(j) && at.some((i) => Math.abs(i - j) <= ROLE_REACH));

  return at.some((i) => {
    for (let j = 0; j < tokens.length; j++) {
      const byNoun = BY_NOUN.some((b) => b.noun.test(lower[j]) && b.means.test(role.source.source) && lower[j + 1] === "by");
      if (!isRole(j) && !byNoun) continue;
      if (j > i) {
        // Active: the rest of a name list, then plain words, then the verb.
        if (j - i - 1 > ROLE_REACH || lower[j + 1] === "by" || lower[j + 2] === "by") continue;
        let k = i + 1;
        while (k < j && (isName(k) || NAME_PARTICLE.test(lower[k]))) k++;
        if (lower[k - 1] === "," && lower[k] === "who") k++; // "Chen, who composed"
        else if (lower[k - 1] === "," && k < j) continue;
        let plain = true;
        for (; k < j; k++) if (isName(k) || /^[,;]$/.test(tokens[k]) || /^(while|whereas|but|although)$/.test(lower[k])) plain = false;
        if (plain) return true;
      } else if (j < i) {
        const span = lower.slice(j + 1, i);
        const by = span.indexOf("by");
        if (by === -1) {
          // Title: "composer Mia Chen".
          if (/(er|or|ist)$/.test(lower[j]) && span.every((_, n) => isCap(j + 1 + n))) return true;
          continue;
        }
        // Passive: a few plain words, "by", then only names up to this one.
        const before = span.slice(0, by);
        const list = span.slice(by + 1);
        if (before.length > 3 || before.some((w) => /^[,;]$/.test(w))) continue;
        if (!list.every((w, n) => isCap(j + 2 + by + n) || NAME_PARTICLE.test(w))) continue;
        if (CREDIT_VERB.test(lower[i + 1] ?? "") && lower[i + 2] !== "by") continue; // "... and Smith directed"
        return true;
      }
    }
    return false;
  });
}

/** "by Adele", "by Nobuo Uematsu": a capitalized name after "by". */
const BY_NAME = /\bby\s+((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:(?:Mc)?\p{Lu}[\p{L}'’.-]*|de|van|von|da|del|la|le))*)/gu;

/** The names a fact credits: two or more capitalized words, or any name after "by". */
function creditedNames(fact: string): string[] {
  const names = new Set<string>();
  for (const m of fact.matchAll(BY_NAME)) names.add(m[1].trim().replace(/[.'’-]+$/, ""));
  for (const m of fact.matchAll(ACTIVE_NAME)) {
    const words = m[1].trim().split(/\s+/).filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length) names.add(words.join(" "));
  }
  // A title in quotation marks is a work, not a person: "Take On Me" can't be given a credit.
  const titles = [...fact.matchAll(/["“]([^"“”]+)["”]/g)].map((m) => m[1]);
  for (const candidate of fact.match(NAME) ?? []) {
    if (titles.some((t) => t.includes(candidate))) continue;
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, ""));
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    if (words.length >= 2 && !words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) names.add(words.join(" "));
  }
  return [...names];
}

/**
 * A credit the source doesn't give: a named person in a role (composed,
 * wrote, produced, directed, performed, designed) with no source sentence
 * naming them in that kind of role. Returns the name, or null.
 */
export function unsupportedCredit(fact: string, context: string): string | null {
  const roles = ROLES.filter((r) => r.fact.test(fact));
  if (!roles.length) return null;
  const sentences = context.split(/(?<=[.!?])\s+|\n+/);
  for (const name of creditedNames(fact)) {
    const surname = (name.split(/\s+/).pop() ?? name).toLowerCase();
    const stated = sentences.some((sentence) => roles.some((r) => statesRole(sentence, surname, r)));
    if (!stated) return name;
  }
  return null;
}

/** "Audrey Hepburn won", "Mancini received": a capitalized name right before winning something. */
const WINNER = /((?:Mc)?\p{Lu}[\p{L}'’.-]*(?:\s+(?:Mc)?\p{Lu}[\p{L}'’.-]*){0,3})\s+(?:also\s+|later\s+)?(?:won|received|earned|was awarded)\b/gu;
const WON = { source: /^(won|wins|winning|awarded|received|earned|winner)$/i };

/**
 * A named winner the source doesn't name as the winner. "The song won an
 * Academy Award" doesn't make its singer the winner (seen replaying a
 * stream: Moon River and Audrey Hepburn). The work itself, named as the
 * article is titled, is left to the award checks.
 */
export function unsupportedWinner(fact: string, context: string): string | null {
  const article = normalizeTitle(context.split("\n")[0]);
  const sentences = context.split(/(?<=[.!?])\s+|\n+/);
  for (const m of fact.matchAll(WINNER)) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/['’]s?$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    const name = words.join(" ");
    if (article && mentionsName(article, [normalizeTitle(name)])) continue;
    const surname = words[words.length - 1].toLowerCase();
    if (!sentences.some((s) => statesRole(s, surname, WON))) return name;
  }
  return null;
}

export function unsupportedName(fact: string, context: string): string | null {
  // A single-word name after "by" or before a credit verb ("composed by Adele",
  // "Adele composed") must be there too.
  for (const m of [...fact.matchAll(BY_NAME), ...fact.matchAll(ACTIVE_NAME)]) {
    const words = m[1].trim().split(/\s+/).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => w && !NAME_STOPWORDS.has(w.toLowerCase()));
    if (words.length && !words.every((w) => hasWord(w, context))) return words.join(" ");
  }
  for (const candidate of fact.match(NAME) ?? []) {
    // "Colonel Abrams' track": the possessive isn't part of the name.
    const words = candidate.split(/\s+/).map((w) => w.replace(/['’]s?$/, ""));
    while (words.length && NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
    const isName = words.length >= 2 || /^Mc/.test(words[0] ?? "");
    if (!isName || words.every((w) => NAME_STOPWORDS.has(w.toLowerCase()))) continue;
    if (words.every((w) => hasWord(w, context))) continue;
    return words.join(" ");
  }
  return null;
}

/** Strip "Fact 1:", bullets, numbering and wrapping quotes. */
function stripPrefix(fact: string): string {
  return fact
    .replace(/^\s*(fact|trivia|tip|line)\s*\d*\s*[:.\-—]\s*/i, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .trim()
    // Quotes around the whole line go; a quoted title at the start stays whole.
    .replace(/^["“]([^"“”]*)["”]$/, "$1")
    .replace(/^'(.*)'$/, "$1")
    .trim();
}

function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

/**
 * Words that only say what the request already shows: that it's a song, who
 * it's by or what it's from, and how it was made in general terms. Genre and
 * nationality words count too: "a song by English rock band Coldplay" tells
 * a viewer nothing the request didn't.
 */
const RESTATES = new Set(
  (
    "is was are were be been a an the this that it its one here now so just " +
    "song songs track tracks single tune piece music musical instrumental theme composition compositions original originals cover " +
    "by from of in on for and with to as " +
    "written wrote writes composed composer performed performer recorded sung sings sang released credited " +
    "artist band group singer songwriter duo trio musician rapper " +
    "video game games soundtrack ost score album " +
    "you youre re hearing listening playing straight person who " +
    "english british american canadian australian irish scottish welsh japanese korean swedish french german " +
    "rock pop hip hop rap country folk indie jazz electronic dance metal punk alternative soul r b"
  ).split(" ")
);

/**
 * A caption that only repeats what viewers already see: the title, the artist
 * or game, and filler. "\"Clocks\" was written by Coldplay" says nothing when the
 * request read "Coldplay - Clocks"; "\"Clocks\" was written by Chris Martin" or
 * "came out in 2002" adds something and stays.
 */
export function restatesRequest(fact: string, song: SSLSong): boolean {
  const { game, track } = resolveGameAndTrack(song);
  const known = new Set(
    // Apostrophes go on both sides, so "Laura's" in the title is "Lauras" in the caption too.
    [song.title, song.artist, game, track].flatMap((s) => normalizeTitle((s ?? "").replace(/['’]/g, "")).split(" ")).filter(Boolean)
  );
  const left = normalizeTitle(fact.replace(/['’]/g, ""))
    .split(" ")
    .filter((t) => t && !known.has(t) && !RESTATES.has(t));
  return left.length === 0;
}

/** Jaccard or containment overlap; containment catches a restatement that adds words. */
export function tooSimilar(a: string, b: string): boolean {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared) >= 0.5 || shared / Math.min(ta.size, tb.size) >= 0.7;
}

const MAX_QUOTE_WORDS = 12;
const plainQuotes = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").toLowerCase();

/**
 * Words in quotation marks are someone's own words, so they must be in the
 * source exactly, and short: a quote of three or more words that the source
 * doesn't contain, or one over twelve words, is returned. One- and two-word
 * quotes are titles and nicknames, which the name checks cover.
 */
export function alteredQuote(fact: string, context: string): string | null {
  const source = plainQuotes(context);
  for (const m of plainQuotes(fact).matchAll(/"([^"]+)"/g)) {
    const words = m[1].replace(/[.,!?;:]+$/, "").trim();
    const count = words.split(" ").length;
    if (count < 3) continue;
    if (count > MAX_QUOTE_WORDS || !source.includes(words)) return words;
  }
  return null;
}

/** Music terms a viewer may not know, each with a few plain words. Fixed text: the model never explains them itself. */
const PLAIN_WORDS: Array<[RegExp, string]> = [
  [/\barpeggi(?:o|os|ated)\b/i, "a chord's notes played one at a time"],
  [/\bostinato\b/i, "a short pattern repeated over and over"],
  [/\bleitmotifs?\b/i, "a tune tied to a character or idea"],
  [/\bcounterpoint\b/i, "two melodies at once"],
  [/\bsyncopat(?:ed|ion)\b/i, "accents off the beat"],
  [/\bmodulat(?:es|ed|ion)\b/i, "a change of key"],
  [/\bpentatonic\b/i, "a five-note scale"],
  [/\b(?:Dorian|Phrygian|Lydian|Mixolydian)\b/, "an old kind of scale"],
  [/\bchord progression\b/i, "the order of the chords"],
  [/\btime signature\b/i, "how the beats are counted"],
  [/\bcoda\b/i, "a closing section"],
  [/\bbeats per minute\b/i, "how fast it goes"],
];

/** Add a few plain words after the first music term in a caption, when they fit in the bubble (issue #48). */
export function explainMusicTerms(fact: string): string {
  for (const [term, plain] of PLAIN_WORDS) {
    const m = term.exec(fact);
    if (!m || fact.includes(plain)) continue;
    const at = m.index + m[0].length;
    const explained = `${fact.slice(0, at)} (${plain})${fact.slice(at)}`;
    return explained.length <= MAX_FACT_CHARS ? explained : fact;
  }
  return fact;
}

/**
 * The sentence in the reference a caption was most likely written from, so
 * the streamer can see what it rests on. The one sharing the most of the
 * caption's content words, when it shares at least half; otherwise none:
 * showing a poor match as "the source" would mislead.
 */
export function supportingSentence(fact: string, context: string): string {
  // The plain-word explanations in brackets are ours, not the article's.
  const want = contentTokens(fact.replace(/\s*\([^)]*\)/g, ""));
  if (!want.size) return "";
  let best = "";
  let bestShare = 0;
  const body = context.split("\n").slice(1).join("\n").replace(/^(From the people who made it|How the music is built|How it was received): /gm, "");
  for (const raw of body.split(/(?<=[.!?]["”]?)\s+(?=["“]?\p{Lu})|\n+/u)) {
    const sentence = raw.trim();
    if (sentence.length < 20) continue;
    const have = contentTokens(sentence);
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const share = shared / want.size;
    if (share > bestShare) [best, bestShare] = [sentence, share];
  }
  return bestShare >= 0.5 ? (best.length > 320 ? `${best.slice(0, 317)}…` : best) : "";
}

export interface ScreenResult {
  kept: string[];
  rejected: Array<{ text: string; reason: string }>;
}

/**
 * Keep only facts the reference visibly supports. With no reference (only
 * when FACT_VERIFICATION=off) the source checks are skipped but formatting,
 * meta-commentary, risky claims, length and duplicates are still screened.
 */
export function screenClaims(facts: string[], context: string): ScreenResult {
  const result: ScreenResult = { kept: [], rejected: [] };

  const reasonToDrop = (fact: string): string | null => {
    if (META_PATTERNS.some((re) => re.test(fact))) return "meta-commentary";
    if (fact.length < 20) return "too short";
    if (OPINION.test(fact)) return "opinion";
    // "He combined two words": a viewer can't tell who.
    if (/^(He|She|They|His|Her|Their)\b/.test(fact)) return "doesn't say who";
    if (ABOUT_THE_VIDEO.test(fact)) return "about the music video";
    for (const { re, label } of RISKY_PATTERNS) {
      const m = fact.match(re);
      if (m && !hasWord(m[0].trim(), context)) return label;
    }
    if (context) {
      const year = (fact.match(YEAR) ?? []).find((y) => !hasWord(y, context));
      if (year) return `unsupported year ${year}`;
      const platform = (fact.match(PLATFORM_PATTERN) ?? []).find((p) => !platformSupported(p, context));
      if (platform) return `unsupported platform "${platform}"`;
      const name = unsupportedName(fact, context);
      if (name) return `unsupported name "${name}"`;
      const credit = unsupportedCredit(fact, context);
      if (credit) return `unsupported credit for "${credit}"`;
      const winner = unsupportedWinner(fact, context);
      if (winner) return `award not given to "${winner}" in the source`;
      const quote = alteredQuote(fact, context);
      if (quote) return `quote not in the source: "${quote}"`;
    }
    if (fact.length > MAX_FACT_CHARS) return `too long (${fact.length} chars)`;
    if (result.kept.some((k) => tooSimilar(k, fact))) return "near-duplicate of an earlier fact";
    return null;
  };

  for (const raw of facts) {
    const fact = stripPrefix(raw);
    const reason = reasonToDrop(fact);
    if (reason) result.rejected.push({ text: fact, reason });
    else result.kept.push(fact);
  }
  return result;
}

// --- Curated pool ------------------------------------------------------

/** `count` hand-verified facts from the topic packs, shuffled. */
export function curatedFacts(count: number): string[] {
  const pool = [...topic.curatedFacts];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.max(0, count));
}
